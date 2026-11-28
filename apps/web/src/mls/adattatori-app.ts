/**
 * Il cassetto e il deposito MLS **nell'app**: sulla cassaforte del
 * dispositivo invece che su IndexedDB ([ADR 0044](../../../../docs/adr/0044-il-dispositivo-e-l-app.md) §2).
 *
 * Nella cassaforte del sistema sta una chiave sola; ogni voce qui sotto è un
 * file sigillato con quella chiave, nella cartella dati dell'app (lo spike
 * [S6](../../../../docs/spike/S6-lo-stack-dell-app.md) §3). I tre verbi del
 * `Cassetto` diventano tre comandi Rust: il confine scelto dal client web
 * regge senza cambiarlo.
 *
 * Un comando Tauri viaggia in JSON, quindi `Uint8Array` e `bigint` (che
 * IndexedDB conserva com'erano) si marcano all'andata e si ricostruiscono al
 * ritorno.
 */
import { invoke } from "@tauri-apps/api/core";

import { base64InBytes, bytesInBase64 } from "../piattaforma/app.js";
import type { Cassetto } from "./dispositivo.js";
import type { CommitInSospeso, Deposito } from "./sessione.js";

export function serializza(valore: unknown): string {
  return JSON.stringify(valore, (_k, v: unknown) => {
    if (v instanceof Uint8Array) return { $u8: bytesInBase64(v) };
    if (typeof v === "bigint") return { $big: v.toString() };
    return v;
  });
}

export function deserializza(testo: string): unknown {
  return JSON.parse(testo, (_k, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const chiavi = Object.keys(o);
      if (chiavi.length === 1 && typeof o.$u8 === "string") return base64InBytes(o.$u8);
      if (chiavi.length === 1 && typeof o.$big === "string") return BigInt(o.$big);
    }
    return v;
  });
}

/** Le tre parti della cassaforte che usa MLS. Il lato nativo tiene le sue a parte. */
const DISPOSITIVO = "mls/dispositivo/";
const STATI = "mls/stato/";
const CURSORI = "mls/cursore/";
const MAZZI = "mls/mazzo/";
const SOSPESI = "mls/sospeso/";

async function leggi(nome: string): Promise<unknown> {
  const testo = await invoke<string | null>("cassaforte_leggi", { nome });
  return testo === null ? undefined : deserializza(testo);
}

function scrivi(nome: string, valore: unknown): Promise<void> {
  return invoke("cassaforte_scrivi", { nome, valore: serializza(valore) });
}

function svuota(prefisso: string): Promise<void> {
  return invoke("cassaforte_svuota", { prefisso });
}

export const cassettoCassaforte: Cassetto = {
  leggi: (chiave) => leggi(DISPOSITIVO + chiave),
  scrivi: (chiave, valore) => scrivi(DISPOSITIVO + chiave, valore),
  svuota: () => svuota(DISPOSITIVO),
};

export const depositoCassaforte: Deposito = {
  leggi: async (id) => (await leggi(STATI + id)) as Uint8Array | undefined,
  leggiCursore: async (id) => (await leggi(CURSORI + id)) as string | undefined,
  leggiMazzo: async (id) => (await leggi(MAZZI + id)) as string | undefined,
  // La cassaforte non toglie una voce sola: «niente in sospeso» si scrive come
  // `null`, e si rilegge come se la voce non ci fosse.
  leggiSospeso: async (id) =>
    ((await leggi(SOSPESI + id)) ?? undefined) as CommitInSospeso | undefined,
  scrivi: (id, stato) => scrivi(STATI + id, stato),
  scriviCursore: (id, cursore) => scrivi(CURSORI + id, cursore),
  scriviMazzo: (id, mazzo) => scrivi(MAZZI + id, mazzo),
  scriviSospeso: (id, sospeso) => scrivi(SOSPESI + id, sospeso ?? null),
  svuota: async () => {
    await svuota(STATI);
    await svuota(CURSORI);
    await svuota(MAZZI);
    await svuota(SOSPESI);
  },
};
