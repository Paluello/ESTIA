import { randomUUID } from "node:crypto";
import {
  MAX_FOGLIE_GRUPPO,
  MIN_MEMBRI_GRUPPO,
  type ArchivioPage,
  type ConversazioneTipo,
  type CreaGruppoRequest,
  type MembroGruppoInput,
  type RuoloGruppo,
  type DepositaHandshakeRequest,
  type HandshakePage,
  type ConversazioneView,
  type CronologiaPage,
  type GroupInfoView,
  type MazzoArchivioView,
  type RigaCronologiaView,
  type VoceArchivioInput,
} from "@estia/contracts";
import type { CodiceErrore } from "@estia/lingue";

import { DomainError } from "../errors.js";
import { casaValida, idDiVoce, istanteValido, nomeValido } from "./forma.js";
import { codificaCursore, decodificaCursore } from "./repository.js";
import type { UserRepository } from "../identity/repository.js";
import type {
  HandshakeRecord,
  MessaggiRepository,
  SegnapostoInput,
  SegnapostoRecord,
} from "./repository.js";

/**
 * La composizione di una conversazione, come la dichiara **la casa che
 * ordina** ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §3).
 *
 * È il pezzo che mancava ai gruppi fra tre case: l'annuncio di §4.1 porta i
 * destinatari di una casa sola, quindi la casa di chi è invitato conosceva i
 * propri membri e chi aveva creato la conversazione — e una terza casa non le
 * risultava partecipante. Chi c'è lo sa chi ordina, e glielo si chiede.
 *
 * Le persone sono nominate come nella credenziale MLS, `username@casa`
 * (§0): è l'unica forma che vuol dire la stessa cosa in tutte le case.
 */
export interface Composizione {
  /** Cresce a ogni cambio. Uno specchio non accetta una versione più bassa di quella che ha. */
  versione: number;
  tipo: ConversazioneTipo;
  nome: string | null;
  membri: { chi: string; ruolo: RuoloGruppo; dal: string }[];
  /** Chi è stato tolto o è uscito: `da` è chi l'ha tolto, lui stesso se è uscito. */
  rimossi: { chi: string; il: string; da: string }[];
}

/** Un cambio di composizione chiesto a chi ordina, con le persone per indirizzo. */
export type CambioMembri =
  | { azione: "aggiungi"; chi: string }
  | { azione: "togli"; chi: string }
  | { azione: "esci" }
  | { azione: "nomina"; chi: string; ruolo: "amministratore" | "membro" };

/**
 * Perché chi ordina ha detto di no a un cambio, quando il no è una regola del
 * gruppo e non un rifiuto di §2. Sono codici della tabella delle frasi: la casa
 * di chi ha chiesto li mostra nella lingua di chi legge.
 */
export const MOTIVI_DI_RIFIUTO = [
  "solo_amministratori",
  "solo_il_creatore",
  "creatore_non_si_toglie",
  "gruppo_pieno",
  "gia_nel_gruppo",
  "non_nel_gruppo",
  "non_un_gruppo",
  "user_not_found",
] as const satisfies readonly CodiceErrore[];
export type MotivoDiRifiuto = (typeof MOTIVI_DI_RIFIUTO)[number];

const STATO_DEL_RIFIUTO: Record<MotivoDiRifiuto, number> = {
  creatore_non_si_toglie: 403,
  gia_nel_gruppo: 409,
  gruppo_pieno: 409,
  non_nel_gruppo: 404,
  non_un_gruppo: 400,
  solo_amministratori: 403,
  solo_il_creatore: 403,
  user_not_found: 404,
};

export function eMotivoDiRifiuto(codice: string): codice is MotivoDiRifiuto {
  return (MOTIVI_DI_RIFIUTO as readonly string[]).includes(codice);
}

/** Un cambio come lo applica chi ordina: le persone per id di questa casa. */
type Cambio =
  | { azione: "aggiungi"; bersaglio: string }
  | { azione: "togli"; bersaglio: string }
  | { azione: "esci" }
  | { azione: "nomina"; bersaglio: string; ruolo: "amministratore" | "membro" };

/** Quanti rimossi viaggiano in una composizione: i più recenti. */
const MAX_RIMOSSI_IN_COMPOSIZIONE = 256;

/** Ogni quanto si richiede la composizione a chi ordina, per conversazione. */
const COMPOSIZIONE_MINIMA_MS = 60 * 1000;

/** Una finestra di segnaposto come la dichiara la casa custode (ADR 0042 §4.1). */
export interface FinestraSegnaposti {
  da: number;
  a: number;
  voci: SegnapostoInput[];
  prossimo?: string;
}

/**
 * La rete, come la vede questo servizio: la coda, lo stato, i segnaposto, e
 * una chiave.
 *
 * È il confine che tiene la federazione fuori da qui ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §3):
 * quando la casa che ordina non è questa, la coda **non si duplica** — si
 * chiede a lei. Assente finché la rete non è attiva, e allora una conversazione
 * ordinata altrove dice di no invece di far finta.
 */
export interface ReteFraCase {
  /** La chiave di questa casa (ADR 0042 §0). */
  casa: string;
  deposita: (
    casa: string,
    conversazioneId: string,
    busta: {
      id: string;
      epoch: number;
      tipo: "commit" | "welcome";
      destinatario?: string | undefined;
      busta: string;
      createdAt: string;
    },
  ) => Promise<
    | { esito: "depositato" }
    /** Un altro commit ha già creato quell'epoch: si rifà sull'epoch nuova (§3). */
    | { esito: "indietro" }
    | { esito: "rifiutato" }
    | { esito: "irraggiungibile" }
  >;
  coda: (
    casa: string,
    conversazioneId: string,
    dopo?: string,
  ) => Promise<
    // Senza `seq`: quello è il progressivo di chi ordina, e chi legge avanza
    // con `prossimo`. Un numero di riga di un altro database non vuol dire
    // niente qui.
    | { esito: "coda"; handshake: Omit<HandshakeRecord, "seq">[]; prossimo?: string }
    | { esito: "rifiutato" }
    | { esito: "irraggiungibile" }
  >;
  /** `GroupInfo` o mazzo, letti presso chi ordina e **non conservati qui**. */
  leggiStato: (
    casa: string,
    conversazioneId: string,
    tipo: "group-info" | "mazzo",
  ) => Promise<
    | { esito: "stato"; blob: string; epoch: number; updatedAt: string }
    | { esito: "assente" }
    | { esito: "rifiutato" }
    | { esito: "irraggiungibile" }
  >;
  depositaStato: (
    casa: string,
    conversazioneId: string,
    tipo: "group-info" | "mazzo",
    stato: { blob: string; epoch: number },
  ) => Promise<
    | { esito: "depositato"; updatedAt: string }
    | { esito: "indietro" }
    | { esito: "rifiutato" }
    | { esito: "irraggiungibile" }
  >;
  /**
   * La visita (`archivio`): le voci con questi id, chieste alla casa che le
   * custodisce. **Si inoltrano e non si scrivono**: tornano per questa risposta
   * e basta (ADR 0043 §0). `assenti` sono quelle che la casa custode non ha —
   * ritirate, o mai esistite — e i loro segnaposto si cancellano.
   */
  visitaArchivio: (
    casa: string,
    conversazioneId: string,
    ids: string[],
  ) => Promise<
    | {
        esito: "voci";
        voci: { id: string; chiaveN: number; busta: string; createdAt: string }[];
        assenti: string[];
      }
    | { esito: "rifiutato" }
    | { esito: "irraggiungibile" }
  >;
  /** I segnaposto dopo un cursore, chiesti alla casa custode (`segnaposto-da`). */
  segnapostiDa: (
    casa: string,
    conversazioneId: string,
    dopo: number,
  ) => Promise<
    | ({ esito: "finestra" } & FinestraSegnaposti)
    | { esito: "rifiutato" }
    | { esito: "irraggiungibile" }
  >;
  /**
   * La spinta (`segnaposto`): i segnaposto nuovi, o nessuno per annunciare
   * che la conversazione esiste. Best effort: se non arriva, la prossima
   * richiesta recupera.
   */
  spingiSegnaposti: (
    casa: string,
    spinta: {
      conversazioneId: string;
      /** Chi scrive, o chi ha creato la conversazione, su questa casa. */
      da: string;
      /** I membri della conversazione che abitano **là**. */
      destinatari: string[];
      voci: SegnapostoInput[];
      /**
       * Chi spinge **ordina** questa conversazione? Solo allora la spinta può
       * farla nascere presso chi la riceve: con tre case, il messaggio di una
       * casa che partecipa può arrivare prima dell'annuncio di chi ordina, e
       * farla nascere da quello vorrebbe dire scrivere la casa sbagliata.
       */
      ordina: boolean;
    },
  ) => Promise<void>;
  /** La composizione, chiesta a chi ordina (`composizione`, azione `leggi`). */
  composizione: (
    casa: string,
    conversazioneId: string,
  ) => Promise<
    | { esito: "composizione"; composizione: Composizione }
    | { esito: "rifiutato" }
    | { esito: "irraggiungibile" }
  >;
  /** La composizione, detta da chi ordina a una casa che custodisce. Best effort. */
  annunciaComposizione: (
    casa: string,
    conversazioneId: string,
    composizione: Composizione,
  ) => Promise<void>;
  /**
   * Un cambio di composizione chiesto a chi ordina (`membri`), a nome di un
   * membro di **questa** casa. `negato` è un no che viene dalle regole del
   * gruppo; `rifiutato` è il rifiuto unico di §2.
   */
  cambiaMembri: (
    casa: string,
    conversazioneId: string,
    richiesta: { da: string } & CambioMembri,
  ) => Promise<
    | { esito: "fatto"; composizione: Composizione }
    | { esito: "negato"; motivo: MotivoDiRifiuto }
    | { esito: "rifiutato" }
    | { esito: "irraggiungibile" }
  >;
}

/**
 * Chi può aprire una conversazione con chi, da un'altra casa
 * ([ADR 0030](../../../../docs/adr/0030-chi-puo-scrivere-a-chi.md) §1).
 *
 * Una porta e non il registro dei follow, perché la regola sta in un posto
 * solo — [`direttorio.ts`](direttorio.ts) — e questo servizio non deve sapere
 * che cosa sia un follow o un collegamento. **Assente, nessun annuncio fa
 * nascere una conversazione**: il difetto da cui viene questa porta era
 * proprio un sì dato per mancanza di domanda.
 */
