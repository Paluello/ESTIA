# prova-sessione

La prova che la **sessione** del nucleo delle app native ([`apps/nucleo`](../../apps/nucleo), `sessione.rs`) e quella del client web (`apps/web/src/mls/sessione.ts` e `conversazione.ts`) stanno nella stessa conversazione: un telefono e un browser si scrivono e si leggono, entrano e escono, senza che nessuno porti loro le buste a mano.

Sta accanto a [`spike-mls`](../spike-mls) (S7, il protocollo) e a [`prova-archivio`](../prova-archivio) (l'archivio), e ne riprende la forma: un processo Rust comandato a righe JSON e un pilota in Node.

| Lato     | Che cosa gira                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web      | I sorgenti veri di `apps/web/src/mls`: `conversazione.ts` e `sessione.ts`, con `ts-mls` sotto e l'istanza finta dei loro test (`finte.ts`)                                                                                                  |
| telefono | [`ponte_sessione`](../../apps/nucleo/examples/ponte_sessione.rs): lo stesso `Motore` che sta dentro `Sessioni`, sopra la stessa `IstanzaSuCasa`. Cambia soltanto il filo: al posto di iroh c'è una pipe                                     |
| Casa     | Il pilota ([`prova.mjs`](prova.mjs)). Riceve le richieste del nucleo come sono sul filo (metodo, percorso, corpo) e risponde con le forme di `apps/core-api`. La fila, il mazzo, l'archivio e il registro stanno nell'istanza finta del web |

## Che cosa prova

1. **Una chat a due creata dal telefono.** OpenMLS crea il gruppo, il browser entra dal suo invito e apre il suo mazzo; i messaggi si leggono nei due versi con mittente e ora sigillati, una risposta resta una risposta, un messaggio che il telefono ritira il browser non lo vede più (e uno d'altri non si ritira), e il telefono riparte dal suo deposito.
2. **Una chat a due creata dal browser.** Il telefono entra dall'invito di `ts-mls`, con il KeyPackage che aveva pubblicato alla Casa.
3. **Un gruppo con due telefoni e due browser.** Il telefono lo crea e aggiunge un browser, che legge anche il pregresso e il cui ingresso è detto. Il browser toglie un telefono e il telefono toglie un browser: chi resta deriva la stessa chiave nuova senza scambiarsela, e la catena di chi è stato tolto non apre il seguito.
4. **Un telefono esce da un gruppo.** Racconta l'uscita e la dice alla Casa senza mandare un commit; il browser, che ordina, toglie la sua foglia con `ts-mls`, e l'altro telefono applica il commit e continua.

In più, a ogni richiesta:

- il corpo che il nucleo manda e la risposta che riceve si confrontano con gli schemi di `packages/contracts`, con l'Ajv di Fastify: quelli con cui la Casa vera valida le stesse rotte;
- alla fine, ogni rotta che il nucleo ha usato deve ritrovarsi, con il suo metodo, fra quelle che `apps/core-api` registra. Un endpoint inventato fa fallire la prova.

## Che cosa non prova

La Casa del pilota **non è `apps/core-api`**: ne ha le rotte, i corpi e i codici d'errore, non il codice. Non ci sono iroh, la federazione fra due case, l'approvazione di un secondo dispositivo, la paginazione della fila. Queste cose hanno i loro test nel nucleo (`src/sessione/prove.rs`, `tests/casa.rs`) e in `apps/core-api`.

## Come si lancia

```sh
corepack pnpm install --frozen-lockfile
cargo build --manifest-path apps/nucleo/Cargo.toml --example ponte_sessione
node --experimental-transform-types infra/prova-sessione/prova.mjs
```

`--experimental-transform-types` serve perché `conversazione.ts` dichiara una proprietà nel costruttore, e a Node non basta togliere i tipi.

Gira in CI nel flusso [`nucleo`](../../.github/workflows/nucleo.yml), dopo la prova dell'archivio.
