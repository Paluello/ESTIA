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
 * 2. **Lo stato si salva dopo ogni mutazione**, commit per commit e **prima**
 *    del cursore: un giro interrotto a metà non lascia il cursore più avanti
 *    dello stato. E **un commit proprio resta in sospeso finché la fila non
 *    l'ha preso**: lo si annota nel deposito prima di depositarlo, e se la
 *    scheda si chiude o la risposta si perde, al giro dopo lo si riconosce in
 *    fila byte per byte e si finisce il lavoro — oppure lo si butta, se la
 *    fila non l'ha mai visto.
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
  catenaDaTenere,
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
  type IdentitaDispositivo,
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
   * Il commit di questo dispositivo che **non si sa ancora se la fila ha
   * preso**. Si scrive prima di depositarlo e si toglie (`undefined`) quando
   * il lavoro è finito, o quando si sa che la fila non l'ha voluto.
   */
  leggiSospeso: (conversazioneId: string) => Promise<CommitInSospeso | undefined>;
  scriviSospeso: (conversazioneId: string, sospeso: CommitInSospeso | undefined) => Promise<void>;
  /**
   * Via tutto, al logout.
   *
   * Lo stato di un gruppo è materiale di chi era entrato: lasciarlo lì
   * significa consegnarlo a chi accede dopo sullo stesso browser.
   */
  svuota: () => Promise<void>;
}

/**
 * Un commit proprio, annotato prima di depositarlo.
 *
 * Porta tutto ciò che serve a finire il lavoro senza averlo in memoria: `ts-mls`
 * non riapplica un commit a chi l'ha scritto, quindi lo stato che ne esce va
 * tenuto accanto alla busta. Non è materiale in più rispetto a ciò che il
 * deposito già custodisce: è lo stato del gruppo un'epoch più avanti, e il
 * mazzo com'è avvolto sotto quell'epoch — mai una chiave d'archivio in chiaro.
 */
export interface CommitInSospeso {
  /** Il commit com'è stato depositato, in Base64: si riconosce byte per byte. */
  busta: string;
  epoch: number;
  /** Lo stato del gruppo **dopo** il commit, come lo scrive `Deposito.scrivi`. */
  stato: Uint8Array;
  /** La catena di dopo il commit, avvolta sotto la sua epoch. Manca a chi non ha catena. */
  mazzo?: string;
  /** L'invito per chi entra con questo commit, in Base64. */
  welcome?: string;
  /** Gli id a cui l'invito va consegnato. */
  destinatari: string[];
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

const stessiByte = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

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
  return byte === undefined ? undefined : statoDa(ctx, byte);
}

function statoDa(ctx: Contesto, byte: Uint8Array): ClientState | undefined {
  const letto = decodeGroupState(byte, 0);
  if (letto === undefined) {
    // Uno stato illeggibile non si aggiusta indovinando: si riparte.
    return undefined;
  }

  return { ...(letto[0] as GroupState), clientConfig: configurazione(ctx.istanza) };
}

/** Lo stato porta questa conversazione, e non un'altra? Il group id è il suo id. */
const eDi = (stato: ClientState, conversazioneId: string): boolean =>
  stessiByte(stato.groupContext.groupId, new TextEncoder().encode(conversazioneId));

/**
 * Due stati sono lo stesso punto della stessa storia: stessa epoch, stessi
 * commit per arrivarci. È così che si riconosce uno stato salvato dal proprio
 * commit in sospeso da uno, alla stessa epoch, a cui si è arrivati col commit
 * di un altro.
 */
const stessoPunto = (a: ClientState, b: ClientState): boolean =>
  a.groupContext.epoch === b.groupContext.epoch &&
  stessiByte(a.groupContext.confirmedTranscriptHash, b.groupContext.confirmedTranscriptHash);

/**
 * Annota un commit proprio **prima** di depositarlo.
 *
 * Fra il deposito e il salvataggio dello stato c'è una finestra — la scheda che
 * si chiude, la risposta che si perde — in cui la fila ha il commit e il
 * dispositivo no: senza questa nota non saprebbe più applicarlo, e resterebbe
 * fuori dal proprio gruppo.
 */
