import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { deriveNetworkPublicId } from "../instance/identity.js";
import { collectFiles, packFiles, unpackInto, type ArchiveEntry } from "./archive.js";
import { decryptArchive, encryptArchive, type BackupRecipient } from "./crypto.js";

/**
 * Backup and restore of a whole instance (ADR 0013).
 *
 * What goes in is everything an instance needs to be itself again: the
 * database, the media, and the instance private key — without which a restored
 * instance is a stranger to its own members (SECURITY_BASELINE §6, punto 3).
 */

/** Work area for the database snapshot. Inside the data directory, so it has room. */
const WORK_DIR = ".backup-work";

const README = `Backup di un'istanza ESTIA.

Questo archivio e' un tar cifrato con age (https://age-encryption.org), e si
apre con strumenti standard, senza ESTIA:

    age -d -i LA-TUA-CHIAVE-PRIVATA.txt backup.tar.age | tar -xv

Dentro trovi:

    estia/estia.db               il database dell'istanza
    estia/instance-identity.pem  la chiave privata dell'istanza
    estia/media/                 le immagini pubblicate

La chiave privata dell'istanza e' il segreto piu' critico del sistema e non e'
sostituibile: senza di essa un ripristino produce un'istanza che i membri non
riconoscono piu'. Tratta questo archivio di conseguenza.
`;

export interface BackupResult {
  /** Where the encrypted archive was written. */
  path: string;
  byteSize: number;
  /** How many files it holds, the readme aside. */
  fileCount: number;
}

/**
 * Which family an archive belongs to (ADR 0014, punto 6).
 *
 * The one written just before migrations is the most valuable archive an
 * instance ever produces, and it is kept apart so that the ordinary rotation
 * cannot delete it: with `ESTIA_BACKUP_KEEP=1` the following night would
 * otherwise remove the only point of return of that upgrade.
 */
export type ArchiveFamily = "scheduled" | "upgrade";

const FAMILY_PREFIX: Record<ArchiveFamily, string> = {
  scheduled: "estia-",
  upgrade: "estia-aggiornamento-",
};

export interface CreateBackupOptions {
  dataDir: string;
  destination: string;
  recipient: BackupRecipient;
  family?: ArchiveFamily;
  now?: () => Date;
}

/** `estia-2026-08-15T09-30-00Z.tar.age`: sorts chronologically, safe on every filesystem. */
export function backupFileName(now: Date, family: ArchiveFamily = "scheduled"): string {
  return `${FAMILY_PREFIX[family]}${now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z")}.tar.age`;
}

export async function createBackup(options: CreateBackupOptions): Promise<BackupResult> {
  const now = options.now ?? ((): Date => new Date());
  const work = path.join(options.dataDir, WORK_DIR);

  await rm(work, { force: true, recursive: true });
  await mkdir(work, { mode: 0o700, recursive: true });

  try {
    const snapshot = path.join(work, "estia.db");

    // A consistent copy of a live database, in one file and with no WAL beside
    // it: the instance does not need to be stopped (ADR 0013).
    snapshotDatabase(path.join(options.dataDir, "estia.db"), snapshot);

    await writeFile(path.join(work, "LEGGIMI.txt"), README, { mode: 0o600 });

    const entries: ArchiveEntry[] = [
      {
        name: "LEGGIMI.txt",
        size: (await stat(path.join(work, "LEGGIMI.txt"))).size,
        source: path.join(work, "LEGGIMI.txt"),
      },
      { name: "estia.db", size: (await stat(snapshot)).size, source: snapshot },
    ];

    const identity = path.join(options.dataDir, "instance-identity.pem");

    if (existsSync(identity)) {
      entries.push({
        name: "instance-identity.pem",
        size: (await stat(identity)).size,
        source: identity,
      });
    }

    // The database first, then the media: a media row exists only once its
    // files are on disk, so everything the snapshot mentions is already there
    // to be copied (ADR 0013).
    const mediaDir = path.join(options.dataDir, "media");

    if (existsSync(mediaDir)) {
      for (const file of await collectFiles(mediaDir, "media")) {
        entries.push(file);
      }
    }

    const archive = await readStream(packFiles(entries));
    const encrypted = await encryptArchive(archive, options.recipient);
    const target = path.join(options.destination, backupFileName(now(), options.family));

    await mkdir(options.destination, { mode: 0o700, recursive: true });
    await writeFile(target, encrypted, { mode: 0o600 });

    return { byteSize: encrypted.byteLength, fileCount: entries.length - 1, path: target };
  } finally {
    await rm(work, { force: true, recursive: true });
  }
}

export interface RestoreOptions {
  archive: string;
  destination: string;
  key: { kind: "privateKey" | "passphrase"; value: string };
  force?: boolean;
  /**
   * Allows replacing an instance with a **different** one: an archive whose
   * instance key is not the one already in the destination. Off by default.
   */
  otherInstance?: boolean;
  now?: () => Date;
}

export interface RestoreResult {
  /** The files now in place, as paths inside the destination. */
  files: string[];
  /**
   * Where the data that was there before went, when there was any. Moved, not
   * deleted: whoever restores decides when it can go.
   */
  previous?: string;
  /**
   * The network key of the instance the archive belongs to, as the panel and
   * `estia info` show it. Absent for an archive with no instance key.
   */
  instance?: string;
}

/**
 * What an archive brings back, and so the only names a restore may replace.
 * The WAL and its index go with the database: left beside a restored
 * `estia.db`, SQLite would replay the old instance's last writes onto it.
 * Everything else in the destination (the backups folder above all) stays.
 */
const RESTORED = [
  "estia.db",
  "estia.db-wal",
  "estia.db-shm",
  "instance-identity.pem",
  "media",
] as const;

