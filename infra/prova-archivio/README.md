# prova-archivio

La prova che il nucleo delle app native ([`apps/nucleo`](../../apps/nucleo)) e il client web leggono e scrivono **lo stesso archivio** ([ADR 0037](../../docs/adr/0037-la-cronologia-e-un-archivio-non-una-chiave.md), [ADR 0052](../../docs/adr/0052-l-archivio-dei-gruppi.md)): una voce scritta dal telefono la apre il browser, e viceversa, e così il mazzo.

Sta accanto a [`spike-mls`](../spike-mls) (S7), che prova la stessa cosa per MLS, e ne riprende la forma: un processo Rust comandato a righe JSON e un pilota in Node.

| Lato     | Che cosa gira                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web      | I sorgenti veri di `apps/web/src/mls`: `archivio.ts`, `gruppo.ts`, `sessione.ts`, con l'istanza finta dei loro test (`finte.ts`). Node toglie i tipi da sé, non serve una build |
| telefono | [`ponte_archivio`](../../apps/nucleo/examples/ponte_archivio.rs): un `Dispositivo` del nucleo per processo, usato dal confine che vedono Swift e Kotlin                         |

Il pilota ([`prova.mjs`](prova.mjs)) fa l'app del telefono: porta le buste fra il nucleo e l'istanza, e non vede mai una chiave.

## Che cosa prova

1. **Il modulo, a chiavi scoperte.** Con la stessa serratura e la stessa catena sui due lati: il mazzo e le voci scritti da uno si aprono dall'altro, semplici e legate, con una catena ruotata, e sotto il sigillo del mazzo ci sono gli stessi byte. Il legame si confronta anche con virgolette, barre, caratteri di controllo e non ASCII nei campi.
2. **Una conversazione vera**, con due browser e due telefoni. La serratura del mazzo la deriva `ts-mls` da una parte e OpenMLS dall'altra (`estia archive wrap v1`): il mazzo avvolto dal web lo apre il nucleo, e quello avvolto dal nucleo lo apre il web. A ogni rimozione, fatta dal web e poi dal nucleo, chi resta deriva la stessa chiave nuova senza scambiarsela (`estia archive chain v1`), e chi è stato tolto non legge il seguito.

## Come si lancia

```sh
corepack pnpm install --frozen-lockfile
cargo build --manifest-path apps/nucleo/Cargo.toml --example ponte_archivio
node infra/prova-archivio/prova.mjs
```

Gira in CI nel flusso [`nucleo`](../../.github/workflows/nucleo.yml), dopo il test di S7.
