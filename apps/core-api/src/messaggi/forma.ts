/**
 * La forma dei campi che attraversano fra le case, in un posto solo.
 *
 * Un segnaposto ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §4.1)
 * sono sette campi che un'altra casa scrive nel database di questa: fino al
 * 2026-11-27 tre di quelli — l'id, il mittente, la data — erano «un testo non
 * troppo lungo», e una casa poteva metterci quello che voleva. Qui c'è che cosa
 * sono davvero. Le stesse funzioni valgono per il deposito locale, perché una
 * voce che qui entra con una forma che là si rifiuta non arriverebbe mai.
 */
import { USERNAME_PATTERN } from "@estia/contracts";

const NOME = new RegExp(USERNAME_PATTERN, "u");

/** La chiave di una casa: 32 byte ed25519, in esadecimale minuscolo. */
const CASA = /^[0-9a-f]{64}$/u;

/**
 * L'id di una voce d'archivio: lo sceglie il client di chi scrive, a caso
 * (un UUID). Lettere, cifre e pochi segni: niente spazi, niente controlli.
 */
const ID_DI_VOCE = /^[A-Za-z0-9._:-]{1,120}$/u;

/** Un istante in UTC, come lo scrive `Date.prototype.toISOString`. */
const ISTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

export function nomeValido(nome: string): boolean {
  return NOME.test(nome);
}

export function casaValida(casa: string): boolean {
  return CASA.test(casa);
}

export function idDiVoce(id: string): boolean {
  return ID_DI_VOCE.test(id);
}

/** Un istante scritto bene **e** che esiste: il 31 febbraio non passa. */
export function istanteValido(istante: string): boolean {
  if (!ISTANTE.test(istante)) {
    return false;
  }

  // `Date.parse` accetta il 31 febbraio e lo fa diventare marzo: si confronta
  // quello che ha capito con quello che c'era scritto.
  const letto = Date.parse(istante);
  return (
    !Number.isNaN(letto) && new Date(letto).toISOString().slice(0, 19) === istante.slice(0, 19)
  );
}

/** `nome@casa`, l'indirizzo con cui una credenziale MLS nomina un membro. */
export function indirizzoValido(indirizzo: string): boolean {
  const taglio = indirizzo.lastIndexOf("@");

  return (
    taglio > 0 && nomeValido(indirizzo.slice(0, taglio)) && casaValida(indirizzo.slice(taglio + 1))
  );
}
