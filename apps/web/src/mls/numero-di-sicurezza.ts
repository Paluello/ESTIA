/**
 * Il numero di sicurezza ([ADR 0048](../../../../docs/adr/0048-il-numero-di-sicurezza.md)).
 *
 * È l'unica difesa contro chi tiene il registro delle chiavi — l'istanza, chi
 * la amministra, chi l'ha compromessa: il limite 4 di [ADR 0036](../../../../docs/adr/0036-estia-e2e-v1-e-il-debito-verso-mls.md),
 * che [S4](../../../../docs/spike/S4-autenticare-chi-entra.md) §3 ha misurato e
 * che nessuna difesa dentro il protocollo può chiudere. Due persone leggono
 * sessanta cifre su un canale che l'istanza non controlla; se coincidono,
 * vedono le stesse chiavi l'una dell'altra.
 *
 * **La costruzione non è inventata qui.** È quella del safety number di Signal
 * (`NumericFingerprintGenerator`, in libsignal `rust/protocol/src/fingerprint.rs`),
 * e [`improntaSignal`](#improntaSignal) ne è la trascrizione: la prova accanto
 * la confronta con il vettore ufficiale di libsignal. Di ESTIA ci sono solo i
 * due ingressi, e ADR 0048 dice perché:
 *
 * - l'**identificativo** è l'identità della credenziale MLS, `<username>@<chiave
 *   della casa>` ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §0),
 *   dietro un'etichetta di dominio;
 * - la **chiave** è l'insieme delle chiavi di firma dei dispositivi approvati
 *   ([ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)),
 *   senza doppioni, ordinate, ciascuna con la sua lunghezza davanti.
 *
 * Non conosce né la rete né IndexedDB: prende byte e restituisce cifre.
 */
import { sha512 } from "@noble/hashes/sha2.js";

import { scriviIdentita, type Membro } from "./gruppo.js";

/**
 * Quante volte si ripete SHA-512. È il valore di Signal, e la ragione è sua:
 * trenta cifre sono circa 99,7 bit, e 5200 giri (~2^12,3) portano a ~2^112 il
 * costo di trovare una chiave la cui impronta coincida con un'altra.
 */
export const ITERAZIONI = 5200;

/** I due byte di versione che Signal mette in testa al primo giro: `0x0000`. */
const VERSIONE = new Uint8Array([0, 0]);

/**
 * L'etichetta di dominio davanti all'identità. Cambia se cambia la formula:
 * due versioni non devono mai poter dare lo stesso numero per ingressi diversi.
 */
// eslint-disable-next-line estia/no-ui-literal -- byte che entrano in un hash: nessuno li legge, e tradurli cambierebbe il numero
export const ETICHETTA = "ESTIA numero di sicurezza v1\n";

const CIFRE_PER_GRUPPO = 5;
const GRUPPI_PER_PARTE = 6;

function unisci(...pezzi: readonly Uint8Array[]): Uint8Array {
  const tutto = new Uint8Array(pezzi.reduce((n, p) => n + p.length, 0));
  let dove = 0;
  for (const pezzo of pezzi) {
    tutto.set(pezzo, dove);
    dove += pezzo.length;
  }
  return tutto;
}

/**
 * L'impronta di Signal, tale e quale.
 *
 * ```
 * h₀ = SHA-512(0x0000 ‖ chiave ‖ identificativo ‖ chiave)
 * hᵢ = SHA-512(hᵢ₋₁ ‖ chiave)          per i = 1 … iterazioni−1
 * ```
 *
 * Sta esportata per una ragione sola: poterla provare contro il vettore di
 * libsignal con gli ingressi di Signal, che non sono quelli di ESTIA.
 */
export function improntaSignal(
  identificativo: Uint8Array,
  chiave: Uint8Array,
  iterazioni: number = ITERAZIONI,
): Uint8Array {
  let h = sha512(unisci(VERSIONE, chiave, identificativo, chiave));
  for (let i = 1; i < iterazioni; i++) {
    h = sha512(unisci(h, chiave));
  }
  return h;
}

