# ADR 0042 — Come MLS attraversa: la casa che mette in fila, e il nome che porta la casa

- Stato: **Accepted** — dal proprietario il **2026-09-17**. [ADR 0039](0039-mls-attraversa-le-istanze.md) ha deciso **che** si federa; questo decide **come**, e tocca confini di fiducia
- Data: 2026-08-28
- Aggiornamento: **2026-09-07**, adeguata ad [ADR 0043](0043-custodia-lato-mittente.md) **Accepted**: custodia del solo autore, segnaposto remoto senza contenuto. Questo ADR resta **Proposed**, non autorizzato dalla sola approvazione di 0043. **2026-09-17**: risposte del proprietario ai residui e due riletture, in §«Risposte del proprietario». Ne escono il **trasloco** (§3), la specifica del **segnaposto** (§4.1) e la regola che un ritirato non torna. **Accettato lo stesso giorno**: da qui il percorso federato si costruisce
- Proprietario: progetto ESTIA
- Attua: [ADR 0039](0039-mls-attraversa-le-istanze.md) strada B
- Dipende da: [ADR 0018](0018-federazione-fra-istanze-estia.md), [ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md), [ADR 0021](0021-la-forma-del-protocollo-fra-istanze.md), [ADR 0029](0029-un-messaggio-si-consegna.md), [ADR 0036](0036-estia-e2e-v1-e-il-debito-verso-mls.md), [ADR 0037](0037-la-cronologia-e-un-archivio-non-una-chiave.md), [ADR 0040](0040-un-membro-ha-piu-di-un-dispositivo.md), [ADR 0041](0041-le-istanze-si-tengono-d-occhio.md)
- Poggia su: spike [S4](../spike/S4-autenticare-chi-entra.md), [S5](../spike/S5-quanto-pesa-un-albero.md)

## Contesto

[ADR 0039](0039-mls-attraversa-le-istanze.md) ha scelto la strada B — prima MLS attraversa, poi si taglia — e ha lasciato cinque nodi. Uno è chiuso da una misura; ne resta un altro che quell'ADR non aveva visto, e che è il più costoso da correggere dopo.

**Il nodo 5 è chiuso.** [S5](../spike/S5-quanto-pesa-un-albero.md) ha misurato che un Welcome cresce di **262 byte per foglia** e che a cinquanta foglie occupa 17 932 caratteri Base64 contro un tetto di 65 536: margine 3,7×, e il primo tetto vero si incontra a **~187 foglie**. Il tetto della federazione non va toccato e **il disegno non cambia**. Era la domanda che poteva far ripensare tutto.

## Il nodo che ADR 0039 non aveva visto

**Oggi la credenziale MLS porta solo il nome: `credenziale(username)` in [`gruppo.ts`](../../apps/web/src/mls/gruppo.ts).** Dentro un albero con una casa sola va bene, perché i nomi lì sono unici. Fra due case non lo sono: `anna` a Milano e `anna` a Torino sono due persone diverse con la stessa credenziale, e l'`AuthenticationService` andrebbe a cercare la chiave nella casa sbagliata — cioè **autenticherebbe la persona sbagliata**, che è esattamente il buco che [S4](../spike/S4-autenticare-chi-entra.md) esiste per chiudere.

Va corretto **prima** del taglio, e il momento è adesso per una ragione precisa: **nessun gruppo MLS esiste ancora in produzione**, perché l'interfaccia non è ancora passata. Cambiare la forma della credenziale oggi costa una riga; farlo dopo vuol dire migrare alberi vivi, che in MLS significa ricrearli.

## Decisione

### 0. La credenziale porta la casa

**L'identità di una credenziale `basic` diventa `<username>@<chiave della casa>`**, dove la chiave è quella pubblica dell'istanza — la stessa con cui [ADR 0021](0021-la-forma-del-protocollo-fra-istanze.md) §1 identifica chi chiama, e l'unica che non si può dichiarare.

**Costruita il 2026-09-17**, prima del resto e da sola: la credenziale, la casa derivata dall'identità dell'istanza (nota anche a rete spenta), l'instradamento del registro e l'aggiornamento del materiale di dispositivo. Lo stesso giorno è costruita anche `chiavi-di-firma`, quindi il registro di una casa remota si chiede a lei.

Ne discende la regola di instradamento dell'`AuthenticationService`, che è tutta la differenza fra federare e sbagliare persona:

- casa **mia** → registro locale (`getActiveDeviceKeysByUserId`, già filtrato per i dispositivi approvati di [ADR 0040](0040-un-membro-ha-piu-di-un-dispositivo.md));
- casa **d'altri** → il registro di quella casa, chiesto a lei.

### 1. Di quale registro ci si fida, detto per intero

Per un membro remoto il registro è di un'altra istanza. La validazione diventa: **«mi fido che la casa di Bruno dica la verità su Bruno»**.

Non è una fiducia nuova nella sostanza — [ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md) costruisce già rapporti fra istanze, e una casa che mente sui propri membri può già oggi consegnare buste per conto loro — ma **va dichiarata**, perché allarga il limite 4 di [ADR 0036](0036-estia-e2e-v1-e-il-debito-verso-mls.md): i registri di cui fidarsi diventano due, e il numero di sicurezza da confrontare a voce passa da rimedio consigliato a **rimedio necessario**.

**Un vincolo d'implementazione che non è una rifinitura.** `validateCredential` viene chiamata **a ogni foglia** durante la validazione dell'albero ([S4](../spike/S4-autenticare-chi-entra.md) §«Limiti»). Una domanda di rete per foglia, su un gruppo da cinquanta, sarebbe cinquanta giri: **il registro di una casa remota si chiede una volta per validazione e si tiene per la durata di quella validazione**, non per foglia. Fuori da quella finestra non si conserva: un registro memorizzato è una revoca che non arriva.

### 2. Chi può depositare un handshake in casa d'altri

**L'istanza `K` può depositare nella conversazione `X` se e solo se `X` ha fra i membri un `remote:K:*`.**

Si verifica in locale su `conversazione_membri`, e `K` è la chiave della connessione — mai un campo del messaggio, per la regola di [ADR 0021](0021-la-forma-del-protocollo-fra-istanze.md) §1. Nessuna casa può infilare buste in una conversazione a cui non partecipa, e non serve chiedere niente a nessuno per saperlo.

### 3. Una casa mette in fila, ed è quella dove la conversazione è nata

È il nodo che [ADR 0039](0039-mls-attraversa-le-istanze.md) chiama «il più tecnico dei cinque e quello che si sbaglia più facilmente, perché in laboratorio non si vede».

**Costruito il 2026-09-17**: la colonna `casa_che_ordina` (migrazione 29, dove NULL vuol dire questa casa), le due operazioni, la regola §2 verificata sui membri in locale, e il rifiuto unico per «non la ordino io», «non esiste» e «non ci partecipi». Quando la casa che ordina è un'altra, questa istanza **non tiene una coda di riserva**: chiede a lei, e se non risponde lo dice con la frase di questo paragrafo.

