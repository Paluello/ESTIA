# S7 — OpenMLS e `ts-mls` nella stessa conversazione

- Data: 2026-11-27
- Eseguito da: sessione di lavoro assistita, in un container Linux
- Domanda in prova: [ADR 0044](../adr/0044-il-dispositivo-e-l-app.md) §«Come si verifica», verifica 6, riaperta dalla scelta delle app native ([ADR 0051](../adr/0051-le-app-del-telefono-sono-native.md)): una libreria MLS in Rust e il client web stanno nella stessa conversazione?
- Ipotesi in prova: **OpenMLS 0.9.2** con il fornitore RustCrypto, contro `ts-mls`, ciphersuite `MLS_128_DHKEMP256_AES128GCM_SHA256_P256` ([ADR 0038](../adr/0038-mls-si-adotta-e-si-comincia-dal-web.md) §5)
- Esito: **sì, dopo due correzioni dalla parte di `ts-mls`.** Con `ts-mls` 1.6.4 e una patch di dieci righe, tutto lo scenario passa nei due sensi

## La risposta in tre righe

Cinque membri, tre `ts-mls` e due OpenMLS, attraversano otto epoch: ingresso dal Welcome, aggiornamenti di chiave, rientro dal `GroupInfo`, uscite e messaggi, ogni volta da tutte e due le parti.
A ogni epoch tutti i membri hanno lo stesso `epoch_authenticator` e la stessa serratura del mazzo d'archivio, quindi lo stesso key schedule.
Per arrivarci si è dovuto **aggiornare `ts-mls` da 1.6.2 a 1.6.4** e correggere a mano come scrive l'estensione `external_pub`: due difetti di `ts-mls`, il primo dei quali toccava anche il client web di oggi.

## Ambiente

| Voce        | Valore                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Rust        | `openmls` 0.9.2, `openmls_rust_crypto` 0.6.0, `openmls_basic_credential` 0.6.0 (tutte MIT); 1.97.0 |
| TypeScript  | `ts-mls` 1.6.4 da `apps/web`, con `patches/ts-mls@1.6.4.patch`; Node 22.23.5                       |
| Credenziale | `basic`, identità `<username>@<casa>` come in [`gruppo.ts`](../../apps/web/src/mls/gruppo.ts)      |
| Materiale   | [`infra/spike-mls/`](../../infra/spike-mls/README.md)                                              |

La licenza MIT di OpenMLS è compatibile con l'AGPL di ESTIA.

## Che cosa si è costruito

- **`ponte/`**: un membro OpenMLS per processo, comandato a righe JSON. Sa creare un gruppo, aggiungere, togliere, aggiornarsi, entrare da un Welcome, pubblicare un `GroupInfo`, rientrare da uno, cifrare e applicare.
- **`prova.mjs`**: il pilota. Tiene i membri `ts-mls` in memoria, con un `AuthenticationService` vero che controlla ogni foglia contro un registro di chiavi di firma, e comanda i membri OpenMLS. Fra le due parti passano **solo byte `MLSMessage`** di RFC 9420, come sul canale di ESTIA.

## Lo scenario

| Passo | Chi fa che cosa                                                                              | Epoch |
| ----- | -------------------------------------------------------------------------------------------- | ----- |
| 1     | anna (ts) crea e fa entrare bruno (Rust) con un Welcome; messaggi nei due sensi              | 1     |
| 2     | bruno (Rust) fa entrare carla (ts); anna applica il commit                                   | 2     |
| 3     | carla (ts), poi bruno (Rust) aggiornano la propria foglia                                    | 3-4   |
| 4     | dario (Rust) rientra da solo dal `GroupInfo` di anna (ts)                                    | 5     |
| 5     | elena (ts) rientra da sola dal `GroupInfo` di bruno (Rust); ognuno dei cinque scrive a tutti | 6     |
| 6     | anna (ts) toglie dario (Rust); dario riceve il commit e non legge il messaggio dopo          | 7     |
| 7     | bruno (Rust) toglie carla (ts); carla non legge il messaggio dopo; i tre rimasti scrivono    | 8     |

