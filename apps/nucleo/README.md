# estia-nucleo

Il nucleo Rust delle app native di ESTIA ([ADR 0051](../../docs/adr/0051-le-app-del-telefono-sono-native.md)). Sta sotto l'app iPhone (SwiftUI) e l'app Android (Compose), che lo usano attraverso i legami generati da [UniFFI](https://mozilla.github.io/uniffi-rs/).

Contiene ciò che non è interfaccia. L'interfaccia chiede «cifra questo per questa conversazione» e **non tocca mai una chiave**.

| Modulo               | Che cosa fa                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mls.rs`             | MLS con OpenMLS 0.9.2, interoperabile con il client web ([S7](../../docs/spike/S7-openmls-e-ts-mls.md)): KeyPackage, Welcome, commit, rientro, messaggi                                                                                                                        |
| `archivio.rs`        | L'archivio della conversazione ([ADR 0037](../../docs/adr/0037-la-cronologia-e-un-archivio-non-una-chiave.md), [ADR 0052](../../docs/adr/0052-l-archivio-dei-gruppi.md)): la catena, il mazzo, le voci e il loro legame, uguali byte per byte a `apps/web/src/mls/archivio.ts` |
| `istanza.rs`         | L'`Istanza`: ciò che la sessione chiede alla Casa, con le rotte e le forme JSON di `apps/core-api`. `IstanzaSuCasa` la fa sopra il `Collegamento`; nei test c'è un'istanza in memoria (`sessione/finta.rs`)                                                                    |
| `sessione.rs`        | Le conversazioni vere: le regole di `apps/web/src/mls/sessione.ts` e `conversazione.ts`, sopra `mls.rs` e l'`Istanza`. È `Sessioni`, ciò che le schermate usano                                                                                                                |
| `deposito.rs`        | Le due cose che chiede all'app: un `Deposito` (la cassaforte del telefono) e un `Registro` (le chiavi di firma che l'istanza riconosce)                                                                                                                                        |
| `casa.rs`            | Il collegamento con la Casa via iroh: la chiave di rete del dispositivo, l'ingresso con il QR (`estia/ingresso/1`) e le richieste dell'API (`estia/dispositivo/1`)                                                                                                             |
| `filo.rs`, `rete.rs` | Il formato del filo e l'endpoint iroh. Li usa anche l'app del PC (`apps/app/src-tauri`), senza UniFFI                                                                                                                                                                          |
| `errore.rs`          | Codici d'errore, non frasi: la frase la sceglie l'app da `packages/lingue`                                                                                                                                                                                                     |

## Regole che il codice mantiene

- Ogni foglia nuova si autentica contro il `Registro` prima di applicare un commit o di entrare in un gruppo. OpenMLS non ha un `AuthenticationService` da montare come `ts-mls`, quindi lo fa il nucleo.
- Lo stato si scrive nel `Deposito` dopo ogni operazione che lo cambia, sotto il nome `nucleo/mls`.
- Lo stato è alla versione 2 (`estia-nucleo-mls-2`): in coda ha le catene d'archivio. Uno stato della versione 1 si apre ancora, senza catene.
- Un'operazione su un gruppo è **tutto o niente**: se si ferma a metà (il registro non risponde, una foglia non è riconosciuta) lo stato in memoria torna com'era. OpenMLS consuma la chiave di una busta quando la apre, e senza questo la stessa busta non si aprirebbe più al giro dopo.
- La serratura del mazzo e la catena d'archivio non sono esportate. `scripts/legami.sh` fallisce se una funzione esportata somiglia a un segreto.

## L'archivio

L'interfaccia porta le buste e non tocca mai una chiave: la catena sta nello stato del nucleo, e la serratura si deriva e si usa qui dentro.

| Sul `Dispositivo`                               | Che cosa fa                                                                                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archivia(conversazione, testo, id, creato_il)` | Ricifra il testo con l'ultima chiave della catena e restituisce la `VoceCifrata` da depositare. La voce è legata a conversazione, id, data e **alla foglia di chi scrive** |
| `rileggi(conversazione, voce, dichiarato)`      | Il testo, se la voce si apre con ciò che l'istanza dichiara (id, mittente, data). `None` se non si apre: è uno stato da mostrare, mai un testo                             |
| `mazzo_avvolto(conversazione)`                  | Il mazzo sotto la serratura dell'epoch corrente, da depositare presso l'istanza. `None` per chi non conosce la catena                                                      |
| `apri_mazzo(conversazione, avvolto)`            | Apre il mazzo che l'istanza custodisce, se è dell'epoch in cui si è                                                                                                        |
| `ha_archivio(conversazione)`                    | Se questo dispositivo ha la catena: finché non l'ha, non scrive                                                                                                            |

Le regole sono quelle di `apps/web/src/mls/sessione.ts`, e le applica il nucleo:

- La catena nasce con `crea_conversazione`, casuale. Chi entra (`entra`) o rientra (`rientra`) non ce l'ha finché non apre un mazzo.
- **A ogni rimozione la catena guadagna una chiave**, in `rimuovi` e in `applica`, commit per commit. La chiave è l'exporter dell'epoch che la rimozione ha creato, con l'etichetta `estia archive chain v1`: chi resta la ottiene identica senza scambiarsela, chi è stato tolto no.
- **Dopo ogni cambio di epoch l'app chiede `mazzo_avvolto` e lo deposita.** La serratura è l'exporter con `estia archive wrap v1`, contesto vuoto, 32 byte. Chi non conosce la catena riceve `None` e non deposita niente: riavvolgere un mazzo che non si conosce lo sostituirebbe.
- Chi viene tolto (`Ricevuto::Uscito`) perde la catena su questo dispositivo: non legge il seguito e non scrive.

Due cose il nucleo le fa diversamente dal web, perché la catena qui resta nello stato invece di rinascere dal mazzo a ogni sessione. `apri_mazzo` cambia una catena che c'è già soltanto se quella trovata la **allunga**: un mazzo riavvolto da chi era rimasto indietro non toglie chiavi a nessuno. E non c'è la rotazione a mano (`ruotaArchivio`): una chiave aggiunta così dal web arriva dal mazzo.

## Le conversazioni

`Sessioni` è ciò che le schermate usano. Si apre con il `Collegamento` e il `Deposito`, parla con la Casa da sé e restituisce testo, persone e ore: **nessuna chiave, catena, serratura o byte di MLS passa il confine**, nemmeno come busta.

| Su `Sessioni`                                    | Che cosa fa                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apri(collegamento, deposito)`                   | Chiede alla Casa chi si è, apre o crea l'identità MLS, registra la chiave di firma e pubblica i KeyPackage che mancano (dieci di scorta)                                                                      |
| `io()`                                           | Chi si è, e se questo dispositivo è **approvato**. Il primo di una persona lo è da sé; gli altri aspettano il sì di uno già approvato ([ADR 0040](../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)) |
| `conversazioni()`                                | L'elenco, come lo dà la Casa                                                                                                                                                                                  |
| `crea_diretta(con)`, `crea_gruppo(nome, membri)` | Creano la conversazione presso la Casa. Il gruppo cifrato nasce alla prima apertura                                                                                                                           |
| `apri_conversazione(id)`                         | Riprende, entra da un invito, rientra, o crea se tocca a questo dispositivo. `Pronta`, `InAttesa` (l'invito non c'è ancora) o `Tolto`                                                                         |
| `aggiorna(id)`                                   | Un giro: applica gli handshake, riapre il mazzo, rimette l'albero d'accordo con i membri, e restituisce i **messaggi nuovi** con mittente e ora. Apre se non è aperta                                         |
| `cronologia(id, prima)`                          | Una pagina di cronologia, all'indietro                                                                                                                                                                        |
| `invia(id, testo, risponde)`                     | Scrive: la voce va nell'archivio della propria Casa, e basta ([ADR 0043](../../docs/adr/0043-custodia-lato-mittente.md))                                                                                      |
| `membri(id)`                                     | Chi c'è secondo la Casa, e con quanti dispositivi è nel gruppo cifrato                                                                                                                                        |
| `aggiungi_membro`, `fai_entrare`, `togli_membro` | Chi entra e chi esce da un gruppo: prima presso la Casa, poi nel gruppo cifrato. Ogni rimozione ruota la catena                                                                                               |

Le rotte che usa sono quelle del client web, sul canale `estia/dispositivo/1`: `GET /auth/me`, `GET /mls/casa`, `POST /dispositivi/chiave`, `POST /dispositivi/key-packages`, `POST /dispositivi/miei/key-packages`, `GET /mls/chiavi/:casa/:username`, `GET /mls/key-packages/:casa/:username`, `GET`/`POST /conversazioni`, `POST /gruppi`, e sotto `/conversazioni/:id`: `GET` (chi c'è), `POST /membri`, `DELETE /membri/:membro`, `GET`/`POST /handshake`, `GET`/`PUT /archivio/chiavi`, `GET`/`PUT /group-info`, `GET /cronologia`, `POST /archivio`. Nessuna è nuova.

Le regole sono quelle del web, e le applica il nucleo:

- **Gli handshake in ordine di arrivo**, e il cursore avanza solo su ciò che si è applicato. Una fila in disordine si rifiuta, e al giro dopo si riparte dallo stesso punto.
- **Il commit va in fila prima che lo stato avanzi.** Se la fila dice 409 un altro ha preso quell'epoch: il commit si butta, ci si rimette in pari e si riprova, fino a tre volte.
- **Il mazzo si riavvolge a ogni cambio di epoch**, e lo fa solo chi conosce la catena. Con lui si aggiorna il punto di rientro.
- **Le chiavi di firma si chiedono al registro della Casa**, per ogni foglia che entra o cambia, nel momento in cui il commit si applica. Una casa che non risponde è un errore, non un elenco vuoto.
- **Non si scrive se nell'albero c'è chi non è fra i membri** (`PresenzaEstranea`): chi ha una foglia apre il mazzo.
- Chi è stato tolto non rientra da sé, e non legge il seguito.

Quattro cose di prudenza, che il nucleo ha fatto per primo e che dal 2026-11-28 fa anche il client web (`apps/web/src/mls/sessione.ts`):

- **Un commit proprio resta in sospeso finché la fila non l'ha preso.** Prima di depositarlo il nucleo lo annota nel deposito (`nucleo/sessioni`, accanto ai cursori). Se l'app si chiude o la risposta si perde, al giro dopo lo riconosce in fila byte per byte e finisce il lavoro (mazzo, inviti), oppure lo butta se la fila non l'ha mai visto. Il web annota accanto alla busta anche lo stato che ne esce, perché `ts-mls` non riapplica un commit a chi l'ha scritto.
- **Lo stato si salva commit per commit**, prima del cursore: un giro interrotto a metà non lascia il cursore più avanti dello stato.
- **Un dispositivo che aspetta il sì non crea e non rientra.** Il suo commit lo rifiuterebbero tutti, perché la sua chiave nel registro non c'è, e la fila resterebbe ferma su quella busta.
- **Un KeyPackage che nomina un'altra persona non fa entrare nessuno**, anche alla creazione, e un invito per un'altra conversazione non si apre.

Una differenza resta. Chi perde la corsa a creare una chat a due (409) resta `InAttesa` dell'invito dell'altro, invece di ricevere un errore.

Quello che `Sessioni` **non** fa ancora, e che le schermate dovranno sapere: uscire da un gruppo, ritirare un messaggio, segnare come letto, i ruoli, il trasloco di un gruppo congelato, approvare o revocare un dispositivo, il numero di sicurezza. Le rotte ci sono; mancano le chiamate.

## Come si prova

```sh
cargo test
./scripts/legami.sh        # genera Swift e Kotlin in target/legami

# L'archivio davanti al client web vero (infra/prova-archivio)
cargo build --example ponte_archivio
node ../../infra/prova-archivio/prova.mjs

# Una conversazione fra la sessione del nucleo e quella del web (infra/prova-sessione)
cargo build --example ponte_sessione
node --experimental-transform-types ../../infra/prova-sessione/prova.mjs
```

I test della sessione stanno in `src/sessione/prove.rs`, contro l'istanza in memoria: due e tre dispositivi, chi entra e chi esce, la fila in disordine, la corsa sulla stessa epoch, il deposito che non arriva o la risposta che si perde, l'app che si chiude a metà, il registro che non risponde o non riconosce una chiave, chi è stato tolto.

Le librerie per iPhone vanno collegate con i framework `SystemConfiguration`, `Security` e `CoreFoundation`, che iroh usa. Su macOS la CI compila anche i legami Swift e li prova con `tests/swift/main.swift`, e costruisce le librerie per iPhone e per Android.
