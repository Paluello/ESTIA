# ADR 0050 — Il numero di sicurezza: uno per coppia, fatto come quello di Signal

- Stato: **Proposed** — il merito (uno per coppia, dentro M8) è deciso dal proprietario dal 2026-09-17; **la derivazione scritta qui aspetta la sua approvazione**. Il codice che la attua è costruito il 2026-11-27 e non va considerato definitivo finché questo ADR non è Accepted: cambiare la formula dopo vuol dire invalidare ogni verifica già fatta
- Data: 2026-11-27
- Proprietario: progetto ESTIA
- Dipende da: [ADR 0036](0036-estia-e2e-v1-e-il-debito-verso-mls.md) limite 4, [ADR 0038](0038-mls-si-adotta-e-si-comincia-dal-web.md), [ADR 0040](0040-un-membro-ha-piu-di-un-dispositivo.md), [ADR 0042](0042-come-mls-attraversa.md) §0 e §1
- Attua: la risposta del proprietario del 2026-09-17 in [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) M8 Fase 0 — «uno per ogni coppia, dentro M8 — lo stesso numero dei messaggi privati, e chi è verificato lo resta in ogni gruppo» — e la risposta 2 ad ADR 0042, per la sola parte che riguarda chi è già verificato
- Sostituisce: la formula dimostrativa di [S4](../spike/S4-autenticare-chi-entra.md) parte 4, che quello spike dichiarava «una dimostrazione, non un disegno»
- Non tocca: l'`AuthenticationService`, il registro delle chiavi di firma, l'approvazione dei dispositivi. Il numero **legge** il registro e non lo cambia; nessuna rotta nuova, nessuna migrazione

## Contesto

[S4](../spike/S4-autenticare-chi-entra.md) §3 ha misurato che chi tiene il registro delle chiavi di firma — l'istanza, chi la amministra, chi l'ha compromessa — può registrare una chiave propria a nome di un membro, e l'`AuthenticationService` le dice di sì perché è costruito sulla parola del registro. È il limite 4 di [ADR 0036](0036-estia-e2e-v1-e-il-debito-verso-mls.md), e nessuna difesa dentro il protocollo lo chiude. [ADR 0042](0042-come-mls-attraversa.md) §1 lo ha allargato: per un membro remoto il registro è di un'altra casa, e il numero di sicurezza è passato «da rimedio consigliato a rimedio necessario».

Lo spike mostrava un numero (`sha256` su chiavi ordinate, sei gruppi da cinque cifre) e ne scriveva i limiti: **non confrontato con la letteratura**, quante cifre servano non deciso, provato solo fra due persone con un dispositivo a testa.

Da allora sono cambiate due cose che una formula deve conoscere:

1. **Un membro ha più dispositivi** ([ADR 0040](0040-un-membro-ha-piu-di-un-dispositivo.md)), e ogni dispositivo ha una chiave di firma sua. Il registro serve le chiavi dei soli dispositivi approvati. «La chiave di Anna» non esiste più: esiste un insieme.
2. **L'identità porta la casa** ([ADR 0042](0042-come-mls-attraversa.md) §0): la credenziale è `<username>@<chiave della casa>`, e `anna` di una casa non è `anna` dell'altra.

`AGENTS.md` vieta la crittografia inventata. Questo ADR esiste per dire da dove viene ogni pezzo.

## La domanda

Da che cosa si deriva il numero, perché due persone lo calcolino uguale senza scambiarsi niente, perché valga in ogni conversazione che hanno in comune, e perché una chiave sostituita o aggiunta da chi tiene il registro lo faccia cambiare?

## Decisione 1: la costruzione è il safety number di Signal, senza varianti

Si adotta il `NumericFingerprint` di Signal, **versione a 60 cifre**, così com'è in libsignal (`rust/protocol/src/fingerprint.rs`, letto dal ramo `main` il 2026-11-27):

```
h₀ = SHA-512( 0x0000 ‖ K ‖ id ‖ K )
hᵢ = SHA-512( hᵢ₋₁ ‖ K )                 per i = 1 … 5199
metà = i primi 30 byte di h₅₁₉₉, in 6 pezzi da 5 byte:
       ciascuno letto come intero big-endian, modulo 100 000, scritto su 5 cifre
numero = le due metà (30 cifre l'una) in ordine lessicografico crescente, attaccate
```

