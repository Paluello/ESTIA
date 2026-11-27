# S6 — Lo stack dell'app: Tauri 2

- Data: 2026-11-18
- Eseguito da: sessione di lavoro assistita, in un container Linux senza telefoni
- Domanda di [ADR 0044](../adr/0044-il-dispositivo-e-l-app.md) in prova: §8 punto 1, _«lo spike sullo stack dell'app»_, e le verifiche 1, 2, 4 e 6 di §«Come si verifica»
- Ipotesi in prova: **Tauri 2**, con iroh in Rust nativo e l'interfaccia e `ts-mls` nella WebView
- Esito: **parziale, e a favore di Tauri.** Tutto quello che si può provare senza un telefono regge, compreso il codice MLS vero del client web dentro la WebView dell'app. **Restano tre prove che solo l'hardware può fare**: la WebView di iPhone e Android, la cassaforte di iOS e Android, il collegamento Milano–Campello. Nessuna misura fatta qui smentisce Tauri

## La risposta in tre righe

Nella WebView di un'app Tauri l'origine è un **contesto sicuro**, quindi `crypto.subtle` c'è e il codice MLS di `apps/web/src/mls` gira **senza toccarne una riga**: 21 prove su 21 in WebKit, 18 su 18 in Chromium.
La cassaforte del sistema tiene una chiave sola e la chiave **sopravvive al riavvio**; i file dell'app sul disco sono sigillati.
iroh 1.4.1 in Rust **si collega per chiave** alla Casa, anche a quella vera che parla il binding Node 1.1.0, e una chiave non ammessa **non riceve niente**.

## Perché questo spike esiste

[ADR 0044](../adr/0044-il-dispositivo-e-l-app.md) ha deciso che da fuori la Casa si raggiunge solo con l'app, per chiave, via iroh, e ha lasciato aperto lo stack. La valutazione del 2026-11-18 ha escluso la PWA (0044 vieta la porta web da fuori), sconsigliato React Native (niente binding iroh, e `ts-mls` non ci gira: [S1](S1-ts-mls-sotto-la-csp.md)) e indicato Tauri 2 come ipotesi da provare: **una base sola per iOS, Android e PC**, con il Rust dove serve il nativo e il TypeScript dove c'è già.

Come gli altri spike, **non decide niente**: misura, e prepara la decisione del proprietario.

### Un'ipotesi diversa da quella scritta in ADR 0044

ADR 0044 §8 nominava un'altra ipotesi: _«un nucleo in Rust — iroh più una libreria MLS — condiviso da iOS, Android e PC»_, e chiedeva di provare che quella libreria MLS e `ts-mls` stiano nella stessa conversazione. Tauri sposta la linea: in Rust va **solo iroh** e la cassaforte, mentre MLS resta `ts-mls`, cioè **lo stesso codice del client web**. Il problema dell'interoperabilità fra due implementazioni MLS (verifica 6) **non nasce**, perché l'implementazione è una. Il costo di questa scelta è detto sotto, in §«Le chiavi in memoria».

## Ambiente

