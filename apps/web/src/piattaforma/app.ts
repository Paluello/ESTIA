/**
 * Il client web dentro l'app ESTIA ([ADR 0044](../../../../docs/adr/0044-il-dispositivo-e-l-app.md)).
 *
 * Lo stesso codice gira in due posti: nel browser, servito dalla Casa in rete
 * locale, e nella WebView dell'app (`apps/app`), dove la Casa si raggiunge per
 * chiave via iroh. Questo modulo è l'unico punto che sa quale dei due: il resto
 * del client chiama `chiedi` invece di `fetch`, e riceve un cassetto e un
 * deposito senza sapere dove stanno.
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * Vero solo nella build dell'app (`vite build --mode app`) **e** dentro Tauri.
 * La doppia condizione tiene fuori il codice dell'app dalla build della Casa e
 * protegge dal caso di una build dell'app aperta in un browser qualunque.
 */
export function inApp(): boolean {
  return (
    typeof __ESTIA_APP__ !== "undefined" && __ESTIA_APP__ && "__TAURI_INTERNALS__" in globalThis
  );
}

/* --------------------------------- byte ---------------------------------- */

export function bytesInBase64(byte: Uint8Array): string {
  let s = "";
  for (let i = 0; i < byte.length; i += 0x8000) {
    s += String.fromCharCode(...byte.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64InBytes(testo: string): Uint8Array<ArrayBuffer> {
  const grezzo = atob(testo);
  const out = new Uint8Array(grezzo.length);
  for (let i = 0; i < grezzo.length; i++) out[i] = grezzo.charCodeAt(i);
  return out;
}

/* -------------------------------- il filo -------------------------------- */

interface RispostaNativa {
  stato: number;
  intestazioni: Record<string, string>;
  corpo: string;
}

async function corpoInBase64(corpo: BodyInit | null | undefined): Promise<string | null> {
  if (corpo === undefined || corpo === null) return null;
  if (typeof corpo === "string") return bytesInBase64(new TextEncoder().encode(corpo));
  if (corpo instanceof Blob) return bytesInBase64(new Uint8Array(await corpo.arrayBuffer()));
  if (corpo instanceof ArrayBuffer) return bytesInBase64(new Uint8Array(corpo));
  if (ArrayBuffer.isView(corpo)) {
    return bytesInBase64(new Uint8Array(corpo.buffer, corpo.byteOffset, corpo.byteLength));
  }
  throw new Error("corpo di richiesta non supportato dal filo dell'app");
}

/** Una funzione, non un confronto: TypeScript non sa che `aborted` cambia durante un `await`. */
function annullata(segnale: AbortSignal | undefined): boolean {
  return segnale?.aborted === true;
}

function interrotta(): DOMException {
  return new DOMException("aborted", "AbortError");
}

/**
 * Una richiesta all'API della Casa. Nel browser è `fetch`; nell'app passa dal
 * lato nativo, che la porta sullo stream iroh `estia/dispositivo/1`. La forma
 * è quella di `fetch`, così chi chiama non cambia.
 *
 * Nell'app non partono `authorization` né cookie: l'identità è la chiave del
 * dispositivo, e il lato nativo le toglie comunque.
 */
export async function chiedi(percorso: string, init: RequestInit = {}): Promise<Response> {
  if (!inApp()) return fetch(percorso, init);

  const segnale = init.signal ?? undefined;
  if (annullata(segnale)) throw interrotta();

  const intestazioni: Record<string, string> = {};
  new Headers(init.headers).forEach((valore, nome) => {
    intestazioni[nome] = valore;
  });

  const risposta = await invoke<RispostaNativa>("richiesta", {
    corpo: await corpoInBase64(init.body),
    intestazioni,
    metodo: init.method ?? "GET",
    percorso,
  });
  if (annullata(segnale)) throw interrotta();

  const senzaCorpo = risposta.stato === 204 || risposta.stato === 304;
  return new Response(senzaCorpo ? null : base64InBytes(risposta.corpo), {
    headers: risposta.intestazioni,
    status: risposta.stato,
  });
}

/* ------------------------------ l'ingresso ------------------------------- */

/** Che cosa il lato nativo dice di sé all'avvio. */
export interface AmbienteApp {
  os: string;
  versione: string;
  /** La chiave della Casa, se il dispositivo è già entrato. */
  casa: string | null;
  errore_cassaforte: string | null;
}

export function ambienteApp(): Promise<AmbienteApp> {
  return invoke<AmbienteApp>("ambiente");
}

/**
 * Nell'app non c'è un token di sessione: la sessione sta nella Casa, legata
 * alla chiave del dispositivo, e il filo non manda `authorization`. Il client
 * però è scritto attorno a un token, e questo è il segnaposto che lo soddisfa.
 */
export const TOKEN_APP = "app";

/**
 * Presenta alla Casa il collegamento del QR (`estia://ingresso?...`). Ritorna
 * l'utente come la Casa lo descrive. Un rifiuto non dice perché: la Casa non
 * lo dice nemmeno a noi.
 */
export function entraConCollegamento(collegamento: string, etichetta: string): Promise<unknown> {
  return invoke("ingresso", { collegamento, etichetta });
}

/** Il dispositivo dimentica la Casa. La revoca vera la fa la Casa. */
export function dimenticaCasa(): Promise<void> {
  return invoke("dimentica_casa");
}
