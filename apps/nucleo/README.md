# estia-nucleo

Il nucleo Rust delle app native di ESTIA ([ADR 0051](../../docs/adr/0051-le-app-del-telefono-sono-native.md)). Sta sotto l'app iPhone (SwiftUI) e l'app Android (Compose), che lo usano attraverso i legami generati da [UniFFI](https://mozilla.github.io/uniffi-rs/).

Contiene ciò che non è interfaccia. L'interfaccia chiede «cifra questo per questa conversazione» e **non tocca mai una chiave**.

| Modulo               | Che cosa fa                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mls.rs`             | MLS con OpenMLS 0.9.2, interoperabile con il client web ([S7](../../docs/spike/S7-openmls-e-ts-mls.md)): KeyPackage, Welcome, commit, rientro, messaggi                                                                                                                        |
| `archivio.rs`        | L'archivio della conversazione ([ADR 0037](../../docs/adr/0037-la-cronologia-e-un-archivio-non-una-chiave.md), [ADR 0052](../../docs/adr/0052-l-archivio-dei-gruppi.md)): la catena, il mazzo, le voci e il loro legame, uguali byte per byte a `apps/web/src/mls/archivio.ts` |
| `deposito.rs`        | Le due cose che chiede all'app: un `Deposito` (la cassaforte del telefono) e un `Registro` (le chiavi di firma che l'istanza riconosce)                                                                                                                                        |
| `casa.rs`            | Il collegamento con la Casa via iroh: la chiave di rete del dispositivo, l'ingresso con il QR (`estia/ingresso/1`) e le richieste dell'API (`estia/dispositivo/1`)                                                                                                             |
| `filo.rs`, `rete.rs` | Il formato del filo e l'endpoint iroh. Li usa anche l'app del PC (`apps/app/src-tauri`), senza UniFFI                                                                                                                                                                          |
| `errore.rs`          | Codici d'errore, non frasi: la frase la sceglie l'app da `packages/lingue`                                                                                                                                                                                                     |

## Regole che il codice mantiene

- Ogni foglia nuova si autentica contro il `Registro` prima di applicare un commit o di entrare in un gruppo. OpenMLS non ha un `AuthenticationService` da montare come `ts-mls`, quindi lo fa il nucleo.
- Lo stato si scrive nel `Deposito` dopo ogni operazione che lo cambia, sotto il nome `nucleo/mls`.
- Lo stato è alla versione 2 (`estia-nucleo-mls-2`): in coda ha le catene d'archivio. Uno stato della versione 1 si apre ancora, senza catene.
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

## Come si prova

```sh
cargo test
./scripts/legami.sh        # genera Swift e Kotlin in target/legami

# L'archivio davanti al client web vero (infra/prova-archivio)
cargo build --example ponte_archivio
node ../../infra/prova-archivio/prova.mjs
```

Le librerie per iPhone vanno collegate con i framework `SystemConfiguration`, `Security` e `CoreFoundation`, che iroh usa. Su macOS la CI compila anche i legami Swift e li prova con `tests/swift/main.swift`, e costruisce le librerie per iPhone e per Android.