| Voce                   | Valore                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tauri                  | `tauri` 2.12.5, `tauri-build` 2.7.4, `@tauri-apps/cli` e `@tauri-apps/api` 2.12.4                                                                       |
| iroh                   | `iroh` 1.4.1 (Rust) nel dispositivo; `@number0/iroh` 1.1.0 (Node) nella Casa, quello di `apps/core-api`                                                 |
| MLS                    | `ts-mls` 1.6.2 da `apps/web`, ciphersuite `MLS_128_DHKEMP256_AES128GCM_SHA256_P256` ([ADR 0038](../adr/0038-mls-si-adotta-e-si-comincia-dal-web.md) §5) |
| Cassaforte             | `keyring-core` 1.0.1 con un negozio per piattaforma (sotto); ChaCha20-Poly1305 0.10.1 per i file                                                        |
| WebView misurate       | WebKitGTK 2.52 (l'app Tauri vera, su Linux, sotto Xvfb); Chromium 157 (Playwright)                                                                      |
| Rust, Node             | 1.97.0, 22.23.5                                                                                                                                         |
| Telefoni, Mac, Windows | **nessuno**                                                                                                                                             |
| Materiale              | [`infra/spike-app/`](../../infra/spike-app/README.md), con i risultati grezzi in `risultati/`                                                           |

## Che cosa si è costruito

- **`ponte/`**: il collegamento Dispositivo → Casa in Rust. Un ALPN suo (`estia/dispositivo/spike-0`, distinto da `estia/1` come vuole ADR 0044 §4), una Casa che **ammette solo chiavi registrate** e chiude le altre senza un byte, un dispositivo che bussa e misura strada, tempo di andata e ritorno e un'eco da 64 kB (l'ordine di grandezza di un Welcome grande, [S5](S5-quanto-pesa-un-albero.md)).
- **`interop-node/`**: la stessa Casa con il binding Node che usa davvero `apps/core-api`.
- **`app/`**: un'app Tauri 2. Nella WebView una **sonda** che importa `apps/web/src/mls/gruppo.ts` e `dispositivo.ts` così come sono; in Rust la cassaforte e il pulsante «Bussa». Il `Cassetto` del client web (tre verbi: leggi, scrivi, svuota) è implementato sulla cassaforte dell'app invece che su IndexedDB: **il confine scelto dal client web regge senza cambiarlo**.

## Misure

### 1. La WebView: contesto sicuro e `crypto.subtle`

È la domanda da cui dipende tutto il resto: senza `crypto.subtle` `ts-mls` non funziona ([S1](S1-ts-mls-sotto-la-csp.md) §«Limiti»), e il browser lo concede solo in un contesto sicuro.

| Dove                                                             | Origine                  | `isSecureContext` | `crypto.subtle` | MLS                |
| ---------------------------------------------------------------- | ------------------------ | ----------------- | --------------- | ------------------ |
| App Tauri su Linux (WebKitGTK 2.52) — è l'origine di macOS e iOS | `tauri://localhost`      | **sì**            | **sì**          | **21 prove su 21** |
| Chromium — è l'origine di Android e Windows                      | `http://tauri.localhost` | **sì**            | **sì**          | **18 prove su 18** |
| Chromium, controllo negativo                                     | `http://estia.lan`       | no                | **assente**     | fallisce           |

Il controllo negativo è quello che rende valide le altre due righe: un nome qualunque in HTTP non è un contesto sicuro, e lì `ts-mls` fallisce esattamente come su React Native (`Cannot read properties of undefined (reading 'generateKey')`). Tauri su Android e Windows serve l'app da `http://tauri.localhost` e regge perché **i nomi sotto `.localhost` sono contesti sicuri per specifica**; su macOS e iOS la serve da uno schema suo, `tauri://`, che WebKit tratta come sicuro.

**Non misurato**: WKWebView su iPhone e la WebView di sistema di Android, che sono gli stessi motori ma non gli stessi binari. È la prima delle prove sul dispositivo.

### 2. Il codice MLS di ESTIA nella WebView

Lo scenario usa le funzioni del client web, con la stessa ciphersuite: due dispositivi preparati con `preparaDispositivo` (identità e scorta di dieci `KeyPackage`), Anna crea la conversazione e aggiunge Bruno, Bruno entra dal Welcome, si scrivono, lo stato del gruppo di Anna fa il giro della cassaforte con `encodeGroupState` e la risposta di Bruno si legge con lo stato riaperto; poi backup sotto passphrase e ripristino su un dispositivo vuoto.

