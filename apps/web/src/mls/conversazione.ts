/**
 * Quello che la schermata chiede, e niente di più.
 *
 * `Messaggi.tsx` non deve sapere che cosa sia un'epoch, un Welcome o una catena
 * di chiavi: chiede di aprire una conversazione, di leggerla e di mandare una
 * riga. Qui sotto quelle richieste diventano i passi che [`sessione`](./sessione.ts)
 * espone — ed è per questo che la schermata resta sottile e questo file è
 * provabile senza React.
 *
 * **La cronologia si visita, non si trasporta** ([ADR 0043](../../../../docs/adr/0043-custodia-lato-mittente.md)).
 * Chi scrive deposita nella propria casa; chi legge chiede alla propria istanza
 * la cronologia ricomposta dalle custodie, e la decifra qui, in memoria.
 */
import { confronta, epochDi, scriviIdentita, type Confronto, type Membro } from "./gruppo.js";
import {
  aggiungiFoglie,
  aggiungiMembro,
  apriCon,
  cambiaMembri,
  cronologia,
  entra,
  invia,
  riprendi,
  rientraIn,
  sincronizza,
  togliFoglie,
  type BustaHandshake,
  type Contesto,
  type Ingresso,
  type RigaCronologia,
  type Sessione,
} from "./sessione.js";
import type { KeyPackage } from "ts-mls";

/** Una riga come la mostra la schermata. */
export interface Riga {
  id: string;
  createdAt: string;
  /** `username@casa`, o `null` per il pregresso senza autore attestato. */
  mittente: string | null;
  stato: RigaCronologia["stato"];
  testo?: string;
  /**
   * `false` quando chi e quando li dice soltanto l'istanza: una voce di prima
   * che mittente e data venissero sigillati con il testo
   * ([ADR 0052](../../../../docs/adr/0052-l-archivio-dei-gruppi.md) §1).
   */
  attestata?: boolean;
  /** L'id del messaggio a cui questa riga risponde, se risponde. */
  risponde?: string;
  /** La riga non è una frase di qualcuno: è qualcosa che è successo nel gruppo. */
  evento?: Evento;
}

/**
 * Ciò che succede a un gruppo e che chi c'è deve **vedere**: qualcuno entra,
 * qualcuno viene tolto, qualcuno esce.
 *
 * Viaggia come una voce d'archivio di chi l'ha fatto, sigillata come le altre:
 * è lui che lo dice, e lo dice nel punto della conversazione in cui è
 * successo. Serve soprattutto all'ingresso, che è un momento **dichiarato**:
 * chi entra riceve la catena intera e legge anche quello che è stato scritto
 * prima, e chi c'era lo deve sapere quando succede, non scoprirlo dopo.
 *
 * È un racconto, non l'autorità: chi è nel gruppo lo dicono i membri.
 */
export interface Evento {
  tipo: "ingresso" | "rimozione" | "uscita";
  /** `username@casa` di chi è entrato, è stato tolto o è uscito. */
  chi: string;
}

/**
 * Come si è aperta una conversazione su questo dispositivo.
 *
 * Quattro esiti, e la schermata ne mostra quattro diversi: non c'è un «errore»
 * generico dove le cose da fare sono diverse.
 */
export type Apertura =
  | { kind: "pronta"; sessione: Sessione }
  /** Questo dispositivo è stato tolto dal gruppo: non c'è niente da aprire. */
  | { kind: "tolto" }
  /** La conversazione la ordina un'altra casa, e il nostro Welcome non c'è ancora. */
  | { kind: "in-attesa" };

export interface Invitato {
  keyPackage: KeyPackage;
  idDiChiEntra: string;
}

/**
 * Come si ottiene la chiave d'ingresso di chi si invita, e chi è per la casa
 * che ordina. Uno in una chat a due; in un gruppo, tutti quelli che hanno un
 * dispositivo.
 */
export type Invito = () => Promise<Invitato | readonly Invitato[]>;

