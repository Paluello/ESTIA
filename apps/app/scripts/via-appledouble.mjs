// Toglie i file AppleDouble (`._nome`) che macOS scrive accanto a ogni file su
// un disco exFAT o FAT, come un SSD esterno. Per Tauri non sono metadati: sono
// file. `._default.json` in `capabilities/` è una capability illeggibile,
// `._icon.png` un'icona rotta, e la build si ferma.
//
// Gira prima di ogni build e di ogni avvio di sviluppo. Non basta da solo se
// anche la cartella `target/` di cargo sta su quel disco: lì i `._` nascono
// durante la build. Per questo `ios-simulatore.sh` e il README dicono di
// tenere la build sul disco interno.

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const radice = fileURLToPath(new URL("../../../", import.meta.url));
const salta = new Set([".git", "node_modules", "target"]);
let tolti = 0;

function visita(cartella) {
  let voci;
  try {
    voci = readdirSync(cartella, { withFileTypes: true });
  } catch {
    return;
  }
  for (const voce of voci) {
    const percorso = join(cartella, voce.name);
    if (voce.name.startsWith("._")) {
      rmSync(percorso, { force: true, recursive: true });
      tolti += 1;
    } else if (voce.isDirectory() && !salta.has(voce.name)) {
      visita(percorso);
    }
  }
}

for (const parte of ["apps/app", "apps/web", "packages"]) visita(join(radice, parte));

if (tolti > 0) console.log(`via-appledouble: tolti ${tolti} file ._`);