**Ogni conversazione ha una casa che ordina, decisa alla nascita e scritta sulla riga della conversazione.** I commit si depositano lì; tutti leggono da lì la coda ordinata. La casa che ordina non capisce che cosa smista — resta un Delivery Service che muove buste opache, come [ADR 0027](0027-la-libreria-mls.md) punto 3 già stabiliva.

**Perché una e non due.** MLS applica i commit **in sequenza**, e la sua architettura presuppone un servizio di consegna che li metta in fila. Con due code indipendenti due commit alla stessa epoch sono una corsa: entrambe le case ne accettano uno, e da quel momento hanno due alberi diversi che si credono lo stesso. Non è un errore che si vede — è uno stato che diverge in silenzio, e si scopre quando un messaggio non si apre più.

**Il caso della corsa, risolto.** Con una fila sola, il secondo commit arriva a un'epoch già superata e viene rifiutato. Chi l'ha scritto lo rifà sull'epoch nuova. È un fallimento **visibile e ripetibile**, che è la differenza che conta.

**Costruito il 2026-09-23, e mancava.** Fino a quel giorno la coda accettava ogni commit: la fila era una, ma il rifiuto di questo paragrafo non esisteva, e due commit alla stessa epoch sarebbero entrati tutti e due — cioè esattamente la divergenza silenziosa che §3 esiste per impedire. Ora un commit entra solo se crea un'epoch più alta di ogni commit già in fila, con un'istruzione SQL sola perché controllo e scrittura non si separino; il secondo riceve un 409 in casa e `epoch_superata` sul filo, che dice a chi l'ha scritto di rifarlo invece di chiudergli la porta. I Welcome non concorrono: stanno con il loro commit.

**Il costo, dichiarato.** Se la casa che ordina è spenta, in quella conversazione **non si può cambiare chi c'è**: niente ingressi, niente uscite. I messaggi applicativi non cambiano l’epoch, ma con ADR 0043 si leggono solo le parti custodite da case raggiungibili e si scrive solo potendo depositare nella propria casa con le chiavi necessarie. La frase che l'interfaccia dovrà dire è una: _«La casa che gestisce il gruppo non risponde: non puoi aggiungere o togliere membri. I contenuti ospitati lì non sono disponibili.»_ E grazie a [ADR 0041](0041-le-istanze-si-tengono-d-occhio.md) l'istanza **sa** se quella casa è accesa, quindi può dirlo prima invece che dopo un tentativo fallito.

**Ma «congelato per sempre» non è uno stato finale accettabile**, e il proprietario lo ha rifiutato il 2026-09-17. Una casa spenta per un fine settimana è un'attesa; una casa che non torna più è un gruppo di persone vive che non possono più farne entrare una, e non c'è nessuno a cui chiedere.

#### Il trasloco: quando la casa che ordina è persa

**È una procedura eccezionale, dichiarata e mai automatica.** La soglia non fa niente da sola: apre un bottone, e a premerlo è una persona che si firma.

**Quello che il trasloco non deve recuperare, perché non è mai stato lì.** Dopo [ADR 0043](0043-custodia-lato-mittente.md) la casa che ordina **non custodisce contenuti**: ordina buste opache. La cronologia è l'unione delle custodie, e la casa persa si porta via soltanto quello che avevano scritto **i suoi** membri — che è quanto 0043 stabilisce comunque, per qualunque casa che si spegne. **La conversazione non è ostaggio di chi la ordina**, ed è questa separazione che rende il trasloco una procedura e non un miracolo.

**Quello che si perde davvero** è lo stato di protocollo che stava lì e solo lì (decisione 5 delle risposte del proprietario): il `GroupInfo` dell'epoch corrente, il mazzo, la coda dei commit. Chi era in linea ha ancora il proprio stato MLS nel browser; chi doveva rientrare non ha più da dove.

**Come si fa.**

1. **La casa si dichiara persa.** Il battito di [ADR 0041](0041-le-istanze-si-tengono-d-occhio.md) non la raggiunge da oltre la soglia (valore iniziale: **30 giorni**). Prima della soglia il bottone non c'è: un fine settimana di silenzio non è una scomparsa.
2. **Un amministratore del gruppo trasloca**, dalla propria casa, che diventa la casa che ordina del gruppo **successore**. Se nessun amministratore ha una casa viva, può farlo qualunque membro: l'atto porta il suo nome, e questo conta più di chi aveva il ruolo.
3. **Nasce un gruppo nuovo, non si ripunta quello vecchio.** L'albero, il mazzo e il punto di rientro del gruppo vecchio non si possono ricostruire senza la casa che li teneva: chi trasloca crea un gruppo MLS nuovo e manda i Welcome ai membri delle case raggiungibili. Ripuntare la coda e basta vorrebbe dire dichiarare sana una fila di cui manca il seguito.
4. **Il successore dichiara di esserlo.** Porta l'identificatore del gruppo vecchio e l'ultima epoch che chi trasloca aveva visto, e l'interfaccia lo dice con parole intere: _«Questo gruppo continua «Cena di quartiere». La casa che lo gestiva non risponde dal 3 marzo. L'ha traslocato Anna il 5 aprile.»_ Non diventa lo stesso gruppo di soppiatto.
5. **Il gruppo vecchio resta, in sola lettura**, marcato come congelato: la cronologia delle case ancora vive si continua a visitare, e non si riscrive la storia per far sembrare che il trasloco non sia avvenuto.

**I due costi, detti prima.** Chi non ha una casa raggiungibile nel giorno del trasloco **non entra nel successore** e va aggiunto a mano quando ritorna: il trasloco non è un'operazione che si subisce senza esserci. E il gruppo nuovo ha un mazzo d'archivio nuovo: **la parte vecchia della conversazione si legge con le chiavi che ogni client ha già**, e chi non le aveva — chi entra dopo — vede il gruppo vecchio come lo vede un estraneo, cioè non lo vede.

**Il doppio trasloco non si previene: si rende visibile.** Se due amministratori traslocano lo stesso giorno nascono due successori, ognuno con il nome di chi l'ha fatto e la sua data. Sono due righe nell'elenco, e le persone scelgono quale tenere. È la stessa scelta di §3: un fallimento che si vede batte una convergenza che si spera.

**L'alternativa scartata**, e perché: fondere due code ordinando per epoch con un criterio di spareggio. Richiede che le due case concordino sullo spareggio **e** che convergano, e sbaglia esattamente quando due persone committano insieme — cioè il caso che in laboratorio non si riproduce. Un disegno che è corretto solo finché nessuno fa due cose insieme non è un disegno.

### 4. L'archivio si visita; resta solo il segnaposto

**Vincolo deciso dal proprietario il 2026-09-07 in [ADR 0043](0043-custodia-lato-mittente.md).** Sostituisce la proposta del 28 agosto che replicava l'archivio e accettava la deroga di ADR 0029.

