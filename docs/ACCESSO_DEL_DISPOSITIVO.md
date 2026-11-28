# L'accesso del Dispositivo

Come l'app ESTIA entra nella propria Casa da fuori, per chiave e senza web. È il lato Casa di [ADR 0044](adr/0044-il-dispositivo-e-l-app.md) §4–§5, costruito il 2026-11-27 in `apps/core-api/src/dispositivi/` (`accesso.ts`, `alpn.ts`, `canale.ts`). Le costanti e il codec del filo stanno in `@estia/contracts`, perché client e Casa devono scriverli allo stesso modo.

## Le due porte

La Casa ha un solo endpoint iroh, con la chiave derivata dall'identità dell'istanza. Oltre a `estia/1` (fra Case) e alla prova di rete, serve due ALPN in più:

| ALPN                  | Chi ci bussa                      | Che cosa ottiene                                                     |
| --------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `estia/ingresso/1`    | Una chiave nuova con il codice QR | Una volta sola: la chiave diventa un Dispositivo del membro          |
| `estia/dispositivo/1` | Un Dispositivo registrato         | L'API dei membri, la stessa delle rotte HTTP, una richiesta a stream |

Su tutte e due, chi non ha diritto riceve **una connessione chiusa e niente altro**: nessun codice d'errore, nessun testo. «Chiave sconosciuta», «codice sbagliato», «codice scaduto» e «codice già usato» sono indistinguibili da fuori (verifica 2 di ADR 0044).

L'endpoint esiste solo quando la rete della Casa è accesa (`local` o `internet`, dal pannello o da `ESTIA_NETWORK_PROBE`). A rete spenta non si emettono QR: `POST /api/v1/dispositivi/ingressi` risponde `409 rete_spenta`.

## Il primo ingresso

1. Un membro già dentro — dal browser in casa, o da un'app già ammessa — chiama `POST /api/v1/dispositivi/ingressi`. Riceve un codice monouso (128 bit, dieci minuti) e il testo del QR:

   ```
   estia://ingresso?casa=<chiave della Casa>&codice=<codice>[&ticket=<ticket>]
   ```

   Il `ticket` c'è solo in `local`, dove nessuna scoperta dice dove abita la chiave. In `internet` basta la chiave. Nel database c'è solo l'impronta del codice.

2. L'app legge il QR (`leggiQrDiIngresso`), si collega **a quella chiave** su `estia/ingresso/1`, apre uno stream, manda il JSON `{"codice": "...", "etichetta": "iPhone di Anna"}` e chiude il lato di scrittura.

3. Se il codice è valido la Casa apre una **sessione nuova** del membro che l'ha emesso, con quell'etichetta, la lega alla chiave di rete provata dall'handshake QUIC, e risponde `{"esito": "ammesso", "utente": {...}, "sessionId": "..."}`. Poi è l'app a chiudere.

4. Da lì l'app parla su `estia/dispositivo/1`, da ovunque.

La chiave della Casa arriva dalla fotocamera, non dalla rete: chi volesse sostituirsi alla Casa dovrebbe sostituire il foglio.

**Entrare nella Casa non è entrare nelle conversazioni.** Dopo l'ingresso l'app registra la sua chiave di firma con `POST /api/v1/dispositivi/chiave`, come fa oggi il browser, e il sì di [ADR 0040](adr/0040-un-membro-ha-piu-di-un-dispositivo.md) resta com'è: il primo dispositivo di una persona si approva da solo, ogni altro aspetta che uno già approvato dica di sì. Un codice QR si ottiene anche solo con la password, quindi non può bastare per leggere i messaggi: quello lo decide un dispositivo che si ha in mano.

Dal 2026-11-27 la strada C di ADR 0040 è chiusa anche dove la si poteva percorrere con la sola password:

- **Ripresentare una chiave già approvata** — il rientro con la frase segreta — vale solo con la **prova di possesso**: l'app chiede `POST /api/v1/dispositivi/sfida` e manda in `prova` la firma di `messaggioDiProvaChiave(sfida, publicKey)` con la privata. La chiave pubblica è nel registro che ogni membro legge, quindi da sola non prova niente.
- **Il primo dispositivo** è il primo davvero: chi ha già avuto un dispositivo approvato, anche se oggi è uscito da tutti, non ne ha più uno «primo».
- **Una sessione approvata che cambia chiave** perde il sì.
- **Un dispositivo in attesa non revoca gli altri**, e una sessione tolta da un'altra porta via la sua chiave per sempre: un telefono rubato non rientra firmando con la propria privata.
- **Il registro ignora le sessioni scadute**, e il prelievo di KeyPackage ha un tetto di trenta al minuto.