async function annota(
  ctx: Contesto,
  dopo: Sessione,
  esito: { commit: Uint8Array; epoch: number; welcome?: Uint8Array },
  ingressi: readonly Ingresso[],
): Promise<CommitInSospeso> {
  const sospeso: CommitInSospeso = {
    busta: b64(esito.commit),
    destinatari: [...new Set(ingressi.map((i) => i.destinatario))],
    epoch: esito.epoch,
    stato: encodeGroupState(dopo.stato),
    ...(dopo.catena === undefined
      ? {}
      : { mazzo: avvolgi(dopo.catena, await serraturaArchivio(dopo.stato)) }),
    ...(esito.welcome === undefined ? {} : { welcome: b64(esito.welcome) }),
  };
  await ctx.deposito.scriviSospeso(dopo.conversazioneId, sospeso);
  return sospeso;
}

/**
 * Deposita il commit annotato. Se la fila lo **rifiuta** (409) si sa com'è
 * andata e la nota si toglie; per ogni altro guasto non si sa, e resta: la
 * scioglie la prossima sincronizzazione.
 */
async function deposita(
  ctx: Contesto,
  conversazioneId: string,
  sospeso: CommitInSospeso,
): Promise<void> {
  try {
    await ctx.istanza.depositaHandshake(conversazioneId, {
      busta: sospeso.busta,
      epoch: sospeso.epoch,
      tipo: "commit",
    });
  } catch (causa) {
    if (superata(causa)) {
      await ctx.deposito.scriviSospeso(conversazioneId, undefined);
    }
    throw causa;
  }
}

/**
 * Finisce il lavoro di un commit che la fila ha preso: lo stato si salva, il
 * mazzo si riavvolge, gli inviti partono — e solo allora la nota si toglie.
 */
async function concludi(ctx: Contesto, dopo: Sessione, sospeso: CommitInSospeso): Promise<void> {
  await salva(ctx, dopo);
  // Prima il mazzo, poi gli inviti: chi entra lo trova già avvolto sotto
  // l'epoch del suo Welcome, e legge subito.
  await dopoIlCambioDiEpoch(ctx, dopo);
  await consegnaWelcome(ctx, dopo.conversazioneId, sospeso);
  await ctx.deposito.scriviSospeso(dopo.conversazioneId, undefined);
}

/** La catena che un commit in sospeso porta con sé, se ne porta una e si apre. */
async function catenaDelSospeso(
  sospeso: CommitInSospeso,
  stato: ClientState,
): Promise<Catena | undefined> {
  if (sospeso.mazzo === undefined) {
    return undefined;
  }

  try {
    return svolgi(sospeso.mazzo, await serraturaArchivio(stato));
  } catch {
    return undefined;
  }
}

/**
 * Applica gli handshake che mancano, **in ordine e uno alla volta**.
 *
 * Il cursore avanza solo su ciò che è stato applicato davvero: se un commit non
 * si applica ci si ferma lì, perché saltarlo lascerebbe lo stato a un'epoch che
 * il resto del gruppo ha già superato — e da lì non si torna indietro.
 *
 * Lo stato si salva **a ogni commit, prima del cursore**: un cursore rimasto
 * indietro rilegge buste già applicate e le salta, uno andato avanti dello
 * stato ne perderebbe, e il dispositivo non le rivedrebbe più.
 *
 * È anche qui che si scioglie un commit proprio rimasto in sospeso: se è in
 * fila, identico byte per byte, è arrivato, e si finisce ciò che era rimasto a
 * metà; se un altro ha preso la sua epoch, o la fila non l'ha mai visto, si
 * butta.
 */