Dopo ogni passo il pilota confronta, per ogni membro: epoch, `epoch_authenticator`, l'exporter con l'etichetta `estia archive wrap v1` (la serratura di [S2](S2-la-chiave-d-archivio.md)) e l'elenco dei membri. Tutto coincide.

La chiave di firma che il registro conosce per i membri OpenMLS è letta **dal loro `KeyPackage` con `ts-mls`**, ed è la stessa che l'`AuthenticationService` vede poi nelle foglie: le due parti la codificano uguale.

## Che cosa non andava, e com'è stato corretto

### 1. `ts-mls` 1.6.2 non mette il percorso nei commit che tolgono qualcuno

RFC 9420 §12.4 vuole un `UpdatePath` in ogni commit che contiene una `Remove`. Il motivo è di sicurezza: senza percorso il segreto del commit è zero, e chi viene tolto conosce già l'`init_secret` dell'epoch prima. Può quindi derivare l'epoch nuova e leggere ciò che si scrive dopo la sua uscita. In 1.6.2 il controllo era `remove.length > 1` invece di `> 0`: un commit che toglie **una** persona usciva senza percorso. OpenMLS lo rifiuta (`RequiredPathNotFound`), e ha ragione.

**Riguarda anche il client web di oggi**, anche senza nessuna app nativa: in un gruppo solo `ts-mls`, chi è stato tolto da un commit con una sola uscita poteva continuare a leggere. 1.6.4 corregge questo e altri due punti dello stesso codice (il segreto del commit e l'esclusione dei nuovi membri dal percorso). **`apps/web` passa a 1.6.4**; i 125 test di `apps/web/src/mls` passano.

### 2. `ts-mls` scrive `external_pub` senza lunghezza

RFC 9420 §12.4.3.2: l'estensione è `struct { HPKEPublicKey external_pub; }`, e `HPKEPublicKey` è `opaque<V>`, cioè preceduta dalla sua lunghezza. `ts-mls` 1.6.4, e anche 2.0.0-rc.19, scrive la chiave nuda e la rilegge nuda. Fra due client `ts-mls` funziona; OpenMLS non legge il `GroupInfo` (`TrailingData`), e `ts-mls` non legge quello di OpenMLS.

La correzione è in [`patches/ts-mls@1.6.4.patch`](../../patches/ts-mls@1.6.4.patch), applicata da pnpm: si **scrive** con la lunghezza e si **legge** in tutte e due le forme. I punti di rientro già depositati su un'istanza restano leggibili. Va segnalata a `ts-mls`, e la patch si toglie quando la correzione arriva.

## Limiti

- **Un fornitore crittografico solo per lato**: RustCrypto in Rust, WebCrypto e `@noble` in `ts-mls`. Sul telefono il nucleo userà lo stesso RustCrypto, quindi è il caso giusto.
- **Lo stato OpenMLS sta in memoria.** Il nucleo vero lo terrà nella cassaforte, attraverso un `StorageProvider` suo; non cambia niente sul filo.
- **Non si è provato il resync** (rientro con la stessa chiave di firma che sostituisce la foglia vecchia, [S3](S3-il-rientro-di-un-dispositivo.md)). OpenMLS lo fa togliendo da sé la foglia con la stessa identità; va provato quando il nucleo avrà la cassaforte.
- **Le proposte separate dal commit** (una `Remove` proposta da uno e messa nel commit da un altro) non sono nello scenario: ESTIA oggi non le usa.

## Che cosa decide

Niente da solo: misura. Dice che la scelta di [ADR 0051](../adr/0051-le-app-del-telefono-sono-native.md), un nucleo Rust con OpenMLS sotto le app native, **non spezza le conversazioni con il web**, a patto di tenere `ts-mls` a 1.6.4 o oltre e la patch finché serve.

## Come si rifà

```sh
pnpm install
cargo build --manifest-path infra/spike-mls/ponte/Cargo.toml
node infra/spike-mls/prova.mjs
```
