/**
 * La sessione MLS di una conversazione ([ADR 0038](../../../../docs/adr/0038-mls-si-adotta-e-si-comincia-dal-web.md) punto 4).
 *
 * È il pezzo che tiene insieme i tre di sotto: [`gruppo`](./gruppo.ts) fa la
 * crittografia, [`archivio`](./archivio.ts) fa la cronologia, e qui si decide
 * **quando** e **in che ordine** — che è dove le cose si rompono davvero.
 *
 * Due dipendenze, entrambe iniettate: un `Deposito` dove mettere lo stato del
 * gruppo, e un'`Istanza` a cui chiedere ciò che sta sul server. Nessuna delle
 * due è IndexedDB o `fetch`: è quello che rende la sessione provabile senza
 * browser e senza rete, e i test qui accanto la provano così.
 *
 * Tre regole, e nessuna è un dettaglio:
 *
 * 1. **Gli handshake si applicano in ordine di arrivo, uno alla volta.** MLS li
 *    applica in sequenza; saltarne uno o invertirli spacca lo stato del gruppo.
 *    Il cursore avanza solo su ciò che è stato applicato davvero.
 * 2. **Lo stato si salva dopo ogni mutazione.** Una scheda chiusa a metà di un
 *    commit non deve lasciare un gruppo a un'epoch che nessun altro conosce.
 * 3. **Il mazzo d'archivio si riavvolge a ogni cambio di epoch**, perché la
 *    serratura è quella dell'epoch ([S2](../../../../docs/spike/S2-la-chiave-d-archivio.md)).
 *    E **solo da chi lo conosce**: un dispositivo che non ha ancora aperto il
 *    mazzo — appena rientrato, o entrato prima che qualcuno lo avvolgesse —
 *    non lo riavvolge e non scrive. Riavvolgere un mazzo che non si conosce
 *    vorrebbe dire sostituirlo con un altro, cioè togliere a tutti la
 *    cronologia.
 *
 * **Il contenuto non viaggia come busta MLS.** Con [ADR 0043](../../../../docs/adr/0043-custodia-lato-mittente.md)
 * la parola resta nell'archivio della casa di chi scrive, e chi legge la
 * **visita**: MLS serve a sapere chi è membro e a derivare la serratura del
 * mazzo, non a trasportare il testo. Una busta applicativa consegnata in casa
 * d'altri sarebbe la copia che quell'ADR vieta.
 */
import { decodeGroupState, encodeGroupState, type GroupState } from "ts-mls/clientState.js";

import {
  archiviaLegata,
  avvolgi,
  catenaNuova,
  catenaRuotata,
  rileggiLegata,
  svolgi,
  type Catena,
} from "./archivio.js";
import {
  applicaHandshake,
  cambiaFoglie,
  chiaveDiRotazione,
  configurazione,
  creaConversazione,
  diChiE,
  entraDaWelcome,
  epochDi,
  foglieDi,
  ioIn,
  puntoDiRientro,
  qualcunoTolto,
  rientra,
  scriviIdentita,
  serraturaArchivio,
  toltoDalGruppo,
  type Membro,
  type Porta,
  type Portachiavi,
} from "./gruppo.js";
import type { ClientState, KeyPackage } from "ts-mls";

/** Dove si conserva lo stato del gruppo. In produzione è IndexedDB. */
export interface Deposito {
  leggi: (conversazioneId: string) => Promise<Uint8Array | undefined>;
  scrivi: (conversazioneId: string, stato: Uint8Array) => Promise<void>;
  /** Il cursore degli handshake già applicati. */
  leggiCursore: (conversazioneId: string) => Promise<string | undefined>;
  scriviCursore: (conversazioneId: string, cursore: string) => Promise<void>;
  /**
   * Il mazzo d'archivio **com'è avvolto**, sotto la serratura dell'epoch dello
   * stato che gli sta accanto: lo stesso blob che si deposita presso la casa
   * che ordina, tenuto anche qui.
   *
   * Serve a una cosa sola: se quella casa è **persa** il mazzo se ne va con
   * lei, e il gruppo di prima si deve poter leggere ancora «con le chiavi che
   * ogni client ha già» ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md)
   * §3, «Il trasloco»). Non è una chiave in chiaro: si apre soltanto con lo
   * stato del gruppo, che sta già qui.
   */
  leggiMazzo: (conversazioneId: string) => Promise<string | undefined>;
  scriviMazzo: (conversazioneId: string, mazzo: string) => Promise<void>;
  /**
   * Via tutto, al logout.
   *
   * Lo stato di un gruppo è materiale di chi era entrato: lasciarlo lì
   * significa consegnarlo a chi accede dopo sullo stesso browser.
   */
  svuota: () => Promise<void>;
}