`K` è la chiave pubblica di una persona, `id` il suo identificativo stabile. Ognuno calcola la metà propria e quella dell'altro; l'ordinamento rende il risultato uguale dai due lati.

**Perché questa e non un'altra.**

- È in uso da anni su una base di utenti enorme, ed è pensata per lo stesso gesto: due persone che leggono cifre a voce.
- **Le cifre e i giri sono motivati, non scelti a occhio.** Trenta cifre per parte sono 10³⁰ ≈ 2^99,7. I 5200 giri di SHA-512 alzano di ~2^12,3 il costo di ogni tentativo di chi cerca una chiave con la stessa impronta, e portano il totale a ~2^112: è il conto che libsignal stesso scrive nel commento del generatore («1024 ~ 109.7 bits, 1400 > 110 bits, 5200 > 112 bits»). Risponde alla domanda che S4 lasciava aperta, «quante cifre servano».
- La riduzione modulo 100 000 di un intero a 40 bit ha uno squilibrio dell'ordine di 10⁻⁷ fra una cifra e l'altra: è quello di Signal, e si tiene.
- **Ha un vettore di prova pubblico**, e il codice di ESTIA lo riproduce: `improntaSignal` in [`numero-di-sicurezza.ts`](../../apps/web/src/mls/numero-di-sicurezza.ts), con le chiavi e gli identificativi di `fingerprint_test_v1` di libsignal, dà `300354477692869396892869876765458257569162576843440918079131`. La prova sta in [`numero-di-sicurezza.test.ts`](../../apps/web/src/mls/numero-di-sicurezza.test.ts). Non è «ispirato a»: il nucleo è lo stesso, bit per bit.

Non si adotta la parte «scannable» (il QR con le due impronte a 32 byte): vedi §«Che cosa non c'è».

