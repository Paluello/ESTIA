// Dopo `tauri android init`: le due cose che il progetto Android generato non
// fa da sé, e senza le quali l'app sarebbe sbagliata, non solo diversa.
//
// 1. `android:allowBackup="false"`. Altrimenti il backup automatico di Android
//    riporterebbe su un telefono nuovo i file sigillati della cassaforte, che
//    lì non si aprono più (la chiave sta nel Keystore, che non si copia): un
//    dispositivo nuovo che crede di essere il vecchio (S6, ADR 0044 §2).
// 2. Lo schema `estia://`, perché un collegamento d'ingresso aperto dal
//    telefono porti nell'app.
//
// `src-tauri/gen/` non si committa: si rigenera, e questo script lo rimette a
// posto ogni volta. Idempotente.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifesto = fileURLToPath(
  new URL("../src-tauri/gen/android/app/src/main/AndroidManifest.xml", import.meta.url),
);

let xml = readFileSync(manifesto, "utf8");

function imposta(attributo, valore) {
  const re = new RegExp(`${attributo}="[^"]*"`);
  if (re.test(xml)) {
    xml = xml.replace(re, `${attributo}="${valore}"`);
  } else {
    xml = xml.replace(/<application\b/, `<application\n        ${attributo}="${valore}"`);
  }
}

imposta("android:allowBackup", "false");
imposta("android:fullBackupContent", "false");

const schema = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="estia" android:host="ingresso" />
            </intent-filter>`;

if (!xml.includes('android:scheme="estia"')) {
  // Dentro la prima activity, accanto al suo intent-filter di avvio.
  xml = xml.replace(/(<activity\b[\s\S]*?>)/, `$1${schema}`);
}

writeFileSync(manifesto, xml);

if (!/android:allowBackup="false"/.test(xml)) {
  console.error("prepara-android: allowBackup non impostato");
  process.exit(1);
}
console.log("prepara-android: allowBackup=false, schema estia:// registrato");
