# ESTIA per iPhone

L'app iPhone in SwiftUI ([ADR 0051](../../docs/adr/0051-le-app-del-telefono-sono-native.md)). Si appoggia al nucleo Rust di [`apps/nucleo`](../nucleo/README.md) per il collegamento con la Casa e per MLS. Barre, schede e fogli sono quelli di sistema, quindi su iOS 26 sono Liquid Glass senza imitazioni.

Per ora l'app fa tre cose:

- collega il telefono alla Casa con il codice del QR, inquadrato dalla fotocamera (`estia://ingresso`) o incollato;
- mostra la bacheca della Casa;
- mostra il profilo e permette di uscire da questo dispositivo.

| Cartella           | Che cosa c'è                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `Estia/App`        | L'avvio e lo stato: se il telefono è entrato in una Casa, e il collegamento con cui le parla                      |
| `Estia/Cassaforte` | Il `Deposito` del nucleo: una chiave nel Keychain (`ThisDeviceOnly`), file sigillati ed esclusi dal backup        |
| `Estia/Lingue`     | Le frasi di `packages/lingue`, con le stesse regole del web                                                       |
| `Estia/Aspetto`    | Colori (ocra, chiaro e scuro) e caratteri: Besley per i titoli, Atkinson Hyperlegible Next per il testo (OFL 1.1) |
| `Estia/Schermate`  | Ingresso, bacheca, profilo                                                                                        |

## Come si apre sul Mac

Servono Xcode, Rust (`rustup`) e Node. La prima volta:

```sh
cd apps/ios
./scripts/prepara.sh --debug   # nucleo per iPhone e simulatore, frasi, progetto Xcode
./scripts/simulatore.sh        # costruisce e apre l'app nel simulatore
```

`prepara.sh` installa XcodeGen con Homebrew se manca. Il progetto `Estia.xcodeproj` si genera da `project.yml` e non sta in git; va rigenerato con `prepara.sh` quando si aggiungono file.

Se il repository sta su un disco esterno (exFAT), vale quello che dice [`apps/app/README.md`](../app/README.md) sui file `._`: la build va tenuta sul disco interno.

## Regole

- Nessuna frase scritta nel codice: `Frasi.t("chiave")`, e `scripts/controlla-frasi.mjs` fallisce in CI se una chiave non è nella tabella.
- Nessuna chiave nell'interfaccia: l'app chiede al nucleo, e il nucleo non esporta segreti.
