# ADR 0047 — Le segnalazioni si visitano, non circolano

- Stato: **Accepted** — il merito è stato deciso dal proprietario il 2026-11-14; la forma è stata riscritta lo stesso giorno contro i documenti esistenti
- Data: 2026-11-14
- Proprietario: progetto ESTIA
- Dipende da: [ADR 0018](0018-federazione-fra-istanze-estia.md), [ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md), [ADR 0026](0026-i-commenti-remoti-restano-a-casa-di-chi-li-scrive.md)
- Corregge: [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), milestone successive, punto 4, voce «Le segnalazioni circolano, i verdetti no»; la stessa idea in [ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md) §4 e in [`PRODUCT_VISION.md`](../PRODUCT_VISION.md) §7
- Attua: il primo strato della moderazione federata (punto 4 delle milestone successive)
- Non tocca: le segnalazioni di un contenuto **locale** ai moderatori della propria istanza ([`PRODUCT_VISION.md`](../PRODUCT_VISION.md) §7, «strumenti individuali»), che restano com'è

## Contesto

Il piano dice che «un'istanza accumula segnalazioni da chi la incontra». La seconda metà della frase — **nessun verdetto vale per tutti** — resta giusta. La prima no: un'istanza che _accumula_ segnalazioni altrui conserva giudizi scritti da altri, cioè delle copie. È lo stesso difetto per cui l'indice dei profili è stato tolto da ADR 0018 (§«Scoperta», «Rivisto»): una copia piccola, che sopravvive a chi l'ha generata, nel punto in cui nessuno guarda. E ADR 0018 ha già fissato il metodo: **i contenuti si visitano, non si replicano**.

Una segnalazione è il caso peggiore di copia. Non è un post che qualcuno ha scelto di pubblicare: è **un giudizio su qualcun altro**. Se restasse nei database di venti istanze dopo che chi l'ha scritta ha cambiato idea, diventerebbe reputazione senza autore — il meccanismo delle piattaforme da cui ESTIA prende le distanze.

C'è poi un rischio specifico, che in una rete pensata anche per comunità che si organizzano va scritto per primo: **le segnalazioni sono lo strumento classico per isolare chi dà fastidio.** Segnalazioni di massa coordinate contro collettivi, minoranze, comunità nuove che «nessuno conosce». Un sistema di avvisi è una funzione politica, e va progettato come tale.

## La domanda

Come fa una persona ad avvisare la propria rete che un'istanza le sembra non autentica o inaccettabile, senza che l'avviso diventi un giudizio copiato ovunque, una sanzione automatica o un'arma per chi si coordina?

## Decisione 1: la segnalazione resta a casa di chi la scrive

È [ADR 0026](0026-i-commenti-remoti-restano-a-casa-di-chi-li-scrive.md) applicato a un altro oggetto: una segnalazione è, nella sostanza, **un commento su un'istanza**. Con una differenza, in senso più stretto: per i commenti la destinazione conserva un puntatore; qui **nessuno conserva niente**, nemmeno un puntatore, perché un elenco di «chi è stato segnalato da chi» sarebbe già un registro di giudizi.

- La scrive **una persona**, non un'istanza: chi segnala è sempre un membro, con il proprio account.
- Si salva **solo sull'istanza di chi la scrive**: istanza segnalata (per chiave), categoria (Decisione 2), motivo in testo libero, data.
- **Chi la scrive la ritira quando vuole**, e il ritiro ha effetto subito per tutti, perché nessuno ne tiene una copia.
- **Ne risponde l'istanza di chi la scrive**, come per i commenti: il motivo è contenuto di quel membro, e il suo admin lo può moderare.

Chi vuole sapere se un'istanza è stata segnalata **va a chiederlo** (Decisione 4). Nessuna istanza riceve, accumula o inoltra segnalazioni altrui.

## Decisione 2: due categorie, che non si mescolano mai

