# Ospitare un Nodo pubblico

- Decisione: [ADR 0045](adr/0045-la-rete-dei-relay-della-comunita.md)
- Immagine: `ghcr.io/paluello/estia-nodo-pubblico`, sorgente in [`infra/nodo-pubblico/`](../infra/nodo-pubblico/)
- Per chi è: chi sa aprire un server. **Non** serve per installare una Casa, e chi installa una Casa non deve leggere questa pagina.

## Che cos'è

Un Nodo pubblico è un **relay iroh**: una macchina raggiungibile da Internet che passa pacchetti cifrati fra due Case che non riescono a parlarsi in diretto, di solito perché tutte e due stanno dietro un router o dietro il CGNAT dell'operatore. Non conserva niente, non ha un database, non conosce gli utenti di nessuna Casa.

Di Nodi pubblici ne servono **pochi, sparsi e indipendenti**: un relay passa soltanto pacchetti, quindi una macchina sola ne serve molte. Lo ospita chi può: un'associazione, un circolo, un hackerspace, un comune, una biblioteca, un volontario con un server.

## Che cosa ti serve

| Che cosa                                                                                                                | Perché                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Una macchina raggiungibile da Internet: un VPS, o un server di casa su una linea **senza CGNAT** con le porte inoltrate | Il relay serve proprio quando le Case non si lasciano raggiungere, quindi deve stare dove tutti lo raggiungono                             |
| Un **nome DNS** che punta a quella macchina (record `A`, ed eventualmente `AAAA`)                                       | Il certificato si chiede per un nome, non per un indirizzo                                                                                 |
| Le porte **80/tcp, 443/tcp e 7842/udp** aperte verso la macchina                                                        | 80 per la sfida di Let's Encrypt, 443 per il relay, 7842 per QUIC: le Case ci scoprono il proprio indirizzo pubblico, che aiuta il diretto |
| Docker con il plugin Compose, su Linux `amd64` o `arm64`                                                                | È l'unico modo di installazione documentato                                                                                                |

Le risorse sono poche: il relay è un solo processo, senza disco oltre ai certificati. Quello che conta è la **banda** della linea, perché ogni byte che passa entra e riesce.

## Installazione

```bash
mkdir nodo-pubblico && cd nodo-pubblico
curl -fsSLO https://raw.githubusercontent.com/Paluello/ESTIA/main/infra/nodo-pubblico/compose.yaml
NODO_DOMINIO=relay.esempio.it NODO_EMAIL=chi@esempio.it docker compose up -d
docker compose logs -f
```

Al primo avvio il relay chiede il certificato a Let's Encrypt: serve che il nome DNS punti già alla macchina e che la porta 80 sia raggiungibile. Se vuoi provare senza consumare i tentativi di Let's Encrypt, aggiungi `NODO_LE_STAGING=1`: il certificato di prova non è valido per le Case, quindi toglilo appena funziona.

Per controllare che risponda da fuori:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://relay.esempio.it/ping   # deve rispondere 200
```

L'indirizzo da dare alle Case è `https://relay.esempio.it/`.

### Le variabili

| Variabile          | Predefinito      | Che cosa fa                                                                              |
| ------------------ | ---------------- | ---------------------------------------------------------------------------------------- |
| `NODO_DOMINIO`     | — (obbligatoria) | Il nome DNS della macchina                                                               |
| `NODO_EMAIL`       | — (obbligatoria) | Il contatto per Let's Encrypt: ti scrive se il certificato sta per scadere senza rinnovo |
| `NODO_BANDA_KIB`   | `1024`           | Banda in ingresso **per ogni Casa** collegata, in KiB/s                                  |
| `NODO_RAFFICA_KIB` | `4096`           | Quanto una Casa può superare quel limite per poco, in KiB                                |
| `NODO_LE_STAGING`  | `0`              | `1` per i certificati di prova                                                           |

Il contenitore rifiuta di partire, con un messaggio che dice quale, se manca una variabile obbligatoria o se un valore non ha senso.

## I limiti

Il relay è **aperto a chiunque**, con limiti che regoli tu ([ADR 0045](adr/0045-la-rete-dei-relay-della-comunita.md) §4). Un controllo d'accesso «solo Case ESTIA» non c'è, ed è voluto: il relay vede chiavi, non Case, e per riconoscere le Case dovrebbe ricevere l'elenco di chi parla con chi.

Che cosa si può limitare, verificato sul filo il 2026-11-27 nel [laboratorio dei relay](../infra/relay-lab/README.md):

- **La banda in ingresso di ogni Casa**: sì, con `NODO_BANDA_KIB`. A 64 KiB/s un MiB andata e ritorno è passato a 69 KiB/s invece che a 6-10 MiB/s.
- **Il ritmo di connessioni nuove**: **no**. iroh-relay 1.5.0 accetta la chiave `accept_conn_limit` nella configurazione ma non la applica (lo dice il suo codice, e il laboratorio lo conferma); l'immagine quindi non la scrive.
- **Il numero di connessioni simultanee e la banda totale**: **no**, iroh-relay non ha queste opzioni.

Se ti servono, mettili fuori dal contenitore: un limite di banda della macchina o del VPS, oppure regole del firewall sul numero di connessioni alla 443 (per esempio `iptables -m connlimit` o `nft ... ct count`). Non sono nell'immagine perché dipendono da come è fatta la tua macchina.

## Che cosa vedrai, e che cosa no

Questa è la parte da leggere prima di accendere.

|              |                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Non vedi** | I contenuti: messaggi, fotografie, nomi delle persone. Tutto è cifrato fra le due Case prima di arrivare a te, e tu non hai le chiavi                    |
| **Non puoi** | Fingerti una Casa: ogni Casa è la sua chiave, e il collegamento lo verifica                                                                              |
| **Vedi**     | Le **chiavi pubbliche** delle Case che si collegano, i loro **indirizzi IP**, **chi parla con chi, quando e quanto**                                     |
| **Puoi**     | Lasciar cadere tutto: rendere irraggiungibile una Casa che ti usa. È il motivo per cui un amministratore adotta un relay con un gesto, mai in automatico |

Il punto che conta: le chiavi da sole non dicono a chi appartengono, ma **tu, che sei vicino, forse sì**. Un operatore che conosce le persone del quartiere vede metadati che valgono di più di quelli che vede un'azienda lontana. Per questo, quando un amministratore adotta il tuo relay, ESTIA gli mostra **il tuo nome** come gestore.

Le metriche del relay restano dentro il contenitore (`127.0.0.1:9090`), e i registri di iroh-relay non scrivono contenuti. Non conservare più di quello che ti serve per tenerlo in piedi.

## Aggiornare, fermare, togliere

```bash
docker compose pull && docker compose up -d   # aggiornare
docker compose down                           # fermare: le Case ripiegano su un altro relay
docker compose down -v                        # togliere anche i certificati
```

Fermare un Nodo pubblico non fa perdere dati a nessuno: le Case che lo usavano ripiegano sul relay successivo della loro mappa, e per ultimi su quelli di n0. Se smetti per sempre, avvisa chi te l'ha chiesto, così toglie il tuo relay dalla sua Casa.

## Il collegamento con la tua Casa

[ADR 0045](adr/0045-la-rete-dei-relay-della-comunita.md) §5 prevede che l'operatore colleghi il Nodo alla propria Casa per vederne lo stato e regolarne i limiti dal pannello. **Non è ancora costruito**: oggi il Nodo si regola con le variabili qui sopra e si guarda con `docker compose logs`.