/**
 * Apre una conversazione su questo dispositivo, dal caso più comune al più raro.
 *
 * 1. **Si riprende**: questo dispositivo ha già lo stato del gruppo.
 * 2. **Si entra**: c'è un Welcome che chiama una chiave di questo dispositivo.
 * 3. **Si rientra**: il gruppo esiste — c'è un punto di rientro — ma questo
 *    dispositivo non ne ha lo stato e nessun Welcome lo chiama. È il browser
 *    svuotato o l'accesso da capo, la via A di S3.
 * 4. **Si crea**, soltanto se la conversazione la ordina questa casa: chi sta
 *    altrove **aspetta**, perché un gruppo creato da due parti è una corsa che
 *    uno dei due perde (ADR 0042 §3). In un gruppo la crea **chi l'ha creato**,
 *    e gli altri aspettano anche se stanno nella stessa casa: è `creaQui`.
 *
 * `invito` si chiama solo nel caso 4, e può fallire: chi lo scrive sa dire
 * perché (nessun dispositivo, casa che non risponde), e la schermata lo dice.
 */
export async function apriConversazione(
  ctx: Contesto,
  conversazione: { id: string; ordinataQui: boolean; creaQui?: boolean },
  invito: Invito,
): Promise<Apertura> {
  const ripresa = await riprendi(ctx, conversazione.id);
  if (ripresa !== undefined && ripresa.tolto !== true) {
    return { kind: "pronta", sessione: ripresa };
  }

  // Un Welcome può chiamare una chiave che questo dispositivo non ha più: se
  // ne guardano tutti, e `entra` dice `undefined` invece di tirare a indovinare.
  //
  // **Dal più recente.** Chi è stato tolto e poi riammesso ha sul canale due
  // inviti: quello di allora, che porta a un'epoch da cui è già stato tolto, e
  // quello nuovo. Per la stessa ragione, chi riprende uno stato da cui risulta
  // tolto guarda soltanto gli inviti **venuti dopo**: uno c'è solo se qualcuno
  // l'ha fatto rientrare.
  const dopoDi = ripresa === undefined ? 0 : epochDi(ripresa.stato);
  // Si scorre **tutta** la fila, non la prima pagina: in un gruppo che vive da
  // un po' l'invito di chi entra oggi sta dopo centinaia di commit.
  const inviti: BustaHandshake[] = [];
  for (let dopo: string | undefined; ;) {
    const pagina = await ctx.istanza.handshakeDopo(conversazione.id, dopo);
    inviti.push(
      ...pagina.handshake.filter((busta) => busta.tipo === "welcome" && busta.epoch > dopoDi),
    );
    if (pagina.prossimo === undefined || pagina.handshake.length === 0) {
      break;
    }
    dopo = pagina.prossimo;
  }
  inviti.sort((a, b) => b.epoch - a.epoch);
  for (const busta of inviti) {
    const entrata = await entra(ctx, conversazione.id, busta);
    if (entrata !== undefined) {
      return { kind: "pronta", sessione: entrata };
    }
  }

  // Tolto, e nessuno l'ha fatto rientrare: non si rientra da soli.
  if (ripresa !== undefined) {
    return { kind: "tolto" };
  }

  const rientrata = await rientraIn(ctx, conversazione.id);
  if (rientrata !== undefined) {
    return { kind: "pronta", sessione: rientrata };
  }

  if (!(conversazione.creaQui ?? conversazione.ordinataQui)) {
    return { kind: "in-attesa" };
  }

  const invitati = await invito();
  const ingressi = (Array.isArray(invitati) ? invitati : [invitati as Invitato]).map(
    (i): Ingresso => ({ destinatario: i.idDiChiEntra, keyPackage: i.keyPackage }),
  );

  return { kind: "pronta", sessione: await apriCon(ctx, conversazione.id, ingressi) };
}

/* ------------------------------ i gruppi (M8) ------------------------------ */

/**
 * Chi è nel gruppo secondo la casa, detto come lo dice MLS.
 *
 * `autorevole` è vero quando questa casa è quella che ordina: lì la
 * composizione è quella vera, altrove è l'ultima che è arrivata — e può
 * mancare di qualcuno appena entrato.
 */
export interface Composizione {
  membri: readonly { id: string; membro: Membro }[];
  /** Chi è stato tolto, o è uscito: questo lo sa ogni casa, con certezza. */
  rimossi: readonly Membro[];
  autorevole: boolean;
}

