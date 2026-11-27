# ADR 0052 — L'archivio dei gruppi: a che cosa è legata una voce, e da dove viene la chiave nuova

- Stato: **Proposed** — sono tre scelte crittografiche fatte costruendo i gruppi (M8) e la correzione chiesta dalla revisione di sicurezza del 2026-11-27. Il codice che le attua è costruito e provato; **non vanno considerate definitive finché il proprietario non le accetta**. Cambiare la prima dopo vuol dire che le voci scritte nel frattempo si aprono come «di prima»; cambiare la seconda vuol dire che i client vecchi e nuovi derivano catene diverse
- Data: 2026-11-27
- Proprietario: progetto ESTIA
- Dipende da: [ADR 0037](0037-la-cronologia-e-un-archivio-non-una-chiave.md) §3 (la catena d'archivio), [ADR 0038](0038-mls-si-adotta-e-si-comincia-dal-web.md), [ADR 0040](0040-un-membro-ha-piu-di-un-dispositivo.md), [ADR 0042](0042-come-mls-attraversa.md) §3 e §«Aggiunta del 2026-11-27», [ADR 0043](0043-custodia-lato-mittente.md)
- Modifica: [ADR 0037](0037-la-cronologia-e-un-archivio-non-una-chiave.md) §3, per **come nasce** la chiave che la catena guadagna a una rimozione. Che la catena ruoti a ogni rimozione, e perché, resta com'è
- Chiude: il rilievo 3 della revisione del client web («le voci d'archivio non sono legate a mittente, id e data») e il rilievo 4 («l'albero MLS non è mai confrontato con i membri della conversazione»)
- Non tocca: la custodia lato mittente, il segnaposto, la serratura del mazzo (`mlsExporter` con l'etichetta `estia archive wrap v1`), l'`AuthenticationService`

## Contesto

Tre cose mancavano perché un gruppo mantenesse quello che dice.

**La prima la trova la revisione.** Una voce d'archivio era `AES-GCM(chiave della catena, testo)` e nient'altro. Chi l'ha scritta, quando, e in quale conversazione li dichiarava **l'istanza** accanto al testo cifrato, e il client li mostrava sulla sua parola. Con la custodia lato mittente ([ADR 0043](0043-custodia-lato-mittente.md)) quelle istanze sono più d'una, e nessuna è quella di chi legge: una casa poteva servire il testo cifrato di Anna dicendo che l'aveva scritto Bruno, o ieri, o spostarlo in un'altra conversazione con la stessa catena. La voce si apriva lo stesso. ADR 0043 chiamava «provenienza autenticata» questa condizione, e la lasciava aperta.

**La seconda nasce con le rimozioni.** [ADR 0037](0037-la-cronologia-e-un-archivio-non-una-chiave.md) §3 dice che a ogni rimozione la catena guadagna una chiave, e `catenaRuotata` la sceglieva a caso. In un gruppo una chiave casuale deve **arrivare** agli altri, e l'unica strada è il mazzo avvolto sotto l'epoch nuova. Ma il mazzo lo riavvolge chiunque noti un cambio di epoch ([`sessione.ts`](../../apps/web/src/mls/sessione.ts), regola 3), con la catena che ha in mano: un membro che applica il commit di rimozione un attimo prima che chi ha tolto depositi il mazzo lo riavvolge **con la catena vecchia**, e la chiave nuova è persa — insieme a tutto ciò che nel frattempo è stato scritto con lei. Fra due persone non succedeva perché non si toglie nessuno; in un gruppo è una corsa che qualcuno prima o poi perde.

**La terza è chi è nel gruppo.** Per l'istanza i membri sono righe di `conversazione_membri`; per la crittografia sono le foglie dell'albero MLS. Niente le confrontava. E chi esce da un gruppo **non può togliere la propria foglia**: MLS non lo permette a chi firma il commit. Finché nessun altro lo fa, chi è uscito apre ancora il mazzo.

## Decisione 1: una voce è legata a conversazione, id, mittente e data

I quattro campi entrano nel sigillo come **dati autenticati** (l'AAD di AES-GCM), non nella busta:

```
AAD = UTF-8( JSON.stringify([ "estia-archivio-v2",
                              conversazioneId, id, mittente, createdAt ]) )
voce = IV(12) ‖ AES-256-GCM(chiave della catena, IV, AAD, testo)
```

- `mittente` è `username@casa`, ed è **l'identità della foglia di chi scrive** ([`ioIn`](../../apps/web/src/mls/gruppo.ts)): la stessa che il gruppo ha autenticato, non un parametro che la schermata passa.
- `id` e `createdAt` sono quelli che il client di chi scrive sceglie e deposita, e che la sua casa ripete nel segnaposto ([ADR 0042](0042-come-mls-attraversa.md) §4.1): l'istanza non li riscrive, li valida soltanto nella forma.
- Un array JSON di stringhe e non una concatenazione: nessuna scelta dei campi ne produce un'altra con gli stessi byte. Il primo elemento dice che cosa si sta legando.

**Chi legge ricostruisce l'AAD da ciò che la sua istanza dichiara** e apre con quello. Se una casa — quella di chi scrive, quella di chi legge, una in mezzo — ha cambiato uno dei quattro campi, il sigillo non si apre e la riga è `non-si-apre`: lo stato che c'è già, non un testo attribuito a un altro.

**Le voci di prima.** Una voce che non si apre con il suo legame si riprova **senza**: se si apre così, è nata prima di questo ADR, e la riga porta `attestata: false`. Il client la mostra con «Mittente e orario non verificati». Il ripiego non indebolisce le voci nuove: una voce sigillata con un AAD non si apre senza, e per fabbricarne una senza serve la chiave della catena, che nessuna casa ha.

### Che cosa il legame non prova

**Non prova chi ha scritto contro un altro membro.** La chiave della catena è la stessa per tutti: chi è nel gruppo può sigillare una voce con qualunque `mittente`. Perché arrivi a qualcuno come «di Anna» deve però essere servita **dalla casa di Anna** — è lì che si visitano le voci di Anna — quindi serve un membro **e** quella casa, insieme. Contro questo servirebbe una firma con la chiave della foglia su ogni voce. Non è fatto qui: costa una firma per messaggio e una verifica per riga, e la chiave di firma è quella che un dispositivo rientrato può non avere più; va deciso sapendolo.

**Non prova l'ordine né la completezza.** Una casa può ancora tacere una voce, o servirne una ritirata: la prima è ciò che `non-disponibile` già mostra, la seconda è il tetto dei cinque minuti di ADR 0042 §4.1.

## Decisione 2: la chiave che la catena guadagna a una rimozione si deriva dall'epoch

```
A(n+1) = MLS-Exporter( epoch creata dal commit di rimozione,
                       label = "estia archive chain v1", context = "", 32 byte )
```

Chi resta la ottiene **identica senza scambiarsi niente**: la calcola applicando il commit, o costruendolo. Chi è stato tolto non la ottiene, perché di quell'epoch non ha il segreto — è la garanzia che MLS dà a una rimozione, ed è la sola su cui questa decisione poggia. La corsa del §Contesto sparisce: non c'è una chiave che deve arrivare prima di un riavvolgimento.

- **Quando.** Fra lo stato di prima e quello di dopo un commit, se una **chiave di firma** che c'era non c'è più ([`qualcunoTolto`](../../apps/web/src/mls/gruppo.ts)). Si guarda la chiave e non il posto: un rientro con la stessa chiave sostituisce la foglia e non toglie nessuno; un dispositivo revocato a una persona che resta è una rimozione a tutti gli effetti.
- **Dove.** In [`sincronizza`](../../apps/web/src/mls/sessione.ts), **commit per commit** — la chiave è di quell'epoch e non della successiva — e in chi il commit lo costruisce. Chi non ha la catena (un dispositivo appena rientrato) non aggiunge niente: la riceve intera dal mazzo, già con le chiavi delle rimozioni passate.
- **L'etichetta è diversa** da quella della serratura (`estia archive wrap v1`): stesso segreto di epoch, due usi che non si toccano.
- La chiave derivata **entra nella catena e ci resta**: chi entra dopo la riceve dal mazzo come le altre. Non è più «legata all'epoch» di quanto lo sia una chiave casuale, una volta nella catena — che è l'obiezione di [S2](../spike/S2-la-chiave-d-archivio.md) a usare `mlsExporter` come chiave d'archivio, e qui non si applica.

**La prima chiave resta casuale**, e nasce con il gruppo: lì non c'è nessuno a cui farla arrivare.

**Questa decisione vale quanto vale la rimozione in MLS.** `ts-mls` 1.6.2 costruiva un commit con una sola Remove **senza UpdatePath**: chi veniva tolto calcolava da sé i segreti dell'epoch dopo, quindi anche questa chiave e la serratura del mazzo. È corretto dalla 1.6.4 ([S7](../spike/S7-openmls-e-ts-mls.md)), e [`gruppi.test.ts`](../../apps/web/src/mls/gruppi.test.ts) lo prova: con la 1.6.2 la prova «chi è stato tolto non decifra un messaggio dell'epoch successiva» **cade**, con la 1.6.4 passa. Chi cambia versione di `ts-mls` la deve vedere verde.

## Decisione 3: l'albero si mette accanto ai membri, e ciò che non torna si dice o si toglie

A ogni giro di lettura il client confronta le identità delle foglie con i membri che la sua istanza dichiara ([`confronta`](../../apps/web/src/mls/gruppo.ts), [`allinea`](../../apps/web/src/mls/conversazione.ts)). Due esiti:

- **Estranei**: hanno una foglia e non sono fra i membri. Aprono il mazzo, quindi leggono.
- **Assenti**: sono fra i membri e non hanno una foglia. Non leggono ancora niente.

**Un estraneo si toglie soltanto quando si è certi che lo sia**:

1. se risulta **tolto o uscito** — la vista della conversazione porta ora `rimossi`, gli indirizzi di chi non c'è più, che ogni casa conosce dalla composizione ([ADR 0042](0042-come-mls-attraversa.md) §«Aggiunta del 2026-11-27») — lo toglie **il primo dispositivo che se ne accorge**, di qualunque casa. È così che esce la foglia di chi è uscito da solo;
2. se chi guarda sta **nella casa che ordina un gruppo**, dove la composizione è quella vera, toglie chiunque non sia fra i membri.

Altrove, e in ogni conversazione a due, un nome sconosciuto **non si toglie**: può essere qualcuno appena entrato di cui la composizione non è ancora arrivata. Si **dice** — «Qui dentro c'è qualcuno che non risulta fra le persone di questa conversazione», con il suo nome — e **finché c'è non si scrive**: [`manda`](../../apps/web/src/mls/conversazione.ts) rifiuta, e il campo è spento.

Ogni rimozione fatta così è una rimozione: la catena guadagna la sua chiave (decisione 2).

Insieme a questo, una chiave d'ingresso si accetta solo se **nomina la persona che si sta facendo entrare** ([`aggiungiFoglie`](../../apps/web/src/mls/sessione.ts)): una casa che ne consegna una di un altro non fa entrare nessuno.

### Che cosa il confronto non prova

- **L'istanza che ordina resta creduta su chi è membro.** Può aggiungere una riga, e chi amministra da quella casa farebbe entrare quella persona senza vederci niente di strano oltre al nome nell'elenco e alla riga «ha aggiunto» nella conversazione. Il confronto difende dall'altro verso: una foglia che **nessuna** istanza dichiara.
- **I commit degli altri membri si applicano tutti** (`acceptAll`): MLS non sa chi «amministra», e un membro qualunque può costruire un commit che aggiunge o toglie. Lo si vede dopo, dal confronto, non lo si impedisce prima. Rifiutare un commit in base al ruolo vorrebbe dire fidarsi dei ruoli dichiarati dall'istanza **dentro** la macchina a stati di MLS, e fermarsi a un'epoch diversa da quella degli altri: non è deciso.
- **Fra l'uscita di qualcuno e il primo giro di un altro, chi è uscito legge.** L'istanza gli rifiuta già tutto (criterio 3 di M8); la crittografia lo chiude quando un dispositivo qualunque apre il gruppo.

## Alternative considerate

- **Firmare ogni voce con la chiave della foglia**, invece dell'AAD. Chiude anche il caso «membro + casa». Rimandata, non scartata: vedi §«Che cosa il legame non prova».
- **Tenere la chiave casuale e impedire il riavvolgimento sbagliato lato istanza** (accettare il mazzo di un'epoch solo dal primo che lo deposita). L'istanza non sa chi ha tolto: vincerebbe chi arriva prima, cioè a volte la catena vecchia. E affida a un controllo dell'istanza una proprietà che deve valere contro di lei.
- **Far riavvolgere il mazzo solo a chi ha fatto il commit.** Se la sua scheda si chiude fra il commit e il mazzo, nessun altro può più aprirlo: era il difetto che la regola «lo fa chiunque noti il cambio» aveva chiuso.
- **Togliere ogni estraneo, da ogni casa.** Una casa con la composizione in ritardo toglierebbe chi è appena entrato.

## Come si verifica

- [`apps/web/src/mls/gruppi.test.ts`](../../apps/web/src/mls/gruppi.test.ts): una casa che cambia mittente o data ottiene una voce che non si apre; la stessa busta ridepositata con un altro id non si apre; una voce di prima si apre come non attestata. Chi resta deriva la stessa chiave senza leggerla dal mazzo; chi è tolto rilegge il passato e non apre il seguito, né decifra un messaggio dell'epoch dopo. Riammissione nello stesso commit, secondo dispositivo, 409 e nuovo tentativo, tetto di 50 foglie. Estranei tolti solo se certi; `manda` rifiuta finché ce ne sono.
- [`apps/core-api/src/messaggi/due-case-mls.test.ts`](../../apps/core-api/src/messaggi/due-case-mls.test.ts), §«un gruppo fra tre case»: lo stesso percorso con tre istanze intere e il client vero.
- **Non provato**: in un browser vero; con più schede dello stesso dispositivo sulla stessa conversazione; con un membro che applica dieci commit arretrati di cui tre rimozioni, se non come conseguenza del ciclo che li applica uno alla volta.

## Quando riesaminare

- Se si decide la firma per voce: la decisione 1 resta come legame, e la firma le si aggiunge.
- Quando il nucleo Rust con OpenMLS ([ADR 0051](0051-le-app-del-telefono-sono-native.md)) scriverà nell'archivio: l'AAD e l'etichetta dell'exporter diventano parte di ciò che i due client devono fare uguale, e meritano vettori di prova scritti qui.
- Se i ruoli dovessero valere **dentro** MLS (un commit di un non-amministratore rifiutato da tutti): è un'altra decisione, e tocca [ADR 0042](0042-come-mls-attraversa.md).
