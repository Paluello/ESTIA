# estia-nucleo

Il nucleo Rust delle app native di ESTIA ([ADR 0051](../../docs/adr/0051-le-app-del-telefono-sono-native.md)). Sta sotto l'app iPhone (SwiftUI) e l'app Android (Compose), che lo usano attraverso i legami generati da [UniFFI](https://mozilla.github.io/uniffi-rs/).

Contiene ciò che non è interfaccia. L'interfaccia chiede «cifra questo per questa conversazione» e **non tocca mai una chiave**.

| Modulo        | Che cosa fa                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mls.rs`      | MLS con OpenMLS 0.9.2, interoperabile con il client web ([S7](../../docs/spike/S7-openmls-e-ts-mls.md)): KeyPackage, Welcome, commit, rientro, messaggi |
| `deposito.rs` | Le due cose che chiede all'app: un `Deposito` (la cassaforte del telefono) e un `Registro` (le chiavi di firma che l'istanza riconosce)                 |
| `errore.rs`   | Codici d'errore, non frasi: la frase la sceglie l'app da `packages/lingue`                                                                              |

Il filo verso la Casa (iroh, `estia/ingresso/1` ed `estia/dispositivo/1`) arriva qui da `apps/app/src-tauri` nel passo successivo.

## Regole che il codice mantiene

- Ogni foglia nuova si autentica contro il `Registro` prima di applicare un commit o di entrare in un gruppo. OpenMLS non ha un `AuthenticationService` da montare come `ts-mls`, quindi lo fa il nucleo.
- Lo stato si scrive nel `Deposito` dopo ogni operazione che lo cambia, sotto il nome `nucleo/mls`.
- La serratura del mazzo d'archivio non è esportata. `scripts/legami.sh` fallisce se una funzione esportata somiglia a un segreto.

## Come si prova

```sh
cargo test
./scripts/legami.sh        # genera Swift e Kotlin in target/legami
```

Su macOS la CI compila anche i legami Swift e li prova con `tests/swift/main.swift`, e costruisce le librerie per iPhone e per Android.
