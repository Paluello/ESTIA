# ADR 0051 — Le app del telefono sono native, sopra un nucleo Rust comune

- Stato: **Proposed** — da accettare dal proprietario
- Data: 2026-11-27
- Proprietario: progetto ESTIA
- Dipende da: [ADR 0044](0044-il-dispositivo-e-l-app.md) §8 punto 1, [ADR 0038](0038-mls-si-adotta-e-si-comincia-dal-web.md) §5
- Misurato da: [S6](../spike/S6-lo-stack-dell-app.md) (Tauri, iroh e cassaforte in Rust), [S7](../spike/S7-openmls-e-ts-mls.md) (OpenMLS e `ts-mls` nella stessa conversazione)

## Contesto

[S6](../spike/S6-lo-stack-dell-app.md) ha provato Tauri 2 per tutte e tre le piattaforme: l'interfaccia del web in una WebView, iroh e la cassaforte in Rust, `ts-mls` come nel browser. Regge, ed è diventata l'app di `apps/app` (PR #15), che oggi produce un APK Android e una build per il simulatore iPhone.

Il 2026-11-27 il proprietario ha fissato un'altra priorità: **l'esperienza più bella possibile sul telefono**. Su iPhone vuol dire il Liquid Glass di iOS vero, cioè i componenti di sistema, e non una sua imitazione in CSS dentro una WebView. Su Android vuol dire Material 3 con i suoi gesti e le sue transizioni. Una WebView non dà né l'uno né l'altro, e la differenza si vede proprio dove un'app di messaggi passa il tempo: liste lunghe, tastiera, scorrimento, ritorno indietro.

Il proprietario ha scelto la strada nativa sapendo il costo: due interfacce invece di una, e circa **4-6 settimane** in più prima del lancio.

## Decisione

1. **iPhone in SwiftUI, Android in Jetpack Compose.** Ogni app usa i componenti del proprio sistema: su iOS barre, fogli e schede con il materiale di sistema (Liquid Glass dove il sistema lo offre), su Android Material 3. Lo studio dell'interfaccia (caratteri Besley e Atkinson Hyperlegible impacchettati, ocra come predefinito, la piastrella della Casa) dà la direzione, non le schermate.
2. **Il PC resta Tauri con il client web**, cioè `apps/app` così com'è. Sul PC la WebView non è un compromesso visibile, e il client web serve comunque.
3. **Un nucleo Rust comune ai due telefoni**, `estia-nucleo`, esposto a Swift e Kotlin con UniFFI. Contiene tutto ciò che non è interfaccia:
   - il filo verso la Casa: iroh 1.4.1, `estia/ingresso/1` ed `estia/dispositivo/1` ([`ACCESSO_DEL_DISPOSITIVO.md`](../ACCESSO_DEL_DISPOSITIVO.md)), preso dal lato Rust di `apps/app`;
   - la cassaforte: una chiave nel Keychain o nel Keystore, i file sigillati, il segno d'installazione ([S6](../spike/S6-lo-stack-dell-app.md));
   - **MLS con OpenMLS**, con lo stato salvato nella cassaforte.

   Le chiavi non escono dal nucleo. L'interfaccia chiede «cifra questo per questa conversazione», non riceve segreti.

4. **MLS: OpenMLS sul telefono, `ts-mls` sul web, la stessa ciphersuite** (`MLS_128_DHKEMP256_AES128GCM_SHA256_P256`). [S7](../spike/S7-openmls-e-ts-mls.md) mostra che stanno nella stessa conversazione nei due sensi, a due condizioni che questo ADR rende regole:
   - `ts-mls` **1.6.4 o successivo**. 1.6.2 non metteva il percorso nei commit con una sola uscita, e chi veniva tolto poteva continuare a leggere;
   - la patch `patches/ts-mls@1.6.4.patch` per `external_pub`, finché `ts-mls` non la corregge.

   La prova di S7 diventa un **test in CI**: ogni modifica a `apps/web/src/mls` o al nucleo la rifà.

5. **Una lingua sola per le frasi.** Le app native leggono le tabelle di `packages/lingue` così come sono: la build le copia nell'app, e le regole di lettura (lingua scelta, inglese di riserva, segnaposto) sono le stesse del web. Un controllo in CI fallisce se l'app chiede una chiave che la tabella non ha, come oggi fa il lint sul web.
6. **I colori, i caratteri e le misure vengono da un posto solo**: i token dello studio dell'interfaccia, generati per CSS, Swift e Kotlin.
7. **Su CI si costruiscono tutte e due**: l'app iPhone per il simulatore su un runner macOS, l'APK Android firmato nella pre-release `app-anteprima`, come oggi. La firma per TestFlight e Play arriva con gli account.
8. **L'APK Tauri resta l'anteprima Android** finché l'app in Compose non fa almeno ingresso e messaggi; poi la sostituisce nella stessa pre-release.

## Conseguenze

- **Due interfacce da scrivere e da tenere allineate.** È il costo principale ed è voluto. Tutto ciò che non si vede sta nel nucleo, quindi la logica non si scrive due volte.
- **Due implementazioni MLS in produzione.** Un difetto in una delle due può spezzare le conversazioni miste: per questo il test di S7 entra in CI e non resta uno spike. In cambio, S7 ha già trovato due difetti di `ts-mls`, e uno toccava anche il web di oggi.
- **La sveglia di [ADR 0048](0048-il-fornitore-della-sveglia.md) è più semplice da nativo**: APNs e UnifiedPush hanno librerie native, senza un plugin di Tauri in mezzo.
- **Il lancio slitta di circa 4-6 settimane**, accettato dal proprietario il 2026-11-27.
- `apps/app` resta, ma per il PC: le parti per iOS e Android vengono tolte quando le app native le sostituiscono.

## Come si verifica

1. **La stessa conversazione** fra l'app iPhone, l'app Android e il browser, nei due sensi: il test di S7 in CI, poi su telefoni veri.
2. **Una chiave MLS non esce dal nucleo**: l'interfaccia UniFFI non ha funzioni che restituiscono segreti, e un test lo controlla sull'elenco delle funzioni esportate.
3. **Il Liquid Glass è quello di sistema**: le barre e le schede dell'app iPhone sono componenti SwiftUI di sistema, non viste disegnate a mano.
4. **Nessuna frase scritta nel codice delle app**: la build fallisce se ne trova una fuori dal catalogo generato.

## Quando riesaminare

- Se tenere allineate due interfacce costa più di quanto si guadagni in esperienza, misurato sulle prime tre schermate.
- Se OpenMLS e `ts-mls` divergono in un modo che una patch non ripara.
- Se `ts-mls` corregge `external_pub`: la patch si toglie.

## Fonti

- [S6](../spike/S6-lo-stack-dell-app.md), [S7](../spike/S7-openmls-e-ts-mls.md)
- RFC 9420 §12.4 (percorso nei commit), §12.4.3.2 (`external_pub`)
- OpenMLS 0.9.2, licenza MIT; UniFFI, licenza MPL-2.0
