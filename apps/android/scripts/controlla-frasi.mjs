// Ogni frase che l'app chiede con `Frasi.t("…")` deve esistere nella tabella
// di riferimento di packages/lingue (ADR 0051, verifica 4): una chiave che
// manca farebbe vedere la chiave stessa sullo schermo. Lo stesso controllo
// dell'app iPhone, sui file Kotlin.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const qui = fileURLToPath(new URL("..", import.meta.url));
const tabella = JSON.parse(
  readFileSync(join(qui, "../../packages/lingue/src/frasi/en.json"), "utf8"),
);

function kotlin(cartella) {
  return readdirSync(cartella).flatMap((voce) => {
    const percorso = join(cartella, voce);
    if (statSync(percorso).isDirectory()) return kotlin(percorso);
    return voce.endsWith(".kt") ? [percorso] : [];
  });
}

const mancanti = [];
let usate = 0;
for (const file of kotlin(join(qui, "app/src/main/java"))) {
  const testo = readFileSync(file, "utf8");
  // Le chiavi delle schede stanno in una tabella, non in una chiamata.
  const chiavi = [
    ...testo.matchAll(/Frasi\.t\("([^"]+)"/g),
    ...testo.matchAll(/Scheda\("([^"]+)"/g),
  ];
  for (const [, chiave] of chiavi) {
    usate += 1;
    if (!Object.hasOwn(tabella, chiave)) mancanti.push(`${file}: ${chiave}`);
  }
}

if (mancanti.length > 0) {
  console.error(`controlla-frasi: chiavi senza frase\n${mancanti.join("\n")}`);
  process.exit(1);
}
console.log(`controlla-frasi: ${usate} frasi, tutte nella tabella`);
