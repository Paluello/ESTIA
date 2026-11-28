# Laboratorio dei relay — ADR 0045, verifiche 1-3

- Decisione: [ADR 0045](../../docs/adr/0045-la-rete-dei-relay-della-comunita.md) §«Prima di costruire»
- Risultati: [`results/2026-11-27.md`](results/2026-11-27.md)
- Dove gira: `.github/workflows/relay-lab.yml` su GitHub Actions; `run.sh` anche su un portatile con Docker

## Che cosa risponde

ADR 0045 mette tre verifiche tecniche prima di costruire la rete dei relay della comunità. Questo laboratorio le fa sul filo, con lo stesso binding di `apps/core-api` (`@number0/iroh` 1.1.0, cioè iroh 1.0.2) e l'immagine ufficiale del relay (`n0computer/iroh-relay` 1.5.0, fissata per digest).

1. **Due Case con relay principali diversi si raggiungono?** Due reti Docker separate, `lab-a` e `lab-b`: Docker non instrada fra reti utente, quindi il diretto è impossibile come fra due linee dietro CGNAT. La Casa A conosce solo `relay-a`, la Casa B solo `relay-b`. Si prova con l'indirizzo completo (chiave e relay, come un invito), con la sola chiave e la scoperta DNS di n0, e nei due casi misti con i relay di n0. La prova 1b è il controllo: senza relay e senza scoperta **deve** fallire, altrimenti le reti non sono separate e il resto non vale.
2. **I limiti dell'`iroh-relay` esistono come configurazione?** Lo stesso MiB su un relay senza limiti e su uno con `limits.client.rx` a 64 KiB/s; dieci Case accese insieme su un relay con `accept_conn_limit` a 1/s.
3. **Il binding lascia attiva la mappatura delle porte, e su quale porta?** `gateway.mjs` fa da router sull'host (che in una rete Docker è il gateway): ascolta NAT-PMP e PCP sulla 5351, risponde all'M-SEARCH di UPnP con una descrizione IGD minima e registra la chiamata `AddPortMapping`/`AddAnyPortMapping` con la porta interna dentro. Non mappa niente.

## Come si lancia

```bash
infra/relay-lab/run.sh                  # tutte le prove, serve Internet per 1c-1e
LAB_OFFLINE=1 infra/relay-lab/run.sh    # senza le prove che chiedono n0
```

Dietro un proxy che re-firma TLS, `npm install` dentro `docker build` fallisce: si costruisce l'immagine della sonda a parte e si passa `PROBE_SKIP_BUILD=1`. Il riassunto finisce in `results/out/summary.md` (ignorato da git) e, sul runner, nel riassunto del lavoro.

Il lavoro fallisce solo se una **prova del laboratorio** non torna (1a, 1b, 1c-1e, 2a, 2b). Le righe che rispondono a una domanda dell'ADR (2c, 3) danno un sì o un no, e tutti e due sono esiti validi.

## Pulizia

`run.sh` toglie contenitori e reti che crea, anche se fallisce. Resta l'immagine `estia-relay-lab-probe:local`: `docker image rm estia-relay-lab-probe:local`. Niente di questo laboratorio entra nell'immagine della Casa.