/**
 * Le trenta cifre di un'impronta, come le scrive Signal: i primi trenta byte in
 * sei pezzi da cinque, ciascuno letto come intero big-endian e ridotto modulo
 * 100 000, con gli zeri davanti.
 */
export function cifreDi(impronta: Uint8Array): string {
  let cifre = "";
  for (let gruppo = 0; gruppo < GRUPPI_PER_PARTE; gruppo++) {
    let valore = 0n;
    for (let i = 0; i < 5; i++) {
      valore = (valore << 8n) | BigInt(impronta[gruppo * 5 + i] ?? 0);
    }
    cifre += (valore % 100_000n).toString().padStart(CIFRE_PER_GRUPPO, "0");
  }
  return cifre;
}

function confronta(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return a.length - b.length;
}

const u16 = (n: number): Uint8Array => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);

/**
 * Le chiavi distinte di un membro, in ordine di byte.
 *
 * Senza doppioni perché il registro ha **una riga per sessione**, e due
 * sessioni dello stesso browser portano la stessa chiave di firma: contarla due
 * volte farebbe cambiare il numero a ogni accesso, e un numero che cambia senza
 * motivo insegna a ignorarlo.
 */
export function chiaviDistinte(chiavi: readonly Uint8Array[]): Uint8Array[] {
  const ordinate = [...chiavi].sort(confronta);
  return ordinate.filter((c, i) => i === 0 || confronta(c, ordinate[i - 1] ?? c) !== 0);
}

/**
 * L'insieme delle chiavi di un membro come una sola sequenza di byte.
 *
 * `u16(quante) ‖ per ciascuna: u16(lunghezza) ‖ chiave`. Le lunghezze stanno
 * davanti perché la sequenza si possa leggere in un modo solo: due insiemi
 * diversi non danno mai gli stessi byte, qualunque sia la forma delle chiavi.
 */
export function chiaveLogica(chiavi: readonly Uint8Array[]): Uint8Array {
  const distinte = chiaviDistinte(chiavi);
  if (distinte.length === 0) {
    throw new Error("Nessuna chiave di firma: non c'è niente di cui fare l'impronta.");
  }
  if (distinte.length > 0xffff || distinte.some((c) => c.length === 0 || c.length > 0xffff)) {
    throw new Error("Chiavi di firma di una forma che il numero di sicurezza non sa leggere.");
  }
  return unisci(u16(distinte.length), ...distinte.flatMap((c) => [u16(c.length), c]));
}

/** Una persona come la vede il numero: chi è, e con quali chiavi firma. */
export interface Parte {
  membro: Membro;
  /** Le chiavi di firma dei suoi dispositivi approvati, in qualunque ordine. */
  chiavi: readonly Uint8Array[];
}

/**
 * La metà del numero che appartiene a una persona: trenta cifre.
 *
 * Dipende soltanto da lei — identità e chiavi — e per questo è ciò che si
 * conserva quando la si segna verificata: se cambia, sono cambiate le **sue**
 * chiavi, non quelle di chi guarda.
 */
export function improntaDi(parte: Parte): string {
  const identificativo = new TextEncoder().encode(ETICHETTA + scriviIdentita(parte.membro));
  return cifreDi(improntaSignal(identificativo, chiaveLogica(parte.chiavi)));
}

/**
 * Il numero di sicurezza di una coppia: sessanta cifre.
 *
 * Le due metà in ordine crescente, come in Signal: chiunque dei due lo calcoli,
 * e in qualunque conversazione, viene uguale. Non c'entra il gruppo, né
 * l'epoch, né chi ha scritto per primo.
 */
export function numeroDiSicurezza(io: Parte, altro: Parte): string {
  const mia = improntaDi(io);
  const sua = improntaDi(altro);
  return mia < sua ? mia + sua : sua + mia;
}

/** Il numero in dodici gruppi da cinque, per leggerlo a voce. */
export function inGruppi(numero: string): string[] {
  return numero.match(new RegExp(`.{1,${String(CIFRE_PER_GRUPPO)}}`, "g")) ?? [];
}