| Passo (ms)                                      | WebKitGTK, app Tauri | Chromium |
| ----------------------------------------------- | -------------------- | -------- |
| `preparaDispositivo` (identità + 10 KeyPackage) | 328                  | 82       |
| Crea la conversazione                           | 27                   | 15       |
| Aggiunge Bruno (Commit + Welcome, ~1 kB)        | 44                   | 18       |
| Entra dal Welcome                               | 28                   | 10       |
| Cifra / decifra un messaggio (324 byte)         | 4 / 9                | 2 / 5    |
| Stato del gruppo nella cassaforte e ritorno     | 6                    | 2        |
| Backup sotto passphrase (PBKDF2 600 000)        | 124                  | 113      |

Sono tempi di un container senza GPU, e un telefono sarà più lento; ma l'operazione più cara di una sessione normale, `preparaDispositivo`, sta sotto il terzo di secondo e si fa all'accesso, non a ogni messaggio.

**La CSP dell'app è quella dell'istanza** (`script-src 'self'`, [`static.ts`](../../apps/core-api/src/web/static.ts)), ed è **viva**: `new Function` è bloccato in tutti e due i motori. Un'osservazione per chi rifà S1: **WebKitGTK non applica la CSP a WebAssembly**, che lì compila anche senza `wasm-unsafe-eval`. Per `ts-mls`, che di WebAssembly non ne ha, non cambia niente; ma in WebKit il controllo negativo di S1 non vale, e quello giusto è `eval`.

### 3. La cassaforte del sistema

ADR 0044 §2 vuole le chiavi del dispositivo nella cassaforte del sistema. La forma provata:

- **nella cassaforte del sistema sta una chiave sola**, di 32 byte;
- tutto il resto — materiale MLS, stati dei gruppi, chiave di rete iroh — sta in **file sigillati** nella cartella dati dell'app, cifrati con quella chiave e con il nome del file come dato associato.

Il perché della forma: su Windows un segreto del Credential Manager ha un tetto di 2560 byte, e già il materiale di un dispositivo con la sua scorta pesa **9508 byte** sigillato. Una chiave sola ci sta ovunque, e la forma è la stessa sulle quattro piattaforme.

| Piattaforma | Negozio                                                                               | Stato                                                                                               |
| ----------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Linux       | Secret Service (GNOME Keyring), via D-Bus                                             | **misurato**: chiave creata al primo avvio, ritrovata al secondo, stessa chiave di firma MLS        |
| iOS         | portachiavi protetto, `AfterFirstUnlockThisDeviceOnly` (niente iCloud, niente backup) | il codice compila contro l'API (`cargo check` del negozio per `aarch64-apple-ios`); **da misurare** |
| Android     | chiave nel Keystore, segreto in `SharedPreferences`                                   | compila contro l'API per `aarch64-linux-android`; **da misurare**                                   |
| macOS       | portachiavi dell'utente (login keychain)                                              | compila contro l'API; **da misurare**                                                               |
| Windows     | Credential Manager                                                                    | compila contro l'API; **da misurare**                                                               |

Misurato anche, su Linux: **il file sul disco non è in chiaro** (la sonda ne mostra i primi byte), e cancellando la cartella dati dell'app con la chiave ancora nel portachiavi, al riavvio l'app **trova il residuo e lo cancella** e nasce un dispositivo nuovo. È la simulazione del caso iOS qui sotto.

Il binario compilato dell'app, su Linux, pesa **22,8 MB** con iroh dentro (la WebView è quella del sistema); l'interfaccia della sonda 260 kB.

### 4. Il collegamento iroh

| Prova                                                              | Esito                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Dispositivo Rust 1.4.1 → Casa Rust 1.4.1, rete locale              | **diretta**, mediana 0,8 ms su 20 domande, eco 64 kB in 1,8 ms                    |
| Dispositivo Rust 1.4.1 → **Casa con `@number0/iroh` 1.1.0** (Node) | **diretta**, mediana 1,5 ms, eco 64 kB in 10,6 ms: **le due versioni si parlano** |
| Chiave non ammessa, sulle due Case                                 | **nessun byte applicativo**: connessione chiusa con codice 0 e nessun motivo      |
| Test automatico (`cargo test`): ammesso riceve, estraneo no        | **verde**                                                                         |
| Internet, con scoperta e relay di n0                               | **non misurabile qui**: il proxy del container rifiuta i relay di n0              |
| Milano–Campello sui dati mobili                                    | **da misurare**                                                                   |

