# App Android

L'app Android di ESTIA in Jetpack Compose e Material 3 ([ADR 0051](../../docs/adr/0051-le-app-del-telefono-sono-native.md)), sopra il nucleo Rust di [`apps/nucleo`](../nucleo), che vede attraverso i legami Kotlin di UniFFI.

Per ora fa tre cose: l'ingresso nella Casa con il codice del QR, la bacheca e il profilo, con l'uscita da questo dispositivo.

Dal profilo si aprono i propri dispositivi ([ADR 0040](../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md), `schermate/Dispositivi.kt`): chi ha il sì, chi lo aspetta con il codice da confrontare, chi è stato revocato; il sì, il no e la revoca con conferma. Finché il telefono aspetta il sì, i messaggi mostrano il suo codice al posto dell'elenco.

## Che cosa c'è

- `app/src/main/java/org/estia/app/`
  - `Casa.kt`: lo stato dell'app e le richieste alla Casa, sul filo `estia/dispositivo/1`.
  - `Cassaforte.kt`: il `Deposito` del nucleo. È una chiave AES nell'Android Keystore e i file sigillati in `noBackupFilesDir`.
  - `Frasi.kt`: le frasi di `packages/lingue`, con le stesse regole del web.
  - `aspetto/Tema.kt`: i colori ocra dello studio e i caratteri Besley e Atkinson Hyperlegible Next (OFL 1.1, licenze in `assets/licenze`).
  - `schermate/`: le schermate dell'ingresso, della bacheca, del profilo e di dentro la Casa.
- `scripts/prepara.sh` compila il nucleo per arm64 con l'NDK. Genera i legami Kotlin e copia le frasi. Nulla di ciò che produce va in git.
- `scripts/controlla-frasi.mjs` fallisce se l'app chiede una frase che la tabella non ha.

## Come si prova

Servono l'SDK di Android con l'NDK, Rust, Java 17 e Gradle 8.14:

```sh
cd apps/android
./scripts/prepara.sh --debug
gradle installDebug   # con un telefono collegato, o l'emulatore arm64
```

In CI il flusso `android` costruisce l'APK firmato. Su main lo aggiunge alla pre-release `app-anteprima` come `estia-android-nativa.apk`.
