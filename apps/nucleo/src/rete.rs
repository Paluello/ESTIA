//! La rete del Dispositivo: un endpoint iroh con la chiave custodita nella
//! cassaforte, che parla **solo con la propria Casa** (ADR 0044 §1, §4).
//!
//! Due ALPN, due momenti:
//!
//! - `estia/ingresso/1`, una volta sola: la chiave nuova presenta il codice
//!   monouso del QR, e se la Casa lo accetta la chiave diventa del membro;
//! - `estia/dispositivo/1`, sempre dopo: ogni richiesta dell'API dei membri è
//!   uno stream della stessa connessione ([`crate::filo`]).

use std::{collections::BTreeMap, time::Duration};

use anyhow::{anyhow, bail, Context, Result};
use iroh::{
    endpoint::{presets, Connection},
    Endpoint, EndpointAddr, EndpointId, SecretKey,
};
use iroh_tickets::endpoint::EndpointTicket;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::filo::{
    incornicia, scomponi, CollegamentoIngresso, IntestazioneRichiesta, IntestazioneRisposta,
    ALPN_DISPOSITIVO, ALPN_INGRESSO, TETTO_CORPO_RICHIESTA, TETTO_CORPO_RISPOSTA,
    TETTO_INTESTAZIONE,
};

/// Quanto si aspetta la Casa prima di dire che non risponde. Nessuna domanda
/// senza tetto di tempo (ADR 0041).
pub const ATTESA_COLLEGAMENTO: Duration = Duration::from_secs(30);
pub const ATTESA_RISPOSTA: Duration = Duration::from_secs(60);

/// La Casa di questo dispositivo, come la si ricorda fra un avvio e l'altro.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Casa {
    /// La chiave pubblica della Casa.
    pub chiave: String,
    /// Il ticket, quando la Casa è in rete locale senza scoperta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket: Option<String>,
}

impl Casa {
    pub fn indirizzo(&self) -> Result<EndpointAddr> {
        if let Some(ticket) = &self.ticket {
            let ticket: EndpointTicket = ticket.parse().context("ticket della Casa illeggibile")?;
            let indirizzo = ticket.endpoint_addr().clone();
            if indirizzo.id.to_string() != self.chiave {
                bail!("il ticket non è della Casa che il QR dichiara");
            }
            return Ok(indirizzo);
        }
        let id: EndpointId = self
            .chiave
            .parse()
            .context("chiave della Casa illeggibile")?;
        Ok(EndpointAddr::new(id))
    }
}

/// Una risposta della Casa, com'è arrivata dal filo.
#[derive(Debug, Clone, Serialize)]
pub struct Risposta {
    pub stato: u16,
    pub intestazioni: BTreeMap<String, String>,
    pub corpo: Vec<u8>,
}

pub struct Rete {
    endpoint: Endpoint,
    connessione: Mutex<Option<Connection>>,
}

impl Rete {
    /// Apre l'endpoint con la chiave di rete del dispositivo. Nessun ALPN in
    /// ascolto: il dispositivo bussa, non riceve.
    pub async fn apri(chiave: SecretKey) -> Result<Self> {
        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(chiave)
            .proxy_from_env()
            .bind()
            .await
            .context("l'endpoint non si apre")?;
        Ok(Self {
            endpoint,
            connessione: Mutex::new(None),
        })
    }

    pub fn chiave_pubblica(&self) -> String {
        self.endpoint.id().to_string()
    }

    async fn collega(&self, casa: &Casa, alpn: &[u8]) -> Result<Connection> {
        tokio::time::timeout(
            ATTESA_COLLEGAMENTO,
            self.endpoint.connect(casa.indirizzo()?, alpn),
        )
        .await
        .map_err(|_| anyhow!("la Casa non risponde"))?
        .context("collegamento alla Casa fallito")
    }

