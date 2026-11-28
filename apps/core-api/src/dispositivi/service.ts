import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";

import { messaggioDiProvaChiave } from "@estia/contracts";
import type {
  ChiaviDiFirmaView,
  SfidaView,
  KeyPackageMlsView,
  DeviceKeyView,
  KeyBackupView,
  PublishKeyPackagesRequest,
  RegisterDeviceKeyRequest,
  SaveKeyBackupRequest,
} from "@estia/contracts";

import { DomainError } from "../errors.js";
import type { UserRepository } from "../identity/repository.js";
import type { DeviceKeyRecord, DeviceKeysRepository } from "./repository.js";

/** L'algoritmo dei dispositivi MLS, come il client lo scrive in `device_keys`. */
export const ALGORITMO_MLS = "MLS-P256-v1";

/** Quanto vale una sfida per la prova di possesso. */
const SFIDA_DURATA_MS = 5 * 60 * 1000;

/** L'inizio DER di una chiave pubblica P-256, compressa (33 byte) o no (65). */
const SPKI_P256 = {
  33: Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"),
  65: Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
} as const;

/**
 * Se `firma` (base64, DER) è una firma ECDSA P-256 con SHA-256 di `messaggio`
 * fatta con la privata di `publicKey` (base64, il punto grezzo come lo scrive
 * `ts-mls`). Ogni errore di forma è un no.
 */
function firmaValida(publicKey: string, messaggio: string, firma: string): boolean {
  try {
    const punto = Buffer.from(publicKey, "base64");
    const prefisso =
      punto.length === 33 ? SPKI_P256[33] : punto.length === 65 ? SPKI_P256[65] : undefined;

    if (prefisso === undefined) {
      return false;
    }

    const chiave = createPublicKey({
      format: "der",
      key: Buffer.concat([prefisso, punto]),
      type: "spki",
    });

    return verify(
      "sha256",
      Buffer.from(messaggio, "utf8"),
      { dsaEncoding: "der", key: chiave },
      Buffer.from(firma, "base64"),
    );
  } catch {
    return false;
  }
}

export interface DispositiviServiceOptions {
  repository: DeviceKeysRepository;
  users: UserRepository;
  now?: (() => Date) | (() => string);
}

export class DispositiviService {
  private readonly repo: DeviceKeysRepository;
  private readonly users: UserRepository;
  private readonly now: () => string;
  /** Una sfida per sessione, in memoria: dura cinque minuti e si usa una volta. */
  private readonly sfide = new Map<string, { sfida: string; scadeIl: string }>();

  constructor(options: DispositiviServiceOptions) {
    this.repo = options.repository;
    this.users = options.users;
    if (options.now) {
      const fn = options.now;
      this.now = () => {
        const val = fn();
        return typeof val === "string" ? val : val.toISOString();
      };
    } else {
      this.now = () => new Date().toISOString();
    }
  }

  /**
   * Registra la chiave di questo dispositivo, e decide se e' gia' approvata.
   *
   * [ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)
   * ha scelto che a dire di si' a un dispositivo nuovo sia un dispositivo che la
   * persona possiede gia'. Due casi si approvano da soli, e nessuno dei due e'
   * una scorciatoia:
   *
   * - **il primo dispositivo**, perche' non c'e' ancora niente da proteggere e
   *   non ci sarebbe nessuno a cui chiedere — e' come Signal tratta il primario;
   * - **una chiave gia' approvata che si ripresenta**, cioe' chi ha rimesso le
   *   proprie chiavi con la frase segreta: riprodurre quella chiave pubblica
   *   richiede la privata, quindi ha gia' dimostrato di essere lui. E' la via di
   *   riserva per chi ha un dispositivo solo e lo perde.
   *
   * Tutti gli altri **aspettano**. Non e' una preferenza: e' il modo in cui la
   * strada C di quell'ADR — «basta saper entrare nell'account» — diventa
   * impossibile invece che sconsigliata.
   */
  /**
   * Una sfida per la prova di possesso di questa sessione. Ne sostituisce una
   * precedente: ce n'è una sola alla volta.
   */
  sfida(sessionId: string): SfidaView {
    const adesso = new Date(this.now());

    for (const [chiave, valore] of this.sfide) {
      if (valore.scadeIl <= adesso.toISOString()) {
        this.sfide.delete(chiave);
      }
    }

    const sfida = {
      scadeIl: new Date(adesso.getTime() + SFIDA_DURATA_MS).toISOString(),
      sfida: randomBytes(32).toString("base64url"),
    };
    this.sfide.set(sessionId, sfida);

    return sfida;
  }

