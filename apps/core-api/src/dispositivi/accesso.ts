import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  INGRESSO_DURATA_MS,
  formattaQrDiIngresso,
  type DomandaConInvito,
  type EsitoDiIngresso,
  type EsitoDiRichiesta,
  type IngressoEmessoView,
  type JoinRequestSubmission,
  type JoinRequestView,
} from "@estia/contracts";

import type { Transactor } from "../db/database.js";
import { DomainError } from "../errors.js";
import type { IdentityService } from "../identity/service.js";
import { hashSessionToken } from "../identity/tokens.js";

/**
 * L'accesso del Dispositivo ([ADR 0044](../../../../docs/adr/0044-il-dispositivo-e-l-app.md) §4–§5).
 *
 * Tre cose, e nient'altro:
 *
 * 1. **emettere** un codice d'ingresso, che il QR porta insieme alla chiave
 *    della Casa — lo chiede un membro già dentro, da un browser in casa o da
 *    un'app già ammessa;
 * 2. **ammettere** la chiave di rete che presenta quel codice, legandola a una
 *    sessione nuova del membro che l'ha emesso;
 * 3. dire, data una chiave, **quale sessione** apre — oppure nessuna.
 *
 * Il sì di [ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)
 * per le chiavi dei messaggi resta dov'è: entrare nella Casa non mette il
 * dispositivo in nessuna conversazione. Dopo l'ingresso l'app registra la sua
 * chiave di firma, e se non è il primo dispositivo aspetta che uno già
 * approvato dica di sì.
 */

export interface ChiaveDiReteRecord {
  chiave: string;
  sessionId: string;
  userId: string;
  creatoIl: string;
}

export class SqliteAccessoRepository {
  public constructor(private readonly db: DatabaseSync) {}