export interface VoceArchivio {
  id: string;
  chiaveN: number;
  busta: string;
  createdAt: string;
}

export interface BustaHandshake {
  id: string;
  tipo: "commit" | "welcome";
  epoch: number;
  busta: string;
}

/** Ciò che la sessione chiede all'istanza. Niente di più. */
export interface Istanza extends Porta {
  handshakeDopo: (
    conversazioneId: string,
    dopo?: string,
  ) => Promise<{ handshake: BustaHandshake[]; prossimo?: string }>;
  depositaHandshake: (
    conversazioneId: string,
    busta: { tipo: "commit" | "welcome"; epoch: number; busta: string; destinatario?: string },
  ) => Promise<void>;
  mazzo: (conversazioneId: string) => Promise<{ mazzo: string; epoch: number } | undefined>;
  salvaMazzo: (conversazioneId: string, dati: { mazzo: string; epoch: number }) => Promise<void>;
  /** Il punto da cui si rientra. L'istanza non lo apre: per lei è un blob e un'epoch. */
  salvaPuntoDiRientro: (
    conversazioneId: string,
    dati: { groupInfo: string; epoch: number },
  ) => Promise<void>;
  /** Il punto da cui si rientra, se la conversazione ne ha uno. */
  puntoDiRientro: (
    conversazioneId: string,
  ) => Promise<{ groupInfo: string; epoch: number } | undefined>;
  /**
   * La cronologia ricomposta dalle custodie ([ADR 0043](../../../../docs/adr/0043-custodia-lato-mittente.md) §2),
   * dalla pagina più recente: le voci della propria casa e quelle visitate
   * alla casa di chi le ha scritte.
   */
  cronologia: (conversazioneId: string, prima?: string) => Promise<PaginaRemota>;
  depositaArchivio: (conversazioneId: string, voci: VoceArchivio[]) => Promise<void>;
}

/** Una riga come la ricompone l'istanza: la voce c'è solo se la sua casa ha risposto. */
export interface RigaRemota {
  id: string;
  /** `username@casa`; `null` per il pregresso senza autore attestato. */
  mittente: string | null;
  createdAt: string;
  casa: string;
  stato: "disponibile" | "non-disponibile";
  voce?: { chiaveN: number; busta: string };
}

export interface PaginaRemota {
  righe: RigaRemota[];
  prima?: string;
  /** Le case che non hanno risposto. */
  nonRispondono: string[];
}

export interface Sessione {
  conversazioneId: string;
  stato: ClientState;
  /**
   * La catena d'archivio, se questo dispositivo ha aperto il mazzo.
   *
   * `undefined` non è un guasto: è il dispositivo appena rientrato, che torna
   * nel gruppo prima che qualcuno gli riavvolga il mazzo sotto l'epoch nuova
   * ([S3](../../../../docs/spike/S3-il-rientro-di-un-dispositivo.md)). Finché
   * resta così non si scrive, e il mazzo non si tocca.
   */
  catena: Catena | undefined;
  /**
   * Questo dispositivo è stato tolto dal gruppo: un commit applicato ha tolto
   * la sua foglia. Da qui non si legge il seguito e non si scrive, e lo stato
   * non si porta più avanti.
   */
  tolto?: true;
}

/**
 * Un deposito che la fila rifiuta perché **qualcuno è arrivato prima** sulla
 * stessa epoch ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §3).
 * Non è un guasto: ci si rimette in pari e si riprova.
 */
const superata = (causa: unknown): boolean =>
  causa instanceof Error && "status" in causa && causa.status === 409;

/** Quante volte si riprova un commit che un altro ha preceduto. */
const TENTATIVI = 3;

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

function daB64(s: string): Uint8Array {
  const grezzo = atob(s);
  const bytes = new Uint8Array(grezzo.length);
  for (let i = 0; i < grezzo.length; i++) {
    bytes[i] = grezzo.charCodeAt(i);
  }
  return bytes;
}

export interface Contesto {
  deposito: Deposito;
  istanza: Istanza;
  /** Le chiavi di questo dispositivo. Sono più d'una: un `KeyPackage` è monouso. */
  io: Portachiavi;
}

async function salva(ctx: Contesto, sessione: Sessione): Promise<void> {
  await ctx.deposito.scrivi(sessione.conversazioneId, encodeGroupState(sessione.stato));
  await ricordaMazzo(ctx, sessione);
}

