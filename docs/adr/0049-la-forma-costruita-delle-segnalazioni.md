# ADR 0049 — La forma costruita delle segnalazioni

- Stato: **Accepted** — la scelta sulla domanda aperta 1 di ADR 0047 (Decisione 4) è stata confermata dal proprietario il 2026-11-27, come scelta per ora
- Data: 2026-11-27
- Proprietario: progetto ESTIA
- Dipende da: [ADR 0047](0047-le-segnalazioni-si-visitano.md), [ADR 0021](0021-la-forma-del-protocollo-fra-istanze.md), [ADR 0020](0020-che-cosa-puo-chiedere-un-istanza-che-non-conosciamo.md), [ADR 0041](0041-le-istanze-si-tengono-d-occhio.md)
- Attua: il primo strato della moderazione federata, punto 4 delle milestone successive di [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md), nella deroga dichiarata dal piano di un mese del 2026-11-27

## Contesto

ADR 0047 ha deciso il merito: la segnalazione resta a casa di chi la scrive, si visita a un salto, si contano le istanze e il verdetto è locale. Lo stesso documento dice che costruirla vuole **una nuova operazione sul filo**, e che quella passa da ADR 0021, non da lì. Lascia anche cinque domande aperte, di cui due vanno sciolte prima di scrivere codice (la 1 e la 3). Questo documento fa le due cose e niente di più.

## Decisione 1: due richieste nuove, additive

ADR 0021 §3 permette di aggiungere tipi di richiesta dentro `estia/1`: chi non li conosce risponde `richiesta_sconosciuta`, ed è un no ordinato. Si aggiungono due tipi.

| Richiesta      | Chi può farla                 | Che cosa chiede                                                           | Che cosa torna                                                           |
| -------------- | ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `segnalazioni` | solo un'istanza **collegata** | le segnalazioni dei membri di qui su **una chiave** che chi chiede nomina | per ogni segnalazione: categoria, motivo, **mese**. Mai chi l'ha scritta |
| `replica`      | solo un'istanza **collegata** | la replica di questa istanza alle segnalazioni su di sé                   | il testo e il mese, oppure niente                                        |

- **Non esiste una domanda senza chiave.** `segnalazioni` vuole sempre l'istanza di cui si chiede; non c'è «tutte quelle che hai» (ADR 0020 §1).
- **«In contatto» non basta.** Un follow accettato si ottiene da soli (ADR 0022), e un giudizio su un'istanza non è una cosa da dare a chi si è messo in contatto da solo. Serve il collegamento amministrativo, che è il grafo su cui ADR 0047 Decisione 3 fa i conti.
- **Chi risponde non registra chi chiede.** Il budget per istanza di ADR 0020 §2 conta la domanda come le altre; nessuna riga, nessun registro, nessun «chi ha chiesto di X».
- **Il tetto di tempo** è quello delle ricerche inoltrate: una casa spenta non trattiene nessuno, e risulta fra quelle che non hanno risposto.

## Decisione 2: la data grossolana è il mese

ADR 0047 Decisione 6 dice «non l'ora, non il giorno». Sul filo viaggia `AAAA-MM`, e la data piena non lascia mai la casa di chi ha scritto. Il mese basta per capire se una segnalazione è vecchia (domanda aperta 2 di ADR 0047, che resta aperta per la soglia ma ha già il dato per mostrarla).

## Decisione 3: il tetto dei motivi (domanda aperta 3 di ADR 0047)

- **Tre motivi per categoria per istanza** in una risposta, i più recenti. Cinquanta motivi di un'istanza sola restano tre, e chi guarda vede comunque **una istanza**.
- Un motivo è lungo al massimo **400 caratteri**. Con sei motivi la risposta resta sotto i 16 kB dei messaggi di controllo (ADR 0021), senza bisogno di un tetto suo.
- **Una persona ha al più una segnalazione per categoria su una stessa istanza.** Scriverne un'altra sostituisce la prima: una persona che insiste non diventa dieci righe.

I numeri vanno ritarati con il pilot, insieme ai budget di ADR 0020 §2. Sono scritti qui perché un tetto deciso nel codice e non in un documento è un tetto che nessuno sa di poter cambiare.

## Decisione 4: la replica verso chi non è collegato (domanda aperta 1 di ADR 0047) — per ora

Si costruisce la seconda delle due opzioni di ADR 0047: **la replica si visita solo dove l'istanza segnalata è collegata a chi guarda**, e altrove l'avviso dice «replica non disponibile». Non si tocca ADR 0020 §1, e quindi la presentazione resta ciò che è oggi.

È la scelta reversibile: aggiungere più tardi la replica come campo della presentazione è un campo in più, additivo per ADR 0021, mentre toglierlo dopo averlo distribuito non lo è. **Confermata dal proprietario il 2026-11-27**, come scelta per ora: si può ribaltare con una riga qui sotto, datata, senza che il codice di oggi vada buttato.

## Decisione 5: che cosa vuol dire «ignorare le segnalazioni»

ADR 0047 Decisione 5 dà al verdetto locale tre forme: bloccare, annotare, ignorare.

- **Bloccare** è il blocco che esiste già (ADR 0020 §4), per chiave. Non si duplica.
- **Annotare** salva una nota dell'admin, sua, con autore e data. L'interfaccia **non la precompila** con niente.
- **Ignorare** vuol dire che questa istanza **smette di chiedere** le segnalazioni su X per i propri membri: chi apre il profilo di X non vede l'avviso, e vede invece che il proprio admin ha deciso di non mostrarlo. Non si tace in silenzio: si dice perché.

Il verdetto è l'unica cosa che si conserva, e si conserva solo qui.

## Decisione 6: chi vede l'avviso

L'avviso è ciò che la propria istanza ricompone visitando le collegate. Lo vede **ogni membro** che apre il profilo di un'istanza remota, e l'admin quando valuta una richiesta di collegamento. Le segnalazioni scritte **dai membri di questa istanza** non entrano nell'avviso mostrato ai membri: per ADR 0047 Decisione 6 gli altri membri della stessa casa non le vedono. Le vede l'admin, nella schermata in cui le modera.

## Conseguenze

**Positive.** Il merito di ADR 0047 diventa codice senza riaprire nessun confine: due tipi additivi, nessun campo nuovo nella presentazione, nessuna copia su disco. I tetti sono scritti e tarabili.

**Negative.** Finché la Decisione 4 vale, l'admin che valuta una richiesta di collegamento da un'istanza sconosciuta vede l'avviso senza la replica. È il prezzo che ADR 0047 aveva già messo per iscritto.

## Quando riesaminare

Con il pilot, come ADR 0047, e in più: alla prima istanza che chiede di poter rispondere a chi non le è collegato.
