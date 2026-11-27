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
import { INTESTAZIONE_CANALE, contrassegna } from "./canale.js";

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
      // potrebbe portarsi via la risposta prima che arrivi.
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
    !percorso.startsWith("/api/") ||
    percorso.includes("..") ||
    // ASCII stampabile soltanto: il resto va codificato con %, come in un URL.
    !/^[!-~]+$/.test(percorso) ||
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

export class ServizioDispositivo implements AlpnService {
  public readonly alpn = ALPN_DISPOSITIVO;

  readonly #accesso: AccessoDispositivi;
  readonly #rotte: Iniettore;

  public constructor(accesso: AccessoDispositivi, rotte: Iniettore) {
    this.#accesso = accesso;
    this.#rotte = rotte;
  }

  public async serve(connection: IrohConnection): Promise<void> {
    const chiave = connection.remoteId().toString();

    // Prima di leggere qualunque cosa: una chiave che non apre niente non
    // riceve nemmeno un rifiuto.
    if (this.#accesso.sessioneDi(chiave) === undefined) {
      chiudi(connection);
      return;
    }

    try {
      for (;;) {
        const stream = await connection.acceptBi();

        // Una revoca vale dalla richiesta dopo, su una connessione già aperta.
        const sessionId = this.#accesso.sessioneDi(chiave);

        if (sessionId === undefined) {
          chiudi(connection);
          return;
        }

        void this.#gestisci(stream, sessionId, chiave);
      }
    } catch {
      // La connessione è finita, che è come finiscono le connessioni.
    }
  }

  async #gestisci(stream: IrohStream, sessionId: string, chiave: string): Promise<void> {
    try {
      const bytes = await stream.recv.readToEnd(
        4 + FRAME_MAX_INTESTAZIONE + FRAME_MAX_CORPO_RICHIESTA,
      );
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

      const risposta = await this.#rotte.inject({
        headers: {
          ...richiesta.intestazioni,
          [INTESTAZIONE_CANALE]: contrassegna({ chiave, sessionId }),
        },
        method: richiesta.metodo,
        url: richiesta.percorso,
        ...(corpo.length === 0 ? {} : { payload: Buffer.from(corpo) }),
      });

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
