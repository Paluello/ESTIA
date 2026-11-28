/**
 * Un gruppo, visto dalla schermata: chi c'è, chi può fare che cosa, e come si
 * dice.
 *
 * Qui non c'è React di proposito, come in [`chat-impedimento`](../chat-impedimento.ts):
 * sono funzioni da una conversazione a delle risposte, e le risposte — «questa
 * persona la puoi togliere?», «il gruppo lo crei tu?» — sono ciò che vale la
 * pena provare senza un browser.
 *
 * Le regole sono quelle del proprietario (M8): aggiungono e tolgono il creatore
 * e gli amministratori che nomina; chiunque può uscire. L'istanza le fa
 * rispettare comunque — qui servono a **non offrire** un gesto che verrebbe
 * rifiutato (euristica 5).
 */
import {
  MAX_FOGLIE_GRUPPO,
  MIN_MEMBRI_GRUPPO,
  type AuthorView,
  type ConversazioneView,
  type RuoloGruppo,
} from "@estia/contracts";

import type { Composizione, Evento } from "../../mls/conversazione.js";
import { leggiIdentita, scriviIdentita, type Confronto, type Membro } from "../../mls/gruppo.js";
import { membroDi } from "../sicurezza/membri.js";

type Gruppo = Pick<ConversazioneView, "tipo" | "membri" | "ruoli" | "rimossi" | "ordinataQui">;

export const eUnGruppo = (conv: Pick<ConversazioneView, "tipo"> | undefined): boolean =>
  conv?.tipo === "gruppo";

/** Il nome con cui si mostra una persona: quello che si è data, o il suo nome utente. */
export const nomeDi = (autore: Pick<AuthorView, "displayName" | "username">): string =>
  autore.displayName === "" ? autore.username : autore.displayName;

export const ruoloDi = (conv: Pick<ConversazioneView, "ruoli">, id: string): RuoloGruppo =>
  conv.ruoli?.[id] ?? "membro";

/**
 * Chi aggiunge e toglie: il creatore e gli amministratori. In un gruppo
 * congelato nessuno: la casa che lo ordinava è persa, e l'istanza rifiuta.
 */
export function gestisce(
  conv: Pick<ConversazioneView, "ruoli" | "congelata">,
  id: string,
): boolean {
  if (conv.congelata === true) {
    return false;
  }

  const ruolo = ruoloDi(conv, id);
  return ruolo === "creatore" || ruolo === "amministratore";
}

/**
 * Chi nomina gli amministratori: il creatore. Se il creatore è uscito, chi
 * amministra — un gruppo in cui nessuno può più nominare nessuno sarebbe un
 * vicolo cieco.
 */
export function nomina(conv: Pick<ConversazioneView, "ruoli" | "congelata">, id: string): boolean {
  if (conv.congelata === true) {
    return false;
  }

  const ruolo = ruoloDi(conv, id);
  const cEUnCreatore = Object.values(conv.ruoli ?? {}).includes("creatore");
  return ruolo === "creatore" || (!cEUnCreatore && ruolo === "amministratore");
}

/** Che cosa può fare chi guarda a una persona del gruppo. */
export function gestiSu(
  conv: Pick<ConversazioneView, "ruoli" | "congelata">,
  ioId: string,
  bersaglioId: string,
): { togliere: boolean; nominare: boolean; revocare: boolean } {
  const suo = ruoloDi(conv, bersaglioId);
  if (bersaglioId === ioId || suo === "creatore") {
    return { nominare: false, revocare: false, togliere: false };
  }

  return {
    nominare: nomina(conv, ioId) && suo === "membro",
    revocare: nomina(conv, ioId) && suo === "amministratore",
    togliere: gestisce(conv, ioId),
  };
}

/**
 * Il gruppo cifrato lo crea **una persona sola**: chi ha creato il gruppo,
 * dalla casa che lo ordina. Se due lo creassero insieme uno dei due perderebbe
 * la corsa (ADR 0042 §3). Se il creatore è uscito prima di aprirlo, tocca a
 * chi amministra.
 */
export function creaQui(conv: Gruppo, ioId: string): boolean {
  if (!eUnGruppo(conv)) {
    return conv.ordinataQui;
  }

  return conv.ordinataQui && nomina(conv, ioId);
}

/** Chi è nel gruppo per la casa, nei termini con cui lo confronta MLS. */
export function composizioneDi(conv: Gruppo, casa: string): Composizione {
  return {
    // In una conversazione a due non si toglie nessuno da soli: lì un estraneo
    // nell'albero non è qualcuno che è uscito, è qualcosa che non doveva
    // succedere — si dice, e non si scrive.
    autorevole: conv.ordinataQui && eUnGruppo(conv),
    membri: conv.membri.map((autore) => ({ id: autore.id, membro: membroDi(autore, casa) })),
    rimossi: (conv.rimossi ?? []).map(leggiIdentita).filter((m): m is Membro => m !== undefined),
  };
}

