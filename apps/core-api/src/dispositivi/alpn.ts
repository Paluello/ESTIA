import {
  ALPN_DISPOSITIVO,
  ALPN_INGRESSO,
  FRAME_MAX_CORPO_RICHIESTA,
  FRAME_MAX_INTESTAZIONE,
  codificaFrame,
  decodificaFrame,
  type RichiestaSuStream,
} from "@estia/contracts";

import { DomainError, errorBody } from "../errors.js";
import type { AlpnService, IrohConnection, IrohStream } from "../federation/endpoint.js";
import type { AccessoDispositivi } from "./accesso.js";
import { INTESTAZIONE_CANALE, conContrassegno } from "./canale.js";

/**
 * Le due porte del Dispositivo sull'endpoint della Casa ([ADR 0044](../../../../docs/adr/0044-il-dispositivo-e-l-app.md) §4).
 *
 * - `estia/ingresso/1`: una chiave nuova presenta il codice del QR, una volta.
 * - `estia/dispositivo/1`: una chiave registrata parla l'API dei membri, la
 *   stessa delle rotte HTTP, una richiesta per stream.
 *
 * Su tutte e due, chi non ha diritto riceve **una connessione chiusa e
 * nient'altro**: nessun codice d'errore, nessun testo, niente che distingua
 * «chiave sconosciuta» da «codice scaduto» da «non c'è nessuno».
 */

/** Quanto si aspetta la domanda d'ingresso prima di chiudere. */
const ATTESA_INGRESSO_MS = 10_000;

/** Quanto la Casa lascia aperta una connessione d'ingresso dopo aver risposto. */
const CHIUSURA_DOPO_ESITO_MS = 5_000;

/**
 * Quanto si aspetta che una richiesta arrivi tutta. Largo, perché un'immagine
 * da qualche MiB via relay su dati mobili ci mette; ma finito, perché uno
 * stream aperto e mai chiuso non tenga memoria per sempre.
 */
const ATTESA_RICHIESTA_MS = 120_000;

/** Quante richieste una connessione porta insieme. Le altre aspettano il loro turno. */
const STREAM_PER_CONNESSIONE = 8;

/** Quante connessioni aperte insieme una chiave. Un'app ne usa una. */
const CONNESSIONI_PER_CHIAVE = 4;

/** La domanda d'ingresso è un JSON piccolo: codice ed etichetta. */
const MAX_DOMANDA_INGRESSO = 4 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function chiudi(connection: IrohConnection): void {
  try {
    connection.close(0n, []);
  } catch {
    // Già chiusa: è l'esito che si voleva.
  }
}

async function entro<T>(ms: number, promessa: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promessa,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("tempo scaduto")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ServizioIngresso implements AlpnService {
  public readonly alpn = ALPN_INGRESSO;

  readonly #accesso: AccessoDispositivi;

  public constructor(accesso: AccessoDispositivi) {
    this.#accesso = accesso;
  }

  public async serve(connection: IrohConnection): Promise<void> {
    try {
      const chiave = connection.remoteId().toString();
      const stream = await entro(ATTESA_INGRESSO_MS, connection.acceptBi());
      const bytes = await entro(ATTESA_INGRESSO_MS, stream.recv.readToEnd(MAX_DOMANDA_INGRESSO));
      const domanda = JSON.parse(decoder.decode(Uint8Array.from(bytes))) as unknown;

      if (
        typeof domanda !== "object" ||
        domanda === null ||
        typeof (domanda as { codice?: unknown }).codice !== "string" ||
        typeof (domanda as { etichetta?: unknown }).etichetta !== "string"
      ) {
        chiudi(connection);
        return;
      }

      const { codice, etichetta } = domanda as { codice: string; etichetta: string };
      const esito = this.#accesso.ammetti(chiave, codice, etichetta);

      if (esito === undefined) {
        chiudi(connection);
        return;
      }

      await stream.send.writeAll(Array.from(encoder.encode(JSON.stringify(esito))));
      await stream.send.finish();
      // Chi chiude è il dispositivo, quando ha letto: chiudere da qui adesso
      // potrebbe portarsi via la risposta prima che arrivi. Se non lo fa, lo
      // fa la Casa fra poco.
      setTimeout(() => chiudi(connection), CHIUSURA_DOPO_ESITO_MS).unref();
    } catch {
      chiudi(connection);
    }
  }
}

/** Ciò che serve delle rotte: `app.inject()` di Fastify. */
export interface Iniettore {
  inject(opzioni: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: Buffer;
  }): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | number | undefined>;
    rawPayload: Buffer;
  }>;
}