  public salvaIngresso(record: {
    id: string;
    userId: string;
    codiceHash: string;
    emessoIl: string;
    scadeIl: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ingressi_dispositivo (id, user_id, codice_hash, emesso_il, scade_il, usato_il)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(record.id, record.userId, record.codiceHash, record.emessoIl, record.scadeIl);
  }

  /**
   * Consuma un codice valido e restituisce di chi è. Una sola istruzione, così
   * due connessioni con lo stesso codice non entrano tutte e due.
   */
  public consumaIngresso(codiceHash: string, adesso: string): string | undefined {
    const row = this.db
      .prepare(
        `UPDATE ingressi_dispositivo SET usato_il = ?
         WHERE codice_hash = ? AND usato_il IS NULL AND scade_il > ?
         RETURNING user_id`,
      )
      .get(adesso, codiceHash, adesso) as { user_id: string } | undefined;

    return row?.user_id;
  }

  /** I codici scaduti o usati non servono a niente, nemmeno come storia. */
  public pulisciIngressi(adesso: string): void {
    this.db
      .prepare(`DELETE FROM ingressi_dispositivo WHERE usato_il IS NOT NULL OR scade_il <= ?`)
      .run(adesso);
  }

  public legaChiave(record: ChiaveDiReteRecord): void {
    this.db
      .prepare(
        `INSERT INTO chiavi_di_rete (chiave, session_id, user_id, creato_il)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (chiave) DO UPDATE SET
           session_id = excluded.session_id,
           user_id = excluded.user_id,
           creato_il = excluded.creato_il`,
      )
      .run(record.chiave, record.sessionId, record.userId, record.creatoIl);
  }

  public perChiave(chiave: string): ChiaveDiReteRecord | undefined {
    const row = this.db
      .prepare(`SELECT chiave, session_id, user_id, creato_il FROM chiavi_di_rete WHERE chiave = ?`)
      .get(chiave) as
      { chiave: string; session_id: string; user_id: string; creato_il: string } | undefined;

    return row === undefined
      ? undefined
      : {
          chiave: row.chiave,
          creatoIl: row.creato_il,
          sessionId: row.session_id,
          userId: row.user_id,
        };
  }

  /** Quale chiave ha mandato una richiesta d'ingresso con invito. */
  public salvaRichiesta(record: {
    requestId: string;
    chiave: string;
    etichetta: string;
    creatoIl: string;
  }): void {
    this.db.prepare(`DELETE FROM richieste_dispositivo WHERE chiave = ?`).run(record.chiave);
    this.db
      .prepare(
        `INSERT INTO richieste_dispositivo (request_id, chiave, etichetta, creato_il)
         VALUES (?, ?, ?, ?)`,
      )
      .run(record.requestId, record.chiave, record.etichetta, record.creatoIl);
  }

  public richiesta(requestId: string): { chiave: string; etichetta: string } | undefined {
    return this.db
      .prepare(`SELECT chiave, etichetta FROM richieste_dispositivo WHERE request_id = ?`)
      .get(requestId) as { chiave: string; etichetta: string } | undefined;
  }

  public chiaveDellaSessione(sessionId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT chiave FROM chiavi_di_rete WHERE session_id = ?`)
      .get(sessionId) as { chiave: string } | undefined;

    return row?.chiave;
  }
}

/** Lunghezza massima dell'etichetta che il dispositivo dichiara di sé. */
export const ETICHETTA_MAX = 80;

/** Ciò che serve dell'ammissione: chiedere con un invito. */
export interface Ammissioni {
  submitJoinRequest(input: JoinRequestSubmission): Promise<JoinRequestView>;
}

/**
 * Le domande con invito che una Casa accetta in dieci minuti, da tutte le
 * chiavi insieme: ogni domanda valida costa un hash di password, e le chiavi
 * iroh non costano niente. Un tetto per chiave non fermerebbe nessuno.
 */
const RICHIESTE_MAX = 20;
const RICHIESTE_FINESTRA_MS = 10 * 60 * 1000;

export class AccessoDispositivi {
  readonly #repository: SqliteAccessoRepository;
  readonly #identity: IdentityService;
  readonly #transaction: Transactor;
  readonly #now: () => Date;
  #ammissioni: Ammissioni | undefined;
  #richiesteRecenti: number[] = [];

  public constructor(options: {
    repository: SqliteAccessoRepository;
    identity: IdentityService;
    transaction: Transactor;
    now?: () => Date;
  }) {
    this.#repository = options.repository;
    this.#identity = options.identity;
    this.#transaction = options.transaction;
    this.#now = options.now ?? ((): Date => new Date());
  }

  /**
   * Un codice nuovo per il membro. In chiaro una volta sola, qui: nel database
   * c'è soltanto l'impronta.
   */
  public emetti(userId: string, casa: { chiave: string; ticket?: string }): IngressoEmessoView {
    const adesso = this.#now();
    const codice = randomBytes(16).toString("base64url");
    const scadeIl = new Date(adesso.getTime() + INGRESSO_DURATA_MS).toISOString();

    this.#repository.pulisciIngressi(adesso.toISOString());
    this.#repository.salvaIngresso({
      codiceHash: hashSessionToken(codice),
      emessoIl: adesso.toISOString(),
      id: randomUUID(),
      scadeIl,
      userId,
    });

    const qr = {
      casa: casa.chiave,
      codice,
      ...(casa.ticket === undefined ? {} : { ticket: casa.ticket }),
    };

    return { ...qr, qr: formattaQrDiIngresso(qr), scadeIl };
  }

  /**
   * Ammette `chiave` se `codice` è valido. `undefined` per qualunque altro
   * caso, senza dire quale: chi bussa con un codice sbagliato non deve poter
   * distinguere «scaduto» da «mai esistito».
   *
   * Una chiave già legata a un'altra sessione la lascia: l'installazione che
   * possiede la chiave privata è una sola, e ha appena dimostrato di averla.
   */
  public ammetti(chiave: string, codice: string, etichetta: string): EsitoDiIngresso | undefined {
    // Tutto o niente: un codice consumato senza che la chiave sia legata
    // brucerebbe il QR, e una sessione vecchia revocata senza la nuova
    // lascerebbe l'app fuori.
    try {
      return this.#transaction(() => this.#ammetti(chiave, codice, etichetta));
    } catch {
      return undefined;
    }
  }

  #ammetti(chiave: string, codice: string, etichetta: string): EsitoDiIngresso | undefined {
    const adesso = this.#now().toISOString();
    const userId = this.#repository.consumaIngresso(hashSessionToken(codice), adesso);

    if (userId === undefined) {
      return undefined;
    }

    const precedente = this.#repository.perChiave(chiave);

    if (precedente !== undefined) {
      this.#identity.revokeSession(precedente.userId, precedente.sessionId);
    }

    const caller = this.#identity.openDeviceSession(userId, etichettaDi(etichetta));

    this.#repository.legaChiave({
      chiave,
      creatoIl: adesso,
      sessionId: caller.sessionId,
      userId,
    });

    return {
      esito: "ammesso",
      sessionId: caller.sessionId,
      utente: {
        displayName: caller.user.displayName,
        id: caller.user.id,
        username: caller.user.username,
      },
    };
  }

  /**
   * La sessione che `chiave` apre adesso, o `undefined`. Si chiede a ogni
   * stream, non una volta per connessione: una revoca vale dalla richiesta
   * successiva, non dalla prossima volta che l'app si ricollega.
   */
  public sessioneDi(chiave: string): string | undefined {
    const legame = this.#repository.perChiave(chiave);

    if (legame === undefined) {
      return undefined;
    }

    // Solo una lettura: la sessione la tocca e la allunga `requireAuth`, una
    // volta per richiesta.
    return this.#identity.isSessionLive(legame.sessionId) ? legame.sessionId : undefined;
  }

  public chiaveDellaSessione(sessionId: string): string | undefined {
    return this.#repository.chiaveDellaSessione(sessionId);
  }

  /** L'ammissione nasce prima dell'accesso, in `app.ts`: si collegano dopo. */
  public useAmmissioni(ammissioni: Ammissioni): void {
    this.#ammissioni = ammissioni;
  }

  /**
   * Chi non è membro chiede di entrare, con un invito, da `chiave`.
   *
   * La richiesta è quella di `POST /api/v1/join/request`, e la decide
   * l'amministratore come sempre: un invito fa **chiedere**, non entrare
   * ([ADR 0003](../../../../docs/adr/0003-primo-contatto-in-rete-locale.md), requisito 3). Qui si
   * ricorda soltanto da quale chiave è arrivata. `undefined` — nessuna
   * risposta — per un invito che non vale, come per un codice d'ingresso
   * sbagliato.
   */
  public async richiedi(
    chiave: string,
    domanda: DomandaConInvito,
  ): Promise<EsitoDiRichiesta | undefined> {
    if (this.#ammissioni === undefined) {
      return undefined;
    }

    const adesso = this.#now().getTime();
    this.#richiesteRecenti = this.#richiesteRecenti.filter(
      (t) => t > adesso - RICHIESTE_FINESTRA_MS,
    );
    if (this.#richiesteRecenti.length >= RICHIESTE_MAX) {
      return undefined;
    }
    this.#richiesteRecenti.push(adesso);

    const { codice, username, password, displayName, message } = domanda.invito;
    let richiesta: JoinRequestView;
    try {
      richiesta = await this.#ammissioni.submitJoinRequest({
        inviteCode: codice,
        password,
        username,
        ...(displayName === undefined ? {} : { displayName }),
        ...(message === undefined ? {} : { message }),
      });
    } catch (causa) {
      if (causa instanceof DomainError && causa.code !== "invalid_invite") {
        return { codice: causa.code, esito: "rifiutata" };
      }

      return undefined;
    }

    this.#repository.salvaRichiesta({
      chiave,
      creatoIl: new Date(adesso).toISOString(),
      etichetta: etichettaDi(domanda.etichetta),
      requestId: richiesta.id,
    });

    return { esito: "richiesta", richiestaId: richiesta.id };
  }

  /**
   * L'amministratore ha detto di sì: se la richiesta era arrivata dall'app,
   * la sua chiave diventa il primo dispositivo del nuovo account.
   *
   * Si chiama **dentro** la transazione dell'approvazione: o l'account nasce
   * con il dispositivo, o non nasce.
   */
  public dopoApprovazione(requestId: string, userId: string): void {
    const richiesta = this.#repository.richiesta(requestId);
    if (richiesta === undefined) {
      return;
    }

    const precedente = this.#repository.perChiave(richiesta.chiave);
    if (precedente !== undefined) {
      this.#identity.revokeSession(precedente.userId, precedente.sessionId);
    }

    const caller = this.#identity.openDeviceSession(userId, richiesta.etichetta);
    this.#repository.legaChiave({
      chiave: richiesta.chiave,
      creatoIl: this.#now().toISOString(),
      sessionId: caller.sessionId,
      userId,
    });
  }
}

const etichettaDi = (etichetta: string): string =>
  etichetta.trim().slice(0, ETICHETTA_MAX) || "App ESTIA";
