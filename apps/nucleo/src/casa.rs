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
use crate::rete::{Casa, EsitoRichiesta, Rete};
use crate::ErroreNucleo;

const NOME_CHIAVE: &str = "nucleo/chiave-di-rete";
const NOME_CASA: &str = "nucleo/casa";
/// La Casa a cui si è chiesto di entrare con un invito, finché non decide.
const NOME_IN_ATTESA: &str = "nucleo/casa-in-attesa";

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

/// Chi chiede di entrare con un invito: è la richiesta del modulo web.
#[derive(uniffi::Record)]
pub struct DomandaDiEntrare {
    pub username: String,
    pub password: String,
    pub nome: Option<String>,
    /// Una riga per l'amministratore: «sono del secondo piano».
    pub messaggio: Option<String>,
}

#[derive(uniffi::Object)]
pub struct Collegamento {
    rete: Rete,
    deposito: Arc<dyn Deposito>,
    casa: Mutex<Option<Casa>>,
    in_attesa: Mutex<Option<Casa>>,
}

fn leggi_casa(deposito: &Arc<dyn Deposito>, nome: &str) -> Result<Option<Casa>, ErroreNucleo> {
    match deposito.leggi(nome.into())? {
        Some(byte) if !byte.is_empty() => {
            Ok(Some(serde_json::from_slice(&byte).map_err(|_| {
                ErroreNucleo::Deposito("Casa ricordata illeggibile".into())
            })?))
        }
        _ => Ok(None),
    }
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
        let casa = leggi_casa(&deposito, NOME_CASA)?;
        let in_attesa = leggi_casa(&deposito, NOME_IN_ATTESA)?;
        let rete = Rete::apri(chiave)
            .await
            .map_err(|e| rete(format!("{e:#}")))?;
        Ok(Arc::new(Collegamento {
            rete,
            deposito,
            casa: Mutex::new(casa),
            in_attesa: Mutex::new(in_attesa),
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
            .map_err(|e| {
                // `Rete::entra` chiama così ogni rifiuto della Casa, e
                // altrimenti è la rete che non arriva.
                let testo = format!("{e:#}");
                if testo.contains("codice non accettato") {
                    ErroreNucleo::CodiceNonAccettato
                } else {
                    rete(testo)
                }
            })?;
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

    /// Chi non è ancora membro chiede di entrare con il QR d'invito
    /// (`estia://invito?...`). Ritorna l'id della richiesta, che decide
    /// l'amministratore; finché non decide, [`Self::controlla_richiesta`] dice
    /// se questa chiave è già dentro. Se l'amministratore approva, è **questa
    /// chiave** a entrare: niente secondo QR.
    pub async fn chiedi_di_entrare(
        &self,
        collegamento: String,
        domanda: DomandaDiEntrare,
        etichetta: String,
    ) -> Result<String, ErroreNucleo> {
        let collegamento = CollegamentoIngresso::leggi_invito(&collegamento)
            .map_err(|e| ErroreNucleo::Formato(e.to_string()))?;
        let mut invito = serde_json::json!({
            "codice": collegamento.codice,
            "username": domanda.username.trim().to_lowercase(),
            "password": domanda.password,
        });
        if let Some(nome) = domanda.nome.filter(|n| !n.trim().is_empty()) {
            invito["displayName"] = nome.trim().into();
        }
        if let Some(messaggio) = domanda.messaggio.filter(|m| !m.trim().is_empty()) {
            invito["message"] = messaggio.trim().into();
        }
        let (casa, esito) = self
            .rete
            .chiedi_con_invito(&collegamento, invito, etichetta.trim())
            .await
            .map_err(|e| {
                let testo = format!("{e:#}");
                if testo.contains("invito non accettato") {
                    ErroreNucleo::InvitoNonAccettato
                } else {
                    rete(testo)
                }
            })?;
        match esito {
            EsitoRichiesta::Inviata(id) => {
                let byte = serde_json::to_vec(&casa).map_err(rete)?;
                self.deposito.scrivi(NOME_IN_ATTESA.into(), byte)?;
                *self.in_attesa.lock().unwrap() = Some(casa);
                Ok(id)
            }
            EsitoRichiesta::Rifiutata(codice) => Err(ErroreNucleo::Casa { stato: 409, codice }),
        }
    }

    /// La Casa a cui si è chiesto di entrare e che non ha ancora deciso.
    pub fn in_attesa(&self) -> Option<String> {
        self.in_attesa
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| c.chiave.clone())
    }

    /// Se l'amministratore ha detto di sì: la chiave apre l'API dei membri, e
    /// da qui la Casa è quella di sempre. `None` finché non apre niente — la
    /// Casa non dice se ha rifiutato o se non ha ancora deciso.
    pub async fn controlla_richiesta(&self) -> Result<Option<Ingresso>, ErroreNucleo> {
        let casa = self
            .in_attesa
            .lock()
            .unwrap()
            .clone()
            .ok_or(ErroreNucleo::NessunaCasa)?;
        let intestazione = IntestazioneRichiesta::nuova("GET", "/api/v1/auth/me", BTreeMap::new())
            .map_err(|e| ErroreNucleo::Formato(e.to_string()))?;
        let risposta = match self.rete.chiedi(&casa, intestazione, Vec::new()).await {
            Ok(r) if r.stato == 200 => r,
            _ => {
                self.rete.chiudi().await;
                return Ok(None);
            }
        };
        let byte = serde_json::to_vec(&casa).map_err(rete)?;
        self.deposito.scrivi(NOME_CASA.into(), byte)?;
        self.deposito.scrivi(NOME_IN_ATTESA.into(), Vec::new())?;
        let chiave = casa.chiave.clone();
        *self.casa.lock().unwrap() = Some(casa);
        *self.in_attesa.lock().unwrap() = None;
        Ok(Some(Ingresso {
            casa: chiave,
            utente: String::from_utf8_lossy(&risposta.corpo).into_owned(),
        }))
    }

    /// Ritira la domanda da questo dispositivo: non la cancella dalla Casa,
    /// smette soltanto di aspettarla.
    pub fn dimentica_richiesta(&self) -> Result<(), ErroreNucleo> {
        self.deposito.scrivi(NOME_IN_ATTESA.into(), Vec::new())?;
        *self.in_attesa.lock().unwrap() = None;
        Ok(())
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
