# ADR 0047 — Le segnalazioni si visitano, non circolano

- Stato: **Accepted** — decisa dal proprietario il 2026-11-14 (bozza da rifinire nella forma, non nel merito)
- Data: 2026-11-14
- Proprietario: progetto ESTIA
- Dipende da: [ADR 0018](0018-federazione-fra-istanze-estia.md), [ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md), [ADR 0026](0026-i-commenti-remoti-restano-a-casa-di-chi-li-scrive.md)
- Corregge: [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), successiva 4, voce «Le segnalazioni circolano, i verdetti no»
- Attua: il primo strato della moderazione federata

## Contesto

La voce 4 del piano dice che «un'istanza accumula segnalazioni da chi la incontra». La seconda metà della frase — **nessun verdetto vale per tutti** — resta giusta. La prima no: un'istanza che *accumula* segnalazioni altrui conserva giudizi scritti da altri, cioè delle copie. È lo stesso difetto per cui l'indice dei profili è stato tolto da ADR 0018 §«Rivisto»: una copia piccola, che sopravvive a chi l'ha generata, nel punto in cui nessuno guarda.

E una segnalazione è il caso peggiore di copia. Non è un post che qualcuno ha scelto di pubblicare: è **un giudizio su qualcun altro**. Se resta nei database di venti istanze dopo che chi l'ha scritta ha cambiato idea, diventa reputazione senza autore — ed è esattamente il meccanismo delle piattaforme da cui ESTIA prende le distanze.

C'è poi un rischio specifico, che in una rete pensata anche per comunità che si organizzano va scritto per primo: **le segnalazioni sono lo strumento classico per isolare chi dà fastidio.** Segnalazioni di massa coordinate contro collettivi, minoranze, comunità nuove che «nessuno conosce». Un sistema di avvisi è quindi una funzione politica, e va progettato come tale.

## La domanda

Come fa una persona ad avvisare la propria rete che un'istanza le sembra non autentica o pericolosa, senza che quell'avviso diventi un giudizio copiato ovunque, una sanzione automatica, o un'arma per chi si coordina?

## Decisione 1: la segnalazione resta a casa di chi la scrive

È [ADR 0026](0026-i-commenti-remoti-restano-a-casa-di-chi-li-scrive.md) applicato a un altro oggetto. Una segnalazione è, nella sostanza, **un commento su un'istanza**.

- La scrive **una persona**, non un'istanza: chi segnala è sempre un membro, con il proprio account.
- Si salva **solo sull'istanza di chi la scrive**: istanza segnalata (per chiave), categoria (Decisione 2), motivo in testo libero, data.
- **Chi la scrive la ritira quando vuole**, e il ritiro ha effetto subito per tutti, perché nessuno ne tiene una copia.
- **Ne risponde l'istanza di chi la scrive**, come per i commenti: il motivo in testo libero è contenuto di quel membro, e il suo admin lo può moderare.

Chi vuole sapere se un'istanza è stata segnalata **va a chiederlo** (Decisione 4). Nessuna istanza riceve, accumula o inoltra segnalazioni altrui.

## Decisione 2: due categorie, che non si mescolano mai

| Categoria         | Che cosa dice                                                     | Natura    |
| ----------------- | ----------------------------------------------------------------- | --------- |
| **Non autentica** | Account finti, bot, persone che nessuno ha mai incontrato davvero | Tecnica   |
| **Non gradita**   | Contenuti o comportamenti che chi segnala ritiene inaccettabili  | Politica  |

La separazione è la decisione più importante di questo documento. «Non autentica» è un'affermazione che si può verificare; «non gradita» è un'opinione, legittima ma sempre un'opinione. Mostrarle sotto la stessa etichetta trasformerebbe un dissenso in un sospetto di frode.

Non esiste una categoria «generata con l'AI». Una persona vera che usa uno strumento non è un bot, e riconoscere un testo generato non è affidabile: quella è materia delle regole di ogni istanza, non della rete.

## Decisione 3: si contano le istanze, non le persone

Quello che si mostra è **da quante istanze collegate arrivano segnalazioni**, e tramite quali: «segnalata come non autentica da persone di 3 istanze — tramite Sampierdarena, Vanchiglia, …». Mai «47 segnalazioni».

Il motivo è aritmetico. Cinquanta persone coordinate su un'istanza sola pesano **una istanza**. Per pesare di più bisogna essere in più comunità che i tuoi vicini hanno scelto di collegare, il che è difficile da fingere, perché il collegamento è un atto deliberato di un amministratore ([ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md)).

## Decisione 4: si chiede a un salto, al momento

Per sapere chi ha segnalato l'istanza X, la mia istanza **lo chiede alle istanze a cui è collegata**, nel momento in cui serve: quando qualcuno apre il profilo di X, quando un admin valuta una richiesta di collegamento da X. Ognuna risponde per i propri membri. Il risultato **non si archivia**.

