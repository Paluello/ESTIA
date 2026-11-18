import type { Frase } from "@estia/contracts";
import { type BasePlurale, type Chiave, traduciFrasi, type Valori } from "@estia/lingue";

/**
 * The sentences the instance writes for an administrator, sent by key
 * (ADR 0046): the panel reads them in the language of whoever is looking. The
 * English text goes along as `detail`, for logs and for a client that does not
 * know the key yet — the same rule as the `message` of an error.
 *
 * The key is typed on the table, so a sentence without its phrase does not
 * compile. A base with plural forms takes its count in `n`.
 */
export function frase(chiave: Chiave | BasePlurale, valori?: Valori): Frase {
  return valori === undefined ? { chiave } : { chiave, valori: { ...valori } };
}

/** The sentences in English, one after the other. */
export function inInglese(frasi: readonly Frase[]): string {
  return traduciFrasi("en", frasi) ?? "";
}

/** A `detail` and its keys, ready to spread into a view. */
export function detto(...frasi: Frase[]): { detail: string; detailFrasi: Frase[] } {
  return { detail: inInglese(frasi), detailFrasi: frasi };
}
