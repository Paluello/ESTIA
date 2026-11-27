# Le schede degli store

Che cosa si scrive su App Store Connect e su Google Play Console quando l'app di [ADR 0044](../adr/0044-il-dispositivo-e-l-app.md) è pronta per l'invio. I testi sono già nelle due lingue dell'interfaccia ([ADR 0046](../adr/0046-le-lingue-di-estia.md)) e stanno nei limiti di caratteri degli store; vanno incollati, non riscritti.

Questo documento è anche un elenco di cose che deve essere vero **il giorno dell'invio**: dove un testo dice qualcosa dell'app (un permesso, un dato che non si raccoglie), il thread dell'app lo deve rendere vero nel codice, e chi invia lo verifica prima.

## Che cosa serve da Mattia, e quando

| Che cosa                                                               | Dove                    | Quando                                                  |
| ---------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| Account sviluppatore Apple (99 $/anno), come persona fisica            | developer.apple.com     | Prima della prima build TestFlight                      |
| Account Google Play (25 $ una volta), come persona fisica              | play.google.com/console | **Entro il 10 dicembre**: il test chiuso dura 14 giorni |
| 12 tester con un account Google, iscritti al test chiuso per 14 giorni | Play Console → Test     | Subito dopo la prima build Android                      |
| Un indirizzo email di contatto pubblico per gli store                  | Le due console          | All'apertura degli account                              |
| Settings → Pages → Source «GitHub Actions», per l'URL della privacy    | GitHub                  | Prima dell'invio                                        |

Il nome dello sviluppatore che gli store mostrano è quello dell'account. Un account personale mostra il nome della persona; per mostrare «ESTIA» serve un'organizzazione con numero D-U-N-S, che si può fare dopo.

## I dati comuni

| Campo           | Valore                                                                           |
| --------------- | -------------------------------------------------------------------------------- |
| Nome dell'app   | ESTIA                                                                            |
| Categoria       | Social networking (Apple) · Social (Google)                                      |
| Prezzo          | Gratis, senza acquisti in app, senza pubblicità                                  |
| Privacy policy  | `https://paluello.github.io/ESTIA/privacy.html`                                  |
| Sito / supporto | `https://paluello.github.io/ESTIA/` · `https://github.com/Paluello/ESTIA/issues` |
| Codice sorgente | `https://github.com/Paluello/ESTIA` (AGPL-3.0)                                   |
| Classificazione | 12+ (Apple) · Teen (IARC): contenuti generati dagli utenti, chat                 |
| Paesi           | Tutti, salvo dove la cifratura richiede pratiche a parte (sotto)                 |

## I testi

### English

**Subtitle** (Apple, 30): `A social network in your home`

**Short description** (Google, 80): `A social network whose posts, photos and chats live on a machine in your home.`

**Promotional text** (Apple, 170): `Public beta. Your community's feed, your profile and end-to-end encrypted chats, stored on a small machine at home instead of someone else's servers.`

**Keywords** (Apple, 100): `community,self-hosted,private,encrypted,chat,neighbours,local,federated,NAS,open source,no ads`

**Description** (4000):

```text
ESTIA is a real social network whose content lives in a place that is yours: a small machine in your flat, your building or your community centre. Encrypted, with no algorithm, no advertising and no server run by the people who make it.

ESTIA is in public beta. It is free and open source, and it says honestly what is ready.

HOW IT WORKS
Someone in your community sets up a home: ESTIA on a NAS, a mini-PC or a Raspberry Pi. This app connects to it. Everything you publish stays on that home, and nowhere else.

THREE SURFACES, ONE ACCOUNT
• The local feed of the people who share your home: photos and posts, in time order.
• Your profile, which people in other homes can follow.
• Private chats, end-to-end encrypted with MLS. Your home stores them and cannot read them.

YOU NEED A HOME TO USE THIS APP
The app does not create an account with us: there is no "us" to hold one. You join a home with an invite or by scanning its QR code, and its administrator lets you in. To set up a home for your community, see the ESTIA website.

FOUND BY KEY, NOT BY ADDRESS
Your phone reaches your home by its public key, from anywhere, with no domain and no open ports on the router. When a direct connection is not possible, a community relay forwards encrypted traffic it cannot read.

WHAT ESTIA DOES NOT DO
• No ads, no tracking, no analytics.
• No algorithm deciding what you see.
• Nothing becomes public unless you choose so.
• When you delete a post, it is really deleted: other homes visit your content, they do not keep copies.

Free software under the GNU AGPL v3. Source code: github.com/Paluello/ESTIA
```

**What's new** (prima versione): `First public beta: local feed, profiles, end-to-end encrypted chats, access from anywhere by key.`

### Italiano

**Sottotitolo** (Apple, 30): `Un social network in casa tua`

**Descrizione breve** (Google, 80): `Un social network in cui post, foto e chat stanno su una macchina in casa tua.`

**Testo promozionale** (Apple, 170): `Beta pubblica. Il feed della tua comunità, il tuo profilo e chat cifrate end-to-end, conservati su una piccola macchina in casa invece che sui server di altri.`

**Parole chiave** (Apple, 100): `comunità,self-hosted,privato,cifrato,chat,vicini,quartiere,federato,NAS,open source,senza pubblicità`

**Descrizione** (4000):