- **Un salto solo**, come la ricerca (ADR 0018 §«Il salto transitivo è stato scartato»). Le istanze collegate a Vanchiglia, che a me non sono collegate, non contano.
- **Il prezzo, dichiarato:** un gruppo di bot già noto a Torino resta invisibile a Roma, se Roma e Torino non si conoscono. È la conseguenza diretta di «la scoperta segue il grafo sociale» (ADR 0018), e la stessa regola vale per la reputazione: ci si fida di chi ha scelto di fidarsi di qualcuno vicino.
- **Un'istanza spenta porta via le proprie segnalazioni**, come porta via i propri post. Un avviso incompleto lo si dice («2 istanze non hanno risposto»), non lo si nasconde.

## Decisione 5: il verdetto è locale, ed è l'unica cosa che si conserva

Le segnalazioni degli altri si visitano. **La decisione del mio admin si salva a casa mia**: bloccare X, annotarla, oppure ignorare le segnalazioni su di lei. Non è la copia di un giudizio altrui: è un giudizio proprio, con autore e data.

È questo che rende sostenibile la Decisione 4. Un avviso che dipende dal NAS di qualcun altro può sparire; una decisione presa sulla base di quell'avviso no. «I verdetti restano locali» vuol dire anche «i verdetti restano accesi».

Nessuna soglia produce effetti da sola. Nessun numero di segnalazioni blocca, nasconde o declassa un'istanza: **le segnalazioni informano, le persone decidono**.

## Decisione 6: chi vede che cosa, e il diritto di replica

| Chi                                   | Vede                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| Chi ha scritto la segnalazione        | Tutto, e può ritirarla                                                               |
| L'admin della sua istanza             | Tutto, compreso chi l'ha scritta: ne risponde                                        |
| Un'istanza collegata che chiede       | Categoria, motivo, istanza di provenienza. **Non chi l'ha scritta**                  |
| L'istanza segnalata                   | Lo stesso, se è collegata all'istanza di provenienza. **Non chi l'ha scritta**       |

**Il segnalatore non è mai identificabile fuori casa sua.** Chi segnala un gruppo aggressivo non deve esporsi a quel gruppo: è un rischio concreto, non teorico.

**L'istanza segnalata può rispondere.** La replica è contenuto suo e resta a casa sua, come ogni contenuto: chi visita le segnalazioni su X visita anche la replica di X, e la vede **accanto**, non in una pagina separata. Un avviso senza la possibilità di rispondere è una condanna in contumacia.

## Che cosa l'interfaccia non deve dire

- **Un avviso non è un verdetto.** Niente rosso d'allarme, niente icone di pericolo, niente «istanza pericolosa». La forma giusta è informativa: chi ha segnalato, per quale categoria, con quale motivo, e la replica.
- **Le due categorie non condividono mai la stessa etichetta o lo stesso colore.**
- **Nessun punteggio di reputazione**, nessun contatore aggregato fra categorie, nessuna classifica di istanze. È la regola «niente ranking» di [`PRODUCT_VISION.md`](../PRODUCT_VISION.md) §9 applicata alle comunità invece che ai contenuti.
- **Un avviso incompleto si dichiara incompleto**: quante istanze collegate non hanno risposto.

Va scritto perché è il rischio vero: un avviso, per quanto «solo informativo», funziona già come sanzione. Nessuno si collega a un'istanza bollata. La neutralità di questo meccanismo sta tutta nella sua forma.

## Che cosa vede il terzo

- **L'istanza a cui chiedo** sa che mi interesso di X, e quando. È la stessa esposizione della ricerca inoltrata, e va nello stesso bilancio.
- **L'istanza segnalata**, se collegata alla provenienza, sa *da quale comunità* arriva la segnalazione. In un quartiere questo può bastare a restringere molto il campo di chi l'ha scritta. Non è eliminabile senza togliere il diritto di replica; va detto a chi segnala, **nel momento in cui segnala**.

## Che cosa cambia nel piano

Nella successiva 4 di [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), la voce diventa:

> **Le segnalazioni si visitano, i verdetti restano locali ([ADR 0047](adr/0047-le-segnalazioni-si-visitano.md)).** Chi segnala salva la segnalazione a casa propria e la ritira quando vuole; chi vuole sapere chiede alle istanze collegate, a un salto, e non archivia la risposta. Si contano le istanze, non le persone. Nessuna soglia agisce da sola.

## Domande aperte

1. **Scadenza.** Una segnalazione dimenticata resta valida per sempre? Probabile risposta: chi la visita vede la data, e oltre una certa età l'interfaccia la mostra come vecchia. Da decidere con il pilot.
2. **Liste di blocco condivise.** PRODUCT_VISION §7 prevede «l'adesione alla lista di blocco di qualcuno di cui ci si fida». Un'adesione così è una lista che si visita o una che si copia? Per coerenza con questo ADR dovrebbe visitarsi, ma una blocklist che sparisce quando l'altra casa è spenta smette di proteggere: va deciso in un ADR suo.
3. **Segnalare senza aver incontrato.** Non è verificabile che chi segnala abbia mai visto X. La Decisione 3 ne limita il peso; resta da capire se basta.

## Quando riesaminare

Quando il pilot ha almeno tre istanze collegate fra loro e una prima segnalazione vera. La misura che conta: se chi riceve l'avviso lo legge come informazione o come condanna.
