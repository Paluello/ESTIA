/**
 * Da come la conversazione nomina un membro a come lo nomina MLS.
 *
 * Una conversazione dice `remote:<casa>:<username>` per chi abita altrove e un
 * id locale per chi abita qui; il numero di sicurezza vuole il nome **e la
 * casa** ([ADR 0042](../../../../../docs/adr/0042-come-mls-attraversa.md) §0),
 * perché `anna` di una casa non è `anna` dell'altra.
 */
import type { AuthorView } from "@estia/contracts";

import type { Membro } from "../../mls/gruppo.js";

export function membroDi(autore: Pick<AuthorView, "id" | "username">, casa: string): Membro {
  const altrove = autore.id.startsWith("remote:") ? autore.id.split(":")[1] : undefined;
  return { casa: altrove ?? casa, username: autore.username };
}