/** Come si scrive una persona da aggiungere, per l'istanza. */
export function comeInput(
  persona: { username: string; instanceKey?: string | undefined },
  casa: string,
): { username: string; casa?: string } {
  return persona.instanceKey === undefined || persona.instanceKey === casa
    ? { username: persona.username }
    : { casa: persona.instanceKey, username: persona.username };
}

/** L'id con cui una conversazione nomina una persona cercata. */
export function idAtteso(
  persona: { username: string; instanceKey?: string | undefined },
  membri: readonly AuthorView[],
  casa: string,
): string | undefined {
  const altrove = persona.instanceKey !== undefined && persona.instanceKey !== casa;
  return membri.find((m) =>
    altrove
      ? m.id === `remote:${String(persona.instanceKey)}:${persona.username}`
      : !m.id.startsWith("remote:") && m.username === persona.username,
  )?.id;
}

/** Perché non si può ancora creare il gruppo, se non si può. */
export function mancaPerCreare(
  nome: string,
  scelti: number,
): "nome" | "persone" | "troppe" | undefined {
  if (nome.trim().length === 0) {
    return "nome";
  }

  // Chi crea è già uno dei tre.
  if (scelti < MIN_MEMBRI_GRUPPO - 1) {
    return "persone";
  }

  return scelti > MAX_FOGLIE_GRUPPO - 1 ? "troppe" : undefined;
}

/** I membri che non hanno ancora una foglia: non leggono niente, finché non entrano. */
export function assentiFra(
  conv: Gruppo,
  casa: string,
  confronto: Confronto | undefined,
): Set<string> {
  const assenti = new Set((confronto?.assenti ?? []).map(scriviIdentita));
  return new Set(
    conv.membri.filter((m) => assenti.has(scriviIdentita(membroDi(m, casa)))).map((m) => m.id),
  );
}

/**
 * Il nome di chi un evento nomina: fra i membri se c'è ancora, altrimenti il
 * suo nome utente — chi è stato tolto non è più nell'elenco, ed è proprio di
 * lui che l'evento parla.
 */
export function nomeNellEvento(evento: Evento, conv: Gruppo, casa: string): string {
  return nomeDaIndirizzo(evento.chi, conv, casa);
}

/** Il nome di una persona detta per indirizzo, `username@casa`. */
export function nomeDaIndirizzo(
  indirizzo: string,
  conv: Pick<ConversazioneView, "membri">,
  casa: string,
): string {
  const trovato = conv.membri.find((m) => scriviIdentita(membroDi(m, casa)) === indirizzo);
  return trovato === undefined
    ? (leggiIdentita(indirizzo)?.username ?? indirizzo)
    : nomeDi(trovato);
}

/* ------------------------- il trasloco (ADR 0042 §3) ------------------------- */

/**
 * Che cosa c'è da dire di un gruppo riguardo al trasloco, e che cosa da
 * offrire. Tre cose possono essere vere, e la schermata le dice tutte:
 *
 * - `continua`: questo gruppo è un successore, e lo dichiara;
 * - `successori`: questo gruppo è stato traslocato — una riga per ognuno, e
 *   `mio` dice se chi guarda nel gruppo nuovo c'è;
 * - `persa`: la casa che lo gestisce tace da oltre la soglia e nessuno l'ha
 *   ancora traslocato. `puoi` è il gesto: solo allora, e solo a chi tocca.
 */
export interface StatoTrasloco {
  continua?: NonNullable<ConversazioneView["continua"]> & { apribile: boolean };
  congelato: boolean;
  successori: { id: string; da: string; il: string; mio: boolean }[];
  persa?: { dal: string; puoi: boolean };
}

export function statoTrasloco(
  conv: Pick<
    ConversazioneView,
    "continua" | "congelata" | "successori" | "casaPersaDal" | "puoTraslocare"
  >,
  /** Gli id delle conversazioni di chi guarda. */
  mie: ReadonlySet<string>,
): StatoTrasloco {
  const successori = (conv.successori ?? []).map((s) => ({ ...s, mio: mie.has(s.id) }));
  const congelato = conv.congelata === true;

  return {
    congelato,
    successori,
    ...(conv.continua === undefined
      ? {}
      : { continua: { ...conv.continua, apribile: mie.has(conv.continua.conversazioneId) } }),
    // Il gesto non si offre due volte dalla stessa casa: chi vede già un
    // successore sceglie quello. Due traslochi restano possibili da due case,
    // e allora si vedono tutti e due.
    ...(conv.casaPersaDal === undefined || congelato || successori.length > 0
      ? {}
      : { persa: { dal: conv.casaPersaDal, puoi: conv.puoTraslocare === true } }),
  };
}

/** C'è qualcosa da dire? Un gruppo qualunque non mostra niente. */
export const haUnTrasloco = (stato: StatoTrasloco): boolean =>
  stato.continua !== undefined ||
  stato.congelato ||
  stato.successori.length > 0 ||
  stato.persa !== undefined;