Matteo su B scrive a Marco su A: **la voce cifrata resta solo su B**. A conserva un segnaposto con mittente, orario e riferimenti opachi necessari a richiedere la voce. Nessun testo, allegato, anteprima, citazione copiata, dimensione o hash del contenuto, busta o archivio cifrato nel segnaposto. Una busta contiene il messaggio cifrato e **non è** un segnaposto vuoto.

La lettura passa dal dispositivo di Marco ad A, da A a B, e torna senza scritture del contenuto su A. Ogni nuova lettura verifica in B l'autorizzazione attuale; un identificatore noto non è un permesso. La paginazione deve ricomporre le custodie senza confondere messaggi omonimi di case diverse. Il deposito delle voci è riservato alla casa dell'autore, con provenienza verificata: il client destinatario non archivia nella propria casa ciò che ha ricevuto.

**Se B non risponde, A mostra soltanto il segnaposto con mittente e orario.** Quando B ritorna, A richiede nuovamente il contenuto. Una copia persistente o una cache usata come ripiego non sono consentite, nemmeno cifrate o cancellate dopo il prelievo.

**Il mazzo e il controllo MLS**, che la versione precedente lasciava aperti, sono collocati dalle risposte del proprietario del 2026-09-17: `GroupInfo` e mazzo stanno **solo sulla casa che ordina e solo per l'epoch corrente**, che ogni epoch nuova sovrascrive; la coda dei commit resta finché tutti i dispositivi membri l'hanno presa, con il tetto di 30 giorni. Le altre case li chiedono e non li conservano. Resta che il consenso al segnaposto non autorizza da sé nessun altro dato chiamato «stato di protocollo»: quello che non è elencato qui sotto è una decisione nuova.

### 4.1 Il segnaposto, per intero

**Scritta il 2026-09-17 su richiesta del proprietario, che ha voluto leggerla prima di accettare questo ADR.** È l'unica cosa che una casa conserva di un messaggio che i suoi membri non hanno scritto.

#### I campi, e nient'altro

| campo           | che cos'è                                                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | 16 byte casuali, scelti da chi scrive. **Casuali e non derivati**: un id che fosse l'hash del messaggio sarebbe un'impronta del contenuto scritta in casa d'altri                                                                                     |
| `conversazione` | la conversazione, come la nomina la casa che riceve                                                                                                                                                                                                   |
| `mittente`      | `username@casa`, la stessa forma della credenziale MLS (§0)                                                                                                                                                                                           |
| `casa_custode`  | la casa a cui chiedere il contenuto. Normalmente è quella del mittente, ed è scritta comunque, perché un trasloco non deve costringere a ricalcolarla                                                                                                 |
| `inviato_il`    | l'orario **dichiarato** da chi scrive, in UTC                                                                                                                                                                                                         |
| `ricevuto_il`   | l'orario in cui la casa che riceve l'ha preso in carico. Non arriva dalla rete: se lo scrive lei                                                                                                                                                      |
| `seq`           | il progressivo che la casa custode assegna, **per (conversazione, casa custode)** e non per casa: due conversazioni non si spartiscono un contatore, e due case non si pestano i piedi nella stessa. Serve al recupero, ed è l'unico campo che cresce |

**Fuori, e non per dimenticanza**: testo, anteprime, citazioni, allegati, nomi di file, tipo del contenuto, **lunghezza**, hash, buste cifrate, voci d'archivio, epoch. La lunghezza è un dato che viene dal contenuto quanto il contenuto, e l'epoch sta dentro la busta — e la busta non è qui.

**Un segnaposto non è una busta vuota.** Se un giorno qualcuno aggiungesse «solo la dimensione, che è comoda per la barra di caricamento», starebbe scrivendo in casa d'altri un fatto sul messaggio di qualcun altro. È una decisione nuova, e va scritta come tale.

#### Chi può depositarne uno

Vale la regola di §2, senza eccezioni: la casa `K` è la **chiave della connessione** ([ADR 0021](0021-la-forma-del-protocollo-fra-istanze.md) §1), mai un campo del messaggio, e può depositare in `X` solo se `X` ha fra i membri un `remote:K:*`. In più: **la casa del mittente dev'essere `K`**. Nessuno deposita segnaposto a nome di una casa che non è la sua.

#### Deduplicazione

La chiave è `(conversazione, casa_custode, id)`: l'id è unico dentro la casa che lo ha scelto, e due case non si pestano i piedi.

- Ripetizione **identica** (stesso mittente, stesso orario dichiarato): accettata e senza effetto. È il caso normale di una consegna ritentata dopo una connessione caduta.
- Ripetizione **diversa**: rifiutata, e con essa **l'intero lotto**, come già fa `insertVociArchivio` per l'archivio. Un id che cambia significato è l'unico modo che una casa avrebbe per riscrivere il passato di un'altra.

#### Il recupero dopo una disconnessione

Due operazioni, e sono simmetriche a quelle degli handshake.

- `segnaposto`: la casa custode **spinge** il lotto verso le case che partecipano, appena può.
- `segnaposto-da`: la casa che riceve **chiede** quello che c'è dopo un cursore. Il cursore è il `seq` più alto che ha preso da **quella** casa in **quella** conversazione.

Si chiede al rientro, e quando il battito di [ADR 0041](0041-le-istanze-si-tengono-d-occhio.md) dice che una casa è tornata: è la stessa correzione che la Fase 5 ha già fatto per la coda dei messaggi, e per la stessa ragione — nessuno deve aspettare un'ora perché qualcosa si sveglia da solo.

**I buchi si vedono.** `seq` è progressivo dentro `(conversazione, casa custode)`: un salto è un segnaposto mancante e si richiede. È il motivo per cui il numero lo assegna la casa custode e non chi riceve — un progressivo di chi riceve non saprebbe mai quello che non gli è arrivato.

**La risposta dichiara la finestra che copre, e dentro quella finestra è la verità.** `segnaposto-da` risponde con `da`, `a` e l'elenco di ciò che esiste: dentro quel tratto, **quello che non è elencato non esiste**, e chi riceve cancella i propri segnaposto che cadono lì dentro e non sono nell'elenco. Senza questa regola un buco sarebbe indistinguibile da una perdita, e chi riceve lo richiederebbe per sempre.

**Un numero non si riusa mai**, nemmeno quando il suo segnaposto non c'è più: il posto vuoto resta vuoto. Un `seq` riassegnato farebbe passare un messaggio nuovo per uno che qualcuno aveva già visto.

**La spinta non può fare quello che la richiesta non farebbe.** Un `segnaposto` spinto si accetta solo con `seq` **oltre** il cursore di quella casa; qualunque altro si ignora e si riconcilia chiedendo. La spinta è un modo per non aspettare, non una seconda strada per scrivere in casa d'altri.