| Categoria         | Che cosa dice                                                     | Natura   |
| ----------------- | ----------------------------------------------------------------- | -------- |
| **Non autentica** | Account finti, bot, persone che nessuno ha mai incontrato davvero | Tecnica  |
| **Non gradita**   | Contenuti o comportamenti che chi segnala ritiene inaccettabili   | Politica |

La separazione è la decisione più importante di questo documento. «Non autentica» afferma un fatto, che chi legge può controllare per conto suo; «non gradita» è un'opinione, legittima ma sempre un'opinione. Mostrarle sotto la stessa etichetta trasformerebbe un dissenso in un sospetto di frode. In entrambi i casi resta una **dichiarazione di chi segnala**: nessuna delle due è verificata da qualcuno, e l'interfaccia non deve suggerire il contrario ([ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md) §5).

Non esiste una categoria «generata con l'AI». Una persona vera che usa uno strumento non è un bot, e riconoscere un testo generato non è affidabile: quella è materia delle regole di ogni istanza, non della rete.

## Decisione 3: si contano le istanze, non le persone

Quello che si mostra è **da quante istanze collegate arrivano segnalazioni**, e tramite quali: «segnalata come non autentica da persone di 3 istanze — tramite Sampierdarena, Vanchiglia, …». Mai «47 segnalazioni», e mai quante persone per istanza: ogni istanza risponde con **le categorie e i motivi**, non con un numero di persone.

Il motivo è aritmetico. Cinquanta persone coordinate su un'istanza sola pesano **una istanza**. Per pesare di più bisogna stare in più comunità, e le comunità che contano sono **quelle che l'amministratore di chi guarda ha scelto di collegare** ([ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md) §1: il collegamento è un atto deliberato con due lati). Chi crea cinquanta istanze finte non pesa cinquanta, perché non basta crearle: bisogna che qualcuno le colleghi, a ogni destinatario dell'avviso, uno per uno.

I nomi delle istanze in elenco sono quelli che **dichiarano di sé**, non dati verificati: vale il vincolo di presentazione di ADR 0020 §5.

## Decisione 4: si chiede a un salto, al momento

Per sapere chi ha segnalato l'istanza X, la mia istanza **lo chiede alle istanze a cui è collegata**, nel momento in cui serve: quando qualcuno apre il profilo di X, quando un admin valuta una richiesta di collegamento da X. Ognuna risponde per i propri membri.

- **Un salto solo**, come la ricerca (ADR 0018 §«Scoperta»: il salto transitivo è scartato). Le istanze collegate a Vanchiglia che a me non sono collegate non contano.
- **Solo un'istanza collegata può fare questa domanda**, e solo su **una chiave che sa già nominare**: non esiste «dammi tutte le segnalazioni che hai», perché l'enumerazione resta vietata a ogni livello ([ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md) §1). Vale il budget per istanza di §2, e ogni domanda ha un **tetto di tempo** ([ADR 0041](0041-le-istanze-si-tengono-d-occhio.md)).
- **Il risultato non si archivia.** Come ogni lettura federata, passa **in memoria e non si scrive su disco** (ADR 0018 §«I contenuti si visitano, non si replicano»): al più una conservazione in memoria, con scadenza breve, per non rifare la domanda a ogni apertura del profilo.
- **Chi risponde non registra chi chiede.** Contare, non registrare ([ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md) §3, che applica [`SECURITY_BASELINE.md`](../SECURITY_BASELINE.md) §7), e nessuna funzione di prodotto può essere costruita su questo dato: niente «istanze che hanno chiesto di X».
- **Il prezzo, dichiarato:** un gruppo di bot già noto a Torino resta invisibile a Roma, se Roma e Torino non si conoscono. È la conseguenza diretta di «la scoperta segue il grafo sociale» (ADR 0018), e la stessa regola vale per la reputazione: ci si fida di chi ha scelto di fidarsi di qualcuno vicino.
- **Un'istanza spenta porta via le proprie segnalazioni**, come porta via i propri post. Un avviso incompleto lo si dice («2 istanze non hanno risposto»), non lo si nasconde.