/**
 * Restores an archive into a directory.
 *
 * By default, it refuses to write into a directory that already holds an
 * instance: a restore that silently merged into live data would be the worst
 * possible way to discover a mistake. With `force: true` it replaces it, but
 * only after the archive has been decrypted, unpacked to the side and found to
 * hold a database that opens. Until then the live data is not touched; then it
 * is moved aside, never deleted, and `backup/` is never part of it (internal
 * review, 2026-11-27: an empty but valid archive used to wipe the instance,
 * backups included, and report success).
 */
export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const now = options.now ?? ((): Date => new Date());
  const destination = path.resolve(options.destination);

  if (!options.force && existsSync(path.join(destination, "estia.db"))) {
    throw new Error(
      `In ${destination} c'è già un'istanza: scegli una directory vuota e sposta i file solo quando il ripristino è riuscito, oppure usa --sovrascrivi.`,
    );
  }

  const decrypted = await decryptArchive(
    new Uint8Array(await readFile(options.archive)),
    options.key,
  );

  await mkdir(destination, { mode: 0o700, recursive: true });

  // On the same filesystem as the destination, so that putting it in place is
  // a rename. Made fresh, so nothing in it can be a link planted beforehand.
  const staging = await mkdtemp(path.join(destination, ".ripristino-"));

  try {
    const { Readable } = await import("node:stream");

    await unpackInto(Readable.from(Buffer.from(decrypted)), staging);
    checkRestoredDatabase(path.join(staging, "estia.db"));

    const instance = instanceKeyIn(staging);

    if (!options.otherInstance) {
      checkSameInstance(instance, instanceKeyIn(destination));
    }

    const present = RESTORED.filter((name) => existsSync(path.join(destination, name)));
    let previous: string | undefined;

    if (present.length > 0) {
      previous = path.join(
        destination,
        `.prima-del-ripristino-${now().toISOString().replace(/[:.]/g, "-")}`,
      );
      await mkdir(previous, { mode: 0o700 });

      const moved: string[] = [];

      try {
        for (const name of present) {
          await rename(path.join(destination, name), path.join(previous, name));
          moved.push(name);
        }
      } catch (error) {
        await putBack(previous, destination, moved);
        throw error;
      }
    }

    const files: string[] = [];

    for (const name of RESTORED) {
      if (existsSync(path.join(staging, name))) {
        await rename(path.join(staging, name), path.join(destination, name));
      }
    }

    for (const file of await collectFiles(destination)) {
      if (RESTORED.some((name) => file.name === name || file.name.startsWith(`${name}/`))) {
        files.push(file.source);
      }
    }

    return {
      files,
      ...(previous === undefined ? {} : { previous }),
      ...(instance === undefined ? {} : { instance }),
    };
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

/** Refuses an archive whose database is missing or does not open as one. */
function checkRestoredDatabase(file: string): void {
  if (!existsSync(file)) {
    throw new Error(
      "L'archivio non contiene estia.db: non è il backup di un'istanza. I dati attuali non sono stati toccati.",
    );
  }

  let database: DatabaseSync | undefined;

  try {
    database = new DatabaseSync(file, { readOnly: true });
    const check = database.prepare("PRAGMA quick_check").get() as Record<string, unknown>;

    if (Object.values(check)[0] !== "ok") {
      throw new Error("quick_check");
    }
  } catch {
    throw new Error(
      "Il database nell'archivio è danneggiato. I dati attuali non sono stati toccati.",
    );
  } finally {
    database?.close();
  }
}

/**
 * The network key of the instance whose identity file is in `directory`, or
 * nothing when there is none. A file that is not a key counts as none: what
 * matters here is only whether it is the same instance.
 */
function instanceKeyIn(directory: string): string | undefined {
  const file = path.join(directory, "instance-identity.pem");

  if (!existsSync(file)) {
    return undefined;
  }

  try {
    const privateKeyPem = readFileSync(file, "utf8");

    return deriveNetworkPublicId({ privateKeyPem, publicKey: "" });
  } catch {
    return undefined;
  }
}

/**
 * An archive says where it comes from through the instance key it carries,
 * which only that instance holds. Anybody who knows the public backup key can
 * encrypt an archive, so over an existing instance the key must be its own
 * (internal review, 2026-11-27): otherwise a planted archive would replace it.
 * On an empty destination there is nothing to compare, and the CLI shows the
 * key so that whoever restores can check it.
 */
function checkSameInstance(archive: string | undefined, current: string | undefined): void {
  if (current === undefined || archive === current) {
    return;
  }

  throw new Error(
    archive === undefined
      ? `L'archivio non contiene la chiave di nessuna istanza, e questa è l'istanza ${current}. I dati attuali non sono stati toccati. Se vuoi davvero sostituirla, ripeti con --altra-istanza.`
      : `L'archivio è dell'istanza ${archive}, non di questa (${current}). I dati attuali non sono stati toccati. Se vuoi davvero sostituirla con un'altra istanza, ripeti con --altra-istanza.`,
  );
}

/** Best effort: the error that brought us here is the one worth reporting. */
async function putBack(previous: string, destination: string, moved: string[]): Promise<void> {
  for (const name of moved) {
    try {
      await rename(path.join(previous, name), path.join(destination, name));
    } catch {
      // Still in `previous`, which is not removed.
    }
  }
}

function snapshotDatabase(source: string, target: string): void {
  const database = new DatabaseSync(source);

  try {
    // The path is ours, never user input, but it still goes in as a literal —
    // and a quote in it would be a bug worth failing on rather than escaping.
    if (target.includes("'")) {
      throw new Error("Il percorso dello snapshot contiene un apice.");
    }

    database.exec(`VACUUM INTO '${target}'`);
  } finally {
    database.close();
  }
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }

  return new Uint8Array(Buffer.concat(chunks));
}