**L'ordine in cui si leggono.** Per `inviato_il`, a parità l'`id`, che è arbitrario ma uguale per tutti. Un orario dichiarato molto più avanti del `ricevuto_il` di chi lo prende in carico si mostra con l'orario di arrivo e un avviso: l'orario è **dichiarato** ([ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md) §5), e un messaggio non deve poter stare in cima alla conversazione per sempre perché la casa di chi scrive ha l'orologio avanti di un anno.

#### Più dispositivi

**Il segnaposto è del membro, non del dispositivo.** Ne esiste uno per casa e conversazione: i dispositivi di quel membro lo leggono dalla propria casa, e ognuno chiede il contenuto alla casa custode quando apre la conversazione. Non c'è una coda per dispositivo e non si duplica niente — il che vuol dire anche che un telefono spento non trattiene niente da nessuna parte: quando torna, legge quello che la sua casa ha.

Il «visto» resta com'è oggi, per membro. Che un dispositivo abbia letto e un altro no è una preferenza di interfaccia, non un fatto che viaggia fra le case.

#### Il ritiro, e la revoca

**Se l'autore ritira il messaggio, il segnaposto si cancella.** Non resta una lapide: [ADR 0043](0043-custodia-lato-mittente.md) dice che chi spegne la propria casa ritira la propria parola, e una riga «messaggio ritirato» conservata per sempre in casa d'altri è un fatto sul messaggio che sopravvive al messaggio.

- La casa custode cancella la voce d'archivio e risponde `ritirato` a chi chiede quel contenuto.
- La casa che riceve cancella il segnaposto **entro il tetto di 5 minuti** delle risposte del proprietario (decisione 8), anche su una scheda già aperta.
- In quella scheda l'interfaccia può dire, per quella sessione e senza scriverlo da nessuna parte, che un messaggio è stato ritirato. Una riga che sparisce mentre si guarda va spiegata.

**Il ritiro è diverso dall'irraggiungibile.** Casa custode spenta: il segnaposto **resta**, con mittente e orario, e il contenuto torna quando lei torna. È la promessa di 0043, e confonderli vorrebbe dire cancellare la conversazione di chi ha il NAS in manutenzione.

**Un ritirato non torna, e non è una speranza: è come funziona il recupero.** Senza lapidi da nessuna parte, la garanzia sta in tre righe già scritte qui sopra, messe insieme.

1. **La casa custode è l'unica che dice che cosa esiste.** Al ritiro cancella la voce e **lascia il posto vuoto**: non ha più niente da servire a quel `seq`, per nessuno e da nessun cursore. Un recupero da zero e un recupero dall'ultimo cursore danno lo stesso risultato.
2. **La finestra dichiarata cancella quello che avanza.** Se chi riceve si ritrova comunque un segnaposto ritirato — un database ripristinato da un backup precedente, una scheda rimasta aperta, un doppione di una versione vecchia — il primo `segnaposto-da` che copre quel tratto non lo elenca, e chi riceve **lo cancella**. La riconciliazione non è un'operazione in più: è la stessa richiesta del recupero.
3. **Niente lo può rimettere.** La spinta non scende sotto il cursore, la deduplicazione rifiuta un id che torna con un contenuto diverso, e il `seq` di un ritirato non si riusa. Le tre strade per cui un elemento potrebbe ricomparire sono chiuse una per una.

**Il ripristino di chi riceve è il caso che va detto per nome.** Se si ripristina il database di una casa, il suo cursore torna indietro insieme ai dati e può trovarsi **più avanti** di quello che ha davvero: quelle conversazioni si marcano «da riconciliare» e si richiede da zero. Costa un giro di rete e restituisce la verità della casa custode, invece di una cronologia che è vera per metà.

**Revoca di un dispositivo o uscita di un membro**: non toccano i segnaposto. Riguardano le chiavi e l'autorizzazione che la casa custode verifica **a ogni visita** — un identificatore noto non è un permesso, e chi è uscito smette di ricevere risposte anche per i segnaposto che ha già.

#### Come si verifica

1. Ritenta la consegna dello stesso segnaposto dieci volte: la conversazione ne ha uno.
2. Un segnaposto con lo stesso id e un mittente diverso: rifiutato, e con esso il lotto.
3. Una casa che deposita un segnaposto a nome di un'altra: rifiutata sulla chiave della connessione.
4. Spegni la casa che riceve mentre la custode scrive tre messaggi; riaccendila: al rientro ha tutti e tre, e in ordine.
5. Togli il segnaposto numero due dalla risposta: chi riceve si accorge del salto e lo richiede.
6. Ispezione del database e di un backup `age` di chi riceve: nessun testo, **nessuna busta**, nessuna dimensione. Solo i campi della tabella qui sopra.
7. Ritiro: entro cinque minuti la riga non c'è più, né a schermo né nel database, né in un backup fatto dopo.
8. Casa custode spenta: il segnaposto resta e il contenuto torna quando lei torna.
9. Ritira un messaggio, poi **ricostruisci da zero** la conversazione su chi riceve: non ricompare. Stessa prova con la spinta di un lotto vecchio: ignorata perché sotto il cursore.
10. Ripristina su chi riceve un backup **precedente al ritiro**: alla riconciliazione il segnaposto sparisce, perché la finestra dichiarata non lo elenca. Nessuna lapide da nessuna parte, e il numero di quel messaggio non viene riusato.

### 5. I tetti restano quelli

Chiuso da [S5](../spike/S5-quanto-pesa-un-albero.md). Nessuna costante cambia. Si aggiunge però **un test che tiene fermo il fatto**: se un aggiornamento della libreria facesse crescere il Welcome di un ordine di grandezza, oggi non se ne accorgerebbe nessuno fino al campo.

## Le operazioni da scrivere

Sul protocollo di [ADR 0021](0021-la-forma-del-protocollo-fra-istanze.md), che non cambia forma né versione maggiore: sono richieste nuove, non una grammatica nuova.

| `tipo`            | chi la fa                             | che cosa porta                                                                            |
| ----------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `chiavi-di-firma` | chi valida un albero                  | le chiavi di firma **approvate** di un membro                                             |
| `handshake`       | chi ha fatto un commit                | la busta, per la casa che ordina — **costruita il 2026-09-17**                            |
| `handshake-da`    | ogni casa che partecipa               | la coda ordinata da un cursore in poi — **costruita il 2026-09-17**                       |
| `group-info`      | chi rientra, e chi ha fatto un commit | il punto di rientro dell'epoch corrente — **costruita il 2026-09-23**                     |
| `archivio`        | chi vuole leggere                     | richiesta autorizzata delle voci alla casa dell’autore, risposta senza persistenza remota |
| `mazzo`           | chi ha riavvolto, e chi rientra       | il mazzo, con la sua epoch — **costruita il 2026-09-23**                                  |
| `segnaposto`      | la casa dell'autore                   | il lotto di segnaposto, senza contenuto (§4.1)                                            |
| `segnaposto-da`   | ogni casa che partecipa               | i segnaposto dopo un cursore, per il recupero (§4.1)                                      |

