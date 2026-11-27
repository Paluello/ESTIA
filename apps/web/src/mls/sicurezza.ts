/**
 * Chi è verificato, e che cosa si mostra a chi vuole confrontare
 * ([ADR 0050](../../../../docs/adr/0050-il-numero-di-sicurezza.md)).
 *
 * Il calcolo sta in [`numero-di-sicurezza`](./numero-di-sicurezza.ts); qui c'è
 * il suo contorno: da dove vengono le chiavi, dove si ricorda un «verificato»,
 * e quando quel ricordo smette di valere.
 *
 * **La verifica è della persona, non della conversazione.** Si conserva sotto
 * la sua identità `<username>@<casa>` e nient'altro: chi è verificato lo resta
 * nei messaggi privati e in ogni gruppo, che è la risposta del proprietario del
 * 2026-09-17.
 *
 * **Si ricorda la metà del numero che è sua, non il numero intero.** Il numero
 * intero cambia anche quando chi guarda aggiunge un dispositivo, e avvisare
 * allora di ogni contatto verificato sarebbe gridare al lupo per una cosa che
 * si è fatta da soli. La sua metà cambia soltanto se cambiano le sue chiavi.
 *
 * **Sta nel cassetto del dispositivo**, accanto alla chiave di firma: stesso
 * posto, stessa vita. L'uscita lo svuota ([`dimentica`](./dispositivo.ts)), e
 * chi entra dopo sullo stesso browser non eredita la fiducia di chi è uscito.
 * Non si deposita sull'istanza: un «verificato» custodito da chi tiene il
 * registro sarebbe una verifica che il registro può scrivere da solo.
 *
 * Come i suoi vicini non conosce né IndexedDB né `fetch`.
 */
import { chiavePubblicaDiFirma, type Cassetto } from "./dispositivo.js";
import { scriviIdentita, type Membro } from "./gruppo.js";
import { chiaviDistinte, improntaDi, numeroDiSicurezza } from "./numero-di-sicurezza.js";

export interface Dipendenze {
  cassetto: Cassetto;
  /** Il registro delle chiavi di firma: lo stesso su cui poggia l'`AuthenticationService`. */
  chiaviDiFirmaDi: (membro: Membro) => Promise<readonly Uint8Array[]>;
  adesso?: () => Date;
}

/**
 * - `non-verificato`: nessuno ha mai confrontato.
 * - `verificato`: confrontato, e le sue chiavi sono ancora quelle.
 * - `cambiato`: confrontato, e le sue chiavi **non** sono più quelle.
 */
export type StatoVerifica = "non-verificato" | "verificato" | "cambiato";

export type Sicurezza =
  | {
      kind: "pronto";
      /** Le sessanta cifre della coppia. */
      numero: string;
      /** La metà dell'altra persona: è ciò che si conserva segnandola verificata. */
      impronta: string;
      stato: StatoVerifica;
      /** Quando è stata verificata l'ultima volta, se lo è stata. */
      verificatoIl?: string;
      /** Quante chiavi distinte entrano nel numero, per parte. */
      dispositivi: { miei: number; suoi: number };
    }
  /** L'altra persona non ha un dispositivo approvato: non c'è niente da confrontare. */
  | { kind: "senza-chiavi"; stato: StatoVerifica; verificatoIl?: string }
  /**
   * La chiave di **questo** dispositivo non è fra quelle che il registro
   * dichiara per chi guarda: aspetta ancora il sì di ADR 0040, oppure il
   * registro la tace. In tutti e due i casi il numero non parlerebbe di lui.
   */
  | { kind: "non-approvato" };

interface Voce {
  impronta: string;
  verificatoIl: string;
}

interface Registro {
  v: 1;
  voci: Record<string, Voce>;
}

const CHIAVE = "verifiche_sicurezza";

async function leggiRegistro(cassetto: Cassetto): Promise<Registro> {
  const letto = (await cassetto.leggi(CHIAVE)) as Registro | undefined;
  return letto?.v === 1 ? letto : { v: 1, voci: {} };
}

function statoDi(voce: Voce | undefined, impronta: string | undefined): StatoVerifica {
  if (voce === undefined) {
    return "non-verificato";
  }
  return voce.impronta === impronta ? "verificato" : "cambiato";
}

const uguali = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Le identità che questo dispositivo ha segnato verificate, e quando. */
export async function verificati(cassetto: Cassetto): Promise<ReadonlyMap<string, string>> {
  const registro = await leggiRegistro(cassetto);
  return new Map(Object.entries(registro.voci).map(([chi, voce]) => [chi, voce.verificatoIl]));
}

