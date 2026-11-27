# L'app ESTIA

Il Dispositivo di [ADR 0044](../../docs/adr/0044-il-dispositivo-e-l-app.md): da fuori casa la Casa si raggiunge **solo con l'app**, per chiave e via iroh. Telefono e PC, una base sola su [Tauri 2](https://v2.tauri.app), come ha misurato lo spike [S6](../../docs/spike/S6-lo-stack-dell-app.md).

| Dove                          | Che cosa c'è                                                                                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../web`                      | **L'interfaccia**: è il client web, lo stesso codice, compreso MLS. Costruito con `--mode app`, chiama la Casa con [`chiedi`](../web/src/piattaforma/app.ts) invece di `fetch`, e tiene le chiavi MLS nella cassaforte invece che in IndexedDB ([`adattatori-app.ts`](../web/src/mls/adattatori-app.ts)). |
| `src-tauri/src/cassaforte.rs` | Una chiave nella cassaforte del sistema (portachiavi di iOS e macOS, Keystore di Android, Credential Manager, Secret Service), e i segreti del dispositivo in file sigillati con quella. Reinstallare l'app dà un dispositivo nuovo, anche su iOS dove il portachiavi sopravvive.                         |
| `src-tauri/src/rete.rs`       | iroh: l'endpoint con la chiave del dispositivo, l'ingresso con il codice del QR (`estia/ingresso/1`), le richieste dell'API (`estia/dispositivo/1`).                                                                                                                                                      |
| `src-tauri/src/filo.rs`       | Il formato di una richiesta su uno stream, concordato con la Casa ([docs/ACCESSO_DEL_DISPOSITIVO.md](../../docs/ACCESSO_DEL_DISPOSITIVO.md)). Ha i suoi test.                                                                                                                                             |
| `scripts/`                    | `prepara-android.mjs` (backup spento, schema `estia://`), `ios-simulatore.sh`, `via-appledouble.mjs`.                                                                                                                                                                                                     |
| `patches/netdev`              | La correzione perché iroh compili per iOS ([patches/README.md](patches/README.md)).                                                                                                                                                                                                                       |

`src-tauri/gen/` (i progetti Xcode e Android Studio) **non si committa**: lo genera `tauri ios init` / `tauri android init`, e gli script ci rimettono quello che serve.

## Scaricare l'app sul telefono Android

Senza cavo e senza Android Studio: dal telefono apri la pre-release [**app-anteprima**](https://github.com/Paluello/ESTIA/releases/tag/app-anteprima), scarica `estia-android.apk` e aprilo. Android chiede di consentire l'installazione da quella fonte (il browser o il gestore dei file): consenti, poi installa.

Si aggiorna da sola a ogni modifica di `main` che tocca l'app. Finché il repository non ha la chiave di firma fra i segreti (sotto), ogni APK è firmato con una chiave nuova, e Android rifiuta un aggiornamento firmato da un'altra: **disinstalla la versione di prima** prima di installare la nuova.

## Costruire in locale

Prerequisiti: Rust stabile, Node e pnpm come la radice del repository, poi `corepack pnpm install` dalla radice. Per Linux le librerie della WebView (`libwebkit2gtk-4.1-dev` e le altre della [guida di Tauri](https://v2.tauri.app/start/prerequisites/)).

```bash
cd apps/app
pnpm tauri dev                 # il PC, con il client web in sviluppo
cd src-tauri && cargo test     # i test del filo
```

### Simulatore iOS, sul Mac

```bash
apps/app/scripts/ios-simulatore.sh                       # costruisce, installa, apre
SIMULATORE="iPhone 17" apps/app/scripts/ios-simulatore.sh
```

Lo script esiste per tre cose trovate il 2026-11-27 sul Mac di sviluppo, che `tauri ios dev` non regge:

- **Xcode 27.2 senza il simulatore iOS 27.2**: la CLI di Tauri si ferma. Lo script costruisce con `xcodebuild` verso un simulatore installato.
- **Il repository su un SSD esterno (exFAT)**: macOS scrive un file `._` accanto a ogni file, e Tauri li legge come capability e icone rotte. Lo script copia il repository in `~/Library/Caches/estia-app-build` senza i `._` e costruisce lì (`ESTIA_BUILD_DIR` per cambiare posto). `via-appledouble.mjs`, che gira prima di ogni build, li toglie anche dall'albero.
- **Il framework SystemConfiguration** che iroh usa: è dichiarato in `tauri.conf.json` (`bundle.iOS.frameworks`).

Senza firma il portachiavi non c'è («A required entitlement isn't present»): l'app parte e chiede di collegarsi, ma la cassaforte resta chiusa. Per un iPhone vero servono un account Apple Developer e il Team in Xcode.

### Android, in locale

Android Studio con SDK, NDK e JDK 17, poi:

```bash
cd apps/app
pnpm tauri android init && node scripts/prepara-android.mjs
pnpm tauri android dev
```

## La CI

[`.github/workflows/app.yml`](../../.github/workflows/app.yml), a ogni PR che tocca l'app, il client web o i pacchetti:

| Lavoro           | Che cosa produce                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `android`        | `estia-android.apk` per arm64, firmato; su `main` anche nella pre-release `app-anteprima` |
| `linux`          | i test del lato Rust e il binario desktop                                                 |
| `ios-simulatore` | la build per il simulatore, senza firma                                                   |

**La firma stabile di Android** si accende con tre segreti del repository: `ANDROID_KEYSTORE_BASE64` (il keystore, `base64 -w0 estia.jks`), `ANDROID_KEYSTORE_PASSWORD` e `ANDROID_KEY_ALIAS`. Il keystore va conservato fuori dal repository e non si perde: è la stessa chiave che firmerà l'app su Google Play. **TestFlight e App Store** si accendono quando c'è l'account Apple Developer.