/**
 * Rimette l'albero d'accordo con chi è nel gruppo, e dice che cosa resta fuori
 * posto.
 *
 * Chi esce da un gruppo lo dice alla casa che ordina, ma **la sua foglia non
 * può toglierla da sé**: MLS non lo permette a chi firma il commit. La toglie
 * il primo dispositivo che se ne accorge, qui, e con lei la catena d'archivio
 * guadagna la chiave che chi è uscito non avrà.
 *
 * Si toglie soltanto ciò di cui si è **certi**: chi risulta tolto, e — dalla
 * casa che ordina, dove la composizione è quella vera — chiunque abbia una
 * foglia senza essere fra i membri. Altrove un nome sconosciuto può essere
 * qualcuno appena entrato di cui la notizia non è ancora arrivata: lì non si
 * toglie nessuno, si **dice**, e finché resta non si scrive
 * ([`manda`](#manda)).
 */
export async function allinea(
  ctx: Contesto,
  sessione: Sessione,
  composizione: Composizione,
): Promise<{ sessione: Sessione; confronto: Confronto }> {
  const attesi = composizione.membri.map((m) => m.membro);
  const prima = confronta(sessione.stato, attesi);
  const tolti = new Set(composizione.rimossi.map(scriviIdentita));
  const daTogliere = prima.estranei.filter(
    (m) => composizione.autorevole || tolti.has(scriviIdentita(m)),
  );

  if (daTogliere.length === 0 || sessione.tolto === true) {
    return { confronto: prima, sessione };
  }

  const allineata = await cambiaMembri(ctx, sessione, { escono: daTogliere });
  return { confronto: confronta(allineata.stato, attesi), sessione: allineata };
}

/**
 * Fa entrare una persona nel gruppo MLS, con tutte le chiavi d'ingresso che si
 * sono ottenute per lei. Se era stata tolta ed è ancora nell'albero, le sue
 * foglie vecchie escono nello stesso commit.
 */
export async function faiEntrare(
  ctx: Contesto,
  sessione: Sessione,
  chi: { id: string; membro: Membro },
  keyPackages: readonly KeyPackage[],
): Promise<Sessione> {
  return aggiungiFoglie(
    ctx,
    sessione,
    chi.membro,
    keyPackages.map((keyPackage) => ({ destinatario: chi.id, keyPackage })),
    { alPostoDelleVecchie: true },
  );
}

/** Toglie una persona dal gruppo MLS: tutte le sue foglie, e la catena ruota. */
export async function faiUscire(
  ctx: Contesto,
  sessione: Sessione,
  membro: Membro,
): Promise<Sessione> {
  return togliFoglie(ctx, sessione, membro);
}

/** Nell'albero c'è chi non è fra i membri: finché resta, non si scrive. */
export class PresenzaEstranea extends Error {
  public readonly code = "presenza_estranea";

  public constructor(public readonly estranei: readonly Membro[]) {
    // Il messaggio è il codice: la frase la sceglie chi lo mostra (ADR 0046).
    super("presenza_estranea");
  }
}

/** Fa entrare un altro membro in una conversazione che esiste. */
export async function invita(
  ctx: Contesto,
  sessione: Sessione,
  chiEntra: KeyPackage,
  idDiChiEntra: string,
): Promise<Sessione> {
  return aggiungiMembro(ctx, sessione, chiEntra, idDiChiEntra);
}

export interface Lettura {
  sessione: Sessione;
  righe: Riga[];
  /** Da passare per la pagina precedente, se ce n'è una. */
  prima?: string;
  /** Le case che non hanno risposto: le loro righe sono `non-disponibile`. */
  nonRispondono: string[];
  /** L'albero accanto ai membri, se a `leggi` è stata data la composizione. */
  confronto?: Confronto;
}

/**
 * Un giro completo: si applicano gli handshake arretrati, si riapre il mazzo se
 * nel frattempo qualcuno l'ha riavvolto, e si legge una pagina di cronologia.
 */