/**
 * Che cosa mostrare a chi vuole confrontare il numero con `altro`.
 *
 * Chiede al registro le chiavi di **tutti e due**, anche le proprie: il numero
 * deve venire uguale dai due lati, e l'altro lato le mie chiavi le conosce
 * soltanto dal registro.
 */
export async function leggiSicurezza(
  dip: Dipendenze,
  io: Membro,
  altro: Membro,
): Promise<Sicurezza> {
  const [mie, sue, questa, registro] = await Promise.all([
    dip.chiaviDiFirmaDi(io),
    dip.chiaviDiFirmaDi(altro),
    chiavePubblicaDiFirma(dip.cassetto),
    leggiRegistro(dip.cassetto),
  ]);

  if (questa === undefined || !mie.some((chiave) => uguali(chiave, questa))) {
    return { kind: "non-approvato" };
  }

  const voce = registro.voci[scriviIdentita(altro)];
  const verificatoIl = voce === undefined ? {} : { verificatoIl: voce.verificatoIl };

  if (sue.length === 0) {
    return { kind: "senza-chiavi", stato: statoDi(voce, undefined), ...verificatoIl };
  }

  const impronta = improntaDi({ chiavi: sue, membro: altro });

  return {
    dispositivi: { miei: chiaviDistinte(mie).length, suoi: chiaviDistinte(sue).length },
    impronta,
    kind: "pronto",
    numero: numeroDiSicurezza({ chiavi: mie, membro: io }, { chiavi: sue, membro: altro }),
    stato: statoDi(voce, impronta),
    ...verificatoIl,
  };
}

/**
 * Segna `altro` verificato **per l'impronta che si è appena confrontata**.
 *
 * L'impronta arriva da chi chiama e non si ricalcola qui: fra lo sguardo e il
 * tocco il registro potrebbe essere cambiato, e si deve ricordare ciò che la
 * persona ha letto a voce, non ciò che il registro dice un attimo dopo.
 */
export async function segnaVerificato(
  dip: Pick<Dipendenze, "cassetto" | "adesso">,
  altro: Membro,
  impronta: string,
): Promise<void> {
  // Si rilegge prima di scrivere: due schede aperte sono due copie.
  const registro = await leggiRegistro(dip.cassetto);
  registro.voci[scriviIdentita(altro)] = {
    impronta,
    verificatoIl: (dip.adesso?.() ?? new Date()).toISOString(),
  };
  await dip.cassetto.scrivi(CHIAVE, registro);
}

/** Toglie la verifica: da qui in poi `altro` è una persona mai confrontata. */
export async function togliVerifica(cassetto: Cassetto, altro: Membro): Promise<void> {
  const registro = await leggiRegistro(cassetto);
  registro.voci = Object.fromEntries(
    Object.entries(registro.voci).filter(([chi]) => chi !== scriviIdentita(altro)),
  );
  await cassetto.scrivi(CHIAVE, registro);
}

/** Cede il passo: cinquemila giri di SHA-512 per persona non devono fermare la pagina. */
const respira = (): Promise<void> => new Promise((risolvi) => setTimeout(risolvi, 0));

/**
 * Fra questi membri, i verificati le cui chiavi non sono più quelle.
 *
 * È ciò che fa comparire l'avviso in una conversazione. Chiede il registro
 * **solo** per chi è verificato: per gli altri non c'è niente con cui
 * confrontare, e sarebbe una domanda alla loro casa per niente.
 *
 * Un registro che non risponde non è un cambio: quel membro si salta, e
 * l'avviso arriva al giro dopo. Un registro che risponde «nessuna chiave» sì.
 */
export async function cambiati(
  dip: Pick<Dipendenze, "cassetto" | "chiaviDiFirmaDi">,
  membri: readonly Membro[],
): Promise<Membro[]> {
  const registro = await leggiRegistro(dip.cassetto);
  const trovati: Membro[] = [];

  for (const membro of membri) {
    const voce = registro.voci[scriviIdentita(membro)];
    if (voce === undefined) {
      continue;
    }

    let chiavi: readonly Uint8Array[];
    try {
      chiavi = await dip.chiaviDiFirmaDi(membro);
    } catch {
      continue;
    }

    await respira();
    if (chiavi.length === 0 || improntaDi({ chiavi, membro }) !== voce.impronta) {
      trovati.push(membro);
    }
  }

  return trovati;
}