  /** Consuma la sfida della sessione e dice se `prova` firma quella, con `publicKey`. */
  private provaValida(sessionId: string, req: RegisterDeviceKeyRequest): boolean {
    const sfida = this.sfide.get(sessionId);
    this.sfide.delete(sessionId);

    if (
      req.prova === undefined ||
      req.algorithm !== ALGORITMO_MLS ||
      sfida === undefined ||
      sfida.scadeIl <= this.now()
    ) {
      return false;
    }

    return firmaValida(
      req.publicKey,
      messaggioDiProvaChiave(sfida.sfida, req.publicKey),
      req.prova,
    );
  }

  registerKey(userId: string, sessionId: string, req: RegisterDeviceKeyRequest): DeviceKeyView {
    // Check if a device already exists for this session
    const existing = this.repo.getDeviceKeyBySessionId(sessionId);
    const id = existing ? existing.id : randomUUID();
    const createdAt = this.now();

    // La chiave già approvata vale solo con la prova di possesso: è pubblica
    // — il registro la mostra a ogni membro — e chi ha solo la password la può
    // ripresentare. Chi ha anche la privata, cioè chi ha usato la frase
    // segreta, firma la sfida e rientra.
    const daSolo =
      !this.repo.hasApprovedDeviceKey(userId) ||
      (this.repo.isPublicKeyApproved(userId, req.publicKey) && this.provaValida(sessionId, req));

    const record = this.repo.registerDeviceKey({
      id,
      sessionId,
      userId,
      publicKey: req.publicKey,
      algorithm: req.algorithm,
      createdAt,
      approvatoIl: daSolo ? createdAt : null,
    });

    if (req.keyPackages && req.keyPackages.length > 0) {
      this.repo.addKeyPackages(
        req.keyPackages.map((kp) => ({
          id: randomUUID(),
          deviceId: id,
          userId,
          keyPackage: kp,
          createdAt,
        })),
      );
    }

    return {
      id: record.id,
      sessionId: record.sessionId,
      userId: record.userId,
      publicKey: record.publicKey,
      algorithm: record.algorithm,
      createdAt: record.createdAt,
      revokedAt: record.revokedAt,
      approvatoIl: record.approvatoIl,
    };
  }

  getCurrentDevice(sessionId: string): DeviceKeyView | undefined {
    const rec = this.repo.getDeviceKeyBySessionId(sessionId);
    if (!rec) return undefined;
    return {
      id: rec.id,
      sessionId: rec.sessionId,
      userId: rec.userId,
      publicKey: rec.publicKey,
      algorithm: rec.algorithm,
      createdAt: rec.createdAt,
      revokedAt: rec.revokedAt,
      approvatoIl: rec.approvatoIl,
    };
  }

  listUserDevices(userId: string): DeviceKeyView[] {
    return this.repo.getDeviceKeysByUserId(userId).map((rec) => ({
      id: rec.id,
      sessionId: rec.sessionId,
      userId: rec.userId,
      publicKey: rec.publicKey,
      algorithm: rec.algorithm,
      createdAt: rec.createdAt,
      revokedAt: rec.revokedAt,
      approvatoIl: rec.approvatoIl,
    }));
  }

  /**
   * Dice di si' a un dispositivo che aspetta ([ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)).
   *
   * **Solo un dispositivo gia' approvato puo' approvare**, ed e' il vincolo che
   * regge tutta la strada B: senza, quello in attesa direbbe di si' a se stesso
   * e saremmo di nuovo alla strada C, dove basta saper entrare nell'account.
   *
   * Chi non ha nessun dispositivo approvato non e' bloccato: gli resta la frase
   * segreta, che ripresenta una chiave gia' approvata e si fa riconoscere da
   * sola (`registerKey`).
   */
  approva(userId: string, sessionIdDiChiApprova: string, deviceId: string): DeviceKeyView {
    const chiApprova = this.repo.getDeviceKeyBySessionId(sessionIdDiChiApprova);
    if (chiApprova === undefined || chiApprova.approvatoIl === null) {
      throw new DomainError("device_not_approved", 403);
    }

    const daApprovare = this.suoDispositivo(userId, deviceId);
    if (daApprovare.approvatoIl !== null) {
      return this.vista(daApprovare);
    }

    this.repo.approvaDeviceKey(deviceId, this.now());
    return this.vista(this.repo.getDeviceKeyById(deviceId)!);
  }