**`group-info` e `mazzo` hanno due direzioni**, e la tabella ne diceva una sola per ciascuna: qualcuno deposita dopo un commit o un riavvolgimento, qualcun altro legge per rientrare. Restano **un'operazione ciascuna**, con un campo `azione` che vale `leggi` o `deposita`: il nome dice che cosa si tocca, l'azione dice come, e non sono due nomi per la stessa cosa. Deciso costruendo, il 2026-09-23.

**Sono otto, e `messaggio` si ritira al taglio.** Il recapito del segnaposto è un'operazione **distinta** e non un `messaggio` che cambia significato: lo stesso nome che prima porta una busta e poi non la porta più è la cosa che, sei mesi dopo, nessuno si ricorda di verificare. `messaggio` resta com'è finché `ESTIA-E2E-v1` è in piedi, e sparisce con lui. Nessuna busta applicativa remota può essere salvata come soluzione transitoria.

Tutte soggette al tetto di tempo di [ADR 0041](0041-le-istanze-si-tengono-d-occhio.md) §6 e ai budget di [`limits.ts`](../../apps/core-api/src/federation/limits.ts). Nessuna porta contenuti in chiaro: per l'istanza che le smista sono buste opache, come tutto il resto.

## Come si verifica

1. Due case, un gruppo, un messaggio che arriva a tutti — e il testo in chiaro assente da **entrambi** i database e da entrambi i backup `age`.
2. **Due commit lanciati insieme dalle due case**: uno vince, l'altro riceve un rifiuto esplicito e si rifà. Nessuno dei due alberi diverge. È la prova del punto 3, e va fatta con due istanze vere.
3. Un membro remoto la cui chiave **non** è nel registro della sua casa non entra in niente.
4. Due persone con lo stesso username su due case diverse **non** si confondono: è la prova del punto 0.
5. Con la casa che ordina spenta: non si aggiunge nessuno; si leggono soltanto i contenuti delle case raggiungibili. La possibilità di scrivere richiede il proprio archivio disponibile e le chiavi valide; **l’interfaccia dichiara i limiti**, senza promettere di leggere la parte ospitata dalla casa spenta.
6. Con le case degli autori raggiungibili e gli stessi permessi, le visite ricompongono la stessa cronologia. Con B irraggiungibile restano su A soltanto i segnaposto di Matteo con mittente e orario; nessun contenuto arriva da un deposito di A.
7. Un test tiene fermo il peso del Welcome misurato da [S5](../spike/S5-quanto-pesa-un-albero.md).

## Residui da decidere e costruire dopo ADR 0043

**L'approvazione della custodia del mittente non approva le altre scelte di questo ADR.** Prima del codice federato restano da decidere la casa che ordina (§3), la fiducia nei registri remoti (§1) e la conservazione minima dello stato condiviso.

### Risposte del proprietario, 2026-09-17

Il proprietario ha risposto alle domande aperte. **Questo ADR resta Proposed** finché non lo rilegge e lo passa ad Accepted: le risposte fissano la direzione, non autorizzano ancora il codice federato.

1. **La casa che ordina è quella dove la conversazione è nata** (§3), fissata alla creazione. **Corretto il 2026-09-17 dopo la rilettura del proprietario**: «gruppo congelato per sempre» non è uno stato finale accettabile, e §3 ha ora **il trasloco** — una procedura eccezionale, dichiarata e mai automatica, per quando quella casa è persa davvero.
2. **Fiducia nei registri remoti** (§1): si scrive subito, senza confronto obbligatorio. Il numero di sicurezza è sempre disponibile e **l'interfaccia avvisa in modo evidente quando la chiave di un contatto cambia** rispetto all'ultima vista. Per farlo il client conserva l'impronta dell'ultima chiave vista: è un confronto, non una cache del registro, e non sostituisce la domanda alla casa remota a ogni validazione.
3. **Il segnaposto viaggia con un'operazione distinta**, `segnaposto`. `messaggio` resta com'è fino al taglio e poi si ritira: lo stesso nome non porta due cose diverse prima e dopo.
4. **Coda dei commit**: la casa che ordina conserva ogni commit finché tutti i dispositivi membri hanno avanzato il cursore oltre quel punto, con un tetto (proposto: 30 giorni). Chi resta indietro oltre il tetto rientra dal `GroupInfo`.
5. **`GroupInfo` e mazzo** stanno soltanto sulla casa che ordina, per la sola epoch corrente: ogni epoch sovrascrive la precedente. Le altre case li chiedono e non li conservano.
6. **Buste ricevute già salvate** (`messaggi`, chat `ESTIA-E2E-v1`): al taglio ognuna diventa un segnaposto, e il contenuto si cancella dopo aver verificato che la casa dell'autore ne ha la custodia. Dove la custodia manca il testo si perde, e l'interfaccia lo dice. **Senza oggetto dal 2026-10-07**: le installazioni di prima erano bozze, disinstallate, e non c'erano buste da convertire; la migrazione 31 toglie la tabella ([ADR 0038](0038-mls-si-adotta-e-si-comincia-dal-web.md), aggiornamento del 2026-10-07).
7. **Backup `age` storici**: scadono con la rotazione normale. Il limite si dichiara con una data nei documenti e nell'interfaccia; i backup successivi al taglio sono puliti.
8. **Tempo di ritiro dalla vista**: al battito di [ADR 0041](0041-le-istanze-si-tengono-d-occhio.md), **al massimo 5 minuti**, anche su una scheda già aperta. È il valore da misurare.
9. **Una casa sparita da un gruppo vivo**: se il battito la dà per irraggiungibile oltre una soglia (proposta: 30 giorni), un amministratore del gruppo può rimuoverne i membri, e l'interfaccia dice perché. I loro messaggi restano segnaposto. Se la casa sparita è quella che ordina, il gruppo resta congelato e lo dichiara.

### Rilettura del proprietario, 2026-09-17

Le nove risposte restano. Tre precisazioni e due lavori chiesti prima dell'accettazione:

- **La casa che ordina, persa per sempre, non lascia un gruppo congelato.** Scritto: §3, «Il trasloco».
- **La perdita di testo al taglio va bene, a due condizioni**: che si sia **verificato** che la custodia della casa dell'autore manca davvero — non dedotto, non dato per scontato — e che l'interfaccia lo dichiari con parole intere invece di mostrare un vuoto. Nessuna copia remota si tiene per evitare quella perdita.
- **Il cambio di chiave avvisa e non blocca.** L'avviso dev'essere molto evidente; la conversazione non si ferma ad aspettare che il numero di sicurezza sia confrontato.
- **Le due soglie di 30 giorni** (coda dei commit, casa data per persa) sono approvate **come valori iniziali**: si guardano sul campo, e cambiarle non è un ripensamento.
- **La specifica del segnaposto**, chiesta per intero prima dell'accettazione. Scritta: §4.1 — campi, deduplicazione, recupero dopo una disconnessione, più dispositivi, ritiro e revoca, con le sue verifiche.