## Il filo dell'API

Una richiesta è uno stream bidirezionale. Tutti e due i versi hanno la stessa forma:

```
┌──────────────┬────────────────────────────┬──────────────────────────────┐
│ u32 big-end. │ intestazione JSON (UTF-8)  │ corpo grezzo, fino a fine    │
│ = lunghezza  │ ≤ 64 KiB                   │ stream                       │
└──────────────┴────────────────────────────┴──────────────────────────────┘
```

- **Richiesta**: `{"metodo": "GET", "percorso": "/api/v1/feed?limit=20", "intestazioni": {"content-type": "application/json"}}`, corpo fino a 32 MiB. Chi scrive chiude il lato di scrittura quando ha finito.
- **Risposta**: `{"stato": 200, "intestazioni": {...}}`, poi il corpo così come le rotte HTTP lo producono.

`codificaFrame` e `decodificaFrame` in `@estia/contracts` fanno l'una e l'altra cosa.

Regole che la Casa applica:

- **Solo `/api/`**, in ASCII stampabile e senza `..`. Il client web, l'OpenAPI e i controlli di salute non si chiedono da qui. Un frame che non si legge riceve `400 richiesta_su_stream_non_valida`, con il corpo d'errore di sempre: la chiave, in quel caso, è già stata riconosciuta.
- **L'identità la decide la chiave.** `authorization`, `cookie`, `host`, `content-length`, `forwarded`, `x-forwarded-*` mandati dal client si scartano. Il token di qualcun altro, mandato da un Dispositivo, non conta.
- **La revoca vale dalla richiesta dopo.** A ogni stream la Casa richiede quale sessione apre la chiave: una sessione revocata chiude la connessione già aperta, e una connessione nuova non riceve niente.
- **Il limite di frequenza è per chiave**, non per indirizzo: le richieste dei Dispositivi entrano tutte da `app.inject()`, e con l'indirizzo finto dividerebbero un limite solo.

### Come entra nelle rotte

La Casa fa `app.inject()` sulle rotte di oggi: cambia il trasporto, non il contratto ([ADR 0004](adr/0004-client-web-e-trasporto-sostituibile.md), seconda metà). Le rotte autenticano con un token di sessione, che un Dispositivo non ha; la richiesta iniettata porta quindi un contrassegno, `x-estia-canale-dispositivo`, che è un **nonce monouso** di 256 bit: vale soltanto mentre quella richiesta iniettata è in corso, punta a sessione e chiave in una tabella in memoria, e si cancella appena l'inject finisce. L'intestazione non contiene la sessione, e un nonce che trapelasse non varrebbe niente un istante dopo; la stessa intestazione mandata via HTTP dalla rete non apre niente. È tolta dai log come `authorization`, e le richieste che la portano non si contano fra le provenienze di rete del pannello.

Il percorso si controlla **dopo** averlo normalizzato come lo normalizzerà `new URL()` dentro `app.inject()`, e si inietta solo se normalizzarlo non lo cambia: `/api/%2e%2e/health/live` diventerebbe `/health/live`, e si rifiuta. Sono rifiutati anche `%2e`, `%2f`, `%5c`, la barra rovescia e il frammento.

### I tetti

- Il corpo di una richiesta non supera quello che la rotta più larga accetta (quello dei media, `ESTIA_MEDIA_MAX_BYTES`, almeno 1 MiB), e mai i 32 MiB del contratto.
- Una richiesta deve arrivare tutta entro due minuti; se no, la connessione si chiude.
- Otto richieste insieme per connessione: le altre restano in coda nel QUIC, non in memoria.
- Quattro connessioni insieme per chiave.
- Dopo l'esito d'ingresso, se l'app non chiude entro cinque secondi chiude la Casa.

## Più dispositivi e revoca

Ogni chiave di rete ha la sua sessione, quindi telefono e PC sono due righe in `GET /api/v1/auth/sessions` — con il campo `chiaveDiRete` che le distingue da un browser — e si revocano una per una da lì (`DELETE /api/v1/auth/sessions/:id`) o tutte insieme. La revoca della sessione è la revoca della chiave: nessun'altra tabella deve ricordarselo.