export async function sincronizza(ctx: Contesto, sessione: Sessione): Promise<Sessione> {
  if (sessione.tolto === true) {
    return sessione;
  }

  const id = sessione.conversazioneId;
  let stato = sessione.stato;
  let catena = sessione.catena;
  let cursore = await ctx.deposito.leggiCursore(id);
  let sospeso = await ctx.deposito.leggiSospeso(id);
  /** Il commit in sospeso che la fila aveva preso: c'è del lavoro da finire. */
  let ripreso: CommitInSospeso | undefined;
  let mutato = false;
  let tolto = false;

  // Lo stato è già quello del commit in sospeso: era stato salvato, e la scheda
  // si è chiusa prima del mazzo o degli inviti. Si finisce da lì.
  if (sospeso !== undefined && sospeso.epoch === epochDi(stato)) {
    const suo = statoDa(ctx, sospeso.stato);
    if (suo !== undefined && stessoPunto(suo, stato)) {
      ripreso = sospeso;
      mutato = true;
    }
  }

  for (;;) {
    const pagina = await ctx.istanza.handshakeDopo(id, cursore);
    if (pagina.handshake.length === 0) {
      break;
    }

    let ultimoApplicato: string | undefined;
    let guasto: { causa: unknown } | undefined;

    for (const voce of pagina.handshake) {
      // Un Welcome non si «applica»: o si è già dentro, o si entra — e in quel
      // caso non si passa di qui.
      // Un commit di un'epoch già superata è nostro, o è vecchio: in entrambi i
      // casi non si riapplica.
      if (voce.tipo !== "welcome" && voce.epoch > epochDi(stato) && !tolto) {
        try {
          const prima = stato;
          // Il proprio commit si riconosce byte per byte.
          const proprio =
            sospeso !== undefined && sospeso.busta === voce.busta ? sospeso : undefined;
          const suo = proprio === undefined ? undefined : statoDa(ctx, proprio.stato);

          if (proprio !== undefined && suo !== undefined) {
            stato = suo;
            catena =
              (await catenaDelSospeso(proprio, stato)) ??
              (catena !== undefined && qualcunoTolto(prima, stato)
                ? catenaRuotata(catena, await chiaveDiRotazione(stato))
                : catena);
            ripreso = proprio;
          } else {
            stato = await applicaHandshake(stato, daB64(voce.busta), ctx.istanza);
            // Un altro ha preso l'epoch del commit in sospeso: non vale più.
            // La nota si toglie **prima** di salvare lo stato, così che uno
            // stato arrivato fin qui col commit di un altro non le resti
            // accanto a farsi scambiare per il suo.
            if (sospeso !== undefined) {
              await ctx.deposito.scriviSospeso(id, undefined);
              sospeso = undefined;
            }
            tolto = toltoDalGruppo(stato);
            // Qualcuno è stato tolto: la catena guadagna la chiave di
            // quest'epoch, la stessa per tutti quelli che restano (ADR 0052
            // §2). Si fa **qui**, commit per commit, perché la chiave è di
            // questa epoch e non della prossima.
            if (!tolto && catena !== undefined && qualcunoTolto(prima, stato)) {
              catena = catenaRuotata(catena, await chiaveDiRotazione(stato));
            }
          }

          mutato = true;
          // Lo stato, commit per commit, e prima del cursore.
          await salva(
            ctx,
            tolto
              ? { ...sessione, catena: undefined, stato, tolto: true }
              : { ...sessione, catena, stato },
          );
        } catch (causa) {
          guasto = { causa };
          break;
        }
      }

      ultimoApplicato = voce.id;
    }

    if (ultimoApplicato !== undefined) {
      cursore = ultimoApplicato;
      await ctx.deposito.scriviCursore(id, ultimoApplicato);
    }
    if (guasto !== undefined) {
      throw guasto.causa;
    }

    if (pagina.prossimo === undefined) {
      break;
    }
    cursore = pagina.prossimo;
  }

  if (tolto) {
    // Chi è stato tolto non ha più niente da riavvolgere né da pubblicare: lo
    // stato resta com'è, a dire che cosa è successo.
    await ctx.deposito.scriviSospeso(id, undefined);
    return { ...sessione, catena: undefined, stato, tolto: true };
  }

  // Un commit proprio che la fila non ha mai visto: il deposito non era
  // arrivato. Si butta, e lo stato resta all'epoch che tutti conoscono.
  if (sospeso !== undefined && ripreso === undefined) {
    await ctx.deposito.scriviSospeso(id, undefined);
  }

  const aggiornata = { ...sessione, catena, stato };

  if (mutato) {
    await dopoIlCambioDiEpoch(ctx, aggiornata);
  }
  // Il commit era nostro, ed era arrivato: si finisce ciò che la scheda chiusa
  // aveva lasciato a metà, e solo allora la nota si toglie.
  if (ripreso !== undefined) {
    await consegnaWelcome(ctx, id, ripreso);
    await ctx.deposito.scriviSospeso(id, undefined);
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

/**
 * La catena che questo dispositivo **conosce già**: quella del mazzo che tiene
 * accanto allo stato, se si apre con l'epoch in cui si è.
 */
async function catenaNota(
  ctx: Contesto,
  stato: ClientState,
  conversazioneId: string,
): Promise<Catena | undefined> {
  const avvolto = await ctx.deposito.leggiMazzo(conversazioneId);
  if (avvolto === undefined) {
    return undefined;
  }

  try {
    return svolgi(avvolto, await serraturaArchivio(stato));
  } catch {
    return undefined;
  }
}

/**
 * Lo stato non c'è, ma c'è un commit in sospeso: è una creazione, o un rientro,
 * che non si sa se è arrivato — la scheda si è chiusa, o la rete è caduta, fra
 * il deposito e il salvataggio.
 *
 * Vale soltanto se in fila c'è **quel** commit, identico byte per byte: allora
 * lo stato che ne esce è quello che tutti conoscono, e si adotta. Altrimenti è
 * un gruppo che nessun altro conosce, e si butta.
 */
async function riprendiDalSospeso(
  ctx: Contesto,
  conversazioneId: string,
): Promise<ClientState | undefined> {
  const sospeso = await ctx.deposito.leggiSospeso(conversazioneId);
  if (sospeso === undefined) {
    return undefined;
  }

  const stato = statoDa(ctx, sospeso.stato);
  let inFila: BustaHandshake | undefined;
  for (let dopo: string | undefined; stato !== undefined && inFila === undefined;) {
    const pagina = await ctx.istanza.handshakeDopo(conversazioneId, dopo);
    inFila = pagina.handshake.find((h) => h.tipo === "commit" && h.busta === sospeso.busta);
    if (pagina.prossimo === undefined || pagina.handshake.length === 0) {
      break;
    }
    dopo = pagina.prossimo;
  }

  if (stato === undefined || inFila === undefined || !eDi(stato, conversazioneId)) {
    await ctx.deposito.scriviSospeso(conversazioneId, undefined);
    return undefined;
  }

  // Lo stato prima, il cursore poi. La nota resta: la toglie `sincronizza`
  // quando ha riavvolto il mazzo e consegnato gli inviti.
  await salva(ctx, {
    catena: await catenaDelSospeso(sospeso, stato),
    conversazioneId,
    stato,
  });
  await ctx.deposito.scriviCursore(conversazioneId, inFila.id);
  return stato;
}

/** Apre una conversazione che esiste già su questo dispositivo. */
export async function riprendi(
  ctx: Contesto,
  conversazioneId: string,
): Promise<Sessione | undefined> {
  const stato =
    (await ripristina(ctx, conversazioneId)) ?? (await riprendiDalSospeso(ctx, conversazioneId));
  if (stato === undefined) {
    return undefined;
  }

  if (toltoDalGruppo(stato)) {
    return { catena: undefined, conversazioneId, stato, tolto: true };
  }

  // Il mazzo si apre **prima** di sincronizzare, se è ancora all'epoch del
  // proprio stato: è così che chi resta indietro lo porta avanti riavvolgendolo
  // sotto l'epoch nuova. Se non si apre adesso, si riprova dopo, all'epoch
  // raggiunta — che è il caso di chi ritrova il mazzo già riavvolto da altri.
  //
  // **Chi una catena la conosce già la cambia soltanto con una che la
  // estende.** Il mazzo dell'istanza è la parola dell'istanza, e di chi l'ha
  // riavvolto per ultimo: uno che non comincia con le chiavi note toglierebbe
  // la cronologia a questo dispositivo e, al prossimo cambio di epoch, a tutti.
  const prima = catenaDaTenere(
    await catenaNota(ctx, stato, conversazioneId),
    await catenaDi(ctx, stato, conversazioneId),
  );
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
   * **Chi** ci si aspetta che entri. La chiave d'ingresso arriva da una casa,
   * e una casa può mandarne una di qualcun altro: se la credenziale dentro il
   * `KeyPackage` non nomina questa persona, non entra nessuno.
   */
  membro: Membro;
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
  sospeso: CommitInSospeso,
): Promise<void> {
  if (sospeso.welcome === undefined) {
    return;
  }

  for (const destinatario of sospeso.destinatari) {
    await ctx.istanza.depositaHandshake(conversazioneId, {
      busta: sospeso.welcome,
      destinatario,
      epoch: sospeso.epoch,
      tipo: "welcome",
    });
  }
}

/** Una chiave d'ingresso che dice di essere di qualcun altro. */
export class ChiaveDiUnAltro extends Error {
  public readonly code = "chiave_di_un_altro";

  public constructor() {
    // Il messaggio è il codice: la frase la sceglie chi lo mostra (ADR 0046).
    super("chiave_di_un_altro");
  }
}

/** La chiave d'ingresso nomina la persona che ci si aspetta? */
export function eDiChiSiAspetta(ingresso: Ingresso): boolean {
  const suo = diChiE(ingresso.keyPackage);
  return suo !== undefined && scriviIdentita(suo) === scriviIdentita(ingresso.membro);
}

/**
 * Ogni chiave d'ingresso dev'essere **di chi ci si aspetta**: una che nomina
 * un altro si rifiuta, invece di far entrare qualcuno sotto il nome sbagliato.
 * Vale alla creazione come per ogni foglia che entra dopo.
 */
function soloDiChiSiAspetta(ingressi: readonly Ingresso[]): void {
  if (!ingressi.every(eDiChiSiAspetta)) {
    throw new ChiaveDiUnAltro();
  }
}

/** Questo dispositivo aspetta ancora il sì di uno già approvato (ADR 0040). */
export class DispositivoInAttesa extends Error {
  public readonly code = "dispositivo_in_attesa";

  public constructor() {
    // Il messaggio è il codice: la frase la sceglie chi lo mostra (ADR 0046).
    super("dispositivo_in_attesa");
  }
}

/**
 * La propria chiave di firma è nel registro della casa?
 *
 * Chi crea un gruppo o rientra porta **da sé** la propria foglia davanti agli
 * altri, che la autenticano contro il registro: una chiave che aspetta ancora
 * il sì verrebbe rifiutata da tutti, e il suo commit resterebbe in fila davanti
 * a ogni altro.
 */
async function richiediIlSi(ctx: Contesto, io: IdentitaDispositivo): Promise<void> {
  const membro = diChiE(io.publicPackage);
  const mia = io.publicPackage.leafNode.signaturePublicKey;
  const registro = membro === undefined ? [] : await ctx.istanza.chiaviDiFirmaDi(membro);
  if (!registro.some((chiave) => stessiByte(chiave, mia))) {
    throw new DispositivoInAttesa();
  }
}

/** Un invito, o un punto di rientro, che porta in un'altra conversazione. */
export class DiUnAltraConversazione extends Error {
  public readonly code = "di_un_altra_conversazione";

  public constructor() {
    // Il messaggio è il codice: la frase la sceglie chi lo mostra (ADR 0046).
    super("di_un_altra_conversazione");
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
  soloDiChiSiAspetta(ingressi);

  const io = await ctx.io.perNuovaFoglia();
  await richiediIlSi(ctx, io);

  const creato = await creaConversazione(conversazioneId, io, ctx.istanza);
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

  // Il commit si annota, poi va in fila, e **solo allora** lo stato si salva.
  // Se un altro l'ha preceduto sulla stessa epoch la fila lo rifiuta (ADR 0042
  // §3), e qui non resta un gruppo che nessun altro conosce; se la risposta
  // non arriva, lo dirà `riprendi`.
  const sospeso = await annota(ctx, sessione, aggiunta, ingressi);
  await deposita(ctx, conversazioneId, sospeso);
  await concludi(ctx, sessione, sospeso);

  return sessione;
}

/** Crea la conversazione e ci fa entrare una persona: la chat a due. */
export async function apri(
  ctx: Contesto,
  conversazioneId: string,
  chiEntra: KeyPackage,
  idDiChiEntra: string,
  membro: Membro,
): Promise<Sessione> {
  return apriCon(ctx, conversazioneId, [
    { destinatario: idDiChiEntra, keyPackage: chiEntra, membro },
  ]);
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

    // Qui passa ogni foglia che entra in un gruppo che esiste: nessuna con
    // una chiave che nomina un altro.
    soloDiChiSiAspetta(cambio.entrano);

    const esito = await cambiaFoglie(
      attuale.stato,
      { entrano: cambio.entrano.map((i) => i.keyPackage), escono: cambio.escono },
      ctx.istanza,
    );

    // A ogni rimozione la catena guadagna una chiave (ADR 0052 §2): chi è
    // stato tolto tiene quelle che aveva, e non ottiene questa.
    const catena =
      attuale.catena !== undefined && qualcunoTolto(attuale.stato, esito.stato)
        ? catenaRuotata(attuale.catena, await chiaveDiRotazione(esito.stato))
        : attuale.catena;
    const aggiornata: Sessione = { ...attuale, catena, stato: esito.stato };

    // Annotato, poi in fila, e **solo allora** salvato: uno stato che la fila
    // ha rifiutato è un gruppo che nessun altro conosce.
    const sospeso = await annota(ctx, aggiornata, esito, cambio.entrano);
    try {
      await deposita(ctx, attuale.conversazioneId, sospeso);
    } catch (causa) {
      if (!superata(causa) || tentativo >= TENTATIVI) {
        throw causa;
      }
      attuale = await sincronizza(ctx, attuale);
      continue;
    }

    await concludi(ctx, aggiornata, sospeso);
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
  // Chi entra è `membro`, qualunque cosa dica l'ingresso: è di lui che si
  // tolgono le foglie vecchie.
  const chi = scriviIdentita(membro);
  if (ingressi.some((i) => scriviIdentita(i.membro) !== chi)) {
    throw new ChiaveDiUnAltro();
  }
  soloDiChiSiAspetta(ingressi);

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

/**
 * Fa entrare una foglia in una conversazione che esiste già.
 *
 * Resta per la chat a due; i gruppi e i dispositivi usano
 * [`aggiungiFoglie`](#aggiungiFoglie), che toglie anche le foglie di prima.
 * Di chi è la chiave si controlla comunque: `membro` è chi ci si aspetta.
 */
export async function aggiungiMembro(
  ctx: Contesto,
  sessione: Sessione,
  chiEntra: KeyPackage,
  idDiChiEntra: string,
  membro: Membro,
): Promise<Sessione> {
  return commitDiFoglie(ctx, sessione, () => ({
    entrano: [{ destinatario: idDiChiEntra, keyPackage: chiEntra, membro }],
    escono: [],
  }));
}

/**
 * Entra da un Welcome trovato sul canale.
 *
 * `undefined` quando quel Welcome non chiama nessuna chiave di questo
 * dispositivo. Non è un guasto e non si tira a indovinare: succede a chi ha
 * cancellato il browser, e la via che gli resta è il rientro.
 *
 * Un Welcome che porta in **un'altra conversazione** è invece un guasto, e si
 * dice ([`DiUnAltraConversazione`](#DiUnAltraConversazione)).
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
  // Un invito trovato sul canale di questa conversazione deve portare **in
  // questa**: uno che porta in un altro gruppo si rifiuta prima di salvare
  // qualunque cosa, o il suo stato finirebbe sotto il nome di questa.
  if (!eDi(stato, conversazioneId)) {
    throw new DiUnAltraConversazione();
  }

  const catena = await catenaDi(ctx, stato, conversazioneId);
  const sessione: Sessione = { catena, conversazioneId, stato };

  // Chi entra da un invito non ha più niente in sospeso: quello che c'era era
  // di un gruppo che non è questo.
  await ctx.deposito.scriviSospeso(conversazioneId, undefined);
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

  // Chi aspetta il sì non rientra: il suo commit lo rifiuterebbero tutti, e la
  // fila resterebbe ferma su quella busta.
  const io = await ctx.io.perNuovaFoglia();
  await richiediIlSi(ctx, io);

  const tornata = await rientra(daB64(punto.groupInfo), io, ctx.istanza);
  if (!eDi(tornata.stato, conversazioneId)) {
    throw new DiUnAltraConversazione();
  }

  // Come ogni commit proprio: annotato, in fila, e solo allora salvato.
  const sessione: Sessione = { catena: undefined, conversazioneId, stato: tornata.stato };
  const sospeso = await annota(ctx, sessione, tornata, []);
  await deposita(ctx, conversazioneId, sospeso);
  await salva(ctx, sessione);
  await ctx.deposito.scriviSospeso(conversazioneId, undefined);

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