/**
 * Tiene su questo dispositivo il mazzo avvolto sotto l'epoch in cui si è.
 *
 * Va di pari passo con lo stato: uno stato andato avanti senza il suo mazzo
 * avrebbe accanto un mazzo che non apre più. Senza catena non si scrive
 * niente — non c'è niente da ricordare, e quello di prima non lo si sostituisce
 * con un vuoto.
 */
async function ricordaMazzo(ctx: Contesto, sessione: Sessione): Promise<void> {
  if (sessione.catena === undefined || sessione.tolto === true) {
    return;
  }

  await ctx.deposito.scriviMazzo(
    sessione.conversazioneId,
    avvolgi(sessione.catena, await serraturaArchivio(sessione.stato)),
  );
}

async function ripristina(
  ctx: Contesto,
  conversazioneId: string,
): Promise<ClientState | undefined> {
  const byte = await ctx.deposito.leggi(conversazioneId);
  if (byte === undefined) {
    return undefined;
  }

  const letto = decodeGroupState(byte, 0);
  if (letto === undefined) {
    // Uno stato illeggibile non si aggiusta indovinando: si riparte.
    return undefined;
  }

  return { ...(letto[0] as GroupState), clientConfig: configurazione(ctx.istanza) };
}

/**
 * Applica gli handshake che mancano, **in ordine e uno alla volta**.
 *
 * Il cursore avanza solo su ciò che è stato applicato davvero: se un commit non
 * si applica ci si ferma lì, perché saltarlo lascerebbe lo stato a un'epoch che
 * il resto del gruppo ha già superato — e da lì non si torna indietro.
 */
export async function sincronizza(ctx: Contesto, sessione: Sessione): Promise<Sessione> {
  if (sessione.tolto === true) {
    return sessione;
  }

  let stato = sessione.stato;
  let catena = sessione.catena;
  let cursore = await ctx.deposito.leggiCursore(sessione.conversazioneId);
  let mutato = false;
  let tolto = false;

  for (;;) {
    const pagina = await ctx.istanza.handshakeDopo(sessione.conversazioneId, cursore);
    if (pagina.handshake.length === 0) {
      break;
    }

    let ultimoApplicato: string | undefined;

    for (const voce of pagina.handshake) {
      // Un Welcome non si «applica»: o si è già dentro, o si entra — e in quel
      // caso non si passa di qui.
      // Un commit di un'epoch già superata è nostro, o è vecchio: in entrambi i
      // casi non si riapplica.
      if (voce.tipo !== "welcome" && voce.epoch > epochDi(stato) && !tolto) {
        const prima = stato;
        stato = await applicaHandshake(stato, daB64(voce.busta), ctx.istanza);
        mutato = true;
        tolto = toltoDalGruppo(stato);
        // Qualcuno è stato tolto: la catena guadagna la chiave di quest'epoch,
        // la stessa per tutti quelli che restano (ADR 0052 §2). Si fa **qui**,
        // commit per commit, perché la chiave è di questa epoch e non della
        // prossima.
        if (!tolto && catena !== undefined && qualcunoTolto(prima, stato)) {
          catena = catenaRuotata(catena, await chiaveDiRotazione(stato));
        }
      }

      ultimoApplicato = voce.id;
    }

    if (ultimoApplicato !== undefined) {
      cursore = ultimoApplicato;
      await ctx.deposito.scriviCursore(sessione.conversazioneId, ultimoApplicato);
    }

    if (pagina.prossimo === undefined) {
      break;
    }
    cursore = pagina.prossimo;
  }

  if (tolto) {
    // Chi è stato tolto non ha più niente da riavvolgere né da pubblicare: lo
    // stato resta com'è, a dire che cosa è successo.
    const fuori: Sessione = { ...sessione, catena: undefined, stato, tolto: true };
    await salva(ctx, fuori);
    return fuori;
  }

  const aggiornata = { ...sessione, catena, stato };

  if (mutato) {
    await salva(ctx, aggiornata);
    await dopoIlCambioDiEpoch(ctx, aggiornata);
  }

  return aggiornata;
}

/** Riavvolge il mazzo sotto la serratura dell'epoch corrente (regola 3). */
async function riavvolgiMazzo(ctx: Contesto, sessione: Sessione): Promise<void> {
  // Chi non conosce il mazzo non lo riavvolge: lo sostituirebbe (regola 3).
  if (sessione.catena === undefined) {
    return;
  }

  await ctx.istanza.salvaMazzo(sessione.conversazioneId, {
    epoch: epochDi(sessione.stato),
    mazzo: avvolgi(sessione.catena, await serraturaArchivio(sessione.stato)),
  });
}