export interface ChiPuoScrivere {
  /**
   * `da`, della casa `casa`, può aprire una conversazione con questa persona
   * di qui? `casa` è la chiave della connessione; `da` è dichiarato da lei.
   */
  puoAprire(casa: string, da: string, destinatario: { id: string; username: string }): boolean;
}

export interface MessaggiServiceOptions {
  repository: MessaggiRepository;
  users: UserRepository;
  now?: (() => Date) | (() => string);
  /** Assente finché la rete non c'è: allora ordina soltanto questa casa. */
  rete?: ReteFraCase;
  /** Assente = nessuna conversazione nasce da un annuncio. */
  chiPuoScrivere?: ChiPuoScrivere;
}

/**
 * Le quote di ADR 0042 §4.1 e §3, tutte su una finestra di un giorno.
 *
 * Sono larghe per una casa — venti persone che si scrivono non ci arrivano —
 * e strette per chi prova a riempire un disco: ogni riga che un'altra casa può
 * far scrivere qui ha un tetto che non dipende dalla sua buona volontà.
 */
export const QUOTE = {
  /** Conversazioni nate dagli annunci di una casa. */
  annunciPerCasa: 32,
  /** Conversazioni nate dagli annunci di una casa per la stessa persona di qui. */
  annunciPerPersona: 8,
  finestraMs: 24 * 60 * 60 * 1000,
  /** Welcome messi in fila da una stessa casa, in tutte le sue conversazioni. */
  welcomePerCasa: 256,
  /** Welcome in fila in una conversazione. */
  welcomePerConversazione: 128,
  /** Welcome in fila per lo stesso destinatario di una conversazione. */
  welcomePerDestinatario: 16,
} as const;

/**
 * Il costo dichiarato di ADR 0042 §3, detto con le parole che l'interfaccia
 * userà: se la casa che ordina non risponde, in quella conversazione non si
 * cambia chi c'è. Grazie ad [ADR 0041](../../../../docs/adr/0041-le-istanze-si-tengono-d-occhio.md)
 * l'istanza lo sa prima di provarci, e può dirlo invece di far aspettare.
 */
/** Quante voci si chiedono in una visita: una pagina di chat, e la risposta sta nel tetto. */
const VOCI_PER_VISITA = 32;

/** Quanti segnaposto in una risposta: piccoli, quindi tanti. */
const SEGNAPOSTI_PER_PAGINA = 100;

/**
 * Ogni quanto si riconcilia da zero: il tetto di cinque minuti per il ritiro
 * (decisione 8 delle risposte del proprietario, ADR 0042).
 */
const RICONCILIAZIONE_MS = 5 * 60 * 1000;

/** Il respiro minimo fra due domande di segnaposto alla stessa casa per la stessa conversazione. */
const RICHIESTA_MINIMA_MS = 10 * 1000;

/** Il mittente di un segnaposto è di quella casa? Nessuno parla per un'altra. */
function mittenteDiCasa(mittente: string, casa: string): boolean {
  const taglio = mittente.lastIndexOf("@");
  return taglio > 0 && mittente.slice(taglio + 1) === casa;
}

/**
 * Una finestra che si può applicare: parte dove si è chiesto, non va
 * all'indietro, ogni voce ci sta dentro e ogni mittente è della casa custode.
 * Una finestra incoerente non si applica a metà: si scarta.
 */
function finestraCoerente(finestra: FinestraSegnaposti, casa: string, dopo: number): boolean {
  if (finestra.da !== dopo + 1 || finestra.a < dopo) {
    return false;
  }

  return finestra.voci.every(
    (v) => v.seq >= finestra.da && v.seq <= finestra.a && mittenteDiCasa(v.mittente, casa),
  );
}

/**
 * La corsa di ADR 0042 §3, risolta come quell'ADR dice: il secondo commit alla
 * stessa epoch si rifiuta, e chi l'ha scritto lo rifà. È un fallimento
 * **visibile e ripetibile**, che è la differenza fra una fila e due alberi.
 */
function commitSuperato(): DomainError {
  return new DomainError("conflict", 409);
}

function casaCheOrdinaSpenta(): DomainError {
  return new DomainError("casa_che_ordina_non_raggiungibile", 503);
}

export class MessaggiService {
  private readonly repo: MessaggiRepository;
  private readonly users: UserRepository;
  private readonly now: () => string;
  private rete: ReteFraCase | undefined;
  /** Quando si sono chiesti i segnaposto l'ultima volta, per casa e conversazione. Solo in memoria. */
  readonly #ultimeRichieste = new Map<string, number>();
  /** I Welcome depositati da ogni casa nella finestra: gli istanti, in memoria. */
  readonly #welcomeDiCasa = new Map<string, number[]>();
  #chiPuoScrivere: ChiPuoScrivere | undefined;
  /** Quando si è chiesta la composizione l'ultima volta, per conversazione. Solo in memoria. */
  readonly #ultimeComposizioni = new Map<string, number>();

  constructor(options: MessaggiServiceOptions) {
    this.repo = options.repository;
    this.users = options.users;
    this.rete = options.rete;
    this.#chiPuoScrivere = options.chiPuoScrivere;
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

  getOrCreateDirect(
    callerId: string,
    request: {
      recipientUserId?: string | undefined;
      recipientUsername?: string | undefined;
      remoteInstanceKey?: string | undefined;
    },
  ): { conversazione: ConversazioneView } {
    let recipientUserId: string;

    if (request.recipientUserId && request.recipientUserId.startsWith("remote:")) {
      recipientUserId = request.recipientUserId;
    } else if (request.remoteInstanceKey && request.recipientUsername) {
      recipientUserId = `remote:${request.remoteInstanceKey}:${request.recipientUsername}`;
    } else {
      let recipient: ReturnType<typeof this.users.findById> | undefined;

      if (request.recipientUserId) {
        recipient = this.users.findById(request.recipientUserId);
      } else if (request.recipientUsername) {
        recipient = this.users.findByUsername(request.recipientUsername);
      } else {
        throw new DomainError("bad_request", 400);
      }

      if (!recipient) {
        throw new DomainError("user_not_found", 404);
      }

      recipientUserId = recipient.id;
    }

    if (callerId === recipientUserId) {
      throw new DomainError("cannot_message_self", 400);
    }

    let conv = this.repo.findDirectConversazione(callerId, recipientUserId);
    const createdAt = this.now();

    if (!conv) {
      conv = this.repo.createConversazione({
        id: randomUUID(),
        tipo: "diretta",
        createdAt,
        membri: [callerId, recipientUserId],
      });
    }

    const membri = this.repo.getMembers(conv.id);

    return {
      conversazione: {
        id: conv.id,
        tipo: conv.tipo,
        membri,
        nonLetti: 0,
        createdAt: conv.createdAt,
        ordinataQui: this.#ordinaQui(conv.id),
      },
    };
  }

  listConversazioni(callerId: string): ConversazioneView[] {
    const list = this.repo.listConversazioniForUser(callerId);
    return list.map((item) => ({
      id: item.conversazione.id,
      tipo: item.conversazione.tipo,
      membri: item.membri,
      ...(item.ultimoMessaggio ? { ultimoMessaggio: item.ultimoMessaggio } : {}),
      nonLetti: item.nonLetti,
      createdAt: item.conversazione.createdAt,
      ordinataQui: this.#ordinaQui(item.conversazione.id),
      peerVistoFinoA: this.repo.vistoDellAltroFinoA(item.conversazione.id, callerId),
      ...this.#datiDelGruppo(item.conversazione),
    }));
  }

  async getConversazione(callerId: string, id: string): Promise<ConversazioneView> {
    this.#richiediMembro(id, callerId);
    // Chi c'è lo sa chi ordina: prima di mostrarlo lo si richiede, e chi nel
    // frattempo è stato tolto lo scopre qui invece di leggere un elenco vecchio.
    await this.#aggiornaComposizione(id);
    this.#richiediMembro(id, callerId);

    return this.#vista(callerId, id);
  }

  #vista(callerId: string, id: string): ConversazioneView {
    const conv = this.repo.getConversazioneById(id);
    if (!conv) {
      throw new DomainError("conversazione_inesistente", 404);
    }

    return {
      id: conv.id,
      tipo: conv.tipo,
      membri: this.repo.getMembers(id),
      nonLetti: 0,
      createdAt: conv.createdAt,
      ordinataQui: this.#ordinaQui(conv.id),
      peerVistoFinoA: this.repo.vistoDellAltroFinoA(conv.id, callerId),
      ...this.#datiDelGruppo(conv),
    };
  }