**Seconda rilettura, stesso giorno.** Due chiarimenti chiesti prima della firma, entrambi scritti in §4.1:

- **`seq` è progressivo per `(conversazione, casa custode)`**, non per casa. Era l'intenzione, non era scritto.
- **Un elemento ritirato non deve poter tornare** né da `segnaposto-da` né da una risincronizzazione. Non era coperto: adesso lo è, e senza lapidi — la casa custode lascia il posto vuoto e non ha più niente da servire; la risposta dichiara la finestra che copre e dentro quella finestra ciò che non è elencato viene cancellato da chi riceve; il `seq` non si riusa e la spinta non scende sotto il cursore. Il ripristino di un backup di chi riceve è nominato a parte: quelle conversazioni si riconciliano da zero.

**Accepted il 2026-09-17.** Il trasloco crea un successore esplicito invece di ricostruire uno stato MLS che non si ha più, e due traslochi insieme danno due successori visibili invece di una convergenza sperata.

Inventario dal codice, aggiornato il 2026-09-08, non attestazione di conformità:

| Dato attuale                                               | Dove                                                                                                 | Conseguenza del vincolo                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Buste applicative ricevute                                 | `messaggi`, migrazioni 21/23 — **tolta dalla 31, 2026-10-07**                                        | Sostituita dal segnaposto; nessuna copia pregressa da migrare (decisione del proprietario)                              |
| Archivio locale attribuito al depositante                  | `mls/sessione.ts:ricevi`, `messaggi/service.ts:depositaArchivio`                                     | Ricezione senza copia e autore locale autenticato costruiti; provenienza e visite federate ancora da fare               |
| Mittente, orario, riferimenti di messaggio e conversazione | Futuro segnaposto                                                                                    | Autorizzati da 0043; schema minimo senza payload né dati derivati dal contenuto                                         |
| Membri remoti e relazioni di follow                        | `conversazione_membri`, `followers`, `following`                                                     | Esplicitare i riferimenti necessari alle relazioni e ai permessi; nessuna copia di profilo implicita                    |
| Reazioni remote e puntatori ai commenti                    | `remote_post_likes`, `remote_comments`                                                               | Censire i fatti e le durate già previsti da ADR 0025/0026; il consenso ai segnaposto delle chat non approva nuovi campi |
| Stato condiviso MLS                                        | `conversazione_handshake`, `conversazione_group_info`, `conversazione_archivio_chiavi`, stato client | Specificare collocazione, dati visibili, durata e limiti; nessun contenuto applicativo incluso come scorciatoia         |

Il taglio richiede inoltre una procedura per database, WAL, backup storici e restore che possono riportare copie fuori casa. Non si cancellano dati reali approvando un ADR e non si dichiara la garanzia attiva prima della migrazione verificata. Il tempo massimo per rimuovere dalla vista un contenuto divenuto indisponibile va specificato e misurato, anche con una scheda già aperta: il battito a cinque minuti non offre ritiro istantaneo.

Le prove di ADR 0043 sono criteri di accettazione aggiuntivi: devono distinguere **assenza del testo in chiaro** da **assenza anche del contenuto cifrato remoto**, ammettendo soltanto il segnaposto. Non chiudono retroattivamente il gate M6 sul NAS.

## Correzioni del 2026-11-27: la revisione di sicurezza

Una revisione di sicurezza ha trovato che su `main` **la chat MLS fra due case non era collegata**, e quattro difetti che il collegamento avrebbe esposto. Sono corretti nello stesso lavoro, e questa sezione dice che cosa è cambiato rispetto al testo qui sopra, che resta com'era.

**Le operazioni non erano collegate.** `buildApp` consegnava a `FederationService` soltanto il prelievo dei KeyPackage e il registro delle chiavi: `handshake`, `handshake-da`, `group-info`, `mazzo`, `segnaposto`, `segnaposto-da` e `archivio` rispondevano «richiesta sconosciuta» su un'istanza vera. La frase «le otto operazioni sono costruite» era vera per il codice e falsa per l'applicazione. `due-case-mls.test.ts` era verde perché sostituiva il filo con chiamate dirette al servizio dell'altra casa, e così saltava proprio il punto dove il collegamento mancava. Ora il collegamento sta in una funzione sola (`messaggi/direttorio.ts`) che non compila se manca un'operazione, e quella prova passa da `FederationService` da tutte e due le parti: al posto di iroh c'è un filo in processo (`federation/filo-finto.ts`) che porta byte e dice da quale chiave arrivano, e nient'altro.

**§3 — un commit entra solo all'epoch che segue l'ultima.** Il testo del 2026-09-23 dice «un'epoch più alta di ogni commit già in fila». Bastava, quindi, che fosse più alta: un partecipante che dichiarava l'epoch 2^53 chiudeva la fila per sempre, perché nessun commit vero sarebbe più stato più alto del suo. Ora il commit deve creare **esattamente** l'epoch successiva all'ultimo commit in fila (la prima è la 1); ogni altro valore riceve lo stesso 409 in casa ed `epoch_superata` sul filo. Un Welcome porta l'epoch del commit che l'ha prodotto, e si accetta solo se quell'epoch in fila c'è.