  /**
   * Dice di no. Il dispositivo non torna in attesa: esce.
   *
   * Un «no» che lasciasse la richiesta in coda si tradurrebbe in una domanda
   * che ricompare, e chi la vede la seconda volta clicca per farla sparire.
   */
  /**
   * Una sessione revocata **da un'altra** porta via anche le sue chiavi dal
   * registro, per sempre: il dispositivo tolto dal proprietario non rientra
   * ripresentando la stessa chiave. Uscire da sé non lo fa — chi esce rientra
   * con la propria chiave, ed è la cronologia che ADR 0040 promette di tenere.
   */
  revocataDaAltri(sessionId: string): void {
    this.repo.revokeDeviceKeysOfSession(sessionId, this.now());
  }

  /** Se questa sessione è un dispositivo che aspetta ancora il sì. */
  inAttesa(sessionId: string): boolean {
    const device = this.repo.getDeviceKeyBySessionId(sessionId);
    return device !== undefined && device.approvatoIl === null;
  }

  rifiuta(userId: string, sessionIdDiChiRifiuta: string, deviceId: string): { sessionId: string } {
    const chiRifiuta = this.repo.getDeviceKeyBySessionId(sessionIdDiChiRifiuta);
    if (chiRifiuta === undefined || chiRifiuta.approvatoIl === null) {
      throw new DomainError("device_not_approved", 403);
    }

    const daRifiutare = this.suoDispositivo(userId, deviceId);
    this.repo.revokeDeviceKey(deviceId, this.now());
    return { sessionId: daRifiutare.sessionId };
  }

  /**
   * Un dispositivo di questa persona, o un 404.
   *
   * Non distingue «non esiste» da «non e' tuo»: dirlo insegnerebbe a un
   * curioso quali identificativi esistono.
   */
  private suoDispositivo(userId: string, deviceId: string): DeviceKeyRecord {
    const record = this.repo.getDeviceKeyById(deviceId);
    if (record === undefined || record.userId !== userId) {
      throw new DomainError("device_not_found", 404);
    }
    return record;
  }

  private vista(rec: DeviceKeyRecord): DeviceKeyView {
    return {
      algorithm: rec.algorithm,
      approvatoIl: rec.approvatoIl,
      createdAt: rec.createdAt,
      id: rec.id,
      publicKey: rec.publicKey,
      revokedAt: rec.revokedAt,
      sessionId: rec.sessionId,
      userId: rec.userId,
    };
  }

  publishKeyPackages(
    userId: string,
    sessionId: string,
    req: PublishKeyPackagesRequest,
  ): { count: number } {
    const device = this.repo.getDeviceKeyBySessionId(sessionId);
    if (!device) {
      throw new DomainError("device_not_registered", 400);
    }

    const createdAt = this.now();
    this.repo.addKeyPackages(
      req.keyPackages.map((kp) => ({
        id: randomUUID(),
        deviceId: device.id,
        userId,
        keyPackage: kp,
        createdAt,
      })),
    );

    return { count: req.keyPackages.length };
  }

  /** Il prelievo per nome, per chi arriva da una rotta che conosce solo quello. */
  claimKeyPackagePerNome(username: string): KeyPackageMlsView | null {
    const utente = this.users.findByUsername(username);
    return utente === undefined ? null : this.claimKeyPackage(utente.id);
  }

  /**
   * Un `KeyPackage` **MLS** di un membro di questa casa, consumato al prelievo.
   *
   * Soltanto MLS: dal ritiro di `ESTIA-E2E-v1` ([ADR 0038](../../../../docs/adr/0038-mls-si-adotta-e-si-comincia-dal-web.md)
   * punto 4) non c'è un altro protocollo a cui consegnare una chiave, e il
   * dispositivo più recente in assoluto non è una risposta.
   */
  claimKeyPackage(targetUserId: string): KeyPackageMlsView | null {
    const res = this.repo.claimKeyPackageForUser(targetUserId, this.now(), ALGORITMO_MLS);
    if (!res) {
      return null;
    }

    return { deviceId: res.device.id, keyPackage: res.keyPackage.keyPackage };
  }

