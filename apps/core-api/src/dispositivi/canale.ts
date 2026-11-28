import { randomBytes } from "node:crypto";

import type { FastifyRequest } from "fastify";

/**
 * Il contrassegno che una richiesta portata da uno stream iroh si porta dietro
 * quando entra nelle rotte di sempre con `app.inject()` (ADR 0044 §4: «la
 * stessa API, cambia il trasporto»).
 *
 * Le rotte autenticano con un token di sessione, e un Dispositivo non ne ha
 * uno: la sua credenziale è la chiave di rete, che QUIC prova a ogni
 * connessione. Il canale quindi dice a `requireAuth` **quale sessione** la
 * chiave ha aperto.
 *
 * Lo dice con un nonce **monouso**: 256 bit di caso che valgono soltanto per
 * la durata di una richiesta iniettata, e che puntano a sessione e chiave in
 * una tabella in memoria. L'intestazione non contiene la sessione, e un nonce
 * che trapelasse — da un log, da un errore — non varrebbe niente un istante
 * dopo: quando l'inject finisce, il nonce si cancella.
 */
export const INTESTAZIONE_CANALE = "x-estia-canale-dispositivo";

export interface Contrassegno {
  sessionId: string;
  /** La chiave di rete che l'handshake ha provato. */
  chiave: string;
}

const inCorso = new Map<string, Contrassegno>();

/**
 * Esegue `lavoro` con un nonce che vale `contrassegno` finché `lavoro` non è
 * finito, e mai più dopo.
 */
export async function conContrassegno<T>(
  contrassegno: Contrassegno,
  lavoro: (nonce: string) => Promise<T>,
): Promise<T> {
  const nonce = randomBytes(32).toString("base64url");
  inCorso.set(nonce, contrassegno);

  try {
    return await lavoro(nonce);
  } finally {
    inCorso.delete(nonce);
  }
}

/** Il contrassegno della richiesta, o `undefined` se non viene da uno stream. */
export function contrassegnoDi(request: FastifyRequest): Contrassegno | undefined {
  const valore = request.headers[INTESTAZIONE_CANALE];

  // Una ricerca in una Map per una chiave di 256 bit di caso: indovinarla non
  // è un problema di tempi di risposta.
  return typeof valore === "string" ? inCorso.get(valore) : undefined;
}