La seconda riga conta più di quanto sembri: l'app e la Casa aggiorneranno iroh con i loro tempi, e se 1.1 e 1.4 non si capissero l'app sarebbe legata alla versione della Casa.

## Osservazioni che cambiano il lavoro dopo

**Su iOS il portachiavi sopravvive alla cancellazione dell'app.** È un comportamento noto di iOS, e va contro la verifica 4 di ADR 0044 (_«reinstallare l'app produce un dispositivo nuovo»_): senza fare niente, un'app reinstallata ritroverebbe la vecchia chiave. Lo spike lo risolve con un **segno nella cartella dati**, che invece sparisce con l'app: se il segno manca e la cassaforte ha una chiave, quella chiave è di un'installazione precedente e si cancella. Su Linux funziona; su iPhone va provato, ed è il terzo passo della prova 2.

**Su Android il backup automatico va spento** (`android:allowBackup="false"`). Altrimenti riporterebbe su un telefono nuovo i file sigillati, che lì non si aprono più perché la chiave del Keystore non si copia: un dispositivo nuovo che crede di essere il vecchio.

**Una chiave non ammessa riceve niente, ma sa che la Casa c'è.** In QUIC, come in TLS 1.3, la Casa prova la propria identità **prima** di chiedere quella di chi bussa: chi conosce la chiave della Casa scopre che è accesa e parla quell'ALPN, poi la connessione si chiude. Non riceve un byte, e il rifiuto è lo stesso per ogni chiave sconosciuta. Ma la verifica 2 di ADR 0044 chiede di più — _«nemmeno un errore che distingua "non registrato" da "non esiste"»_ — e questo **non si ottiene**: una Casa che non esiste non risponde, una che rifiuta risponde e chiude. Non è una perdita nuova: la chiave della Casa è già pubblicata nella scoperta di n0, e la stessa Casa risponde a chiunque sull'ALPN fra Case ([ADR 0020](../adr/0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md)). **La frase della verifica 2 va riscritta, e la riscrittura è del proprietario.**

**Sul Mac il portachiavi protetto vuole un'app firmata con un profilo di provisioning.** Lo spike usa il portachiavi dell'utente, che è quello delle app desktop non sandboxate. Se l'app per Mac passerà dal Mac App Store, sarà sandboxata e userà quello protetto, come iOS: è una scelta della milestone.

