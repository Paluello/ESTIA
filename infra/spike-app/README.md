# Spike S6 — lo stack dell'app

Materiale dello spike [S6](../../docs/spike/S6-lo-stack-dell-app.md): l'ipotesi **Tauri 2** per l'app di [ADR 0044](../../docs/adr/0044-il-dispositivo-e-l-app.md), cioè iroh in Rust nativo, interfaccia e `ts-mls` nella WebView.

**Non è l'app.** È quanto basta a misurare se lo stack regge, e va rimosso o riconvertito quando si apre la milestone delle app, come [`network-lab`](../network-lab/README.md) per lo spike di rete.

| Cartella        | Che cosa c'è                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ponte/`        | Il collegamento Dispositivo → Casa in Rust (iroh 1.4.1): una libreria, la Casa finta `casa`, il dispositivo da riga di comando `bussa`, un test           |
| `interop-node/` | Una Casa finta con `@number0/iroh` 1.1.0, il binding che usa davvero `apps/core-api`, per vedere se le due versioni si parlano                            |
| `app/`          | L'app Tauri 2: la **sonda** nella WebView (usa il codice MLS di `apps/web/src/mls` così com'è) e, in Rust, la cassaforte di sistema e il pulsante «Bussa» |
| `risultati/`    | Quello che le prove hanno restituito finora                                                                                                               |

## Prerequisiti, per tutte le prove

- Rust stabile (`rustup`), Node 22 e pnpm 11.
- Dalla radice del repository, **una volta**: `pnpm install`. La sonda prende `ts-mls` da `apps/web/node_modules`, alla versione che il client web fissa.
- Per l'app: `cd infra/spike-app/app && npm install`.

## Prova 1 — l'app sul Mac (10 minuti)

```bash
cd infra/spike-app/app
npx tauri dev
```

Si apre una finestra e la sonda parte da sola. Alla prima scrittura macOS può chiedere di consentire l'accesso al portachiavi: rispondi **Consenti sempre**, ed è già una misura (annotalo). Quando la sonda ha finito, premi **Copia il risultato** e salva il testo. Poi **chiudi e riapri l'app**: la riga «La chiave di firma è sopravvissuta al riavvio» deve diventare verde. Copia anche questo secondo risultato.

## Prova 2 — l'iPhone (30–60 minuti la prima volta)

Serve Xcode con un Apple ID (anche gratuito: l'app firmata così dura sette giorni).

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
cd infra/spike-app/app
npx tauri ios init          # genera src-tauri/gen/apple, che non si committa
npx tauri ios dev --open    # apre Xcode
```

In Xcode: progetto `estia-spike-app_iOS` → **Signing & Capabilities** → scegli il tuo Team. Collega l'iPhone, sceglilo come destinazione e premi Run. Al primo avvio iOS chiede di fidarsi dello sviluppatore (Impostazioni → Generali → VPN e gestione dispositivi).

Sul telefono, in quest'ordine:

1. lascia finire la sonda e **copia il risultato**;
2. chiudi l'app dal selettore e riaprila: copia il secondo risultato;
3. **cancella l'app** dal telefono, reinstallala da Xcode, riaprila. È la verifica 4 di ADR 0044: nel risultato «Lato nativo» deve dire `"residuo_cancellato": true` e la riga dell'identità «no: primo avvio». Su iOS il portachiavi **sopravvive** alla cancellazione dell'app, ed è questo che la prova guarda. Copia il terzo risultato.

Se il simulatore basta per una prima occhiata: `npx tauri ios dev` senza `--open`, ma il portachiavi del simulatore non è quello di un telefono e la misura che conta resta quella sul dispositivo.

## Prova 3 — Android (30–60 minuti la prima volta)

Serve Android Studio con SDK, **NDK** e un JDK 17; le variabili `ANDROID_HOME` e `NDK_HOME` come dice la [guida di Tauri](https://v2.tauri.app/start/prerequisites/#android).

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
cd infra/spike-app/app
npx tauri android init      # genera src-tauri/gen/android, che non si committa
```

**Prima di avviare**, apri `src-tauri/gen/android/app/src/main/AndroidManifest.xml` e nel tag `<application` imposta `android:allowBackup="false"`. Senza, il backup automatico di Android riporterebbe su un telefono nuovo i file della cassaforte, che lì non si aprirebbero più (la chiave sta nel Keystore, che non si copia).

Telefono collegato in USB con il debug attivo, poi:

```bash
npx tauri android dev
```

Stessi tre passi dell'iPhone: risultato, riavvio, disinstalla e reinstalla. Su Android la disinstallazione cancella tutto da sé: `residuo_cancellato` deve restare `false` e l'identità deve essere nuova.

## Prova 4 — Milano–Campello

È la verifica 1 di ADR 0044. Si accende una **Casa finta** sul NAS (o su qualunque macchina a Campello) e la si raggiunge dal telefono sui dati mobili, senza Tailscale per la prova (spegnilo sul telefono).

**Sul NAS**, con Docker, dalla cartella del repository:

```bash
docker run --rm -v "$PWD":/src -w /src/infra/spike-app/ponte rust:1.97 cargo build --release
./infra/spike-app/ponte/target/release/casa --chiave-file casa.key --ammetti <CHIAVE-DEL-TELEFONO>
```

`<CHIAVE-DEL-TELEFONO>` è il testo sotto «La chiave di rete di questo dispositivo» nell'app. La Casa stampa `CASA <chiave>`: quella chiave va nel campo «Chiave della Casa» dell'app, poi **Bussa**. Il risultato dice se la strada è `diretta` o `relay`, la mediana del tempo di andata e ritorno su venti domande, e quanto ci mette un'eco da 64 kB. Copialo. `casa.key` tiene la stessa chiave fra un avvio e l'altro; per smettere, Ctrl-C.

Se vuoi provare anche dal Mac senza l'app, sul Mac collegato all'hotspot del telefono:

```bash
cd infra/spike-app/ponte && cargo build --release
./target/release/bussa --solo-chiave                      # la chiave da ammettere
./target/release/bussa --casa <CHIAVE-DELLA-CASA>         # la misura
./target/release/bussa --estraneo --casa <CHIAVE-DELLA-CASA>   # una chiave non ammessa: non deve ricevere niente
```

Ripeti la misura due o tre volte in momenti diversi: il buco nel NAT a volte riesce e a volte no, ed è proprio quello che si vuole sapere.

## Che cosa mandare indietro

I testi copiati, uno per prova, con piattaforma e modello (per esempio «iPhone 13, iOS 26.1»). Vanno in `risultati/` e nel documento dello spike, che li aspetta nella tabella «Da misurare sul dispositivo».

## Prove che girano senza dispositivo

```bash
cd infra/spike-app/ponte && cargo test --release      # ammesso riceve, estraneo no
node infra/spike-app/interop-node/casa-node.mjs <chiave>   # la Casa con il binding Node 1.1.0
cd infra/spike-app/app && npm run build && npx tauri build --no-bundle   # l'app su Linux
```

Su Linux l'app usa il Secret Service (GNOME Keyring o KWallet). Senza mani, con `ESTIA_SONDA_USCITA=/percorso/risultato.json` la sonda scrive lì il risultato e l'app si chiude: è come sono stati presi i file di `risultati/`.

## Pulizia

Niente di questo tocca la Casa vera o la sua configurazione. `casa.key`, `dispositivo.key`, `target/`, `node_modules/`, `dist/` e `app/src-tauri/gen/` sono ignorati da git e si cancellano con la cartella. Sul telefono basta cancellare l'app; sul Mac anche la voce `org.estia.spike` nel portachiavi.