/**
 * Quello che si fa quando l'epoch cambia: il mazzo si riavvolge, e il punto da
 * cui si rientra si aggiorna.
 *
 * Lo fa **chiunque** noti il cambio, non solo chi ha fatto il commit. È qualche
 * `PUT` in più su un oggetto che cambia di rado — in MLS l'epoch si muove sui
 * commit, non sui messaggi — e in cambio il punto di rientro non resta indietro
 * perché la scheda di chi ha committato si è chiusa un attimo troppo presto.
 * L'istanza non lascia comunque tornare indietro l'epoch, quindi due depositi
 * insieme non possono far vincere il più vecchio.
 */
async function dopoIlCambioDiEpoch(ctx: Contesto, sessione: Sessione): Promise<void> {
  await riavvolgiMazzo(ctx, sessione);
  await ctx.istanza.salvaPuntoDiRientro(sessione.conversazioneId, {
    epoch: epochDi(sessione.stato),
    groupInfo: b64(await puntoDiRientro(sessione.stato)),
  });
}

/**
 * Apre il mazzo con la serratura dell'epoch in cui si è.
 *
 * `undefined` in due casi, e nessuno dei due si ripara inventando: il mazzo non
 * c'è ancora, oppure c'è ma è avvolto sotto un'altra epoch. **Non si crea mai un
 * mazzo nuovo qui**: lo fa soltanto chi crea il gruppo. Uno nuovo creato da chi
 * entra sostituirebbe quello vero, e con lui la cronologia di tutti.
 */
async function catenaDi(
  ctx: Contesto,
  stato: ClientState,
  conversazioneId: string,
): Promise<Catena | undefined> {
  const avvolto = await ctx.istanza.mazzo(conversazioneId);
  if (avvolto === undefined || avvolto.epoch !== epochDi(stato)) {
    return undefined;
  }

  try {
    return svolgi(avvolto.mazzo, await serraturaArchivio(stato));
  } catch {
    return undefined;
  }
}

/** Apre una conversazione che esiste già su questo dispositivo. */
export async function riprendi(
  ctx: Contesto,
  conversazioneId: string,
): Promise<Sessione | undefined> {
  const stato = await ripristina(ctx, conversazioneId);
  if (stato === undefined) {
    return undefined;
  }

  // Il mazzo si apre **prima** di sincronizzare, se è ancora all'epoch del
  // proprio stato: è così che chi resta indietro lo porta avanti riavvolgendolo
  // sotto l'epoch nuova. Se non si apre adesso, si riprova dopo, all'epoch
  // raggiunta — che è il caso di chi ritrova il mazzo già riavvolto da altri.
  if (toltoDalGruppo(stato)) {
    return { catena: undefined, conversazioneId, stato, tolto: true };
  }

  const prima = await catenaDi(ctx, stato, conversazioneId);
  const sincronizzata = await sincronizza(ctx, { catena: prima, conversazioneId, stato });

  const ripresa =
    sincronizzata.catena !== undefined || sincronizzata.tolto === true
      ? sincronizzata
      : {
          ...sincronizzata,
          catena: await catenaDi(ctx, sincronizzata.stato, conversazioneId),
        };

  // Chi ha aperto il mazzo adesso, senza che lo stato cambiasse, lo ricorda
  // qui: è il solo passaggio in cui la catena arriva senza un salvataggio.
  await ricordaMazzo(ctx, ripresa);
  return ripresa;
}

/**
 * Apre un gruppo **congelato**: quello che un trasloco ha lasciato in sola
 * lettura ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §3).
 *
 * La casa che lo ordinava è persa, e con lei la coda, il punto di rientro e il
 * mazzo: qui non si chiede niente a nessuno. Si riprende lo stato che questo
 * dispositivo aveva e si apre il mazzo che aveva tenuto. `undefined` se il
 * dispositivo nel gruppo non c'era: chi arriva dopo vede il gruppo di prima
 * come lo vede un estraneo, cioè non lo vede — è il secondo dei due costi.
 */
export async function riprendiCongelata(
  ctx: Contesto,
  conversazioneId: string,
): Promise<Sessione | undefined> {
  const stato = await ripristina(ctx, conversazioneId);
  if (stato === undefined) {
    return undefined;
  }

  const avvolto = await ctx.deposito.leggiMazzo(conversazioneId);
  let catena: Catena | undefined;
  if (avvolto !== undefined) {
    try {
      catena = svolgi(avvolto, await serraturaArchivio(stato));
    } catch {
      // Un mazzo che non si apre non si indovina: le righe diranno che non si aprono.
      catena = undefined;
    }
  }

  return { catena, conversazioneId, stato };
}