## Decisione 5: il verdetto è locale, ed è l'unica cosa che si conserva

Le segnalazioni degli altri si visitano. **La decisione del mio admin si salva a casa mia**: bloccare X, annotarla, oppure ignorare le segnalazioni su di lei. Non è la copia di un giudizio altrui: è un giudizio proprio, con autore e data.

È questo che rende sostenibile la Decisione 4. Un avviso che dipende dal NAS di qualcun altro può sparire; una decisione presa sulla base di quell'avviso no. «I verdetti restano locali» vuol dire anche «i verdetti restano accesi».

**La nota dell'admin è sua.** L'interfaccia non la precompila con il testo delle segnalazioni né con l'elenco delle istanze che le hanno scritte: sarebbe il modo per far rientrare le copie dalla finestra.

Nessuna soglia produce effetti da sola. Nessun numero di segnalazioni blocca, nasconde o declassa un'istanza: **le segnalazioni informano, le persone decidono**.

## Decisione 6: chi vede che cosa, e il diritto di replica

| Chi                                | Vede                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| Chi ha scritto la segnalazione     | Tutto, e può ritirarla                                                               |
| L'admin della sua istanza          | Tutto, compreso chi l'ha scritta: ne risponde                                        |
| Gli altri membri della sua istanza | Niente                                                                               |
| Un'istanza collegata che chiede    | Categoria, motivo, istanza di provenienza, data grossolana. **Non chi l'ha scritta** |
| L'istanza segnalata                | Lo stesso, **se è collegata all'istanza di provenienza**. Non chi l'ha scritta       |

