import type { BackupConfig } from "@estia/config";
import type { BackupArchiveView, BackupReport } from "@estia/contracts";

import { detto, frase, inInglese } from "../frasi.js";
import { backupMemoryWarning } from "./memory.js";
import { lastArchive } from "./schedule.js";

/**
 * What the administrator can see about their own backups.
 *
 * `backup_not_configured` has been shouted into the logs since ADR 0013, which
 * reaches whoever goes looking. This is the other half: the failure this is
 * really about is not the absent backup but the **silent** one — configured,
 * believed in, and not happening — which stays invisible until the day it is
 * needed. So the report does not stop at «configured yes or no»: it looks at
 * whether an archive actually landed, and when.
 */

/**
 * How long after boot a missing archive is still normal. The first scheduled
 * backup runs a minute after startup; ten minutes is generous enough that
 * anything past it is a real problem rather than a race with the timer.
 */
const GRACE_MS = 10 * 60 * 1000;

/** Two intervals: one missed run is a hiccup, two is a pattern. */
const STALE_FACTOR = 2;

function view(
  archive: { name: string; byteSize: number; modifiedAt: Date } | undefined,
): BackupArchiveView | undefined {
  return archive === undefined
    ? undefined
    : {
        byteSize: archive.byteSize,
        modifiedAt: archive.modifiedAt.toISOString(),
        name: archive.name,
      };
}

/** How long ago, in whole hours or days: the bucket picks the sentence. */
function eta(from: Date, to: Date): { ore: number } | { giorni: number } | undefined {
  const hours = Math.floor((to.getTime() - from.getTime()) / (60 * 60 * 1000));

  if (hours < 1) {
    return undefined;
  }

  return hours < 48 ? { ore: hours } : { giorni: Math.floor(hours / 24) };
}

export interface BackupReportOptions {
  config: BackupConfig;
  /** When the process started, to tell a missing archive from a young instance. */
  startedAt: Date;
  now?: () => Date;
  /** Bytes an archive would have to hold, read per request because it grows. */
  storedBytes?: () => number;
  /** The container's memory limit, when there is one to read. */
  memoryLimitBytes?: number | undefined;
}

export async function buildBackupReport(options: BackupReportOptions): Promise<BackupReport> {
  const now = (options.now ?? ((): Date => new Date()))();

  // Said whatever the schedule is doing: it is a prediction about the next
  // backup, not a report on the last one.
  const memoryWarning = backupMemoryWarning(
    options.storedBytes === undefined ? 0 : options.storedBytes(),
    options.memoryLimitBytes,
  );
  const memory =
    memoryWarning === undefined
      ? {}
      : { memoryWarning: inInglese([memoryWarning]), memoryWarningFrasi: [memoryWarning] };

  if (!options.config.scheduled) {
    return {
      ...memory,
      ...detto(frase("diagnostica.backup.not_configured")),
      health: "not_configured",
    };
  }

  const { directory, intervalHours, keep } = options.config;
  const last = view(await lastArchive(directory));
  const lastUpgrade = view(await lastArchive(directory, "upgrade"));
  const common = {
    ...memory,
    intervalHours,
    keep,
    ...(last === undefined ? {} : { last }),
    ...(lastUpgrade === undefined ? {} : { lastUpgradeArchive: lastUpgrade }),
  };

  if (last === undefined) {
    // Young instance: the timer simply has not fired yet.
    if (now.getTime() - options.startedAt.getTime() < GRACE_MS) {
      return {
        ...common,
        ...detto(frase("diagnostica.backup.waiting")),
        health: "waiting",
      };
    }

    return {
      ...common,
      ...detto(frase("diagnostica.backup.missing")),
      health: "missing",
    };
  }

  const age = now.getTime() - new Date(last.modifiedAt).getTime();
  const quanto = eta(new Date(last.modifiedAt), now);

  if (age > intervalHours * STALE_FACTOR * 60 * 60 * 1000) {
    return {
      ...common,
      ...detto(
        quanto !== undefined && "giorni" in quanto
          ? frase("diagnostica.backup.stale.giorni", { n: quanto.giorni, ogni: intervalHours })
          : frase("diagnostica.backup.stale.ore", { n: quanto?.ore ?? 0, ogni: intervalHours }),
      ),
      health: "stale",
    };
  }

  return {
    ...common,
    ...detto(
      quanto === undefined
        ? frase("diagnostica.backup.healthy.meno_ora", { ogni: intervalHours, tiene: keep })
        : "giorni" in quanto
          ? frase("diagnostica.backup.healthy.giorni", {
              n: quanto.giorni,
              ogni: intervalHours,
              tiene: keep,
            })
          : frase("diagnostica.backup.healthy.ore", {
              n: quanto.ore,
              ogni: intervalHours,
              tiene: keep,
            }),
    ),
    health: "healthy",
  };
}
