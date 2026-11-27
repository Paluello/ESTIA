import { randomBytes } from "node:crypto";

import type { FastifyRequest } from "fastify";

import { secretsMatch } from "../identity/tokens.js";

/**
 * Il contrassegno che una richiesta portata da uno stream iroh si porta dietro
 * quando entra nelle rotte di sempre con `app.inject()` (ADR 0044 §4: «la
 * stessa API, cambia il trasporto»).
 *
 * Le rotte autenticano con un token di sessione, e un Dispositivo non ne ha
 * uno: la sua credenziale è la chiave di rete, che QUIC prova a ogni
 * connessione. Il canale quindi dice a `requireAuth` **quale sessione** la
 * chiave ha aperto, e lo dice con un segreto che nasce all'avvio del processo
 * e non lascia mai la sua memoria: una richiesta HTTP che arrivi dalla rete
 * con questa intestazione non conosce il segreto, e non vale niente.
 */
export const INTESTAZIONE_CANALE = "x-estia-canale-dispositivo";

const SEGRETO = randomBytes(32).toString("base64url");

export interface Contrassegno {
  sessionId: string;
  /** La chiave di rete che l'handshake ha provato. */
  chiave: string;
}

export function contrassegna(contrassegno: Contrassegno): string {
  return `${SEGRETO}.${contrassegno.sessionId}.${contrassegno.chiave}`;
}

/** Il contrassegno della richiesta, o `undefined` se non viene da uno stream. */
export function contrassegnoDi(request: FastifyRequest): Contrassegno | undefined {
  const valore = request.headers[INTESTAZIONE_CANALE];

  if (typeof valore !== "string") {
    return undefined;
  }

  const [segreto, sessionId, chiave, ...resto] = valore.split(".");

  if (
    segreto === undefined ||
    sessionId === undefined ||
    chiave === undefined ||
    resto.length > 0 ||
    !secretsMatch(SEGRETO, segreto)
  ) {
    return undefined;
  }

  return { chiave, sessionId };
}