La **data grossolana** (non l'ora, non il giorno) è una scelta di riservatezza: in una comunità piccola un orario preciso basta a riconoscere chi scrive.

**Il segnalatore non è mai identificabile fuori casa sua.** Chi segnala un gruppo aggressivo non deve esporsi a quel gruppo: è un rischio concreto, non teorico. Va detto a chi segnala, **nel momento in cui segnala**, anche che il proprio admin vede chi è, e il costo residuo descritto in «Che cosa vede il terzo».

**L'istanza segnalata può rispondere.** La replica è contenuto suo e resta a casa sua, come ogni contenuto: chi visita le segnalazioni su X visita anche la replica di X, e la vede **accanto**, non in una pagina separata. Un avviso senza la possibilità di rispondere è una condanna in contumacia.

C'è un limite che questo ADR non scioglie, e va scritto invece di essere promesso via: **chi guarda un'istanza che non conosce non è collegato a lei, e un'istanza sconosciuta può soltanto presentarsi** (ADR 0020 §1). Per ora la replica si visita solo dove X è raggiungibile da chi guarda; dove non lo è, l'avviso lo dichiara («replica non disponibile») e non finge che non esista. Come far arrivare la replica anche a chi non è collegato è la prima domanda aperta, e tocca un confine di fiducia: serve una decisione, non un'interpretazione.

## Che cosa l'interfaccia non deve dire

- **Un avviso non è un verdetto.** Niente rosso d'allarme, niente icone di pericolo, niente «istanza pericolosa». La forma giusta è informativa: chi ha segnalato, per quale categoria, con quale motivo, e la replica.
- **Le due categorie non condividono mai la stessa etichetta o lo stesso colore.**
- **Nessun punteggio di reputazione**, nessun contatore aggregato fra categorie, nessuna classifica di istanze: è la regola «niente ranking» di [`PRODUCT_VISION.md`](../PRODUCT_VISION.md) §11 applicata alle comunità invece che ai contenuti.
- **Un avviso incompleto si dichiara incompleto**: quante istanze collegate non hanno risposto.

Va scritto perché è il rischio vero: un avviso, per quanto «solo informativo», funziona già come sanzione. Nessuno si collega a un'istanza bollata. La neutralità di questo meccanismo sta tutta nella sua forma. Per questo il pezzo di interfaccia che lo realizzerà va verificato contro **tutte** le euristiche di [`DESIGN_SYSTEM.md`](../DESIGN_SYSTEM.md), con una verifica in più: che a colpo d'occhio non si legga come un verdetto.

## Che cosa vede il terzo

- **L'istanza a cui chiedo** sa che mi interesso di X, e quando. È la stessa esposizione della ricerca inoltrata, e va nello stesso bilancio; la regola «contare, non registrare» (Decisione 4) la limita senza eliminarla.
- **L'istanza segnalata**, se collegata alla provenienza, sa _da quale comunità_ arriva la segnalazione. In un quartiere questo può bastare a restringere molto il campo di chi l'ha scritta. Non è eliminabile senza togliere il diritto di replica.
- **Il relay** non vede niente di nuovo come categoria: vede che due istanze si parlano ([ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md) §5, [ADR 0045](0045-la-rete-dei-relay-della-comunita.md)), con qualche domanda in più fra istanze già collegate.

## Che cosa cambia nei documenti

Nel punto 4 delle milestone successive di [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) la voce diventa:

> **Le segnalazioni si visitano, i verdetti restano locali ([ADR 0047](0047-le-segnalazioni-si-visitano.md)).** Chi segnala salva la segnalazione a casa propria e la ritira quando vuole; chi vuole sapere chiede alle istanze collegate, a un salto, e non archivia la risposta. Si contano le istanze, non le persone. Nessuna soglia agisce da sola.

La frase «le segnalazioni circolano, i verdetti no» in ADR 0020 §4, e la sua variante «segnalazioni che circolano ma verdetti che restano locali» in `PRODUCT_VISION.md` §7, vanno corrette con una nota datata che rimandi qui, come già si fa altrove: gli ADR sono verbali e non si riscrivono.

## Quando costruire

Non adesso. È la voce «moderazione federata» delle milestone successive, e vale la regola di ADR 0026: non si anticipa prima del consolidamento di M3, M4 e M5. Costruirla vuole anche una nuova operazione sul filo fra istanze, che passa da [ADR 0021](0021-la-forma-del-protocollo-fra-istanze.md) (forma e versionamento del protocollo), non da questo documento.

## Domande aperte

1. **La replica verso chi non è collegato.** Per valutare una richiesta di collegamento da X l'admin ha davanti un'istanza che può solo presentarsi. Opzioni: la replica come campo della presentazione (richiede di correggere ADR 0020 §1), oppure rinunciare e dichiarare «replica non disponibile». Va decisa prima di costruire.
2. **Scadenza.** Una segnalazione dimenticata resta valida per sempre? Probabile risposta: chi la visita vede la data, e oltre una certa età l'interfaccia la mostra come vecchia. Da decidere con il pilot.
3. **Quanti motivi per istanza.** Una risposta che porta cinquanta motivi di una stessa istanza è un amplificatore, anche se pesa uno. Serve un tetto, e va tarato insieme ai budget per istanza di ADR 0020 §2.
4. **Liste di blocco condivise.** [`PRODUCT_VISION.md`](../PRODUCT_VISION.md) §7 e ADR 0020 §4 prevedono l'adesione alla lista di blocco di qualcuno di cui ci si fida. Un'adesione così è una lista che si visita o una che si copia? Per coerenza con questo ADR dovrebbe visitarsi, ma una blocklist che sparisce quando l'altra casa è spenta smette di proteggere: va deciso in un ADR suo.
5. **Segnalare senza aver incontrato.** Non è verificabile che chi segnala abbia mai visto X. La Decisione 3 ne limita il peso; resta da capire se basta.

## Quando riesaminare

Quando il pilot ha almeno tre istanze collegate fra loro e una prima segnalazione vera. La misura che conta: se chi riceve l'avviso lo legge come informazione o come condanna.