**Che cosa è stato confrontato e che cosa no.** È stato letto il codice di riferimento e riprodotto il suo vettore. **Non** è stata fatta una rassegna della letteratura accademica sulle impronte confrontate da persone (lunghezza, formato, tasso d'errore di chi legge), né un confronto puntuale con la verifica di Matrix. Chi approva questo ADR approva una costruzione nota applicata a ingressi nuovi, non un'analisi.

## Decisione 2: gli ingressi sono di ESTIA, e sono due

La costruzione di Signal prende **una** chiave d'identità per persona e un identificativo. ESTIA ha un insieme di chiavi e un'identità con casa. L'adattamento sta tutto negli ingressi, e la funzione non si tocca.

**L'identificativo** è l'identità della credenziale MLS dietro un'etichetta di dominio:

```
id = UTF-8( "ESTIA numero di sicurezza v1\n" ‖ username ‖ "@" ‖ chiave della casa )
```

È la stessa stringa che l'`AuthenticationService` usa per cercare nel registro ([`scriviIdentita`](../../apps/web/src/mls/gruppo.ts)): il numero lega le chiavi a **quella** persona di **quella** casa. L'etichetta separa questo uso da ogni altro, e porta la versione: una formula diversa avrà un'etichetta diversa, e non potrà mai dare lo stesso numero per ingressi diversi.

**La chiave** è l'insieme delle chiavi di firma dei dispositivi approvati, come il registro le serve ([ADR 0040](0040-un-membro-ha-piu-di-un-dispositivo.md): `GET /api/v1/dispositivi/di/:username/chiavi` per la propria casa, `GET /api/v1/mls/chiavi/:casa/:username` per le altre), ridotto a una sola sequenza di byte:

```
K = u16(n) ‖ u16(len(k₁)) ‖ k₁ ‖ … ‖ u16(len(kₙ)) ‖ kₙ
```

dove `k₁ … kₙ` sono le chiavi **distinte**, nella forma grezza in cui stanno nella foglia MLS (decodificate dal Base64 del registro), in **ordine crescente di byte**; `u16` è big-endian.

- **Distinte**, perché il registro ha una riga per sessione e due sessioni dello stesso browser portano la stessa chiave: contarla due volte farebbe cambiare il numero a ogni accesso. Lo stesso vale per chi rimette la chiave con la frase segreta su un altro browser: stessa chiave, stesso numero.
- **Ordinate**, perché l'ordine in cui il registro risponde non è un'informazione.
- **Con le lunghezze davanti**, e questa è l'unica cosa aggiunta rispetto a una concatenazione nuda: così la sequenza si legge in un modo solo, e due insiemi diversi non danno mai gli stessi byte — anche il giorno in cui la ciphersuite cambiasse e le chiavi non fossero più tutte lunghe uguali. `K` compare in `h₀` prima e dopo `id`; essendo auto-delimitata, anche quel confine è univoco.
- Solo le righe `MLS-P256-v1`: è il filtro che il client applica già al registro.

Un membro senza dispositivi approvati **non ha un numero**: non c'è niente di cui fare l'impronta, e l'interfaccia lo dice invece di mostrare cifre.

### Vettori di ESTIA

Tre chiavi di prova da 65 byte (in esadecimale nel file di test, `K1`, `K2`, `K3`), ricalcolati a parte con un'implementazione indipendente (Python, `hashlib`):

| Chi                                  | Chiavi   | Metà (30 cifre)                  |
| ------------------------------------ | -------- | -------------------------------- |
| `anna@casa-aia`                      | `K1`     | `733486787863755005672156483565` |
| `bruno@casa-borgo`                   | `K2`     | `788743789105236207587007469612` |
| `anna@casa-aia`, secondo dispositivo | `K1, K3` | `704316109781076991684436900175` |
| `anna@casa-borgo` (un'altra persona) | `K1`     | `383548449629179640041237109353` |

Numero di Anna e Bruno con un dispositivo a testa: `73348 67878 63755 00567 21564 83565 78874 37891 05236 20758 70074 69612`.

Dopo che Anna approva un secondo dispositivo: `70431 61097 81076 99168 44369 00175 78874 37891 05236 20758 70074 69612`. **La metà di Anna è cambiata tutta; quella di Bruno è rimasta dov'era.**

Se uno di questi vettori cambia, non è un test da aggiornare: è una versione nuova della formula, con un'etichetta nuova e un ADR.

## Decisione 3: uno per coppia, e la conversazione non entra nel conto

Il numero dipende da due persone e da nient'altro: né l'id della conversazione, né l'epoch, né chi altro c'è nel gruppo. È la decisione del 2026-09-17 resa vera **per costruzione**: nei messaggi privati e in qualunque gruppo che Anna e Bruno condividono, il numero è lo stesso perché nessun ingresso sa in quale conversazione lo si sta guardando.

In un gruppo non esiste quindi «il numero del gruppo». Dalla conversazione si arriva a un elenco dei membri, e dietro ogni membro c'è lo stesso pannello dei messaggi privati.

## Che cosa fa cambiare il numero

| Che cosa succede                                                                           | Il numero         | Chi vede l'avviso (se aveva verificato) |
| ------------------------------------------------------------------------------------------ | ----------------- | --------------------------------------- |
| L'altra persona **approva un dispositivo nuovo** con una chiave nuova                      | cambia            | io                                      |
| L'altra persona **toglie** un dispositivo, e nessun altro suo dispositivo ha quella chiave | cambia            | io                                      |
| Chi tiene il registro **sostituisce o aggiunge** una chiave all'altra persona              | cambia            | io                                      |
| **Io** approvo o tolgo un dispositivo                                                      | cambia            | l'altra persona, non io                 |
| Un accesso nuovo dallo stesso browser (stessa chiave di firma, riga nuova nel registro)    | resta             | nessuno                                 |
| Un browser nuovo rimesso con la **frase segreta** (stessa chiave di firma)                 | resta             | nessuno                                 |
| Un dispositivo nuovo **in attesa** del sì (non è nel registro)                             | resta             | nessuno                                 |
| Si entra in un gruppo, se ne esce, cambia l'epoch, la conversazione trasloca               | resta             | nessuno                                 |
| Una persona cambia nome visualizzato                                                       | resta             | nessuno                                 |
| Una persona cambia casa (non costruito): è un'altra identità                               | è un altro numero | —                                       |

**Un dispositivo nuovo cambia il numero, ed è voluto.** È il prezzo di non avere una chiave d'identità della persona sopra quelle dei dispositivi (vedi §«Alternative»): l'unico modo in cui Anna può sapere che il secondo dispositivo di Bruno è di Bruno, e non una chiave che la casa di Bruno ha aggiunto, è confrontare di nuovo. L'avviso dice tutte e due le possibilità con parole semplici, e mette prima la più probabile.

## Decisione 4: «verificato» ricorda la metà dell'altro, e sta su questo dispositivo

**Che cosa si ricorda.** Segnando Bruno verificato, il client di Anna conserva sotto `bruno@<casa>` la **metà di Bruno** (30 cifre) e la data. Non il numero intero: quello cambia anche quando è Anna ad aggiungere un dispositivo, e avvisarla allora di ogni suo contatto sarebbe gridare al lupo per una cosa fatta da lei. La metà di Bruno cambia soltanto se cambiano le chiavi di Bruno.

Ne viene lo stato, uno fra tre: **non verificato**, **verificato** (la metà di oggi è quella conservata), **cambiato** (non lo è, o Bruno non ha più dispositivi).

**Dove sta.** Nel cassetto del dispositivo — lo stesso di IndexedDB che custodisce la chiave di firma — sotto la chiave `verifiche_sicurezza`. Stesso posto, stessa vita:

- **non si deposita sull'istanza**: un «verificato» custodito da chi tiene il registro è una verifica che il registro può scrivere da solo;
- **l'uscita lo cancella**, insieme alla chiave ([`dimentica`](../../apps/web/src/mls/dispositivo.ts)): chi entra dopo sullo stesso browser non eredita la fiducia di chi è uscito;
- **non segue la persona su un altro dispositivo**. È un limite, scritto sotto.

**L'avviso.** Quando una conversazione si apre, quando la scheda torna in primo piano e dopo ogni «verificato», il client chiede il registro **dei soli membri verificati** e ricalcola la loro metà. Se una non coincide, in cima alla conversazione compare un avviso con il nome e il pulsante «Confronta di nuovo». **Avvisa e non blocca** ([ADR 0042](0042-come-mls-attraversa.md), risposta 2): si continua a scrivere. Una casa che non risponde non è un cambio e non produce avvisi; un registro che risponde «nessuna chiave» sì.

**Il numero lo calcola il client, mai l'istanza.** È la regola del codice di [ADR 0040](0040-un-membro-ha-piu-di-un-dispositivo.md): cifre fornite da chi tiene il registro coinciderebbero sempre.

**Chi guarda deve essere dentro il proprio insieme.** Prima di mostrare un numero il client controlla che la chiave di firma di **questo** dispositivo sia fra quelle che il registro dichiara per lui. Se non c'è — aspetta ancora il sì, o il registro la tace — non mostra cifre e dice perché: quel numero non parlerebbe di lui.

## Che cosa il numero non prova

Va scritto per intero, perché è qui che l'adattamento è più debole dell'originale.

1. **Una chiave aggiunta di nascosto _prima_ del confronto, e mostrata a tutti e due, passa.** In Signal la propria metà viene da una chiave che il dispositivo possiede. Qui la propria metà viene dal registro, perché è l'unico posto dove un dispositivo impara le chiavi degli altri **propri** dispositivi: l'approvazione di ADR 0040 è una riga nel database, non una firma. Una casa ostile che aggiunge una chiave sua all'insieme di Anna e la serve **sia ad Anna sia a Bruno** produce due numeri che coincidono. Tre cose lo limitano, nessuna lo chiude:
   - il pannello dice **quante chiavi** entrano nel numero per parte, e dice di non segnare verificato se il conto delle proprie non torna;
   - il controllo «questo dispositivo è nel proprio insieme» impedisce almeno la sostituzione;
   - **dopo** la verifica, qualunque aggiunta fa scattare l'avviso sull'altro lato.

   Lo chiuderebbe una catena di firme fra dispositivi — il dispositivo che approva **firma** la chiave di quello nuovo, come il cross-signing di Matrix — così che l'insieme si possa verificare a partire da una chiave che si possiede. È una decisione crittografica a sé e non è presa qui.

2. **Per chi non è verificato non c'è nessun avviso.** La risposta 2 ad ADR 0042 chiede di avvisare «quando la chiave di un contatto cambia rispetto all'ultima vista», per ogni contatto. Qui si avvisa solo per i verificati. Ricordare l'ultima impronta vista di chiunque (fiducia al primo uso) è il passo che manca, e si appoggia sullo stesso cassetto.

3. **La verifica non attraversa i dispositivi.** Verificato sul computer, non verificato sul telefono. Portarla richiede di decidere chi la custodisce, ed è il punto 1 visto da un'altra parte.

4. **Il numero dice che le chiavi sono quelle, non che i messaggi passati lo fossero.** Chi è entrato in una conversazione con una chiave poi tolta ha letto ciò che ha letto.

5. **Confrontare nella stessa chat non vale niente**, e l'interfaccia lo dice: di persona o al telefono.

## Che cosa non c'è

- **Nessun QR.** Sessanta cifre lette a voce sono l'unica via. Il formato «scannable» di Signal è la strada ovvia, e richiede la fotocamera nel client web.
- **Nessun elenco dei verificati** nelle impostazioni: la verifica si mette e si toglie dal pannello della persona.
- **Nessun segno «verificato»** accanto al nome nell'intestazione della conversazione o nell'elenco: lo stato si vede nel pannello e, in un gruppo, nell'elenco dei membri del pannello.
- **Nessun controllo periodico** a conversazione aperta: apertura, ritorno in primo piano, dopo una verifica.
- **Client mobile**: non costruito ([ADR 0044](0044-il-dispositivo-e-l-app.md)). La formula è di questo ADR e vale per ogni client; i vettori sono la sua prova di compatibilità.

## Alternative considerate

**Una chiave d'identità per persona, condivisa fra i dispositivi (il modello di Signal).** Il numero non cambierebbe a un dispositivo nuovo. Richiede di portare una chiave privata da un dispositivo all'altro, o di firmare con essa le chiavi dei dispositivi: è il cross-signing del punto 1 qui sopra. Giusta, più grande di questo incremento, e non decisa.

**Un numero per dispositivo.** Con due dispositivi a testa sono quattro confronti, e nessuno li fa.

**Un numero per gruppo, derivato dall'albero.** Cambierebbe a ogni ingresso e uscita, e direbbe «questo gruppo è coerente» invece di «questa persona è lei». Scartato dal proprietario il 2026-09-17.

**La verifica interattiva di Matrix (SAS: sette emoji o tre numeri da un segreto concordato sul momento).** Più comoda, ma è un protocollo a più messaggi fra due dispositivi accesi insieme, con il suo trasporto. Il numero statico si confronta anche in differita e non aggiunge messaggi al protocollo.

**La formula di S4** (una `sha256` sulle due chiavi ordinate, trenta cifre in tutto). Nessun legame con chi è la persona, nessun giro di rinforzo, una chiave sola per parte, e un numero unico in cui non si distingue quale delle due metà è cambiata: era una dimostrazione, e lo diceva.

## Come si verifica

In [`numero-di-sicurezza.test.ts`](../../apps/web/src/mls/numero-di-sicurezza.test.ts), [`sicurezza.test.ts`](../../apps/web/src/mls/sicurezza.test.ts) e [`SicurezzaConversazione.test.tsx`](../../apps/web/src/screens/sicurezza/SicurezzaConversazione.test.tsx):

1. Il nucleo riproduce il vettore di libsignal.
2. I vettori di ESTIA qui sopra non si muovono.
3. Il numero è uguale dai due lati, calcolato su due dispositivi con chiavi MLS vere.
4. Una chiave sostituita, o aggiunta e mostrata a un lato solo, dà due numeri diversi.
5. Un dispositivo nuovo dell'altro cambia il numero, porta lo stato a «cambiato» e fa comparire l'avviso; confrontato di nuovo, l'avviso se ne va.
6. Un dispositivo nuovo proprio cambia il numero e **non** accusa l'altro.
7. Lo stesso numero dai messaggi privati e dall'elenco di un gruppo; chi è verificato in una lo è nell'altro.
8. L'uscita cancella le verifiche.

**Non provato**: in un browser vero fra due case; con un gruppo vero di tre persone (la creazione di un gruppo non esiste ancora in questo ramo, e il percorso dei gruppi è provato solo a livello di componente).

## Quando riesaminare

- **Prima di dichiararlo Accepted**: la formula, l'etichetta e i vettori diventano un contratto fra client.
- Quando si decide la firma fra dispositivi (limite 1): il numero dovrebbe allora derivare da una chiave della persona, e sarà una `v2` con la sua etichetta.
- Quando esiste il client mobile: i vettori vanno riprodotti lì prima di qualunque interfaccia.
- Se la ciphersuite cambia ([ADR 0038](0038-mls-si-adotta-e-si-comincia-dal-web.md) §5): le chiavi cambiano forma, e la codifica con le lunghezze regge; i numeri di tutti cambiano comunque, perché cambiano le chiavi.