  /** Il nome e i ruoli, che solo un gruppo ha. */
  #datiDelGruppo(conv: { id: string; tipo: ConversazioneTipo }): {
    nome?: string;
    ruoli?: Record<string, RuoloGruppo>;
    rimossi?: string[];
  } {
    if (conv.tipo !== "gruppo") {
      return {};
    }

    return {
      nome: this.repo.nomeDi(conv.id) ?? "",
      rimossi: this.repo
        .rimossi(conv.id)
        .map((r) => this.#indirizzoDi(r.userId))
        .filter((chi): chi is string => chi !== undefined),
      ruoli: Object.fromEntries(this.repo.membriConRuolo(conv.id).map((m) => [m.userId, m.ruolo])),
    };
  }

  /**
   * Chi chiede dev'essere dentro. Chi è stato tolto riceve **un no che dice
   * perché**: è il criterio 3 di M8 — l'istanza rifiuta di servirgli la
   * conversazione — detto con la sua frase invece che con «non sei membro».
   */
  #richiediMembro(conversazioneId: string, callerId: string): void {
    if (this.repo.isMember(conversazioneId, callerId)) {
      return;
    }

    throw this.repo.rimosso(conversazioneId, callerId) === undefined
      ? new DomainError("non_membro", 403)
      : new DomainError("rimosso_dal_gruppo", 403);
  }

  /* ---------- i gruppi (M8) ---------- */

  /**
   * Crea un gruppo: un nome, chi crea, e almeno altre due persone — di questa
   * casa o di altre.
   *
   * La casa di chi crea è **la casa che ordina** (ADR 0042 §3), e da qui in
   * poi la composizione la sa lei. Alle case degli altri la dice subito, per
   * intero: è ciò che permette a una terza casa di riconoscere la seconda.
   */
  creaGruppo(callerId: string, request: CreaGruppoRequest): { conversazione: ConversazioneView } {
    const nome = request.nome.trim();
    if (nome.length === 0) {
      throw new DomainError("invalid_request", 400);
    }

    const altri = new Set<string>();
    for (const chi of request.membri) {
      const id = this.#idDelMembro(chi);
      if (id !== callerId) {
        altri.add(id);
      }
    }

    if (altri.size + 1 < MIN_MEMBRI_GRUPPO) {
      throw new DomainError("gruppo_troppo_piccolo", 400);
    }

    if (altri.size + 1 > MAX_FOGLIE_GRUPPO) {
      throw new DomainError("gruppo_pieno", 409);
    }

    const conv = this.repo.createConversazione({
      createdAt: this.now(),
      id: randomUUID(),
      membri: [callerId, ...altri],
      nome,
      ruoli: { [callerId]: "creatore" },
      tipo: "gruppo",
    });
    this.repo.avanzaVersioneComposizione(conv.id);
    void this.#annunciaComposizione(conv.id).catch(() => undefined);

    return { conversazione: this.#vista(callerId, conv.id) };
  }

  /** Fa entrare qualcuno. Lo possono fare il creatore e gli amministratori. */
  async aggiungiMembro(
    callerId: string,
    conversazioneId: string,
    chi: MembroGruppoInput,
  ): Promise<{ conversazione: ConversazioneView }> {
    this.#richiediMembro(conversazioneId, callerId);

    const bersaglio = this.#idDelMembro(chi);
    await this.#chiedi(callerId, conversazioneId, { azione: "aggiungi", bersaglio });

    return { conversazione: this.#vista(callerId, conversazioneId) };
  }

  /** Toglie qualcuno. Lo possono fare il creatore e gli amministratori. */
  async togliMembro(
    callerId: string,
    conversazioneId: string,
    membroId: string,
  ): Promise<{ conversazione: ConversazioneView }> {
    this.#richiediMembro(conversazioneId, callerId);
    await this.#chiedi(callerId, conversazioneId, { azione: "togli", bersaglio: membroId });

    return { conversazione: this.#vista(callerId, conversazioneId) };
  }

  /**
   * Uscire: è un'operazione **di chi esce**, non di chi resta. Non serve il
   * permesso di nessuno, e nessun altro la può fare al posto suo — quella è
   * una rimozione, e ha un altro nome e altri diritti.
   */
  async esci(callerId: string, conversazioneId: string): Promise<void> {
    this.#richiediMembro(conversazioneId, callerId);
    await this.#chiedi(callerId, conversazioneId, { azione: "esci" });
  }

  /** Nomina un amministratore, o gli toglie l'incarico. Lo fa il creatore. */
  async cambiaRuolo(
    callerId: string,
    conversazioneId: string,
    membroId: string,
    ruolo: "amministratore" | "membro",
  ): Promise<{ conversazione: ConversazioneView }> {
    this.#richiediMembro(conversazioneId, callerId);
    await this.#chiedi(callerId, conversazioneId, { azione: "nomina", bersaglio: membroId, ruolo });

    return { conversazione: this.#vista(callerId, conversazioneId) };
  }

  /** L'id, in questa casa, di una persona nominata per nome e casa. */
  #idDelMembro(chi: MembroGruppoInput): string {
    if (chi.casa !== undefined && chi.casa !== this.rete?.casa) {
      // Una persona di un'altra casa in un gruppo che questa casa non può
      // annunciare sarebbe un invito che non parte mai.
      if (this.rete === undefined) {
        throw new DomainError("rete_non_attiva", 503);
      }

      // La forma che le altre case pretendono (`forma.ts`): un nome o una
      // chiave scritti male renderebbero malformata la composizione intera, e
      // nessuna casa la accetterebbe più.
      if (!nomeValido(chi.username) || !casaValida(chi.casa)) {
        throw new DomainError("invalid_request", 400);
      }

      return `remote:${chi.casa}:${chi.username}`;
    }

    const utente = this.users.findByUsername(chi.username);
    if (utente === undefined) {
      throw new DomainError("user_not_found", 404);
    }

    return utente.id;
  }

  /**
   * Un cambio di composizione, chiesto da un membro di questa casa.
   *
   * Se ordina questa casa lo si applica qui. Se ordina un'altra **lo si chiede
   * a lei**, e qui si scrive soltanto quello che lei risponde: due case che
   * cambiassero la composizione ognuna per conto suo sarebbero la stessa
   * divergenza silenziosa che §3 esiste per impedire sui commit. Se non
   * risponde, vale il costo dichiarato di §3 — niente ingressi, niente uscite.
   */
  async #chiedi(callerId: string, conversazioneId: string, cambio: Cambio): Promise<void> {
    const altrove = this.#casaCheOrdinaAltrove(conversazioneId);

    if (altrove === undefined) {
      this.#cambia(conversazioneId, callerId, cambio);
      void this.#annunciaComposizione(conversazioneId).catch(() => undefined);
      return;
    }

    const attore = this.users.findById(callerId);
    const chi = "bersaglio" in cambio ? this.#indirizzoDi(cambio.bersaglio) : undefined;
    if (attore === undefined || ("bersaglio" in cambio && chi === undefined)) {
      throw new DomainError("user_not_found", 404);
    }

    const richiesta: { da: string } & CambioMembri =
      cambio.azione === "esci"
        ? { azione: "esci", da: attore.username }
        : cambio.azione === "nomina"
          ? { azione: "nomina", chi: chi ?? "", da: attore.username, ruolo: cambio.ruolo }
          : { azione: cambio.azione, chi: chi ?? "", da: attore.username };

    const esito = await this.#rete().cambiaMembri(altrove, conversazioneId, richiesta);

    if (esito.esito === "irraggiungibile") {
      throw casaCheOrdinaSpenta();
    }

    if (esito.esito === "rifiutato") {
      throw new DomainError("forbidden", 403);
    }

    if (esito.esito === "negato") {
      throw new DomainError(esito.motivo, STATO_DEL_RIFIUTO[esito.motivo]);
    }

    this.riceviComposizione(conversazioneId, altrove, esito.composizione);
  }

  /**
   * Applica un cambio, **presso la casa che ordina**. I diritti si guardano
   * qui e soltanto qui (risposta del proprietario, 2026-09-17): aggiungono e
   * tolgono il creatore e gli amministratori che nomina; chiunque esce da solo.
   */
  #cambia(conversazioneId: string, attore: string, cambio: Cambio): void {
    const conv = this.repo.getConversazioneById(conversazioneId);
    if (conv?.tipo !== "gruppo") {
      throw new DomainError("non_un_gruppo", 400);
    }

    const ruolo = this.repo.ruoloDi(conversazioneId, attore);
    if (ruolo === undefined) {
      throw new DomainError("non_membro", 403);
    }

    const gestisce = ruolo === "creatore" || ruolo === "amministratore";
    const adesso = this.now();

    if (cambio.azione === "esci" || (cambio.azione === "togli" && cambio.bersaglio === attore)) {
      this.repo.togliMembro(conversazioneId, attore, { da: attore, il: adesso });
      this.#lasciaQualcunoAGestire(conversazioneId);
    } else if (cambio.azione === "aggiungi") {
      if (!gestisce) {
        throw new DomainError("solo_amministratori", 403);
      }

      if (this.repo.isMember(conversazioneId, cambio.bersaglio)) {
        throw new DomainError("gia_nel_gruppo", 409);
      }

      if (this.repo.contaMembri(conversazioneId) >= MAX_FOGLIE_GRUPPO) {
        throw new DomainError("gruppo_pieno", 409);
      }

      this.repo.aggiungiMembro(conversazioneId, cambio.bersaglio, "membro", adesso);
    } else if (cambio.azione === "togli") {
      if (!gestisce) {
        throw new DomainError("solo_amministratori", 403);
      }

      const suo = this.repo.ruoloDi(conversazioneId, cambio.bersaglio);
      if (suo === undefined) {
        throw new DomainError("non_nel_gruppo", 404);
      }

      if (suo === "creatore") {
        throw new DomainError("creatore_non_si_toglie", 403);
      }

      this.repo.togliMembro(conversazioneId, cambio.bersaglio, { da: attore, il: adesso });
    } else {
      // Gli amministratori li nomina il creatore. Se il creatore è uscito,
      // resta a chi amministra: un gruppo in cui nessuno può più nominare
      // nessuno sarebbe un vicolo cieco.
      const cEUnCreatore = this.repo
        .membriConRuolo(conversazioneId)
        .some((m) => m.ruolo === "creatore");
      if (ruolo !== "creatore" && (cEUnCreatore || ruolo !== "amministratore")) {
        throw new DomainError("solo_il_creatore", 403);
      }

      const suo = this.repo.ruoloDi(conversazioneId, cambio.bersaglio);
      if (suo === undefined) {
        throw new DomainError("non_nel_gruppo", 404);
      }

      if (suo === "creatore") {
        throw new DomainError("creatore_non_si_toglie", 403);
      }

      this.repo.impostaRuolo(conversazioneId, cambio.bersaglio, cambio.ruolo);
    }

    this.repo.avanzaVersioneComposizione(conversazioneId);
  }

  /**
   * Se chi esce era l'ultimo a poter aggiungere e togliere, il membro entrato
   * da più tempo diventa amministratore. «Chiunque può uscire da solo» vale
   * anche per il creatore, e un gruppo che nessuno amministra non potrebbe più
   * far entrare né togliere nessuno.
   */
  #lasciaQualcunoAGestire(conversazioneId: string): void {
    const restano = this.repo.membriConRuolo(conversazioneId);
    const primo = restano[0];
    if (primo === undefined || restano.some((m) => m.ruolo !== "membro")) {
      return;
    }

    this.repo.impostaRuolo(conversazioneId, primo.userId, "amministratore");
  }

  /** `username@casa` di un id di questa casa; `undefined` se non si sa dire. */
  #indirizzoDi(userId: string): string | undefined {
    if (userId.startsWith("remote:")) {
      const [, casa, ...nome] = userId.split(":");
      return casa === undefined || nome.length === 0 ? undefined : `${nome.join(":")}@${casa}`;
    }

    const utente = this.users.findById(userId);
    return utente === undefined || this.rete === undefined
      ? undefined
      : `${utente.username}@${this.rete.casa}`;
  }

  /** L'id, in questa casa, di un indirizzo `username@casa`; `undefined` se non c'è. */
  #idDi(indirizzo: string): string | undefined {
    const taglio = indirizzo.lastIndexOf("@");
    if (taglio <= 0 || taglio === indirizzo.length - 1) {
      return undefined;
    }

    const username = indirizzo.slice(0, taglio);
    const casa = indirizzo.slice(taglio + 1);

    return casa === this.rete?.casa
      ? this.users.findByUsername(username)?.id
      : `remote:${casa}:${username}`;
  }

  /** La composizione di una conversazione che questa casa ordina. */
  #composizione(conversazioneId: string): Composizione | undefined {
    const conv = this.repo.getConversazioneById(conversazioneId);
    if (conv === undefined) {
      return undefined;
    }

    const membri: Composizione["membri"] = [];
    for (const m of this.repo.membriConRuolo(conversazioneId)) {
      const chi = this.#indirizzoDi(m.userId);
      if (chi !== undefined) {
        membri.push({ chi, dal: m.joinedAt, ruolo: m.ruolo });
      }
    }

    const rimossi: Composizione["rimossi"] = [];
    for (const r of this.repo.rimossi(conversazioneId).slice(-MAX_RIMOSSI_IN_COMPOSIZIONE)) {
      const chi = this.#indirizzoDi(r.userId);
      if (chi !== undefined) {
        rimossi.push({ chi, da: this.#indirizzoDi(r.da) ?? chi, il: r.rimossoIl });
      }
    }

    return {
      membri,
      nome: this.repo.nomeDi(conversazioneId),
      rimossi,
      tipo: conv.tipo,
      versione: this.repo.versioneComposizione(conversazioneId),
    };
  }

  /**
   * Dice la composizione a ogni casa che custodisce qualcosa di questa
   * conversazione: quelle dei membri, e quelle di chi è stato tolto — che
   * devono saperlo per smettere di servirlo, e sapere chi c'è per continuare a
   * servire agli altri quello che lui aveva scritto (ADR 0043).
   *
   * Best effort, come la spinta dei segnaposto: chi non la riceve la chiede.
   */
  async #annunciaComposizione(conversazioneId: string): Promise<void> {
    const rete = this.rete;
    if (rete === undefined || !this.#ordinaQui(conversazioneId)) {
      return;
    }

    const composizione = this.#composizione(conversazioneId);
    if (composizione === undefined) {
      return;
    }

    await Promise.all(
      this.repo
        .caseCustodi(conversazioneId)
        .filter((casa) => casa !== rete.casa)
        .map((casa) =>
          rete.annunciaComposizione(casa, conversazioneId, composizione).catch(() => undefined),
        ),
    );
  }

  /**
   * La composizione per una casa che la chiede (`composizione`, ADR 0042 §2).
   *
   * Le stesse due porte della coda, con una differenza dichiarata: risponde
   * anche a una casa che dentro **aveva** qualcuno e non ce l'ha più. È una
   * casa custode — serve ancora le parole dei suoi — e deve sapere a chi.
   */
  composizionePerCasa(conversazioneId: string, remoteKey: string): Composizione | "rifiutato" {
    if (
      !this.#ordinaQui(conversazioneId) ||
      !(
        this.repo.haMembroDiCasa(conversazioneId, remoteKey) ||
        this.repo.haRimossoDiCasa(conversazioneId, remoteKey)
      )
    ) {
      return "rifiutato";
    }

    return this.#composizione(conversazioneId) ?? "rifiutato";
  }

  /**
   * La composizione detta da un'altra casa: spinta, chiesta, o tornata da un
   * cambio.
   *
   * Si accetta **solo dalla casa che ordina quella conversazione** — la chiave
   * è quella della connessione, mai un campo del messaggio. Se la conversazione
   * qui non esiste nasce adesso, ordinata da chi la annuncia: come per
   * l'annuncio di §4.1, una casa può dichiarare di ordinare soltanto una
   * conversazione sua, e deve averci messo dentro almeno uno di qui.
   *
   * **Chi di qui entra adesso passa dalla stessa porta dell'annuncio**
   * ([ADR 0030](../../../../docs/adr/0030-chi-puo-scrivere-a-chi.md) §1): la
   * casa che ordina deve poterlo raggiungere — per un follow accettato con uno
   * dei suoi che sta nel gruppo, o perché è collegata e lui è presente in
   * rete. Chi non passa **non entra nello specchio**, senza che la risposta lo
   * dica: per il gruppo è un invito a cui nessuno risponde. Chi c'era già
   * resta: il permesso si chiede per entrare, non per restare.
   */
  riceviComposizione(
    conversazioneId: string,
    remoteKey: string,
    composizione: Composizione,
  ): boolean {
    const ordina = this.repo.casaCheOrdina(conversazioneId);
    if (ordina !== undefined && ordina !== remoteKey) {
      return false;
    }

    // I nomi che la casa che ordina dichiara suoi, nel gruppo: sono i soli
    // per cui può valere un follow, perché sono i soli di cui risponde lei.
    const suoi = composizione.membri
      .filter((m) => mittenteDiCasa(m.chi, remoteKey))
      .map((m) => m.chi.slice(0, m.chi.lastIndexOf("@")));

    const membri: { userId: string; ruolo: RuoloGruppo; joinedAt: string }[] = [];
    const nuoviDiQui: string[] = [];
    const visti = new Set<string>();
    for (const m of composizione.membri) {
      const userId = this.#idDi(m.chi);
      // Uno di qui che qui non esiste non entra: un nome inventato non diventa
      // un membro perché un'altra casa lo ha scritto.
      if (userId === undefined || visti.has(userId)) {
        continue;
      }

      const diQui = !userId.startsWith("remote:");
      const cEra = ordina !== undefined && this.repo.isMember(conversazioneId, userId);
      if (diQui && !cEra) {
        if (!this.#raggiungibileDa(remoteKey, suoi, userId)) {
          continue;
        }
        nuoviDiQui.push(userId);
      }

      visti.add(userId);
      membri.push({ joinedAt: m.dal, ruolo: m.ruolo, userId });
    }

    if (membri.length > MAX_FOGLIE_GRUPPO) {
      return false;
    }

    const rimossi: { userId: string; rimossoIl: string; da: string }[] = [];
    for (const r of composizione.rimossi) {
      const userId = this.#idDi(r.chi);
      if (userId !== undefined && !visti.has(userId)) {
        visti.add(userId);
        rimossi.push({ da: this.#idDi(r.da) ?? r.da, rimossoIl: r.il, userId });
      }
    }

    if (ordina === undefined) {
      // Le stesse quote dell'annuncio: una conversazione che nasce qui per
      // volere di un'altra casa è una riga che lei fa scrivere a noi.
      const dal = new Date(Date.parse(this.now()) - QUOTE.finestraMs).toISOString();
      if (
        nuoviDiQui.length === 0 ||
        this.repo.contaNateDa(remoteKey, dal) >= QUOTE.annunciPerCasa ||
        nuoviDiQui.some(
          (id) => this.repo.contaNateDa(remoteKey, dal, id) >= QUOTE.annunciPerPersona,
        )
      ) {
        return false;
      }

      this.repo.createConversazione({
        casaCheOrdina: remoteKey,
        createdAt: this.now(),
        id: conversazioneId,
        membri: [],
        tipo: composizione.tipo,
      });
    }

    // Una versione che non avanza non è un errore: è una spinta arrivata
    // tardi, o due volte. Chi l'ha mandata non deve riprovare.
    this.repo.sostituisciComposizione(conversazioneId, {
      membri,
      nome: composizione.nome,
      rimossi,
      tipo: composizione.tipo,
      versione: composizione.versione,
    });

    return true;
  }

  /**
   * Un cambio chiesto da un'altra casa a nome di un suo membro (`membri`).
   *
   * `K` è la chiave della connessione, e `da` dev'essere un membro **di quella
   * casa**: una casa parla per i suoi e per nessun altro. Che cosa quel membro
   * possa fare lo decide il suo ruolo, guardato qui.
   */
  cambiaMembriRemoto(richiesta: {
    conversazioneId: string;
    remoteKey: string;
    da: string;
    cambio: CambioMembri;
  }): { composizione: Composizione } | { negato: MotivoDiRifiuto } | "rifiutato" {
    const attore = `remote:${richiesta.remoteKey}:${richiesta.da}`;
    if (
      !this.#ordinaQui(richiesta.conversazioneId) ||
      !this.repo.isMember(richiesta.conversazioneId, attore)
    ) {
      return "rifiutato";
    }

    const { cambio } = richiesta;
    let interno: Cambio;
    if (cambio.azione === "esci") {
      interno = { azione: "esci" };
    } else {
      const bersaglio = this.#idDi(cambio.chi);
      // Chi non esiste e chi non si può raggiungere danno **la stessa
      // risposta**: un'altra casa non impara da qui chi abita qua (ADR 0020
      // §1). E aggiungere qualcuno di questa casa è scrivergli: vale ADR 0030.
      if (
        bersaglio === undefined ||
        (cambio.azione === "aggiungi" &&
          !bersaglio.startsWith("remote:") &&
          !this.#raggiungibileDa(richiesta.remoteKey, [richiesta.da], bersaglio))
      ) {
        return { negato: "user_not_found" };
      }

      interno =
        cambio.azione === "nomina"
          ? { azione: "nomina", bersaglio, ruolo: cambio.ruolo }
          : { azione: cambio.azione, bersaglio };
    }

    try {
      this.#cambia(richiesta.conversazioneId, attore, interno);
    } catch (causa) {
      if (causa instanceof DomainError && eMotivoDiRifiuto(causa.code)) {
        return { negato: causa.code };
      }
      throw causa;
    }

    const composizione = this.#composizione(richiesta.conversazioneId);
    if (composizione === undefined) {
      return "rifiutato";
    }

    void this.#annunciaComposizione(richiesta.conversazioneId).catch(() => undefined);
    return { composizione };
  }

  /**
   * Richiede la composizione a chi ordina, se non è questa casa.
   *
   * Non più di una volta al minuto per conversazione: i cambi arrivano già con
   * la spinta, e questa domanda serve a chi la spinta l'ha persa.
   */
  async #aggiornaComposizione(conversazioneId: string): Promise<void> {
    const rete = this.rete;
    const altrove = this.#casaCheOrdinaAltrove(conversazioneId);
    if (rete === undefined || altrove === undefined) {
      return;
    }

    // Una conversazione fra due persone non cambia chi c'è: non c'è niente da
    // chiedere, e una domanda in meno a ogni lettura verso l'altra casa.
    if (this.repo.getConversazioneById(conversazioneId)?.tipo !== "gruppo") {
      return;
    }

    const adesso = Date.parse(this.now());
    const ultima = this.#ultimeComposizioni.get(conversazioneId);
    if (ultima !== undefined && adesso - ultima < COMPOSIZIONE_MINIMA_MS) {
      return;
    }
    this.#ultimeComposizioni.set(conversazioneId, adesso);

    const esito = await rete.composizione(altrove, conversazioneId).catch(() => undefined);
    if (esito?.esito === "composizione") {
      this.riceviComposizione(conversazioneId, altrove, esito.composizione);
    }
  }

  /**
   * Il `GroupInfo` da cui si rientra ([ADR 0038](../../../../docs/adr/0038-mls-si-adotta-e-si-comincia-dal-web.md)).
   *
   * Chi lo chiede **non e' ancora nel gruppo MLS** — e' esattamente il punto:
   * ha perso il telefono e sta rientrando. Il diritto di leggerlo viene quindi
   * dall'essere membro della conversazione ESTIA, non dall'essere una foglia
   * dell'albero, che e' cio' che si sta ricostruendo.
   */
  async getGroupInfo(callerId: string, conversazioneId: string): Promise<GroupInfoView> {
    this.#richiediMembro(conversazioneId, callerId);

    const altrove = await this.#statoAltrove(conversazioneId, "group-info");
    if (altrove !== undefined) {
      if (altrove === "assente") {
        throw new DomainError("nessun_punto_di_rientro", 404);
      }

      return { epoch: altrove.epoch, groupInfo: altrove.blob, updatedAt: altrove.updatedAt };
    }

    const record = this.repo.getGroupInfo(conversazioneId);
    if (!record) {
      throw new DomainError("nessun_punto_di_rientro", 404);
    }

    return { epoch: record.epoch, groupInfo: record.groupInfo, updatedAt: record.updatedAt };
  }

  /**
   * Deposita il `GroupInfo` dell'epoch corrente. Lo fa un membro dopo un commit,
   * e l'istanza non guarda dentro al blob: controlla solo che non faccia
   * **tornare indietro** l'epoch, perche' un `GroupInfo` vecchio manderebbe chi
   * rientra verso un'epoch morta.
   */
  async saveGroupInfo(
    callerId: string,
    conversazioneId: string,
    input: { groupInfo: string; epoch: number },
  ): Promise<GroupInfoView> {
    this.#richiediMembro(conversazioneId, callerId);

    const depositato = await this.#depositaStatoAltrove(conversazioneId, "group-info", {
      blob: input.groupInfo,
      epoch: input.epoch,
    });
    if (depositato !== undefined) {
      return { epoch: input.epoch, groupInfo: input.groupInfo, updatedAt: depositato };
    }

    const updatedAt = this.now();
    const accettato = this.repo.putGroupInfo({
      conversazioneId,
      epoch: input.epoch,
      groupInfo: input.groupInfo,
      updatedAt,
      updatedBy: callerId,
    });

    if (!accettato) {
      throw new DomainError("conflict", 409);
    }

    return { epoch: input.epoch, groupInfo: input.groupInfo, updatedAt };
  }

  /**
   * Il mazzo delle chiavi d'archivio ([ADR 0037](../../../../docs/adr/0037-la-cronologia-e-un-archivio-non-una-chiave.md)).
   *
   * L'istanza lo conserva avvolto e non sa aprirlo: la chiave che lo apre si
   * deriva dall'epoch del gruppo, e quella l'istanza non ce l'ha.
   */
  async getMazzoArchivio(callerId: string, conversazioneId: string): Promise<MazzoArchivioView> {
    this.#richiediMembro(conversazioneId, callerId);

    const altrove = await this.#statoAltrove(conversazioneId, "mazzo");
    if (altrove !== undefined) {
      if (altrove === "assente") {
        throw new DomainError("nessun_archivio", 404);
      }

      return { epoch: altrove.epoch, mazzo: altrove.blob, updatedAt: altrove.updatedAt };
    }

    const record = this.repo.getMazzoArchivio(conversazioneId);
    if (!record) {
      throw new DomainError("nessun_archivio", 404);
    }

    return { epoch: record.epoch, mazzo: record.mazzo, updatedAt: record.updatedAt };
  }

  /** Riavvolge il mazzo sotto l'epoch corrente. L'epoch non torna indietro. */
  async saveMazzoArchivio(
    callerId: string,
    conversazioneId: string,
    input: { mazzo: string; epoch: number },
  ): Promise<MazzoArchivioView> {
    this.#richiediMembro(conversazioneId, callerId);

    const depositato = await this.#depositaStatoAltrove(conversazioneId, "mazzo", {
      blob: input.mazzo,
      epoch: input.epoch,
    });
    if (depositato !== undefined) {
      return { epoch: input.epoch, mazzo: input.mazzo, updatedAt: depositato };
    }

    const updatedAt = this.now();
    const accettato = this.repo.putMazzoArchivio({
      conversazioneId,
      epoch: input.epoch,
      mazzo: input.mazzo,
      updatedAt,
      updatedBy: callerId,
    });

    if (!accettato) {
      throw new DomainError("conflict", 409);
    }

    return { epoch: input.epoch, mazzo: input.mazzo, updatedAt };
  }

  /**
   * ADR 0043: deposita per l'account locale autenticato, mai per un autore
   * scelto dal client. Un retry identico dello stesso autore non duplica;
   * id contesi o payload diversi sono un conflitto sull'intero deposito.
   */
  depositaArchivio(
    callerId: string,
    conversazioneId: string,
    voci: readonly VoceArchivioInput[],
  ): { scritte: number } {
    this.#richiediMembro(conversazioneId, callerId);

    if (!this.users.findById(callerId)) {
      throw new DomainError("forbidden", 403);
    }

    // La stessa forma che le altre case pretendono da un segnaposto
    // ([`forma.ts`](forma.ts)): una voce che qui entrasse con un id o una data
    // che là non passano non arriverebbe mai a nessuno, in silenzio.
    if (!voci.every((v) => idDiVoce(v.id) && istanteValido(v.createdAt))) {
      throw new DomainError("invalid_request", 400);
    }

    const scritte = this.repo.insertVociArchivio(conversazioneId, callerId, voci);
    if (scritte === undefined) {
      throw new DomainError("conflict", 409);
    }

    // La voce resta qui, e alle altre case va solo il segno che esiste
    // (ADR 0043 §3). Senza attendere: la spinta serve a non aspettare, e se
    // non arriva la recupera la prossima richiesta (ADR 0042 §4.1).
    if (scritte > 0) {
      void this.#spingi(
        conversazioneId,
        voci.map((v) => v.id),
      ).catch(() => undefined);
    }

    return { scritte };
  }

  /** Spinge alle altre case i segnaposto delle voci appena depositate. */
  async #spingi(conversazioneId: string, ids: readonly string[]): Promise<void> {
    const rete = this.rete;
    if (rete === undefined) {
      return;
    }

    const custoditi = this.repo.segnapostiCustoditiPerId(conversazioneId, ids);
    if (custoditi.length === 0) {
      return;
    }

    await this.#spingiA(
      conversazioneId,
      custoditi[0]!.autore,
      custoditi.map((v) => ({
        id: v.id,
        inviatoIl: v.createdAt,
        mittente: `${v.autore}@${rete.casa}`,
        seq: v.seq,
      })),
    );
  }

  async #spingiA(conversazioneId: string, da: string, voci: SegnapostoInput[]): Promise<void> {
    const rete = this.rete;
    if (rete === undefined) {
      return;
    }

    const membri = this.repo.getMembers(conversazioneId);
    for (const casa of this.repo.caseDellaConversazione(conversazioneId)) {
      const destinatari = membri
        .map((m) => m.id)
        .filter((id) => id.startsWith(`remote:${casa}:`))
        .map((id) => id.slice(`remote:${casa}:`.length));

      await rete
        .spingiSegnaposti(casa, {
          conversazioneId,
          da,
          destinatari,
          ordina: this.#ordinaQui(conversazioneId),
          voci,
        })
        .catch(() => undefined);
    }
  }

  /**
   * Annuncia alle altre case una conversazione nata qui (ADR 0042 §4.1).
   *
   * È una spinta senza segnaposto: dice «questa conversazione esiste, la
   * ordino io, e dentro ci sono dei tuoi». Senza, la casa di chi viene invitato
   * non saprebbe che c'è una coda da cui prendere il proprio Welcome.
   */
  async annunciaConversazione(callerId: string, conversazioneId: string): Promise<void> {
    this.#richiediMembro(conversazioneId, callerId);

    const autore = this.users.findById(callerId);
    if (autore === undefined) {
      return;
    }

    await this.#spingiA(conversazioneId, autore.username, []);
  }

  /**
   * I segnaposto che questa casa custodisce, per una casa che partecipa
   * (`segnaposto-da`, ADR 0042 §4.1).
   *
   * La risposta **dichiara la finestra** che copre: `da` è il primo progressivo
   * dopo il cursore, `a` l'ultimo che la risposta vale a confermare. Dentro,
   * ciò che non è elencato non esiste — ed è la regola per cui un ritirato non
   * torna.
   *
   * Non serve ordinare la conversazione: ogni casa custodisce la sua parte.
   * Serve partecipare (§2).
   */
  segnapostiPerCasa(
    conversazioneId: string,
    remoteKey: string,
    dopo: number,
  ): FinestraSegnaposti | "rifiutato" {
    const rete = this.rete;
    if (rete === undefined || !this.repo.haMembroDiCasa(conversazioneId, remoteKey)) {
      return "rifiutato";
    }

    const limite = SEGNAPOSTI_PER_PAGINA;
    const pagina = this.repo.listSegnapostiCustoditi(conversazioneId, dopo, limite);
    const ultima = pagina.voci.at(-1);
    const piena = pagina.voci.length === limite && ultima !== undefined;

    return {
      a: piena ? ultima.seq : Math.max(pagina.ultimoSeq, dopo),
      da: dopo + 1,
      voci: pagina.voci.map((v) => ({
        id: v.id,
        inviatoIl: v.createdAt,
        mittente: `${v.autore}@${rete.casa}`,
        seq: v.seq,
      })),
      ...(piena ? { prossimo: String(ultima.seq) } : {}),
    };
  }

  /**
   * La spinta di un'altra casa (`segnaposto`).
   *
   * Se la conversazione qui non esiste **e chi spinge è chi l'ha creata**, si
   * crea, con la casa che ordina scritta: è l'annuncio. Una casa può dire di
   * ordinare solo una conversazione che ha fatto nascere lei, quindi una
   * menzogna qui tocca soltanto le sue conversazioni.
   *
   * **Ogni rifiuto è lo stesso `false`**: un nome che qui non esiste, una
   * persona che esiste e non si può raggiungere da quella casa, una quota
   * finita. Distinguerli direbbe a un'altra casa chi abita qua, un nome per
   * volta ([ADR 0020](../../../../docs/adr/0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md) §1).
   */
  riceviSegnapostiSpinti(spinta: {
    conversazioneId: string;
    remoteKey: string;
    da: string;
    destinatari: readonly string[];
    voci: readonly SegnapostoInput[];
    /** `false` quando chi spinge dichiara di **non** ordinare la conversazione. */
    ordina?: boolean | undefined;
  }): boolean {
    if (!spinta.voci.every((v) => mittenteDiCasa(v.mittente, spinta.remoteKey))) {
      return false;
    }

    if (this.repo.casaCheOrdina(spinta.conversazioneId) === undefined) {
      // Chi non ordina non fa nascere niente: la conversazione arriverà da chi
      // ordina, con la sua composizione, e questi segnaposto si recuperano
      // dopo con `segnaposto-da`.
      if (spinta.ordina === false || !this.#creaDaAnnuncio(spinta)) {
        return false;
      }
    } else if (!this.repo.haMembroDiCasa(spinta.conversazioneId, spinta.remoteKey)) {
      return false;
    }

    return this.repo.inserisciSegnapostiSpinti(
      spinta.conversazioneId,
      spinta.remoteKey,
      spinta.voci,
      this.now(),
    );
  }

  #creaDaAnnuncio(spinta: {
    conversazioneId: string;
    remoteKey: string;
    da: string;
    destinatari: readonly string[];
  }): boolean {
    // Fino al 2026-11-27 bastava che i nomi esistessero: una casa mai vista
    // faceva nascere qui una conversazione con chiunque, e la risposta le
    // diceva quali nomi c'erano. Ora la domanda è quella di ADR 0030 — questa
    // persona, da quella casa, si può raggiungere? — e la fa una porta sola.
    const regola = this.#chiPuoScrivere;
    if (regola === undefined || !nomeValido(spinta.da) || spinta.destinatari.length === 0) {
      return false;
    }

    const locali: { id: string; username: string }[] = [];
    for (const nome of new Set(spinta.destinatari)) {
      const persona = this.users.findByUsername(nome);
      if (persona === undefined || !regola.puoAprire(spinta.remoteKey, spinta.da, persona)) {
        return false;
      }
      locali.push({ id: persona.id, username: persona.username });
    }

    const dal = new Date(Date.parse(this.now()) - QUOTE.finestraMs).toISOString();
    if (
      this.repo.contaNateDa(spinta.remoteKey, dal) >= QUOTE.annunciPerCasa ||
      locali.some(
        (p) => this.repo.contaNateDa(spinta.remoteKey, dal, p.id) >= QUOTE.annunciPerPersona,
      )
    ) {
      return false;
    }

    const membri = [...locali.map((u) => u.id), `remote:${spinta.remoteKey}:${spinta.da}`];

    this.repo.createConversazione({
      casaCheOrdina: spinta.remoteKey,
      createdAt: this.now(),
      id: spinta.conversazioneId,
      membri,
      tipo: membri.length > 2 ? "gruppo" : "diretta",
    });

    return true;
  }

  /**
   * Chiede i segnaposto a ogni altra casa della conversazione, e applica le
   * finestre (ADR 0042 §4.1).
   *
   * Dal cursore, di norma. **Da zero** quando l'ultima riconciliazione è più
   * vecchia di cinque minuti, o non c'è mai stata: è ciò che fa sparire un
   * ritirato che sta sotto il cursore — il tetto di cinque minuti della
   * decisione 8 — e che riporta alla verità una casa ripristinata da un backup.
   *
   * Ritorna le case che non hanno risposto: i loro segnaposto restano, e il
   * contenuto tornerà quando torneranno loro.
   */
  async sincronizzaSegnaposti(conversazioneId: string): Promise<{ irraggiungibili: string[] }> {
    const rete = this.rete;
    const irraggiungibili: string[] = [];
    if (rete === undefined) {
      return { irraggiungibili };
    }

    const adesso = Date.parse(this.now());

    for (const casa of this.repo.caseDellaConversazione(conversazioneId)) {
      const cursore = this.repo.cursoreSegnaposti(conversazioneId, casa);
      const daZero =
        cursore?.riconciliatoIl == null ||
        adesso - Date.parse(cursore.riconciliatoIl) > RICONCILIAZIONE_MS;

      // Non più di una domanda ogni dieci secondi per casa e conversazione, se
      // non tocca una riconciliazione: le novità arrivano già con la spinta, e
      // più schede aperte sulla stessa chat non devono moltiplicare le domande
      // verso l'altra casa fino a far scattare il suo limite di frequenza.
      const chiave = `${conversazioneId}/${casa}`;
      const ultima = this.#ultimeRichieste.get(chiave);
      if (!daZero && ultima !== undefined && adesso - ultima < RICHIESTA_MINIMA_MS) {
        continue;
      }
      this.#ultimeRichieste.set(chiave, adesso);

      let dopo = daZero ? 0 : cursore.cursore;

      for (;;) {
        const esito = await rete.segnapostiDa(casa, conversazioneId, dopo);

        if (esito.esito === "irraggiungibile") {
          irraggiungibili.push(casa);
          break;
        }

        if (esito.esito === "rifiutato" || !finestraCoerente(esito, casa, dopo)) {
          break;
        }

        if (
          !this.repo.applicaFinestraSegnaposti(
            conversazioneId,
            casa,
            { a: esito.a, da: esito.da, voci: esito.voci },
            this.now(),
          )
        ) {
          break;
        }

        if (esito.prossimo === undefined) {
          break;
        }
        dopo = Number(esito.prossimo);
      }
    }

    return { irraggiungibili };
  }

  /**
   * Le voci custodite qui, per una casa che partecipa (`archivio`, ADR 0043 §2).
   *
   * **Ogni visita verifica l'autorizzazione di adesso**: un id noto non è un
   * permesso. Si servono solo le voci degli autori di questa casa — il
   * pregresso senza autore attestato non esce di qui — e quelle che non ci sono
   * si dicono, perché chi riceve cancelli il segnaposto.
   */
  vociPerCasa(
    conversazioneId: string,
    remoteKey: string,
    ids: readonly string[],
  ):
    | {
        voci: { id: string; chiaveN: number; busta: string; createdAt: string }[];
        assenti: string[];
      }
    | "rifiutato" {
    if (!this.repo.haMembroDiCasa(conversazioneId, remoteKey)) {
      return "rifiutato";
    }

    const trovate = this.repo.vociArchivioPerId(conversazioneId, ids, true);
    const presenti = new Set(trovate.map((v) => v.id));

    return {
      assenti: ids.filter((id) => !presenti.has(id)),
      voci: trovate.map((v) => ({
        busta: v.busta,
        chiaveN: v.chiaveN,
        createdAt: v.createdAt,
        id: v.id,
      })),
    };
  }

  /**
   * Il ritiro (ADR 0043 §2): l'autore toglie la propria voce dalla propria
   * casa, e **non ne esiste un'altra copia su nessun server**. Le altre case
   * cancellano il segnaposto alla prossima visita o riconciliazione, entro i
   * cinque minuti della decisione 8.
   */
  ritiraVoce(callerId: string, conversazioneId: string, voceId: string): void {
    this.#richiediMembro(conversazioneId, callerId);

    if (!this.repo.ritiraVoce(conversazioneId, callerId, voceId)) {
      throw new DomainError("messaggio_inesistente", 404);
    }
  }

  /**
   * La cronologia di una conversazione, ricomposta dalle custodie (ADR 0043
   * §2): le voci di chi abita qui, e i segnaposto di chi abita altrove con il
   * contenuto visitato alla casa dell'autore.
   *
   * A pagine dalla più recente, perché la visita costa una domanda per casa: si
   * chiede solo il contenuto delle righe che la pagina mostra. Una casa che non
   * risponde non ferma la pagina — le sue righe restano, con mittente e orario,
   * e `non-disponibile`.
   */
  async cronologia(
    callerId: string,
    conversazioneId: string,
    options: { prima?: string | undefined; limite?: number | undefined } = {},
  ): Promise<CronologiaPage> {
    this.#richiediMembro(conversazioneId, callerId);
    // Chi è stato tolto mentre la sua casa non ascoltava lo scopre qui, prima
    // che gli si serva una riga: è il criterio 3 di M8 anche fra case.
    await this.#aggiornaComposizione(conversazioneId);
    this.#richiediMembro(conversazioneId, callerId);

    const { irraggiungibili } = await this.sincronizzaSegnaposti(conversazioneId);
    const casaMia = this.rete?.casa ?? "";

    type Riga = { id: string; createdAt: string; mittente: string | null; casa: string };
    const tutte: Riga[] = [
      ...this.repo.indiceVociArchivio(conversazioneId).map((v) => ({
        casa: casaMia,
        createdAt: v.createdAt,
        id: v.id,
        mittente: v.autore === null ? null : `${v.autore}@${casaMia}`,
      })),
      ...this.repo.listSegnaposti(conversazioneId).map((s) => ({
        casa: s.casaCustode,
        createdAt: s.inviatoIl,
        id: s.id,
        mittente: s.mittente,
      })),
    ].sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    );

    const limite = Math.min(options.limite ?? 50, 200);
    const prima = options.prima === undefined ? undefined : decodificaCursore(options.prima);
    const precedenti =
      prima === undefined
        ? tutte
        : tutte.filter(
            (r) =>
              r.createdAt < prima.createdAt || (r.createdAt === prima.createdAt && r.id < prima.id),
          );
    const pagina = precedenti.slice(-limite);
    const altre = precedenti.length > pagina.length;

    // Il contenuto: le voci di qui dal database, quelle di fuori dalla visita.
    const contenuti = new Map<string, { chiaveN: number; busta: string }>();
    const nonDisponibili = new Set<string>();
    const nonRispondono = new Set(irraggiungibili);

    const qui = pagina.filter((r) => r.casa === casaMia).map((r) => r.id);
    for (const v of this.repo.vociArchivioPerId(conversazioneId, qui, false)) {
      contenuti.set(`${casaMia}/${v.id}`, { busta: v.busta, chiaveN: v.chiaveN });
    }

    const perCasa = new Map<string, string[]>();
    for (const r of pagina) {
      if (r.casa !== casaMia) {
        perCasa.set(r.casa, [...(perCasa.get(r.casa) ?? []), r.id]);
      }
    }

    const ritirate = new Set<string>();
    for (const [casa, ids] of perCasa) {
      if (nonRispondono.has(casa) || this.rete === undefined) {
        ids.forEach((id) => nonDisponibili.add(`${casa}/${id}`));
        continue;
      }

      for (let i = 0; i < ids.length; i += VOCI_PER_VISITA) {
        const lotto = ids.slice(i, i + VOCI_PER_VISITA);
        const esito = await this.rete.visitaArchivio(casa, conversazioneId, lotto);

        if (esito.esito !== "voci") {
          if (esito.esito === "irraggiungibile") {
            nonRispondono.add(casa);
          }
          lotto.forEach((id) => nonDisponibili.add(`${casa}/${id}`));
          continue;
        }

        for (const v of esito.voci) {
          contenuti.set(`${casa}/${v.id}`, { busta: v.busta, chiaveN: v.chiaveN });
        }

        // Quello che la casa custode non ha più, qui non resta: è il ritiro
        // che arriva alla prima lettura, senza aspettare la riconciliazione.
        for (const id of esito.assenti) {
          this.repo.cancellaSegnaposto(conversazioneId, casa, id);
          ritirate.add(`${casa}/${id}`);
        }
      }
    }

    const righe: RigaCronologiaView[] = [];
    for (const r of pagina) {
      const chiave = `${r.casa}/${r.id}`;
      if (ritirate.has(chiave)) {
        continue;
      }

      const voce = contenuti.get(chiave);
      righe.push({
        casa: r.casa,
        createdAt: r.createdAt,
        id: r.id,
        mittente: r.mittente,
        stato: voce === undefined || nonDisponibili.has(chiave) ? "non-disponibile" : "disponibile",
        ...(voce === undefined ? {} : { voce }),
      });
    }

    const piuVecchia = pagina[0];
    return {
      nonRispondono: [...nonRispondono],
      righe,
      ...(altre && piuVecchia !== undefined
        ? { prima: codificaCursore(piuVecchia.createdAt, piuVecchia.id) }
        : {}),
    };
  }

  /**
   * Questa casa è in una conversazione di qui **per un gesto di qualcuno di
   * qui**? Solo per i limiti di frequenza, e mai per un annuncio suo soltanto.
   */
  casaPartecipa(remoteKey: string): boolean {
    return this.repo.casaPartecipa(remoteKey);
  }

  /** I segnaposto di una conversazione, per un membro di questa casa. */
  segnaposti(callerId: string, conversazioneId: string): SegnapostoRecord[] {
    this.#richiediMembro(conversazioneId, callerId);

    return this.repo.listSegnaposti(conversazioneId);
  }

  /**
   * L'archivio, dalla voce piu' vecchia. E' cosi' che un dispositivo nuovo
   * ricostruisce la cronologia dopo essere rientrato: il trasporto non gliela
   * puo' dare, perche' quelle chiavi non esistono piu'.
   */
  listArchivio(
    callerId: string,
    conversazioneId: string,
    options: { limit?: number | undefined; dopo?: string | undefined } = {},
  ): ArchivioPage {
    this.#richiediMembro(conversazioneId, callerId);

    const limit = Math.min(options.limit ?? 100, 200);
    const voci = this.repo.listVociArchivio(conversazioneId, {
      limit: limit + 1,
      ...(options.dopo !== undefined ? { dopo: options.dopo } : {}),
    });

    const pagina = voci.slice(0, limit);
    const ultima = pagina.at(-1);

    return {
      voci: pagina,
      ...(voci.length > limit && ultima !== undefined
        ? { prossimo: codificaCursore(ultima.createdAt, ultima.id) }
        : {}),
    };
  }

  /**
   * Deposita un handshake MLS ([ADR 0038](../../../../docs/adr/0038-mls-si-adotta-e-si-comincia-dal-web.md)).
   *
   * Un **commit** va a tutti i membri; un **Welcome** solo a chi viene aggiunto,
   * che non e' ancora nel gruppo crittografico e quindi non potrebbe decifrare
   * niente che passi dal canale dei membri.
   */
  async depositaHandshake(
    callerId: string,
    conversazioneId: string,
    input: DepositaHandshakeRequest,
  ): Promise<{ id: string }> {
    this.#richiediMembro(conversazioneId, callerId);

    if (input.tipo === "welcome" && input.destinatario === undefined) {
      throw new DomainError("invalid_request", 400);
    }

    // Un commit e' per tutti: un destinatario lo renderebbe invisibile agli altri,
    // che e' il modo silenzioso di spaccare un gruppo.
    if (input.tipo === "commit" && input.destinatario !== undefined) {
      throw new DomainError("invalid_request", 400);
    }

    // Un Welcome è per qualcuno che nella conversazione c'è: per l'istanza è
    // una riga che resta in fila, e un destinatario qualunque sarebbe un posto
    // dove scrivere senza che nessuno la legga mai.
    if (
      input.destinatario !== undefined &&
      !this.repo.isMember(conversazioneId, input.destinatario)
    ) {
      throw new DomainError("invalid_request", 400);
    }

    const id = randomUUID();
    const createdAt = this.now();
    const altrove = this.#casaCheOrdinaAltrove(conversazioneId);

    // La coda sta dove la conversazione è nata (ADR 0042 §3). Se è un'altra
    // casa, il commit si deposita **là**: una copia qui sarebbe la seconda coda
    // che quell'ADR esiste per non avere.
    if (altrove !== undefined) {
      // Chi entra viaggia **per indirizzo**, `username@casa`: l'id con cui
      // questa casa lo nomina, là non vuol dire niente — e un Welcome
      // depositato con un nome che nessuno riconosce non arriva a nessuno.
      const perChi =
        input.destinatario === undefined
          ? undefined
          : (this.#indirizzoDi(input.destinatario) ?? input.destinatario);
      const esito = await this.#rete().deposita(altrove, conversazioneId, {
        busta: input.busta,
        createdAt,
        epoch: input.epoch,
        id,
        tipo: input.tipo,
        ...(perChi !== undefined ? { destinatario: perChi } : {}),
      });

      if (esito.esito === "irraggiungibile") {
        throw casaCheOrdinaSpenta();
      }

      if (esito.esito === "indietro") {
        throw commitSuperato();
      }

      if (esito.esito === "rifiutato") {
        throw new DomainError("forbidden", 403);
      }

      return { id };
    }

    if (
      input.destinatario !== undefined &&
      this.#troppiWelcome(conversazioneId, input.destinatario)
    ) {
      throw new DomainError("troppe_richieste", 429);
    }

    const accettato = this.repo.insertHandshake({
      busta: input.busta,
      conversazioneId,
      createdAt,
      epoch: input.epoch,
      id,
      tipo: input.tipo,
      ...(input.destinatario !== undefined ? { destinatario: input.destinatario } : {}),
    });

    if (!accettato) {
      throw commitSuperato();
    }

    // Un Welcome per qualcuno di un'altra casa: quella casa deve sapere che la
    // conversazione esiste, o il suo membro non saprebbe dove cercarlo. È
    // l'annuncio di §4.1, e parte dalla casa che ordina — l'unica che può
    // dichiarare di ordinare.
    const invitato = input.tipo === "welcome" ? input.destinatario : undefined;
    if (invitato?.startsWith("remote:") === true) {
      this.#annunciaA(conversazioneId, callerId);
    }

    return { id };
  }

  /** Gli handshake che spettano a chi chiede, dal piu' vecchio. */
  async listHandshake(
    callerId: string,
    conversazioneId: string,
    options: { limit?: number | undefined; dopo?: string | undefined } = {},
  ): Promise<HandshakePage> {
    this.#richiediMembro(conversazioneId, callerId);

    const altrove = this.#casaCheOrdinaAltrove(conversazioneId);

    // Tutti leggono la coda **da chi ordina**: è l'unico modo perché l'ordine
    // sia lo stesso per tutti, che è la ragione di ADR 0042 §3.
    if (altrove !== undefined) {
      const esito = await this.#rete().coda(
        altrove,
        conversazioneId,
        ...(options.dopo === undefined ? [] : [options.dopo]),
      );

      if (esito.esito === "irraggiungibile") {
        throw casaCheOrdinaSpenta();
      }

      if (esito.esito === "rifiutato") {
        throw new DomainError("forbidden", 403);
      }

      return {
        handshake: esito.handshake,
        ...(esito.prossimo === undefined ? {} : { prossimo: esito.prossimo }),
      };
    }

    const limit = Math.min(options.limit ?? 100, 200);
    const righe = this.repo.listHandshakePer(conversazioneId, callerId, {
      limit: limit + 1,
      ...(options.dopo !== undefined ? { dopo: options.dopo } : {}),
    });

    const pagina = righe.slice(0, limit);
    const ultima = pagina.at(-1);

    return {
      handshake: pagina.map(({ seq: _seq, ...vista }) => vista),
      ...(righe.length > limit && ultima !== undefined ? { prossimo: String(ultima.seq) } : {}),
    };
  }

  /**
   * La casa che ordina, quando non è questa. `undefined` vuol dire «sono io».
   */
  #casaCheOrdinaAltrove(conversazioneId: string): string | undefined {
    const casa = this.repo.casaCheOrdina(conversazioneId);
    if (casa === null || casa === undefined) {
      return undefined;
    }

    return this.rete !== undefined && casa === this.rete.casa ? undefined : casa;
  }

  /**
   * Lo stato presso chi ordina, quando non è questa casa.
   *
   * `undefined` vuol dire «ordino io, guarda qui»; `"assente"` che chi ordina
   * ha risposto e non ce l'ha ancora. Niente di quello che torna si scrive:
   * le altre case li chiedono e non li conservano (decisione 5).
   */
  async #statoAltrove(
    conversazioneId: string,
    tipo: "group-info" | "mazzo",
  ): Promise<{ blob: string; epoch: number; updatedAt: string } | "assente" | undefined> {
    const altrove = this.#casaCheOrdinaAltrove(conversazioneId);
    if (altrove === undefined) {
      return undefined;
    }

    const esito = await this.#rete().leggiStato(altrove, conversazioneId, tipo);

    if (esito.esito === "irraggiungibile") {
      throw casaCheOrdinaSpenta();
    }

    if (esito.esito === "rifiutato") {
      throw new DomainError("forbidden", 403);
    }

    return esito.esito === "assente"
      ? "assente"
      : { blob: esito.blob, epoch: esito.epoch, updatedAt: esito.updatedAt };
  }

  /** Il deposito presso chi ordina. Ritorna l'orario, o `undefined` se ordino io. */
  async #depositaStatoAltrove(
    conversazioneId: string,
    tipo: "group-info" | "mazzo",
    stato: { blob: string; epoch: number },
  ): Promise<string | undefined> {
    const altrove = this.#casaCheOrdinaAltrove(conversazioneId);
    if (altrove === undefined) {
      return undefined;
    }

    const esito = await this.#rete().depositaStato(altrove, conversazioneId, tipo, stato);

    if (esito.esito === "irraggiungibile") {
      throw casaCheOrdinaSpenta();
    }

    if (esito.esito === "indietro") {
      throw new DomainError("conflict", 409);
    }

    if (esito.esito === "rifiutato") {
      throw new DomainError("forbidden", 403);
    }

    return esito.updatedAt;
  }

  /**
   * `GroupInfo` o mazzo per una casa che partecipa (ADR 0042 §2 e §4).
   *
   * Le stesse due porte della coda: questa casa deve ordinare la conversazione,
   * e chi chiede deve avere dentro un membro.
   */
  statoRemoto(
    conversazioneId: string,
    remoteKey: string,
    tipo: "group-info" | "mazzo",
  ): { blob: string; epoch: number; updatedAt: string } | "rifiutato" | undefined {
    if (
      !this.#ordinaQui(conversazioneId) ||
      !this.repo.haMembroDiCasa(conversazioneId, remoteKey)
    ) {
      return "rifiutato";
    }

    if (tipo === "group-info") {
      const record = this.repo.getGroupInfo(conversazioneId);
      return record === undefined
        ? undefined
        : { blob: record.groupInfo, epoch: record.epoch, updatedAt: record.updatedAt };
    }

    const record = this.repo.getMazzoArchivio(conversazioneId);
    return record === undefined
      ? undefined
      : { blob: record.mazzo, epoch: record.epoch, updatedAt: record.updatedAt };
  }

  /**
   * Il deposito da un'altra casa. `updatedBy` è la **casa**, non una persona:
   * è l'unica cosa che la connessione autentica, e scrivere un nome di membro
   * vorrebbe dire credere a un campo del messaggio (ADR 0021 §1).
   */
  depositaStatoRemoto(
    conversazioneId: string,
    remoteKey: string,
    tipo: "group-info" | "mazzo",
    stato: { blob: string; epoch: number },
  ): { updatedAt: string } | "rifiutato" | "indietro" {
    if (
      !this.#ordinaQui(conversazioneId) ||
      !this.repo.haMembroDiCasa(conversazioneId, remoteKey)
    ) {
      return "rifiutato";
    }

    const updatedAt = this.now();
    const record = {
      conversazioneId,
      epoch: stato.epoch,
      updatedAt,
      updatedBy: `remote:${remoteKey}`,
    };

    const accettato =
      tipo === "group-info"
        ? this.repo.putGroupInfo({ ...record, groupInfo: stato.blob })
        : this.repo.putMazzoArchivio({ ...record, mazzo: stato.blob });

    return accettato ? { updatedAt } : "indietro";
  }

  #rete(): ReteFraCase {
    if (this.rete === undefined) {
      throw new DomainError("rete_non_attiva", 503);
    }

    return this.rete;
  }

  /** Si collega dopo, come il resto della rete. */
  useRete(rete: ReteFraCase): void {
    this.rete = rete;
  }

  /** Come `useRete`: la regola di ADR 0030 nasce dopo questo servizio. */
  useChiPuoScrivere(regola: ChiPuoScrivere): void {
    this.#chiPuoScrivere = regola;
  }

  /**
   * Il deposito che arriva da un'altra casa (ADR 0042 §2).
   *
   * `K` è la chiave della connessione, **mai** un campo del messaggio: chi
   * chiama non può dichiarare di essere un'altra casa. E può depositare solo
   * se in questa conversazione c'è un membro suo.
   */
  depositaHandshakeRemoto(record: {
    conversazioneId: string;
    remoteKey: string;
    id: string;
    epoch: number;
    tipo: "commit" | "welcome";
    destinatario?: string | undefined;
    busta: string;
    createdAt: string;
  }): { id: string } | "indietro" | undefined {
    if (!this.#ordinaQui(record.conversazioneId)) {
      return undefined;
    }

    if (!this.repo.haMembroDiCasa(record.conversazioneId, record.remoteKey)) {
      return undefined;
    }

    // Un commit è per tutti, un Welcome per chi entra: la stessa regola del
    // deposito locale, perché una casa remota non è più fidata di un membro.
    if (record.tipo === "commit" && record.destinatario !== undefined) {
      return undefined;
    }

    if (record.tipo === "welcome" && record.destinatario === undefined) {
      return undefined;
    }

    // Un Welcome arriva **per indirizzo** (`username@casa`) e qui diventa
    // l'id con cui questa casa nomina quella persona — il solo con cui la
    // coda glielo consegna. Dev'essere già dentro: prima la composizione, poi
    // il Welcome, e un invito a chi non è membro non si mette in fila.
    let destinatario = record.destinatario;
    if (destinatario?.includes("@") === true) {
      destinatario = this.#idDi(destinatario);
    }

    if (record.tipo === "welcome") {
      // Per un membro, e dentro le quote: per casa, per conversazione, per
      // destinatario. Il rifiuto è lo stesso di ogni altro (§2), così chi
      // deposita non impara da qui chi c'è in una conversazione.
      if (
        destinatario === undefined ||
        !this.repo.isMember(record.conversazioneId, destinatario) ||
        this.#troppiWelcome(record.conversazioneId, destinatario) ||
        !this.#contaWelcomeDi(record.remoteKey)
      ) {
        return undefined;
      }
    }

    // L'id e l'orario li mette chi ordina. Quelli dell'altra casa sono campi
    // di un messaggio: un id già usato qui farebbe fallire la scrittura, e un
    // orario scelto da lei sposterebbe la finestra delle quote dove le pare.
    const id = randomUUID();
    const accettato = this.repo.insertHandshake({
      busta: record.busta,
      conversazioneId: record.conversazioneId,
      createdAt: this.now(),
      epoch: record.epoch,
      id,
      tipo: record.tipo,
      ...(destinatario !== undefined ? { destinatario } : {}),
    });

    if (accettato && destinatario?.startsWith("remote:") === true) {
      // Chi entra abita in una terza casa: deve saperlo da chi ordina.
      void this.#annunciaComposizione(record.conversazioneId).catch(() => undefined);
    }

    return accettato ? { id } : "indietro";
  }

  /**
   * Questa persona di qui si può raggiungere da `casa`, per uno dei nomi che
   * quella casa dichiara suoi? Senza nomi resta la strada delle case collegate.
   */
  #raggiungibileDa(casa: string, nomi: readonly string[], userId: string): boolean {
    const regola = this.#chiPuoScrivere;
    const persona = this.users.findById(userId);
    if (regola === undefined || persona === undefined) {
      return false;
    }

    const destinatario = { id: persona.id, username: persona.username };
    return (nomi.length === 0 ? [""] : nomi).some((nome) =>
      regola.puoAprire(casa, nome, destinatario),
    );
  }

  /** La fila ha già troppi Welcome, in questa conversazione o per questo destinatario? */
  #troppiWelcome(conversazioneId: string, destinatario: string): boolean {
    const dal = new Date(Date.parse(this.now()) - QUOTE.finestraMs).toISOString();

    return (
      this.repo.contaWelcome(conversazioneId, dal, destinatario) >= QUOTE.welcomePerDestinatario ||
      this.repo.contaWelcome(conversazioneId, dal) >= QUOTE.welcomePerConversazione
    );
  }

  /** Conta un Welcome di questa casa. `false` quando la sua quota del giorno è finita. */
  #contaWelcomeDi(casa: string): boolean {
    const adesso = Date.parse(this.now());
    const recenti = (this.#welcomeDiCasa.get(casa) ?? []).filter(
      (quando) => adesso - quando < QUOTE.finestraMs,
    );

    if (recenti.length >= QUOTE.welcomePerCasa) {
      this.#welcomeDiCasa.set(casa, recenti);
      return false;
    }

    recenti.push(adesso);
    this.#welcomeDiCasa.set(casa, recenti);
    return true;
  }

  /**
   * Dice alle altre case che la conversazione esiste. Un gruppo si annuncia
   * con la sua composizione intera; una conversazione diretta con l'annuncio
   * di §4.1, che per due persone dice già tutto.
   */
  #annunciaA(conversazioneId: string, callerId: string): void {
    if (this.repo.getConversazioneById(conversazioneId)?.tipo === "gruppo") {
      void this.#annunciaComposizione(conversazioneId).catch(() => undefined);
      return;
    }

    const autore = this.users.findById(callerId);
    if (autore !== undefined) {
      void this.#spingiA(conversazioneId, autore.username, []).catch(() => undefined);
    }
  }

  /**
   * La coda ordinata, per una casa che partecipa (ADR 0042 §2 e §3).
   *
   * Porta i commit e **soltanto i Welcome dei suoi membri**: una casa non è una
   * persona, e il Welcome di qualcun altro non la riguarda.
   */
  handshakeRemoti(
    conversazioneId: string,
    remoteKey: string,
    options: { limit?: number | undefined; dopo?: string | undefined } = {},
  ): { handshake: HandshakeRecord[]; prossimo?: string } | undefined {
    if (!this.#ordinaQui(conversazioneId)) {
      return undefined;
    }

    if (!this.repo.haMembroDiCasa(conversazioneId, remoteKey)) {
      return undefined;
    }

    const limit = Math.min(options.limit ?? 100, 200);
    const righe = this.repo.listHandshakePerCasa(conversazioneId, remoteKey, {
      limit: limit + 1,
      ...(options.dopo !== undefined ? { dopo: options.dopo } : {}),
    });

    const pagina = righe.slice(0, limit);
    const ultima = pagina.at(-1);

    return {
      handshake: pagina,
      ...(righe.length > limit && ultima !== undefined ? { prossimo: String(ultima.seq) } : {}),
    };
  }

  /**
   * Questa conversazione la ordino io?
   *
   * `false` anche quando la conversazione non esiste, e la risposta che ne
   * esce è la stessa: chi chiede non impara da qui se una conversazione c'è.
   */
  #ordinaQui(conversazioneId: string): boolean {
    const casa = this.repo.casaCheOrdina(conversazioneId);
    if (casa === undefined) {
      return false;
    }

    return casa === null || (this.rete !== undefined && casa === this.rete.casa);
  }

  markRead(callerId: string, conversazioneId: string, finoA: string): void {
    this.#richiediMembro(conversazioneId, callerId);
    this.repo.markRead(conversazioneId, callerId, finoA);
  }

  deleteConversazione(callerId: string, conversazioneId: string): void {
    this.#richiediMembro(conversazioneId, callerId);
    // Un gruppo non è di chi lo cancella: da un gruppo si esce, e gli altri
    // restano con quello che c'è.
    if (this.repo.getConversazioneById(conversazioneId)?.tipo === "gruppo") {
      throw new DomainError("gruppo_non_si_elimina", 400);
    }

    this.repo.deleteConversazione(conversazioneId);
  }
}