Una sessione d'app si allunga a ogni uso: un'app che si fa vedere resta dentro, una revocata no. Reinstallare l'app produce una chiave nuova, quindi un dispositivo nuovo che deve rientrare con un QR (verifica 4 di ADR 0044). Ripresentare con un codice nuovo una chiave già legata revoca la sessione vecchia.

## Una persona entra con tutti i suoi dispositivi

`GET /api/v1/mls/key-packages/:casa/:username` consegna un KeyPackage per **ciascun** dispositivo approvato e vivo del membro, fino a dieci, e li consuma. Fra Case la domanda `chiavi` porta `tutti: true`; una Casa che non lo conosce ne manda uno solo, ed è ancora una risposta giusta. Il client web la usa quando apre una conversazione e quando fa entrare qualcuno in un gruppo, così telefono e PC della stessa persona sono due foglie dal primo commit. La rotta al singolare resta per chi non lo sa ancora.

## Il sì e la revoca dentro le conversazioni

Entrare con tutti i dispositivi vale per chi entra da oggi. Per le conversazioni già aperte, ogni dispositivo approvato rimette d'accordo **le proprie foglie** con il registro della propria Casa (`allineaMieiDispositivi` in `apps/web/src/mls/conversazione.ts`), al più ogni cinque minuti per conversazione, quando la legge:

- una chiave approvata che nell'albero non c'è **entra**. La sua chiave d'ingresso si preleva con `POST /api/v1/dispositivi/miei/key-packages` (`{"chiaviDiFirma": [...]}`), che consegna soltanto KeyPackage di altri dispositivi propri e approvati, e risponde `403 device_not_approved` a chi aspetta;
- una foglia propria che il registro non riconosce più, perché revocata o scaduta, **esce**, e la catena dell'archivio ruota.

Un dispositivo che nel registro non c'è non tocca niente: non è lui a decidere. Il tempo di perdita dell'accesso alla cronologia dopo una revoca è quindi «fino a quando un altro dispositivo della persona apre quella conversazione»; la Casa smette comunque di consegnare al revocato da subito.

## Che cosa manca, detto per intero

- **La rimozione subito, non alla lettura.** Oggi la foglia di un dispositivo revocato esce dalle conversazioni man mano che un altro dispositivo della persona le apre. Farlo per tutte al momento della revoca vuole una coda di lavoro sul client.
- **Le app native** devono fare lo stesso allineamento delle foglie: la Casa è pronta.
- **L'ingresso con un invito**, per chi non è ancora membro e non ha un browser in casa: oggi il QR lo emette solo chi è già dentro.
- **Le prove sul campo**, nell'ordine di ADR 0044 e fatte dal proprietario: Milano–Campello su dati mobili, la misura dall'esterno che non c'è nessuna porta web, il tempo effettivo di perdita dell'accesso dopo una revoca.
- **Un invito creato dall'app porta un indirizzo `localhost`.** Non dà accesso a niente, ma il link non serve: va deciso insieme all'ingresso con invito, perché fuori casa non c'è una porta web da aprire. `GET /api/v1/connection` invece dal 2026-11-28 risponde `dispositivo`.
- **Il corpo come `number[]`.** Il binding Node di iroh legge e scrive array di numeri: per un'immagine da qualche MiB è memoria sprecata, non un errore. Se pesa, si spezza il corpo in più scritture.

## Le prove

`apps/core-api/src/dispositivi/accesso.test.ts`, su iroh vero in `local`, nove prove: la Casa è l'app intera, il Dispositivo un endpoint con una chiave sua.

1. Dal QR all'API: il QR si rilegge, la chiave entra, `GET /api/v1/auth/me` e `POST /api/v1/posts` passano dallo stream, la sessione compare con la sua chiave.
2. Una chiave sconosciuta su `estia/dispositivo/1` non riceve niente, e la stessa chiave entra appena ha un codice.
3. Codice inventato, domanda malformata, codice già usato, codice scaduto: niente, e nessuna differenza fra i casi. Tre chiavi con lo stesso codice nello stesso istante: ne entra una.
4. Due dispositivi della stessa persona; la revoca di uno lo ferma sulla connessione già aperta e alla successiva, e l'altro continua.
5. Il token di un'altra persona, un cookie e un contrassegno inventato mandati dal Dispositivo non contano; il contrassegno falsificato via HTTP riceve 401.
6. Fuori da `/api/`, anche con dot-segment codificati, e con un frame malformato: 400 leggibile.
7. A rete spenta non si emette il QR.