/** Chi entra: la sua chiave d'ingresso, e l'id con cui la conversazione lo nomina. */
export interface Ingresso {
  keyPackage: KeyPackage;
  /**
   * L'**id** del membro nella conversazione, non il suo nome: il canale di
   * handshake consegna un Welcome confrontando il destinatario con l'id di chi
   * legge ([`repository.ts`](../../../core-api/src/messaggi/repository.ts),
   * `listHandshakePer`). Con il nome il Welcome si deposita senza errori e non
   * arriva a nessuno.
   */
  destinatario: string;
}

/** Un Welcome solo chiama tutti quelli che entrano: va a ciascuno di loro. */
async function consegnaWelcome(
  ctx: Contesto,
  conversazioneId: string,
  welcome: Uint8Array | undefined,
  epoch: number,
  ingressi: readonly Ingresso[],
): Promise<void> {
  if (welcome === undefined) {
    return;
  }

  const busta = b64(welcome);
  for (const destinatario of new Set(ingressi.map((i) => i.destinatario))) {
    await ctx.istanza.depositaHandshake(conversazioneId, {
      busta,
      destinatario,
      epoch,
      tipo: "welcome",
    });
  }
}

/**
 * Crea la conversazione e ci fa entrare chi c'è: uno in una chat a due, tutti
 * quelli che hanno un dispositivo in un gruppo.
 */
export async function apriCon(
  ctx: Contesto,
  conversazioneId: string,
  ingressi: readonly Ingresso[],
): Promise<Sessione> {
  if (ingressi.length === 0) {
    throw new Error("Una conversazione non si apre da soli.");
  }

  const creato = await creaConversazione(
    conversazioneId,
    await ctx.io.perNuovaFoglia(),
    ctx.istanza,
  );
  const aggiunta = await cambiaFoglie(
    creato,
    { entrano: ingressi.map((i) => i.keyPackage), escono: [] },
    ctx.istanza,
  );

  // Il mazzo nasce qui, e soltanto qui: chi crea il gruppo è l'unico che non
  // trova una cronologia da rispettare.
  const sessione: Sessione = {
    catena: catenaNuova(),
    conversazioneId,
    stato: aggiunta.stato,
  };

  // Il commit va in fila **prima** di salvare lo stato. Se un altro l'ha
  // preceduto sulla stessa epoch la fila lo rifiuta (ADR 0042 §3), e allora
  // qui non deve restare un gruppo che nessun altro conosce.
  await ctx.istanza.depositaHandshake(conversazioneId, {
    busta: b64(aggiunta.commit),
    epoch: aggiunta.epoch,
    tipo: "commit",
  });
  await salva(ctx, sessione);
  // Prima il mazzo, poi gli inviti: chi entra lo trova già avvolto sotto
  // l'epoch del suo Welcome, e legge subito.
  await dopoIlCambioDiEpoch(ctx, sessione);
  await consegnaWelcome(ctx, conversazioneId, aggiunta.welcome, aggiunta.epoch, ingressi);

  return sessione;
}

/** Crea la conversazione e ci fa entrare una persona: la chat a due. */
export async function apri(
  ctx: Contesto,
  conversazioneId: string,
  chiEntra: KeyPackage,
  idDiChiEntra: string,
): Promise<Sessione> {
  return apriCon(ctx, conversazioneId, [{ destinatario: idDiChiEntra, keyPackage: chiEntra }]);
}

/** Una chiave d'ingresso che dice di essere di qualcun altro. */
export class ChiaveDiUnAltro extends Error {
  public readonly code = "chiave_di_un_altro";

  public constructor() {
    // Il messaggio è il codice: la frase la sceglie chi lo mostra (ADR 0046).
    super("chiave_di_un_altro");
  }
}

/**
 * Un commit che cambia le foglie, portato fino in fondo: in fila, salvato, con
 * il mazzo riavvolto e gli inviti consegnati.
 *
 * `calcola` riceve lo stato **su cui il commit verrà costruito** e dice che
 * cosa cambiare: si richiama a ogni tentativo, perché se un altro è arrivato
 * prima (409) ci si rimette in pari e il cambio va ricalcolato — la foglia da
 * togliere può non esserci già più, o avere cambiato posto.
 */
