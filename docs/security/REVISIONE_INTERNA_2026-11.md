# Revisione di sicurezza interna, novembre 2026

Data: 2026-11-27. Versione: `main` a quella data. Chi l'ha fatta: il manutentore con Claude, in quattro aree separate.

**Questa non è un audit indipendente.** L'ha fatta chi ha scritto il codice. Serve a togliere prima del lancio quello che si trova guardando con attenzione. Non garantisce che non resti altro. Un audit esterno è previsto **dopo** il lancio, ed è detto anche in [`SECURITY.md`](../../SECURITY.md).

## Come è stata fatta

Quattro letture indipendenti, ognuna con un perimetro e senza conoscere le conclusioni delle altre:

1. **Identità e dispositivi**: registrazione, sessioni, approvazione dei dispositivi, recupero, ammissione.
2. **Federazione**: protocollo `estia/1`, permessi per livello di rapporto, budget, MLS fra Case.
3. **Media, backup e operazioni**: decodifica delle immagini, backup e ripristino, `install.sh`, `bin/estia`, workflow di rilascio.
4. **Client web**: XSS, CSP, gestione del materiale MLS nel browser, archivio delle conversazioni.

Ogni rilievo «alto» è stato riprodotto prima di correggerlo. Ogni correzione ha un test che fallisce sul codice di prima.

## Corretti

| Gravità | Area        | Che cosa                                                                                                                        | Correzione                                       |
| ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Alta    | Media       | Un JPEG costruito apposta superava il limite di pixel: un file da 60 KB bloccava l'event loop per secondi e occupava diversi GB | [#14](https://github.com/Paluello/ESTIA/pull/14) |
| Alta    | Federazione | La prova dei profili pubblici veniva accettata da qualunque Casa, anche mai collegata: lettura, cuori e commenti a nome d'altri | [#21](https://github.com/Paluello/ESTIA/pull/21) |
| Media   | Operazioni  | `estia ripristino-backup` cancellava i dati, backup compresi, prima di validare l'archivio                                      | [#19](https://github.com/Paluello/ESTIA/pull/19) |
| Media   | Operazioni  | `estia aggiorna` e il rilancio di `install.sh` perdevano porta locale, impostazioni dei backup, montaggi e limiti               | [#17](https://github.com/Paluello/ESTIA/pull/17) |
| Media   | Backup      | Una sessione da amministratore bastava a cambiare la chiave dei backup e a portarsi via il database                             | [#38](https://github.com/Paluello/ESTIA/pull/38) |
| Media   | Federazione | La chat MLS fra Case non era collegata nell'app, e alcune verifiche sugli epoch e sulle quote mancavano                         | [#20](https://github.com/Paluello/ESTIA/pull/20) |
| Bassa   | Media       | Le foto restavano un anno nella cache del browser                                                                               | [#14](https://github.com/Paluello/ESTIA/pull/14) |
| Bassa   | Federazione | Una foto si serviva anche se il suo post era solo per la Casa o nascosto                                                        | [#39](https://github.com/Paluello/ESTIA/pull/39) |
| Bassa   | Operazioni  | Il ripristino da root seguiva link già presenti e aveva tutte le capability                                                     | [#19](https://github.com/Paluello/ESTIA/pull/19) |
| Bassa   | CI          | I workflow di verifica non limitavano i permessi del token                                                                      | [#14](https://github.com/Paluello/ESTIA/pull/14) |

## Ancora aperti

Sono noti e hanno un responsabile. Qui sono descritti solo a grandi linee: il dettaglio arriva con la correzione.

- **Approvazione dei dispositivi.** Ci sono percorsi in cui un dispositivo nuovo risulta approvato senza esserlo. C'è una correzione pronta. Una parte tocca il comportamento dopo il logout, e quella è una scelta di prodotto ancora da fare.
- **Materiale MLS nel browser.** Va legato all'account e alla Casa che l'hanno creato.
- **Provenienza dei messaggi nell'archivio delle conversazioni.** Il precondizionale di ADR 0043, «provenienza autenticata», non è ancora soddisfatto.
- **Federazione verso istanze sconosciute.** Mancano tetti sul numero di follow in attesa, timeout sulle connessioni in entrata e pulizia dei budget. Va anche decisa la richiesta delle chiavi da parte di Case non collegate.
- **Backup.** Gli archivi non dicono da quale istanza vengono.
- **Minori.** Una corsa sulla quota dei media, il commento pubblico leggibile per id, la ricerca dei membri e qualche campo non limitato in lunghezza.

## Che cosa è risultato a posto

Sono stati controllati senza trovare niente:

- token di sessione e loro revoca;
- Argon2id con utente fittizio;
- SQL parametrizzato ovunque;
- schemi con `additionalProperties: false`;
- nessun SSRF dal proxy delle immagini remote;
- filtro delle voci tar e permessi dei file di backup;
- log senza credenziali;
- CSP stretta e nessun punto di iniezione HTML nel client;
- workflow senza `pull_request_target`;
- Dockerfile e Compose con utente non root, filesystem in sola lettura e nessuna capability.