    /// L'ingresso: presenta il codice del QR. Ritorna l'utente come la Casa lo
    /// descrive, oppure un errore che non distingue i motivi, perché la Casa
    /// non li dice (chiude senza rispondere).
    pub async fn entra(
        &self,
        collegamento: &CollegamentoIngresso,
        etichetta: &str,
    ) -> Result<(Casa, serde_json::Value)> {
        let casa = Casa {
            chiave: collegamento.casa.clone(),
            ticket: collegamento.ticket.clone(),
        };
        let connessione = self.collega(&casa, ALPN_INGRESSO).await?;
        let (mut invio, mut ricezione) = connessione.open_bi().await.context("stream rifiutato")?;
        let domanda = serde_json::json!({ "codice": collegamento.codice, "etichetta": etichetta });
        invio.write_all(&serde_json::to_vec(&domanda)?).await?;
        invio.finish()?;
        let grezzo =
            tokio::time::timeout(ATTESA_RISPOSTA, ricezione.read_to_end(TETTO_INTESTAZIONE))
                .await
                .map_err(|_| anyhow!("la Casa non ha risposto"))?
                .map_err(|_| anyhow!("codice non accettato"))?;
        connessione.close(0u32.into(), b"");
        let risposta: serde_json::Value =
            serde_json::from_slice(&grezzo).map_err(|_| anyhow!("codice non accettato"))?;
        if risposta.get("esito").and_then(|e| e.as_str()) != Some("ammesso") {
            bail!("codice non accettato");
        }
        let utente = risposta
            .get("utente")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        Ok((casa, utente))
    }

    /// Una richiesta dell'API dei membri. Riusa la connessione; se è caduta ne
    /// apre una nuova e riprova **una volta**, e solo se la richiesta non era
    /// partita (altrimenti un POST si farebbe due volte).
    pub async fn chiedi(
        &self,
        casa: &Casa,
        intestazione: IntestazioneRichiesta,
        corpo: Vec<u8>,
    ) -> Result<Risposta> {
        if corpo.len() > TETTO_CORPO_RICHIESTA {
            bail!("corpo oltre il tetto di {TETTO_CORPO_RICHIESTA} byte");
        }
        let cornice = incornicia(&intestazione)?;

        let mut guardia = self.connessione.lock().await;
        for tentativo in 0..2 {
            let connessione = match guardia.as_ref() {
                Some(c) if c.close_reason().is_none() => c.clone(),
                _ => {
                    let c = self.collega(casa, ALPN_DISPOSITIVO).await?;
                    *guardia = Some(c.clone());
                    c
                }
            };
            let (mut invio, mut ricezione) = match connessione.open_bi().await {
                Ok(stream) => stream,
                Err(_) if tentativo == 0 => {
                    *guardia = None;
                    continue;
                }
                Err(e) => return Err(anyhow!("stream rifiutato: {e}")),
            };
            // Da qui la richiesta è partita: niente più tentativi.
            drop(guardia);
            invio.write_all(&cornice).await?;
            invio.write_all(&corpo).await?;
            invio.finish()?;
            let grezzo = tokio::time::timeout(
                ATTESA_RISPOSTA,
                ricezione.read_to_end(4 + TETTO_INTESTAZIONE + TETTO_CORPO_RISPOSTA),
            )
            .await
            .map_err(|_| anyhow!("la Casa non ha risposto entro il tempo"))?
            .context("risposta interrotta")?;
            let (testa, corpo): (IntestazioneRisposta, _) = scomponi(&grezzo)?;
            return Ok(Risposta {
                stato: testa.stato,
                intestazioni: testa.intestazioni,
                corpo: corpo.to_vec(),
            });
        }
        bail!("la Casa non accetta la connessione")
    }

    /// Dimentica la connessione, per esempio quando la Casa cambia.
    pub async fn chiudi(&self) {
        if let Some(c) = self.connessione.lock().await.take() {
            c.close(0u32.into(), b"");
        }
    }
}