async function commitDiFoglie(
  ctx: Contesto,
  sessione: Sessione,
  calcola: (stato: ClientState) => { entrano: readonly Ingresso[]; escono: readonly number[] },
): Promise<Sessione> {
  let attuale = await sincronizza(ctx, sessione);

  for (let tentativo = 1; ; tentativo++) {
    if (attuale.tolto === true) {
      throw new Error("Questo dispositivo non è più nel gruppo.");
    }

    const cambio = calcola(attuale.stato);
    if (cambio.entrano.length === 0 && cambio.escono.length === 0) {
      return attuale;
    }

    const esito = await cambiaFoglie(
      attuale.stato,
      { entrano: cambio.entrano.map((i) => i.keyPackage), escono: cambio.escono },
      ctx.istanza,
    );

    try {
      // In fila **prima** di salvare: uno stato che la fila ha rifiutato è un
      // gruppo che nessun altro conosce.
      await ctx.istanza.depositaHandshake(attuale.conversazioneId, {
        busta: b64(esito.commit),
        epoch: esito.epoch,
        tipo: "commit",
      });
    } catch (causa) {
      if (!superata(causa) || tentativo >= TENTATIVI) {
        throw causa;
      }
      attuale = await sincronizza(ctx, attuale);
      continue;
    }

    // A ogni rimozione la catena guadagna una chiave (ADR 0052 §2): chi è
    // stato tolto tiene quelle che aveva, e non ottiene questa.
    const catena =
      attuale.catena !== undefined && qualcunoTolto(attuale.stato, esito.stato)
        ? catenaRuotata(attuale.catena, await chiaveDiRotazione(esito.stato))
        : attuale.catena;
    const aggiornata: Sessione = { ...attuale, catena, stato: esito.stato };

    await salva(ctx, aggiornata);
    await dopoIlCambioDiEpoch(ctx, aggiornata);
    await consegnaWelcome(
      ctx,
      aggiornata.conversazioneId,
      esito.welcome,
      esito.epoch,
      cambio.entrano,
    );

    return aggiornata;
  }
}

/**
 * **Aggiunge le foglie di un membro** a una conversazione: una per ogni chiave
 * d'ingresso, cioè una per dispositivo.
 *
 * È l'operazione dei gruppi — una persona entra — e quella dei dispositivi —
 * un secondo dispositivo della stessa persona entra
 * ([ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)).
 *
 * Con `alPostoDelleVecchie`, le foglie che quella persona ha già escono **nello
 * stesso commit**: è la riammissione di chi era stato tolto ed è rimasto
 * nell'albero, e il modo in cui non esiste un'epoch con le vecchie e le nuove
 * insieme. Le foglie che firmano con una delle chiavi che stanno entrando
 * escono comunque, perché MLS non accetta due volte la stessa chiave.
 *
 * Ogni chiave d'ingresso dev'essere **di quella persona**: una che ne nomina
 * un'altra si rifiuta, invece di far entrare qualcuno sotto il nome sbagliato.
 */
export async function aggiungiFoglie(
  ctx: Contesto,
  sessione: Sessione,
  membro: Membro,
  ingressi: readonly Ingresso[],
  opzioni: { alPostoDelleVecchie?: boolean } = {},
): Promise<Sessione> {
  const chi = scriviIdentita(membro);
  for (const ingresso of ingressi) {
    const suo = diChiE(ingresso.keyPackage);
    if (suo === undefined || scriviIdentita(suo) !== chi) {
      throw new ChiaveDiUnAltro();
    }
  }

  const stesseChiavi = ingressi.map((i) => i.keyPackage.leafNode.signaturePublicKey);

  return commitDiFoglie(ctx, sessione, (stato) => ({
    entrano: ingressi,
    escono: foglieDi(stato, membro)
      .filter(
        (f) =>
          opzioni.alPostoDelleVecchie === true ||
          stesseChiavi.some((k) => stessiByte(k, f.chiaveDiFirma)),
      )
      .map((f) => f.indice),
  }));
}

/**
 * **Toglie le foglie di un membro** da una conversazione: tutte, o soltanto
 * quelle dei dispositivi che firmano con `soloChiavi`.
 *
 * Tutte è togliere una persona dal gruppo; alcune è togliere un dispositivo
 * perduto o revocato a una persona che resta. In entrambi i casi la catena
 * d'archivio guadagna una chiave che chi è uscito non ottiene: **non riceverà
 * più i messaggi nuovi**. Quelli che ha già letto li ha letti, e le chiavi con
 * cui li ha letti le ha avute — qui la crittografia non può niente, e nessuna
 * frase deve dire il contrario.
 *
 * Se non c'è niente da togliere non parte nessun commit.
 */
export async function togliFoglie(
  ctx: Contesto,
  sessione: Sessione,
  membro: Membro,
  opzioni: { soloChiavi?: readonly Uint8Array[] } = {},
): Promise<Sessione> {
  const { soloChiavi } = opzioni;

  return commitDiFoglie(ctx, sessione, (stato) => ({
    entrano: [],
    escono: foglieDi(stato, membro)
      .filter(
        (f) => soloChiavi === undefined || soloChiavi.some((k) => stessiByte(k, f.chiaveDiFirma)),
      )
      .map((f) => f.indice),
  }));
}