**§4 — `GroupInfo` e mazzo solo all'epoch dell'ultimo commit in fila.** Prima si accettava ogni epoch «non più bassa» di quella depositata: lo stesso salto in avanti lasciava per sempre un punto di rientro verso un gruppo che non esiste, o un mazzo che nessuno apre. Ora l'epoch dev'essere quella a cui la fila è arrivata (zero se non c'è ancora nessun commit). La stessa epoch si può riscrivere, come prima. Ne segue una cosa per il client: fra il momento in cui applica un commit e quello in cui deposita può arrivarne un altro, e il suo deposito riceve un 409 che **non è un guasto** — deposita chi ha scritto il commit nuovo, o chiunque lo applichi dopo. `mls/adattatori.ts` lo tratta così.

**§4.1 — l'annuncio non è un permesso.** Il testo dice che una casa può dire di ordinare solo una conversazione che ha fatto nascere lei, «quindi una menzogna qui tocca soltanto le sue conversazioni». Era vero per la coda e non bastava per il resto: qualunque casa, anche mai vista, faceva nascere qui una conversazione con qualunque nome locale, e la risposta — sì se il nome esisteva, no altrimenti — le diceva chi abita qua. Ora una conversazione nasce da un annuncio solo se **ogni** destinatario di qui si può raggiungere da quella casa secondo [ADR 0030](0030-chi-puo-scrivere-a-chi.md) §1, e le strade sono due: fra le due persone c'è un follow accettato, in un verso o nell'altro; oppure le due case sono collegate **e** la persona di qui è presente in rete (la stessa che quella casa trova già con la ricerca). Una casa sconosciuta non passa da nessuna delle due. Ogni rifiuto — nome inesistente, persona non raggiungibile, quota finita — è la stessa risposta (`non_trovato`), come chiede [ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md) §1. L'altra via per cui una conversazione con un'altra casa esiste qui resta il gesto di un membro di qui, che la apre.

**§4.1 — quote.** In un giorno una casa fa nascere al più 32 conversazioni con i suoi annunci, e al più 8 con la stessa persona di qui. Un Welcome è per un **membro** della conversazione, e in un giorno ne entrano in fila al più 16 per destinatario, 128 per conversazione e 256 per casa che li deposita; il conto per casa è in memoria e riparte a un riavvio, gli altri sono nel database. Sono numeri iniziali, larghi per una casa e stretti per chi vuole riempire un disco.

**§2 — il budget di chi partecipa.** Una casa che partecipa a una conversazione ha il limite di frequenza di una collegata, altrimenti una chat aperta fra due case non collegate si chiuderebbe da sola. Ma «partecipa» ora vuol dire **per un gesto di qualcuno di qui**: la conversazione l'ha aperta un membro nostro, o un membro nostro ci ha scritto. Una conversazione che l'altra casa ha soltanto annunciato non conta — altrimenti si darebbe da sola quel budget, con un annuncio.

**§3 — l'id e l'orario di un handshake li mette chi ordina.** Quelli dichiarati dalla casa che deposita si ignorano: un id già usato faceva fallire la scrittura, e un orario scelto da lei avrebbe spostato a piacere la finestra delle quote.

**§4.1 — i campi di un segnaposto hanno una forma.** L'id, il mittente e la data erano «un testo non troppo lungo», scritto da un'altra casa nel database di questa. Ora l'id è fatto di lettere, cifre e `._:-` (al più 120), il mittente è `nome@casa` con un nome utente valido e una chiave di 64 cifre esadecimali, la data è un istante UTC che esiste (`messaggi/forma.ts`). Lo stesso si chiede al deposito locale di una voce, perché una voce che qui entrasse con una forma che là si rifiuta non arriverebbe mai, in silenzio.

**Che cosa non è cambiato, e resta aperto.** Il Welcome depositato da una casa che non ordina, per un membro che non sia della casa che ordina, non arriva: il destinatario viaggia con il nome che ha nella casa di chi deposita, e chi ordina non lo riconosce come membro. Prima si metteva in fila senza arrivare a nessuno; ora si rifiuta. Lo corregge il lavoro dei gruppi, che è il primo ad averne bisogno (**fatto**, vedi la sezione che segue). E `chiavi` e `chiavi-di-firma` rispondono ancora a chiunque non sia bloccata: è il punto 2 della stessa revisione, fuori da questo lavoro.

## Aggiunta del 2026-11-27: la composizione di un gruppo

Le otto operazioni bastavano per una conversazione fra due case. Con tre non bastano, per una ragione precisa: l'annuncio (§4.1) dice a una casa «questa conversazione esiste, e dentro ci sono questi **tuoi**». La seconda casa non sapeva della terza, e §2 — «può depositare chi ha un membro dentro» — non si poteva applicare, perché nessuna casa oltre a quella che ordina sapeva chi c'era dentro. Servono due operazioni in più, e la regola è la stessa di §3: **quello che dev'essere uguale per tutti lo dice una casa sola**.

**La composizione la tiene chi ordina.** Chi c'è, con quale ruolo e da quando; chi è stato tolto o è uscito, quando e da chi; il nome del gruppo. Ha una **versione** che avanza a ogni cambio. Le altre case ne tengono uno specchio, e lo sostituiscono per intero solo quando arriva **dalla casa che ordina quella conversazione** — la chiave della connessione, mai un campo del messaggio — e a una versione non più bassa di quella che hanno. Una spinta vecchia arrivata tardi non rimette dentro chi è stato tolto.

| Operazione     | Chi la serve           | Che cosa fa                                                                                                          |
| -------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `composizione` | chi ordina (`leggi`)   | dà la composizione a una casa che ha dentro un membro, **o un rimosso**                                              |
| `composizione` | ogni casa (`annuncia`) | riceve la composizione da chi ordina; se la conversazione qui non c'è, nasce                                         |
| `membri`       | chi ordina             | applica un cambio (`aggiungi`, `togli`, `esci`, `nomina`) chiesto da una casa **a nome di un suo membro**, o lo nega |

**Chi può cambiare la composizione** lo decide il ruolo, guardato da chi ordina (risposta del proprietario del 2026-09-17): aggiungono e tolgono il creatore e gli amministratori che nomina; chiunque esce da sé. Una casa parla **per i suoi e per nessun altro**: `da` dev'essere un membro di quella casa, e la casa è la chiave della connessione. Un «no» porta il suo motivo (`solo_amministratori`, `gruppo_pieno`…), perché lo sente una persona che è nel gruppo; una casa che non c'entra riceve il rifiuto indistinto di §2.

**Le case dei rimossi restano nel giro.** Una casa che non ha più nessuno dentro non riceve più coda, stato né archivio (§2, com'era). Ma riceve ancora la composizione, e può chiederla: custodisce quello che i suoi avevano scritto ([ADR 0043](0043-custodia-lato-mittente.md)), deve sapere a chi servirlo, e deve sapere che il suo membro è stato tolto per dirglielo. Al membro tolto la sua casa risponde `rimosso_dal_gruppo` su ogni rotta della conversazione.

**Entrare in un gruppo è farsi scrivere.** Chi di una casa entra in un gruppo ordinato da un'altra passa dalla stessa porta dell'annuncio ([ADR 0030](0030-chi-puo-scrivere-a-chi.md) §1): la casa che ordina deve poterlo raggiungere, per un follow accettato con **uno dei suoi** che sta nel gruppo o perché è collegata e lui è presente in rete. I nomi delle altre case che la composizione elenca non contano: di quelli chi ordina non risponde. Chi non passa non entra nello specchio, e la risposta non lo dice — per il gruppo è un invito a cui nessuno risponde. È un limite dichiarato: in un gruppo ordinato da Aia, Bruno di Borgo non può far entrare Carla di Colle se **Aia** non può raggiungere Carla, anche quando Bruno e Carla si seguono.

**Il Welcome viaggia per indirizzo.** Depositato presso chi ordina da un'altra casa, il destinatario è `nome@casa`, e chi ordina lo traduce nell'id con cui lo nomina lui: prima era l'id della casa di chi depositava, che altrove non vuol dire niente.

**Che cosa questo non fa.** Non rende la composizione dell'istanza uguale all'albero MLS: sono due elenchi, tenuti da due parti, e l'istanza non vede il secondo. Che coincidano lo controlla il client (lo confronta e lo dice); un'istanza disonesta può dichiarare una composizione falsa, e la difesa resta quella di §1 — le chiavi nell'albero e il numero di sicurezza. Il tetto di 50 l'istanza lo conta in persone, non in foglie. E il trasloco di §3 dovrà portare con sé anche la composizione: non è costruito (**lo è dal 2026-11-28**, vedi la sezione che segue).

## Costruito il 2026-11-28: il trasloco

§3 «Il trasloco» è costruito com'è scritto. Questa sezione dice **come**, e nomina le scelte che il testo lasciava a chi costruiva: le prime tre aspettano la conferma del proprietario.

**Persa.** Una casa è persa quando l'ultimo contatto registrato con lei — `last_seen_at`, che il battito di [ADR 0041](0041-le-istanze-si-tengono-d-occhio.md) tiene aggiornato e che ogni sua richiesta in arrivo scrive — è più vecchio di 30 giorni (`SOGLIA_CASA_PERSA_MS`). Di una casa che non ha una riga fra le istanze remote vale il giorno in cui la conversazione è nata qui, che è arrivata da lei. La soglia apre il gesto e nient'altro: quando una persona lo fa, l'istanza **bussa un'ultima volta**, e una casa che risponde quel giorno non è persa (`casa_non_persa`). Serve anche per un limite che va saputo: il battito chiede solo alle case **collegate**, quindi di una casa che ordina senza esserlo si conosce solo l'ultima volta che ha scritto lei.

**Chi.** Chi amministra il gruppo secondo lo specchio di questa casa. Un membro soltanto se nessun amministratore ha una casa che risponde in quel momento.

**Il successore.** Una conversazione nuova, ordinata dalla casa di chi trasloca, con lo stesso nome. Dentro: chi trasloca, le persone di questa casa, e quelle delle case che **rispondono a una domanda fatta in quel momento**. La casa persa e quelle che tacciono restano fuori, e si aggiungono a mano. Un successore di una persona sola non nasce. Il gruppo MLS e il mazzo li crea il client di chi ha traslocato, come per ogni gruppo: sono nuovi per costruzione.

**La dichiarazione.** Sta in una tabella sua (migrazione 36) e viaggia nella `composizione` del successore, in un campo in più — `continua`: l'id del gruppo di prima, il suo nome, l'ultima epoch che chi ha traslocato aveva visto (la dice il suo client: l'istanza non la conosce), chi, quando, quale casa era persa e da quando. Nessuna operazione nuova: una casa che non conosce il campo lo ignora, e per lei il successore è un gruppo come un altro. Chi riceve la scrive solo se chi ha traslocato è **della casa che ordina il successore** — la chiave della connessione — e la mette accanto al gruppo di prima solo se quella persona **nel gruppo c'era** e la casa nominata come persa è quella che lo ordinava.

**Il gruppo di prima.** Si congela nella casa di chi trasloca nel momento del trasloco. **Scelta 1**: in un'altra casa si congela quando arriva la dichiarazione **e anche per quella casa** chi ordina risulta persa. Fino ad allora quella casa mostra il successore e lascia scrivere: altrimenti un membro qualunque, da un'altra casa, spegnerebbe la scrittura qui dichiarando il trasloco di un gruppo vivo. Congelato vuol dire che l'istanza rifiuta voci d'archivio, handshake, `GroupInfo`, mazzo e cambi di membri (`gruppo_congelato`), e non chiede più niente alla casa persa. La cronologia si ricompone come prima: le voci delle case vive si visitano, quelle della casa persa restano segnaposto. Non si scongela, nemmeno se la casa torna.

**Le chiavi che ogni client ha già. Scelta 2.** Il testo dice che la parte vecchia «si legge con le chiavi che ogni client ha già», ma il client non le teneva: la catena d'archivio si riapriva a ogni apertura dal mazzo, e il mazzo stava **solo** sulla casa che ordina (decisione 5). Persa quella, il gruppo di prima non si sarebbe riaperto dopo aver ricaricato la pagina. Ora il browser tiene accanto allo stato del gruppo **il mazzo com'è avvolto** sotto l'epoch di quello stato, e lo riscrive a ogni salvataggio. Non è una chiave in chiaro: si apre soltanto con lo stato MLS, che sta nello stesso posto, e l'uscita cancella tutti e due. Le case continuano a non conservarlo. Un dispositivo che nel gruppo non c'era non ha niente da aprire, com'è scritto.

**I ruoli nel successore. Scelta 3.** Chi trasloca ne è il creatore; chi amministrava resta amministratore, e il creatore di prima — se la sua casa risponde — lo diventa.

**Due traslochi.** Niente li impedisce, nemmeno dalla stessa casa: sono due righe in `conversazione_traslochi` e due conversazioni nell'elenco, ognuna con il nome di chi l'ha fatto e la data. L'interfaccia smette di offrire il gesto a chi vede già un successore; non è un controllo.

**Come si verifica.** [`gruppi.test.ts`](../../apps/core-api/src/messaggi/gruppi.test.ts) §«il trasloco»; [`due-case-mls.test.ts`](../../apps/core-api/src/messaggi/due-case-mls.test.ts) §«il trasloco fra tre case» — tre istanze intere sul filo in processo, il client vero, la casa che ordina spenta, un mese di orologio finto; [`conversazione.test.ts`](../../apps/web/src/mls/conversazione.test.ts) §«un gruppo congelato»; [`Trasloco.test.tsx`](../../apps/web/src/screens/gruppi/Trasloco.test.tsx). **Non provato**: in un browser vero, con iroh, sul campo.

**Che cosa non fa.** Non toglie un gruppo congelato dall'elenco (non se ne esce: non c'è più a chi dirlo). Non riporta dentro chi era rimasto fuori. Non firma la dichiarazione: la dice la casa di chi ha traslocato, e vale quanto vale quella casa.

## Quando riesaminare

- **Se la casa che ordina diventa un problema pratico** — cioè se nel pilot capita spesso di non poter cambiare i membri perché una casa è spenta: allora si guarda un ordinamento distribuito, sapendo che costa la convergenza. **Il trasloco è il rimedio per la casa persa, non per quella che dorme**: se lo si usasse per l'assenza di un pomeriggio, la risposta giusta non sarebbe traslocare più in fretta, sarebbe questa riga.
- **Le quote del 2026-11-27** (annunci e Welcome), che nascono come valori iniziali: se in una casa vera qualcuno le tocca senza voler fare danno, sono sbagliate.
- **Le due soglie di 30 giorni**, che nascono come valori iniziali: quante volte un dispositivo ha dovuto rientrare dal `GroupInfo` perché la coda era stata potata, e quante volte una casa data per persa è tornata dopo.
- **Insieme al numero di sicurezza**: il punto 1 lo rende necessario e non più consigliato, ed è la stessa schermata che [ADR 0037](0037-la-cronologia-e-un-archivio-non-una-chiave.md) §«Conseguenze sull'interfaccia» chiede già.
- **Se una casa si scollegasse da una conversazione ancora viva**: che ne è delle foglie dei suoi membri è una domanda che questo ADR non affronta, e che va affrontata prima dei gruppi grandi.
