/**
 * Il `Cassetto` del client web ([dispositivo.ts](../../../../apps/web/src/mls/dispositivo.ts)),
 * implementato sulla cassaforte dell'app invece che su IndexedDB.
 *
 * È la prova che il confine scelto dal client web regge: il bootstrap MLS
 * chiede un cassetto con tre verbi, e qui i tre verbi diventano tre comandi
 * Rust. IndexedDB conserva oggetti con dentro `Uint8Array`; un comando Tauri
 * viaggia in JSON, quindi i byte si marcano all'andata e si ricostruiscono al
 * ritorno.
 */
import { invoke } from "@tauri-apps/api/core";

import type { Cassetto } from "../../../../apps/web/src/mls/dispositivo.ts";

const b64 = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};

function daB64(s: string): Uint8Array<ArrayBuffer> {
  const grezzo = atob(s);
  const out = new Uint8Array(grezzo.length);
  for (let i = 0; i < grezzo.length; i++) out[i] = grezzo.charCodeAt(i);
  return out;
}

export function serializza(valore: unknown): string {
  return JSON.stringify(valore, (_k, v: unknown) => {
    if (v instanceof Uint8Array) return { $u8: b64(v) };
    if (typeof v === "bigint") return { $big: v.toString() };
    return v;
  });
}

export function deserializza(testo: string): unknown {
  return JSON.parse(testo, (_k, v: unknown) => {
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.$u8 === "string" && Object.keys(o).length === 1) return daB64(o.$u8);
      if (typeof o.$big === "string" && Object.keys(o).length === 1) return BigInt(o.$big);
    }
    return v;
  });
}

export const inTauri = (): boolean => "__TAURI_INTERNALS__" in globalThis;

/** Il cassetto sulla cassaforte del sistema. */
export function cassettoTauri(
  prefisso: string,
): Cassetto & { grezzo: (k: string) => Promise<string | null> } {
  return {
    async leggi(chiave) {
      const testo = await invoke<string | null>("cassaforte_leggi", { nome: prefisso + chiave });
      return testo === null ? undefined : deserializza(testo);
    },
    async scrivi(chiave, valore) {
      await invoke("cassaforte_scrivi", { nome: prefisso + chiave, valore: serializza(valore) });
    },
    async svuota() {
      await invoke("cassaforte_svuota");
    },
    grezzo: (chiave) => invoke<string | null>("cassaforte_grezzo", { nome: prefisso + chiave }),
  };
}

/** Un cassetto in memoria: per Bruno, e per la sonda fuori da Tauri. Passa dallo stesso JSON. */
export function cassettoInMemoria(): Cassetto & { grezzo: (k: string) => Promise<string | null> } {
  const m = new Map<string, string>();
  return {
    leggi: (k) => Promise.resolve(m.has(k) ? deserializza(m.get(k)!) : undefined),
    scrivi: (k, v) => {
      m.set(k, serializza(v));
      return Promise.resolve();
    },
    svuota: () => {
      m.clear();
      return Promise.resolve();
    },
    grezzo: () => Promise.resolve(null),
  };
}