const METODI = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Intestazioni che il dispositivo non può scegliere: l'identità la decide la
 * chiave, la lunghezza la calcola chi inietta, il resto non ha senso su uno
 * stream.
 */
const INTESTAZIONI_VIETATE = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "transfer-encoding",
  INTESTAZIONE_CANALE,
]);

/** Le intestazioni della risposta che non hanno senso fuori da HTTP. */
const INTESTAZIONI_DI_HTTP = new Set([
  "connection",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
]);

/**
 * Il percorso che si inietta, già normalizzato, o `undefined`.
 *
 * Normalizzato **qui** e iniettato normalizzato: `app.inject()` passa il
 * percorso a `new URL()`, che risolve anche i dot-segment codificati —
 * `/api/%2e%2e/health/live` diventa `/health/live`. Controllare il testo grezzo
 * non basta; si controlla quello che le rotte vedranno.
 */
function percorsoValido(percorso: string): string | undefined {
  // ASCII stampabile soltanto: il resto va codificato con %, come in un URL.
  if (
    !/^[!-~]+$/.test(percorso) ||
    !percorso.startsWith("/api/") ||
    percorso.includes("\\") ||
    /%2e/i.test(percorso) ||
    /%2f/i.test(percorso) ||
    /%5c/i.test(percorso)
  ) {
    return undefined;
  }

  let url: URL;

  try {
    url = new URL(percorso, "http://casa.invalid");
  } catch {
    return undefined;
  }

  const normalizzato = `${url.pathname}${url.search}`;

  return url.origin === "http://casa.invalid" &&
    url.pathname.startsWith("/api/") &&
    normalizzato === percorso
    ? normalizzato
    : undefined;
}

function richiestaValida(intestazione: unknown): RichiestaSuStream | undefined {
  if (typeof intestazione !== "object" || intestazione === null) {
    return undefined;
  }

  const { metodo, percorso, intestazioni } = intestazione as Record<string, unknown>;

  if (
    typeof metodo !== "string" ||
    !METODI.has(metodo) ||
    typeof percorso !== "string" ||
    // Solo l'API: il client web, l'OpenAPI e i controlli di salute non sono
    // cose che un Dispositivo chiede.
    percorsoValido(percorso) === undefined ||
    typeof intestazioni !== "object" ||
    intestazioni === null ||
    Array.isArray(intestazioni)
  ) {
    return undefined;
  }

  const pulite: Record<string, string> = {};

  for (const [nome, valore] of Object.entries(intestazioni)) {
    const minuscolo = nome.toLowerCase();

    if (
      typeof valore !== "string" ||
      INTESTAZIONI_VIETATE.has(minuscolo) ||
      minuscolo.startsWith("x-forwarded-") ||
      !/^[a-z0-9-]+$/.test(minuscolo) ||
      /[\r\n]/.test(valore)
    ) {
      continue;
    }

    pulite[minuscolo] = valore;
  }

  return { intestazioni: pulite, metodo, percorso };
}

/** Un semaforo minimo: `prendi` aspetta un posto, `lascia` lo restituisce. */
class Posti {
  #liberi: number;
  readonly #inAttesa: (() => void)[] = [];

  public constructor(posti: number) {
    this.#liberi = posti;
  }

  public async prendi(): Promise<void> {
    if (this.#liberi > 0) {
      this.#liberi -= 1;
      return;
    }

    await new Promise<void>((resolve) => this.#inAttesa.push(resolve));
  }

  public lascia(): void {
    const prossimo = this.#inAttesa.shift();

    if (prossimo === undefined) {
      this.#liberi += 1;
    } else {
      prossimo();
    }
  }
}

export class ServizioDispositivo implements AlpnService {
  public readonly alpn = ALPN_DISPOSITIVO;

  readonly #accesso: AccessoDispositivi;
  readonly #rotte: Iniettore;
  readonly #maxCorpo: number;
  readonly #aperte = new Map<string, number>();

  /**
   * `maxCorpo` è il corpo più grande che una rotta accetta: leggerne di più
   * vorrebbe dire tenere in memoria qualcosa che Fastify rifiuterebbe comunque.
   */
  public constructor(accesso: AccessoDispositivi, rotte: Iniettore, maxCorpo: number) {
    this.#accesso = accesso;
    this.#rotte = rotte;
    this.#maxCorpo = Math.min(maxCorpo, FRAME_MAX_CORPO_RICHIESTA);
  }