  /**
   * Un `KeyPackage` per ciascun dispositivo del membro: è ciò che serve per
   * far entrare **la persona**, con tutte le sue foglie, e non soltanto il suo
   * ultimo telefono ([ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)).
   */
  claimKeyPackagesPerNome(username: string): KeyPackageMlsView[] {
    const utente = this.users.findByUsername(username);
    if (utente === undefined) {
      return [];
    }

    return this.repo
      .claimKeyPackagesForUser(utente.id, this.now(), ALGORITMO_MLS)
      .map((res) => ({ deviceId: res.device.id, keyPackage: res.keyPackage.keyPackage }));
  }

  /**
   * I KeyPackage degli **altri dispositivi di chi chiede**, scelti per chiave
   * di firma: è il «sì» di [ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)
   * che arriva nelle conversazioni. Un dispositivo già approvato trova nel
   * registro una chiave sua che nell'albero non c'è, e preleva soltanto quella:
   * le scorte degli altri restano intatte.
   *
   * Solo da un dispositivo approvato: uno che aspetta non fa entrare nessuno.
   */
  claimMieiKeyPackages(
    userId: string,
    sessionId: string,
    chiaviDiFirma: readonly string[],
  ): KeyPackageMlsView[] {
    const chiChiede = this.repo.getDeviceKeyBySessionId(sessionId);
    if (chiChiede === undefined || chiChiede.approvatoIl === null) {
      throw new DomainError("device_not_approved", 403);
    }

    const cercate = chiaviDiFirma.map((k) => Buffer.from(k, "base64"));
    const cercata = (publicKey: string): boolean => {
      const sua = Buffer.from(publicKey, "base64");
      return cercate.some((k) => k.length > 0 && k.equals(sua));
    };

    return this.repo
      .claimKeyPackagesForUser(
        userId,
        this.now(),
        ALGORITMO_MLS,
        (device) => device.id !== chiChiede.id && cercata(device.publicKey),
      )
      .map((res) => ({ deviceId: res.device.id, keyPackage: res.keyPackage.keyPackage }));
  }

  saveBackup(userId: string, req: SaveKeyBackupRequest): KeyBackupView {
    const updatedAt = this.now();
    this.repo.saveKeyBackup({
      userId,
      encryptedBlob: req.encryptedBlob,
      algorithm: req.algorithm,
      salt: req.salt,
      iterations: req.iterations,
      updatedAt,
    });

    return {
      encryptedBlob: req.encryptedBlob,
      algorithm: req.algorithm,
      salt: req.salt,
      iterations: req.iterations,
      updatedAt,
    };
  }

  getBackup(userId: string): KeyBackupView | undefined {
    const rec = this.repo.getKeyBackup(userId);
    if (!rec) return undefined;
    return {
      encryptedBlob: rec.encryptedBlob,
      algorithm: rec.algorithm,
      salt: rec.salt,
      iterations: rec.iterations,
      updatedAt: rec.updatedAt,
    };
  }

  /**
   * Le chiavi di firma che l'istanza riconosce per un membro.
   *
   * E' il registro su cui poggia l'`AuthenticationService` di MLS: senza,
   * chiunque ottenga un `GroupInfo` entra come chi vuole. Ferma l'estraneo;
   * **non** ferma chi ospita, perche' questo registro e' dell'istanza — quel
   * limite si chiude fuori banda, con il numero di sicurezza.
   *
   * **Le chiavi revocate non ci sono.** Un dispositivo revocato che passasse
   * ancora la validazione renderebbe la revoca una parola.
   *
   * Un nome che non esiste non e' un errore: e' un elenco vuoto, e chi chiede
   * non impara se quella persona c'e'.
   */
  public chiaviDiFirmaDi(username: string): ChiaviDiFirmaView {
    const utente = this.users.findByUsername(username);
    if (utente === undefined) {
      return { chiavi: [] };
    }

    return {
      chiavi: this.repo
        .getActiveDeviceKeysByUserId(utente.id, this.now())
        .map((chiave) => ({ algorithm: chiave.algorithm, publicKey: chiave.publicKey })),
    };
  }
}