**Le chiavi in memoria.** Con Tauri le chiavi MLS stanno **nella memoria della WebView** mentre si usano, come oggi nel browser; la cassaforte le protegge **a riposo**, non in uso. Un nucleo MLS in Rust (l'ipotesi scritta in ADR 0044 §8) le terrebbe fuori dalla WebView, al prezzo di una seconda implementazione MLS e della verifica 6 da fare per davvero. Lo spike non vede una ragione di pagarlo adesso: la CSP dell'istanza vale anche nell'app, e l'app non carica codice da fuori. Ma è la domanda giusta da fare se un giorno la WebView diventasse la parte debole.

**Tauri 3 è in alpha** (3.0.0-alpha.6 del 2026-11-06). La milestone delle app lo incontrerà; lo spike sta su 2.12.

## Limiti di questa prova

- **Nessun telefono, nessun Mac, nessun Windows.** iOS e Android sono le due piattaforme per cui l'app esiste, e qui non c'è stata una misura su nessuna delle due. Che il codice della cassaforte compili per i loro target dice che le API sono quelle; non dice che a runtime il Keystore si inizializzi da solo dentro Tauri, come la libreria afferma.
- **Il compilatore non ha prodotto un'app per telefono.** Il container non raggiunge l'SDK e l'NDK di Android, e Xcode esiste solo su macOS. Le istruzioni per farlo sono nel [README](../../infra/spike-app/README.md).
- **La rete vera non c'è stata.** Tutte le misure iroh sono in rete locale, dove la strada è diretta per costruzione. Il caso che decide, il telefono sui dati mobili con la Casa dietro un NAT, è la prova 4.
- **La Casa è finta.** Risponde a `salute` e a `eco`. Portare l'API dei membri su uno stream iroh (ADR 0044 §4, _«la stessa API di oggi»_) è lavoro della milestone, e lo spike non ne misura il costo.
- **Le notifiche non sono toccate.** ADR 0044 §7 le restringe a una scelta di fornitore; con Tauri passano da un plugin nativo, e restano da scegliere.

## Che cosa resta da misurare sul dispositivo

| Prova (README)      | Domanda                                                                                                     | Verifica di ADR 0044 |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------- |
| 1 — Mac             | La sonda passa? Il portachiavi chiede il permesso, e la chiave regge al riavvio?                            | 4 (sul PC)           |
| 2 — iPhone          | La sonda passa in WKWebView? Il portachiavi regge al riavvio, e la reinstallazione dà un dispositivo nuovo? | 4, 6                 |
| 3 — Android         | La sonda passa nella WebView di sistema? Il Keystore si inizializza? Stesse due domande.                    | 4, 6                 |
| 4 — Milano–Campello | Diretta o relay, e con che tempi, dal telefono sui dati mobili alla Casa dietro il router                   | 1, 2                 |

**Che cosa smentirebbe Tauri**, detto prima di misurare: `crypto.subtle` assente nella WebView di un telefono; una cassaforte che su iOS o Android non si apre da Rust dentro Tauri; un collegamento dal telefono che non arriva alla Casa nemmeno via relay. Un tempo lento non smentisce niente: si misura e si decide.

## Conseguenze per ADR 0044

1. **Tauri non è smentito**, e regge una cosa che l'ipotesi scritta in §8 non avrebbe dato: il codice MLS del client web **si porta nell'app senza riscriverlo**, quindi la verifica 6 è vera per costruzione invece che da dimostrare.
2. **Le quattro prove della tabella qui sopra chiudono lo spike.** Fino ad allora l'esito resta parziale, e la milestone delle app non si apre.
3. **Tre frasi da decidere**, nessuna urgente prima delle prove: la verifica 2 com'è scritta non si può ottenere con QUIC e va riscritta; la regola «reinstallare è un dispositivo nuovo» chiede su iOS il segno d'installazione, ed è da scrivere nell'ADR della milestone; il Mac sandboxato o no decide quale portachiavi.
4. **Se le prove passano**, il passo dopo non è un altro spike: è scrivere il piano della milestone delle app con Tauri 2 come stack, e il primo pezzo è l'API dei membri su uno stream iroh.

## Licenze

Tutte compatibili con AGPL-3.0 ([ADR 0015](../adr/0015-licenza-agpl.md)): Tauri e i suoi pacchetti Apache-2.0 o MIT; iroh MIT o Apache-2.0; `keyring-core` e i negozi MIT o Apache-2.0; `chacha20poly1305` Apache-2.0 o MIT; `ts-mls` e la sua catena MIT ([S1](S1-ts-mls-sotto-la-csp.md)). Nessuna dipendenza nuova entra nell'istanza o nel client web: tutto sta in `infra/spike-app/`.

## Fonti

Verificate il 2026-11-18.

- https://v2.tauri.app/start/prerequisites/ — prerequisiti per iOS e Android
- https://w3c.github.io/webappsec-secure-contexts/#localhost — perché `tauri.localhost` è un contesto sicuro
- https://github.com/open-source-cooperative/keyring-rs/wiki/Keyring — i negozi per piattaforma; l'app dimostrativa Tauri 2 del progetto dichiara iOS e Android in beta pubblica
- `iroh` 1.4.1, sorgenti del crate: `EndpointHooks`, `Connection::paths`, `presets::Minimal`
