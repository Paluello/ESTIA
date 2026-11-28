//! Il collegamento con la Casa, per Swift e Kotlin.
//!
//! È quello che `apps/app/src-tauri/src/lib.rs` fa per la WebView, senza la
//! WebView: la chiave di rete nasce qui e si custodisce nel [`Deposito`], la
//! Casa si ricorda dopo l'ingresso, e ogni richiesta dell'API dei membri va sul
//! filo `estia/dispositivo/1` ([`crate::filo`]).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use iroh::SecretKey;

use crate::deposito::Deposito;
use crate::filo::{CollegamentoIngresso, IntestazioneRichiesta};
use crate::rete::{Casa, Rete};
use crate::ErroreNucleo;

const NOME_CHIAVE: &str = "nucleo/chiave-di-rete";
const NOME_CASA: &str = "nucleo/casa";

fn rete<E: std::fmt::Display>(e: E) -> ErroreNucleo {
    ErroreNucleo::Rete(e.to_string())
}

/// Una risposta della Casa.
#[derive(uniffi::Record)]
pub struct RispostaCasa {
    pub stato: u16,
    pub intestazioni: HashMap<String, String>,
    pub corpo: Vec<u8>,
}

/// L'esito di un ingresso riuscito.
#[derive(uniffi::Record)]
pub struct Ingresso {
    /// La chiave pubblica della Casa.
    pub casa: String,
    /// L'utente, come la Casa lo descrive, in JSON.
    pub utente: String,
}

#[derive(uniffi::Object)]
pub struct Collegamento {
    rete: Rete,
    deposito: Arc<dyn Deposito>,
    casa: Mutex<Option<Casa>>,
}

#[uniffi::export(async_runtime = "tokio")]
impl Collegamento {
    /// Apre l'endpoint con la chiave di rete del dispositivo, creandola la
    /// prima volta. Il dispositivo bussa e non ascolta.
    #[uniffi::constructor]
    pub async fn apri(deposito: Arc<dyn Deposito>) -> Result<Arc<Self>, ErroreNucleo> {
        let chiave = match deposito.leggi(NOME_CHIAVE.into())? {
            Some(byte) => {
                let byte: [u8; 32] = byte
                    .try_into()
                    .map_err(|_| ErroreNucleo::Deposito("chiave di rete rotta".into()))?;
                SecretKey::from_bytes(&byte)
            }
            None => {
                let chiave = SecretKey::generate();
                deposito.scrivi(NOME_CHIAVE.into(), chiave.to_bytes().to_vec())?;
                chiave
            }
        };
        let casa = match deposito.leggi(NOME_CASA.into())? {
            Some(byte) if !byte.is_empty() => Some(
                serde_json::from_slice(&byte)
                    .map_err(|_| ErroreNucleo::Deposito("Casa ricordata illeggibile".into()))?,
            ),
            _ => None,
        };
        let rete = Rete::apri(chiave)
            .await
            .map_err(|e| rete(format!("{e:#}")))?;
        Ok(Arc::new(Collegamento {
            rete,
            deposito,
            casa: Mutex::new(casa),
        }))
    }

    /// La chiave pubblica del dispositivo: è quella che la Casa ammette.
    pub fn chiave_pubblica(&self) -> String {
        self.rete.chiave_pubblica()
    }

    /// La chiave della Casa, se il dispositivo ci è già entrato.
    pub fn casa(&self) -> Option<String> {
        self.casa.lock().unwrap().as_ref().map(|c| c.chiave.clone())
    }

    /// L'ingresso con il collegamento del QR (`estia://ingresso?...`). Se la
    /// Casa accetta, la si ricorda. Un rifiuto non dice il motivo, perché la
    /// Casa non lo dice.
    pub async fn entra(
        &self,
        collegamento: String,
        etichetta: String,
    ) -> Result<Ingresso, ErroreNucleo> {
        let collegamento = CollegamentoIngresso::leggi(&collegamento)
            .map_err(|e| ErroreNucleo::Formato(e.to_string()))?;
        let (casa, utente) = self
            .rete
            .entra(&collegamento, etichetta.trim())
            .await
            .map_err(|e| rete(format!("{e:#}")))?;
        let byte = serde_json::to_vec(&casa).map_err(rete)?;
        self.deposito.scrivi(NOME_CASA.into(), byte)?;
        self.rete.chiudi().await;
        let chiave = casa.chiave.clone();
        *self.casa.lock().unwrap() = Some(casa);
        Ok(Ingresso {
            casa: chiave,
            utente: utente.to_string(),
        })
    }

    /// Esce dalla Casa: la dimentica, non dimentica la chiave. La revoca vera
    /// la fa la Casa (ADR 0040).
    pub async fn dimentica_casa(&self) -> Result<(), ErroreNucleo> {
        self.rete.chiudi().await;
        self.deposito.scrivi(NOME_CASA.into(), Vec::new())?;
        *self.casa.lock().unwrap() = None;
        Ok(())
    }

    /// Una richiesta dell'API dei membri. Niente cookie né `Authorization`:
    /// l'identità è la chiave del dispositivo.
    pub async fn chiedi(
        &self,
        metodo: String,
        percorso: String,
        intestazioni: HashMap<String, String>,
        corpo: Vec<u8>,
    ) -> Result<RispostaCasa, ErroreNucleo> {
        let casa = self
            .casa
            .lock()
            .unwrap()
            .clone()
            .ok_or(ErroreNucleo::NessunaCasa)?;
        let intestazioni: BTreeMap<String, String> = intestazioni.into_iter().collect();
        let intestazione = IntestazioneRichiesta::nuova(&metodo, &percorso, intestazioni)
            .map_err(|e| ErroreNucleo::Formato(e.to_string()))?;
        let risposta = self
            .rete
            .chiedi(&casa, intestazione, corpo)
            .await
            .map_err(|e| rete(format!("{e:#}")))?;
        Ok(RispostaCasa {
            stato: risposta.stato,
            intestazioni: risposta.intestazioni.into_iter().collect(),
            corpo: risposta.corpo,
        })
    }
}