export async function leggi(
  ctx: Contesto,
  sessione: Sessione,
  prima?: string,
  composizione?: Composizione,
): Promise<Lettura> {
  // Con la catena in mano basta applicare gli handshake: la catena non dipende
  // dall'epoch, e richiedere il mazzo a ogni giro sarebbe una domanda in più
  // verso la casa che ordina ogni volta che la schermata guarda. Senza catena
  // si riprende da capo, perché è lì che si scopre se qualcuno l'ha riavvolta.
  const sincronizzata =
    sessione.catena !== undefined
      ? await sincronizza(ctx, sessione)
      : ((await riprendi(ctx, sessione.conversazioneId)) ?? sessione);

  // Con la composizione in mano, l'albero le si mette accanto a ogni giro: è
  // qui che la foglia di chi è uscito viene tolta, e che un estraneo si vede.
  const allineata =
    composizione === undefined || sincronizzata.tolto === true
      ? undefined
      : await allinea(ctx, sincronizzata, composizione);
  const aggiornata = allineata?.sessione ?? sincronizzata;

  const pagina = await cronologia(ctx, aggiornata, prima);
  return {
    nonRispondono: pagina.nonRispondono,
    righe: pagina.righe.map(dallaCronologia),
    sessione: aggiornata,
    ...(allineata === undefined ? {} : { confronto: allineata.confronto }),
    ...(pagina.prima === undefined ? {} : { prima: pagina.prima }),
  };
}

/**
 * Manda una riga: va nell'archivio della propria casa, e basta.
 *
 * Il testo e la risposta viaggiano insieme dentro la voce cifrata, in una forma
 * versionata: il segnaposto che arriva alle altre case non ne sa niente, ed è
 * giusto così (ADR 0042 §4.1).
 */
export async function manda(
  ctx: Contesto,
  sessione: Sessione,
  riga: { testo: string; risponde?: string },
  idMessaggio: string,
  quando: string,
  /**
   * Chi dovrebbe esserci. Se nell'albero c'è qualcun altro la riga **non
   * parte**: chi ha una foglia apre il mazzo, e scrivere sarebbe scrivere anche
   * a lui.
   */
  attesi?: readonly Membro[],
): Promise<void> {
  if (attesi !== undefined) {
    const { estranei } = confronta(sessione.stato, attesi);
    if (estranei.length > 0) {
      throw new PresenzaEstranea(estranei);
    }
  }

  const contenuto: Contenuto = {
    t: riga.testo,
    v: 1,
    ...(riga.risponde === undefined ? {} : { r: riga.risponde }),
  };

  await invia(ctx, sessione, JSON.stringify(contenuto), idMessaggio, quando);
}

/** Scrive nella conversazione che cosa è successo al gruppo. */
export async function annuncia(
  ctx: Contesto,
  sessione: Sessione,
  evento: Evento,
  idMessaggio: string,
  quando: string,
): Promise<void> {
  const contenuto: Contenuto = { e: evento, t: "", v: 1 };
  await invia(ctx, sessione, JSON.stringify(contenuto), idMessaggio, quando);
}

/** La forma del contenuto dentro la voce. `v` c'è perché un giorno cambierà. */
interface Contenuto {
  v: 1;
  t: string;
  r?: string;
  e?: Evento;
}

function dallaCronologia(riga: RigaCronologia): Riga {
  const base = { createdAt: riga.createdAt, id: riga.id, mittente: riga.mittente };

  if (riga.stato !== "letta" || riga.testo === undefined) {
    return { ...base, stato: riga.stato };
  }

  const contenuto = leggiContenuto(riga.testo);
  if (contenuto === undefined) {
    // Aperto, ma non nella forma che questo client conosce: non si mostra come
    // se fosse testo, si dice che non si apre.
    return { ...base, stato: "non-si-apre" };
  }

  return {
    ...base,
    stato: "letta",
    testo: contenuto.t,
    ...(riga.attestata === undefined ? {} : { attestata: riga.attestata }),
    ...(contenuto.e === undefined ? {} : { evento: contenuto.e }),
    ...(contenuto.r === undefined ? {} : { risponde: contenuto.r }),
  };
}

function leggiContenuto(testo: string): Contenuto | undefined {
  try {
    const letto = JSON.parse(testo) as Partial<Contenuto>;
    if (letto.v !== 1 || typeof letto.t !== "string") {
      return undefined;
    }

    return {
      t: letto.t,
      v: 1,
      ...(typeof letto.r === "string" ? { r: letto.r } : {}),
      ...(eUnEvento(letto.e) ? { e: { chi: letto.e.chi, tipo: letto.e.tipo } } : {}),
    };
  } catch {
    return undefined;
  }
}

function eUnEvento(valore: unknown): valore is Evento {
  const e = valore as Partial<Evento> | undefined;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.chi === "string" &&
    (e.tipo === "ingresso" || e.tipo === "rimozione" || e.tipo === "uscita")
  );
}
