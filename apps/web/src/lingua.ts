import {
  esisteLingua,
  formaPlurale,
  traduci,
  traduciFrasi,
  traduciPlurale,
  type BasePlurale,
  type Chiave,
  type FraseInviata,
  type Valori,
} from "@estia/lingue";
import { Fragment, createElement, useSyncExternalStore, type ReactNode } from "react";

/**
 * La lingua dell'interfaccia (ADR 0046).
 *
 * Una sola, per tutta la pagina, e sta in un posto solo: l'attributo `lang`
 * della radice, che dice anche al lettore di schermo come pronunciare il testo.
 * La sceglie la persona fra le preferenze (ADR 0024); chi non ha scelto legge
 * quella della Casa, che l'istanza dichiara (`ESTIA_LINGUA`) e manda con la
 * vista pubblica.
 *
 * I componenti leggono le frasi con `useT()`, che li fa ridisegnare quando la
 * lingua cambia; il codice fuori da React con `t()`, che legge quella di ora.
 */

const ascoltatori = new Set<() => void>();

function linguaDellaPagina(): string {
  const lang = typeof document === "undefined" ? "" : document.documentElement.lang;
  return lang !== "" && esisteLingua(lang) ? lang : "en";
}

/** Quella di chi non ha scelto: la dichiara l'istanza (`ESTIA_LINGUA`). */
let casa = linguaDellaPagina();
/** Quella che la persona ha scelto fra le preferenze, se l'ha scelta. */
let scelta: string | undefined;
let corrente = casa;

export function linguaCorrente(): string {
  return corrente;
}

export function linguaDellaCasa(): string {
  return casa;
}

function aggiorna(cambiataLaCasa = false): void {
  const nuova = scelta ?? casa;

  // Chi mostra quale sia la lingua della Casa va ridisegnato anche quando la
  // pagina resta in quella scelta dalla persona.
  if (nuova === corrente && !cambiataLaCasa) {
    return;
  }

  corrente = nuova;
  if (typeof document !== "undefined") {
    document.documentElement.lang = nuova;
  }
  for (const ascolta of ascoltatori) {
    ascolta();
  }
}

/** La lingua scelta dalla persona; `undefined` torna a quella della Casa. */
export function impostaLingua(codice: string | undefined): void {
  scelta = codice !== undefined && esisteLingua(codice) ? codice : undefined;
  aggiorna();
}

/**
 * La lingua della Casa, come la dichiara l'istanza. Vale per chi non ha
 * scelto; la scelta di una persona resta la sua. Un codice che il client non
 * conosce — un'istanza più nuova — lascia l'inglese.
 */
export function impostaLinguaDellaCasa(codice: string): void {
  const prima = casa;
  casa = esisteLingua(codice) ? codice : "en";
  aggiorna(casa !== prima);
}

export function t(chiave: Chiave, valori?: Valori): string {
  return traduci(corrente, chiave, valori);
}

/**
 * Frasi che l'istanza manda per chiave (ADR 0046), nella lingua di adesso. Se
 * una chiave non è nella tabella — un'istanza più nuova del client — si legge
 * la frase inglese che l'istanza manda accanto, mai una chiave.
 */
export function tf(frasi: readonly FraseInviata[] | undefined, riserva: string): string {
  return traduciFrasi(corrente, frasi) ?? riserva;
}

export function tn(base: BasePlurale, n: number, valori?: Valori): string {
  return traduciPlurale(corrente, base, n, valori);
}

function componi(frase: string, nodi: Readonly<Record<string, ReactNode>>): ReactNode {
  const pezzi = frase.split(/\{(\w+)\}/);

  return createElement(
    Fragment,
    null,
    ...pezzi.map((pezzo, i) =>
      // Le posizioni dispari sono i nomi dei segnaposti.
      createElement(Fragment, { key: i }, i % 2 === 1 ? (nodi[pezzo] ?? `{${pezzo}}`) : pezzo),
    ),
  );
}

/**
 * Una frase con dentro un pezzo d'interfaccia — un link, un grassetto — al
 * posto di un segnaposto. La frase resta intera nella tabella, perché l'ordine
 * delle parole intorno al link cambia da una lingua all'altra.
 */
export function tc(chiave: Chiave, nodi: Readonly<Record<string, ReactNode>>): ReactNode {
  return componi(traduci(corrente, chiave), nodi);
}

/**
 * Come `tc`, per una frase che dipende da un conteggio: «**3** seguiti». Il
 * numero, se non lo si passa come pezzo, si scrive come lo scrive la lingua.
 */
export function tcn(
  base: BasePlurale,
  n: number,
  nodi: Readonly<Record<string, ReactNode>> = {},
): ReactNode {
  return componi(formaPlurale(corrente, base, n), {
    n: new Intl.NumberFormat(corrente).format(n),
    ...nodi,
  });
}

function iscrivi(ascolta: () => void): () => void {
  ascoltatori.add(ascolta);
  return () => ascoltatori.delete(ascolta);
}

/** Le frasi per un componente, che si ridisegna quando la lingua cambia. */
export function useT(): {
  t: typeof t;
  tn: typeof tn;
  tc: typeof tc;
  tcn: typeof tcn;
  lingua: string;
} {
  const lingua = useSyncExternalStore(iscrivi, linguaCorrente, linguaCorrente);
  return { t, tn, tc, tcn, lingua };
}