  public async serve(connection: IrohConnection): Promise<void> {
    let chiave: string | undefined;

    try {
      chiave = connection.remoteId().toString();

      // Prima di leggere qualunque cosa: una chiave che non apre niente non
      // riceve nemmeno un rifiuto.
      if (this.#accesso.sessioneDi(chiave) === undefined) {
        chiave = undefined;
        chiudi(connection);
        return;
      }

      const aperte = this.#aperte.get(chiave) ?? 0;

      if (aperte >= CONNESSIONI_PER_CHIAVE) {
        chiave = undefined;
        chiudi(connection);
        return;
      }

      this.#aperte.set(chiave, aperte + 1);

      const posti = new Posti(STREAM_PER_CONNESSIONE);

      for (;;) {
        // Il posto si prende prima di accettare: quando sono tutti occupati,
        // gli stream nuovi restano in coda nel QUIC invece che in memoria qui.
        await posti.prendi();

        let stream: IrohStream;

        try {
          stream = await connection.acceptBi();
        } catch (error) {
          posti.lascia();
          throw error;
        }

        // Una revoca vale dalla richiesta dopo, su una connessione già aperta.
        const sessionId = this.#accesso.sessioneDi(chiave);

        if (sessionId === undefined) {
          posti.lascia();
          chiudi(connection);
          return;
        }

        void this.#gestisci(stream, sessionId, chiave, connection).finally(() => posti.lascia());
      }
    } catch {
      // La connessione è finita, che è come finiscono le connessioni.
      chiudi(connection);
    } finally {
      if (chiave !== undefined) {
        const rimaste = (this.#aperte.get(chiave) ?? 1) - 1;

        if (rimaste <= 0) {
          this.#aperte.delete(chiave);
        } else {
          this.#aperte.set(chiave, rimaste);
        }
      }
    }
  }

  async #gestisci(
    stream: IrohStream,
    sessionId: string,
    chiave: string,
    connection: IrohConnection,
  ): Promise<void> {
    try {
      let bytes: number[];

      try {
        bytes = await entro(
          ATTESA_RICHIESTA_MS,
          stream.recv.readToEnd(4 + FRAME_MAX_INTESTAZIONE + this.#maxCorpo),
        );
      } catch {
        // Troppo grande, o troppo lenta: la connessione si chiude, perché lo
        // stream non si può abbandonare senza che resti a occupare memoria.
        chiudi(connection);
        return;
      }

      let richiesta: RichiestaSuStream | undefined;
      let corpo: Uint8Array = new Uint8Array();

      try {
        const frame = decodificaFrame(Uint8Array.from(bytes));
        richiesta = richiestaValida(frame.intestazione);
        corpo = frame.corpo;
      } catch {
        richiesta = undefined;
      }

      if (richiesta === undefined) {
        await this.#rispondi(
          stream,
          400,
          { "content-type": "application/json; charset=utf-8" },
          encoder.encode(
            JSON.stringify(errorBody(new DomainError("richiesta_su_stream_non_valida", 400))),
          ),
        );
        return;
      }

      const valida = richiesta;
      const risposta = await conContrassegno({ chiave, sessionId }, (nonce) =>
        this.#rotte.inject({
          headers: { ...valida.intestazioni, [INTESTAZIONE_CANALE]: nonce },
          method: valida.metodo,
          url: valida.percorso,
          ...(corpo.length === 0 ? {} : { payload: Buffer.from(corpo) }),
        }),
      );

      const intestazioni: Record<string, string> = {};

      for (const [nome, valore] of Object.entries(risposta.headers)) {
        if (valore === undefined || INTESTAZIONI_DI_HTTP.has(nome.toLowerCase())) {
          continue;
        }

        intestazioni[nome.toLowerCase()] = Array.isArray(valore)
          ? valore.join(", ")
          : String(valore);
      }

      await this.#rispondi(stream, risposta.statusCode, intestazioni, risposta.rawPayload);
    } catch {
      // Lo stream è andato: l'app ripete, se le serve.
    }
  }

  async #rispondi(
    stream: IrohStream,
    stato: number,
    intestazioni: Record<string, string>,
    corpo: Uint8Array,
  ): Promise<void> {
    await stream.send.writeAll(Array.from(codificaFrame({ intestazioni, stato }, corpo)));
    await stream.send.finish();
  }
}
