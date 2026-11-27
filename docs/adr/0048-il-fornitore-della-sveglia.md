# ADR 0048 — Chi porta la sveglia: APNs su iPhone, UnifiedPush su Android, niente sul PC

- Stato: **Proposed** — da accettare dal proprietario
- Data: 2026-11-27
- Proprietario: progetto ESTIA
- Dipende da: [ADR 0044](0044-il-dispositivo-e-l-app.md) §7, che fissa che cosa il servizio può vedere
- Chiude: la decisione aperta «Strategia push tra APNs/FCM e alternative opzionali» in [`AGENTS.md`](../../AGENTS.md)

## Contesto

[ADR 0044](0044-il-dispositivo-e-l-app.md) §7 ha deciso la forma: la notifica è un «svegliati» vuoto, non è obbligatoria, il token è per dispositivo e si revoca con il dispositivo. Ha lasciato aperto **chi la porta**. Questa è l'ultima delle tre precondizioni delle app che restava aperta.

I vincoli sono tre, e non si scelgono:

- **iPhone.** Con l'app chiusa l'unica strada è APNs. Per mandare una notifica serve la chiave di chi pubblica l'app, e una Casa non può averla.
- **Android.** FCM funziona sempre ma passa da Google. UnifiedPush passa da un distributore che la persona sceglie, anche ospitato da sé, ma richiede un'app distributrice installata.
- **PC.** Un'app desktop può restare aperta nell'area di notifica e tenere il collegamento iroh con la Casa. Non c'è niente da svegliare.

## Decisione

1. **iPhone: APNs, attraverso un servizio di inoltro minimo, `estia-sveglia`.** La Casa manda al servizio il token del dispositivo e nient'altro. Il servizio firma con la chiave di chi pubblica l'app e inoltra ad APNs una notifica silenziosa (`content-available`) senza testo. Il servizio non ha un database: non conserva token, Case né orari, e ogni richiesta vive quanto la sua inoltrata. Il codice sta nel repository, e chi ripubblica l'app con la propria chiave ospita il proprio servizio.
2. **Android: UnifiedPush per primo, FCM di riserva.** Se sul telefono c'è un distributore UnifiedPush, la Casa gli parla direttamente e nessuno sta in mezzo. Se non c'è, l'app usa FCM attraverso lo stesso `estia-sveglia`, con le stesse regole del punto 1. La scelta si vede nelle impostazioni del dispositivo, scritta per quello che è.
3. **PC: nessun servizio.** L'app desktop tiene il collegamento con la Casa finché è aperta, anche ridotta a icona.
4. **Limiti dalla parte della Casa.** Una Casa sveglia un dispositivo al massimo una volta al minuto e mette insieme gli eventi che arrivano nel frattempo. Il ritmo che il servizio vede ([ADR 0044](0044-il-dispositivo-e-l-app.md) §7) è quindi più grossolano del ritmo vero della conversazione.
5. **Una Casa che non lo attiva non manda niente.** Il default di una Casa nuova è spento, e il pannello dice che cosa vede il servizio prima di accenderlo.

## Che cosa vede chi sta in mezzo

| Chi                         | Contenuti | Mittente o conversazione | Quale Casa sveglia quale dispositivo | Quando |
| --------------------------- | --------- | ------------------------ | ------------------------------------ | ------ |
| `estia-sveglia`             | No        | No                       | Sì, nel momento in cui inoltra       | Sì     |
| Apple (APNs) / Google (FCM) | No        | No                       | Il dispositivo, non la Casa          | Sì     |
| Distributore UnifiedPush    | No        | No                       | Sì                                   | Sì     |

## Conseguenze

**Positive.** Le app possono ricevere con lo schermo spento su tutte e due le piattaforme mobili. Su Android esiste una strada senza Google. Il servizio non ha niente da perdere in un furto, perché non conserva niente.

**Negative.** `estia-sveglia` è un servizio da ospitare, con la chiave APNs, e la sua disponibilità diventa quella delle notifiche su iPhone. Le notifiche silenziose di iOS non sono garantite: il sistema le può ritardare o scartare, quindi l'app deve funzionare anche quando non arrivano. Chi usa FCM dichiara a Google che il proprio telefono riceve da ESTIA.

## Come si verifica

- Un iPhone con l'app chiusa riceve un messaggio entro un minuto dall'invio, sul campo fra due Case.
- Un Android con un distributore UnifiedPush riceve senza che il traffico passi da `estia-sveglia`.
- Un test sul servizio verifica che il corpo inoltrato è vuoto e che non viene scritto niente su disco.