/**
 * Più persone in un commit solo: entrano le une, escono le altre.
 *
 * È ciò che serve quando l'albero va rimesso d'accordo con chi è nel gruppo —
 * due persone uscite mentre nessuno guardava sono un commit, non due.
 */
export async function cambiaMembri(
  ctx: Contesto,
  sessione: Sessione,
  cambio: { entrano?: readonly Ingresso[]; escono?: readonly Membro[] },
): Promise<Sessione> {
  return commitDiFoglie(ctx, sessione, (stato) => ({
    entrano: cambio.entrano ?? [],
    escono: (cambio.escono ?? []).flatMap((m) => foglieDi(stato, m).map((f) => f.indice)),
  }));
}

const stessiByte = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Fa entrare una foglia in una conversazione che esiste già.
 *
 * Resta per la chat a due; i gruppi e i dispositivi usano
 * [`aggiungiFoglie`](#aggiungiFoglie), che controlla anche di chi è la chiave.
 */
export async function aggiungiMembro(
  ctx: Contesto,
  sessione: Sessione,
  chiEntra: KeyPackage,
  idDiChiEntra: string,
): Promise<Sessione> {
  return commitDiFoglie(ctx, sessione, () => ({
    entrano: [{ destinatario: idDiChiEntra, keyPackage: chiEntra }],
    escono: [],
  }));
}

/**
 * Entra da un Welcome trovato sul canale.
 *
 * `undefined` quando quel Welcome non chiama nessuna chiave di questo
 * dispositivo. Non è un guasto e non si tira a indovinare: succede a chi ha
 * cancellato il browser, e la via che gli resta è il rientro.
 */
export async function entra(
  ctx: Contesto,
  conversazioneId: string,
  welcome: BustaHandshake,
): Promise<Sessione | undefined> {
  const busta = daB64(welcome.busta);
  const io = await ctx.io.perWelcome(busta);
  if (io === undefined) {
    return undefined;
  }

  const stato = await entraDaWelcome(busta, io, ctx.istanza);
  const catena = await catenaDi(ctx, stato, conversazioneId);
  const sessione: Sessione = { catena, conversazioneId, stato };

  await salva(ctx, sessione);
  await ctx.deposito.scriviCursore(conversazioneId, welcome.id);

  return sessione;
}

/**
 * Scrive: la voce va nell'archivio della propria casa, e basta.
 *
 * È tutto l'invio ([ADR 0043](../../../../docs/adr/0043-custodia-lato-mittente.md) §2):
 * la casa custodisce, le altre case ricevono il segnaposto, e chi legge
 * visita. Nessuna busta di trasporto parte, perché consegnarla in casa d'altri
 * sarebbe la copia che quell'ADR vieta.
 *
 * Senza catena non si scrive: una voce chiusa con una chiave che nessun altro
 * ha sarebbe un messaggio che nessuno legge, mostrato come mandato.
 */
export async function invia(
  ctx: Contesto,
  sessione: Sessione,
  testo: string,
  idMessaggio: string,
  quando: string,
): Promise<void> {
  if (sessione.catena === undefined) {
    throw new Error(
      "La cronologia di questa conversazione non è ancora arrivata su questo dispositivo.",
    );
  }

  // Chi scrive lo dice la propria foglia, non un parametro: è la stessa
  // identità che il gruppo ha autenticato, ed è quella che la casa dichiarerà
  // accanto alla voce.
  const io = ioIn(sessione.stato);
  if (io === undefined || sessione.tolto === true) {
    throw new Error("Questo dispositivo non è nel gruppo di questa conversazione.");
  }

  const voce = archiviaLegata(sessione.catena, testo, {
    conversazioneId: sessione.conversazioneId,
    createdAt: quando,
    id: idMessaggio,
    mittente: scriviIdentita(io),
  });

  await ctx.istanza.depositaArchivio(sessione.conversazioneId, [
    { busta: voce.busta, chiaveN: voce.chiaveN, createdAt: quando, id: idMessaggio },
  ]);
}

export interface RigaCronologia {
  id: string;
  createdAt: string;
  /** `username@casa`, o `null` per il pregresso senza autore attestato. */
  mittente: string | null;
  /**
   * `letta` con il testo; `non-si-apre` quando la voce c'è ma questo dispositivo
   * non ha la chiave; `non-disponibile` quando la casa che la custodisce non
   * risponde. Tre stati da mostrare, non tre frasi da inventare.
   */
  stato: "letta" | "non-si-apre" | "non-disponibile";
  testo?: string;
  /**
   * Solo per una riga `letta`: `true` se mittente, data e conversazione sono
   * quelli che chi ha scritto ha sigillato con il testo
   * ([ADR 0052](../../../../docs/adr/0052-l-archivio-dei-gruppi.md) §1);
   * `false` per una voce di prima, dove restano la parola dell'istanza.
   */
  attestata?: boolean;
}

export interface PaginaCronologia {
  righe: RigaCronologia[];
  prima?: string;
  nonRispondono: string[];
}

/**
 * Una pagina di cronologia, dalla più recente, decifrata con la catena.
 *
 * Il testo esiste soltanto qui, in memoria: non si scrive da nessuna parte, ed
 * è la prima delle due assunzioni di client onesto di ADR 0043 §5.
 */
export async function cronologia(
  ctx: Contesto,
  sessione: Sessione,
  prima?: string,
): Promise<PaginaCronologia> {
  const pagina = await ctx.istanza.cronologia(sessione.conversazioneId, prima);

  const righe = pagina.righe.map((riga): RigaCronologia => {
    const base = { createdAt: riga.createdAt, id: riga.id, mittente: riga.mittente };

    if (riga.stato === "non-disponibile" || riga.voce === undefined) {
      return { ...base, stato: "non-disponibile" };
    }

    const riletta =
      sessione.catena === undefined
        ? undefined
        : rileggiLegata(
            sessione.catena,
            { busta: riga.voce.busta, chiaveN: riga.voce.chiaveN },
            riga.mittente === null
              ? undefined
              : {
                  conversazioneId: sessione.conversazioneId,
                  createdAt: riga.createdAt,
                  id: riga.id,
                  mittente: riga.mittente,
                },
          );

    return riletta === undefined
      ? { ...base, stato: "non-si-apre" }
      : { ...base, attestata: riletta.legata, stato: "letta", testo: riletta.testo };
  });

  return {
    nonRispondono: pagina.nonRispondono,
    righe,
    ...(pagina.prima === undefined ? {} : { prima: pagina.prima }),
  };
}

/**
 * Rientra in una conversazione dal punto pubblicato, con una foglia nuova.
 *
 * È ciò che resta a un dispositivo che non ha più lo stato del gruppo — un
 * browser svuotato, un'uscita, un accesso da capo — e non trova un Welcome per
 * sé: la via A di [S3](../../../../docs/spike/S3-il-rientro-di-un-dispositivo.md).
 *
 * **Si torna nel gruppo, non ancora nella cronologia.** Il mazzo è avvolto
 * sotto l'epoch di prima, e si riapre quando un altro membro applica il commit
 * di rientro e lo riavvolge. Fino ad allora la sessione non ha catena, e non si
 * scrive.
 */
export async function rientraIn(
  ctx: Contesto,
  conversazioneId: string,
): Promise<Sessione | undefined> {
  const punto = await ctx.istanza.puntoDiRientro(conversazioneId);
  if (punto === undefined) {
    return undefined;
  }

  const tornata = await rientra(daB64(punto.groupInfo), await ctx.io.perNuovaFoglia(), ctx.istanza);

  await ctx.istanza.depositaHandshake(conversazioneId, {
    busta: b64(tornata.commit),
    epoch: tornata.epoch,
    tipo: "commit",
  });

  const sessione: Sessione = { catena: undefined, conversazioneId, stato: tornata.stato };
  await salva(ctx, sessione);

  return sessione;
}

/**
 * Ruota la catena d'archivio **a mano**, con una chiave casuale.
 *
 * Non è la rotazione delle rimozioni: quella la fanno da sole
 * [`togliFoglie`](#togliFoglie) e [`sincronizza`](#sincronizza), con una chiave
 * derivata dall'epoch che tutti quelli che restano ottengono uguale
 * ([ADR 0052](../../../../docs/adr/0052-l-archivio-dei-gruppi.md) §2). Questa
 * resta per chi vuole una chiave nuova senza togliere nessuno, e ha il limite
 * di una chiave casuale: gli altri la ricevono soltanto dal mazzo, quindi vale
 * finché nessuno lo riavvolge con la catena di prima.
 */
export async function ruotaArchivio(ctx: Contesto, sessione: Sessione): Promise<Sessione> {
  if (sessione.catena === undefined) {
    throw new Error("Non si ruota una catena che questo dispositivo non ha.");
  }

  const aggiornata = { ...sessione, catena: catenaRuotata(sessione.catena) };
  await riavvolgiMazzo(ctx, aggiornata);
  return aggiornata;
}