```text
ESTIA è un social network vero, in cui i tuoi contenuti stanno in un posto che è tuo: una piccola macchina nel tuo appartamento, nel tuo condominio o nello spazio della tua comunità. Cifrato, senza algoritmo, senza pubblicità e senza server gestiti da chi lo sviluppa.

ESTIA è in beta pubblica. È gratuito e open source, e dice con onestà che cosa è pronto.

COME FUNZIONA
Qualcuno della tua comunità installa una Casa: ESTIA su un NAS, un mini-PC o un Raspberry Pi. Questa app si collega a lei. Tutto quello che pubblichi resta su quella Casa, e da nessun'altra parte.

TRE SUPERFICI, UN ACCOUNT
• Il feed di chi condivide la tua Casa: foto e post, in ordine di tempo.
• Il tuo profilo, che chi sta in altre Case può seguire.
• Le chat private, cifrate end-to-end con MLS. La tua Casa le conserva e non le può leggere.

PER USARE L'APP SERVE UNA CASA
L'app non crea un account presso di noi: non c'è un «noi» che lo tenga. Entri in una Casa con un invito o inquadrando il suo QR code, e chi la amministra ti fa entrare. Per installarne una per la tua comunità, vedi il sito di ESTIA.

TI TROVA PER CHIAVE, NON PER INDIRIZZO
Il telefono raggiunge la tua Casa per chiave pubblica, da ovunque, senza dominio e senza aprire porte sul router. Quando il collegamento diretto non riesce, un relay della comunità inoltra traffico cifrato che non può leggere.

CHE COSA ESTIA NON FA
• Niente pubblicità, niente tracciamento, niente analitiche.
• Nessun algoritmo che decide che cosa vedi.
• Niente diventa pubblico se non lo scegli tu.
• Quando cancelli un post è cancellato davvero: le altre Case visitano i tuoi contenuti, non ne tengono copie.

Software libero sotto GNU AGPL v3. Codice: github.com/Paluello/ESTIA
```

**Novità** (prima versione): `Prima beta pubblica: feed locale, profili, chat cifrate end-to-end, accesso da ovunque per chiave.`

## Privacy: le risposte ai due questionari

Valgono **solo se il codice dell'app è così il giorno dell'invio**: nessun SDK di analitiche, crash reporting o pubblicità, e nessun dato inviato a server di chi pubblica l'app oltre al servizio di risveglio. Va verificato sulla build, non su questo documento.

### Apple — App Privacy («nutrition label»)

Apple considera «raccolto» un dato che lascia il dispositivo in modo che lo sviluppatore o i suoi partner possano accedervi. I contenuti vanno alla Casa del membro, che lo sviluppatore non controlla e non può leggere.

- **Data Not Collected**, se il servizio di risveglio non è attivo nella build.
- Se il servizio di risveglio gestito da chi pubblica l'app è attivo: **Identifiers → Device ID** (il token push), uso **App Functionality**, **non** collegato all'identità, **non** usato per il tracciamento. Nient'altro.

### Google — Data safety

- **L'app raccoglie o condivide dati?** Contenuti e account vanno alla Casa scelta dall'utente, non a chi pubblica l'app. Se il servizio di risveglio è attivo: **Device or other IDs**, raccolto, non condiviso, per **App functionality**, trattamento effimero no, obbligatorio no (si può spegnere).
- **Cifratura in transito**: sì (QUIC/TLS di iroh fino alla Casa).
- **Cancellazione dei dati**: l'utente cancella i propri contenuti dall'app; l'account lo cancella l'amministratore della Casa. URL da indicare: la sezione «Your rights» della privacy policy.
- **Account**: l'app non crea account presso lo sviluppatore. Google chiede comunque un metodo di cancellazione dell'account: si indica la privacy policy, che spiega che l'account sta sulla Casa.

## Cifratura ed esportazione

L'app usa cifratura standard (MLS, TLS/QUIC) e nessun algoritmo proprietario.

- **Apple**: `ITSAppUsesNonExemptEncryption` va dichiarato. La cifratura per proteggere comunicazioni degli utenti con algoritmi standard rientra nelle esenzioni comuni, ma va confermata nella domanda di App Store Connect; per la distribuzione in Francia può servire una dichiarazione all'ANSSI. Da decidere con l'account aperto, non prima.
- **Google**: nessun modulo separato, ma la stessa normativa sull'esportazione vale per lo sviluppatore.

## Note per chi revisiona

App Store Review e Google chiedono di poter **provare l'app**. ESTIA non ha un server centrale, quindi va preparata una Casa di prova raggiungibile:

1. Una Casa ESTIA accesa durante la revisione, con alcuni post e un account di prova.
2. Nelle note di revisione: «ESTIA is a client for self-hosted community servers ("homes"). There is no central account. To review, scan this QR code / open this invite and log in with the demo account below. The home is a test instance run by the developer for review.»
3. Account di prova: utente e password nelle note riservate, mai in questo repository.

**Moderazione** (linea guida Apple 1.2, contenuti generati dagli utenti): l'app deve permettere di **segnalare** un contenuto e di **bloccare** una persona, e chi pubblica deve poter rispondere alle segnalazioni. In ESTIA lo fa l'amministratore della Casa ([ADR 0047](../adr/0047-le-segnalazioni-si-visitano.md)); va scritto nelle note e deve esistere nell'app prima dell'invio. È il punto di revisione più probabile.

## Le immagini

| Store  | Che cosa                                                                   |
| ------ | -------------------------------------------------------------------------- |
| Apple  | Screenshot iPhone 6,9" (1320×2868) obbligatori; iPad se l'app gira su iPad |
| Google | Icona 512×512, immagine in evidenza 1024×500, da 2 a 8 screenshot telefono |

Gli screenshot si fanno dalla build vera, su una Casa di prova con contenuti finti ma plausibili, in inglese e in italiano. Nessuna persona reale, nessuna foto di persone riconoscibili.
