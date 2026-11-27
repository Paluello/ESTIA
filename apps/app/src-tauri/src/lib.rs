//! L'app ESTIA: il Dispositivo di [ADR 0044].
//!
//! L'interfaccia è il client web (`apps/web`), compreso il codice MLS
//! (`ts-mls`), e gira nella WebView. Qui sta quello che la WebView non può
//! fare da sola:
//!
//! - **la cassaforte** ([`cassaforte`]): una chiave nella cassaforte del
//!   sistema, e i segreti del dispositivo sigillati con quella;
//! - **la rete** ([`rete`]): iroh, per chiave, solo verso la propria Casa;
//! - **il filo** ([`filo`]): come una richiesta dell'API viaggia su uno stream.
//!
//! [ADR 0044]: ../../../../docs/adr/0044-il-dispositivo-e-l-app.md

mod cassaforte;
mod filo;
mod rete;

use std::{collections::BTreeMap, sync::Mutex};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use cassaforte::{Cassaforte, Stato};
use filo::{CollegamentoIngresso, IntestazioneRichiesta};
use iroh::SecretKey;
use rete::{Casa, Rete};
use serde::Serialize;
use tauri::{Manager, State};
use tokio::sync::OnceCell;

struct StatoApp {
    cassaforte: Mutex<Result<Cassaforte, String>>,
    rete: OnceCell<Rete>,
}

type Esito<T> = Result<T, String>;

fn errore(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn con_cassaforte<T>(
    stato: &State<'_, StatoApp>,
    f: impl FnOnce(&Cassaforte) -> anyhow::Result<T>,
) -> Esito<T> {
    let guardia = stato.cassaforte.lock().map_err(errore)?;
    match guardia.as_ref() {
        Ok(c) => f(c).map_err(|e| format!("{e:#}")),
        Err(e) => Err(format!("cassaforte non disponibile: {e}")),
    }
}

/// I nomi che la cassaforte riserva al lato nativo. La WebView non li legge e
/// non li scrive: il cassetto MLS ha il suo prefisso.
const CHIAVE_DI_RETE: &str = "nativo/chiave-di-rete";
const CASA: &str = "nativo/casa";

fn riservato(nome: &str) -> Esito<()> {
    if nome.starts_with("nativo/") {
        return Err("nome riservato".into());
    }
    Ok(())
}

/// La chiave di rete (ADR 0044 §2): si crea una volta, si custodisce sigillata.
fn chiave_di_rete(stato: &State<'_, StatoApp>) -> Esito<SecretKey> {
    con_cassaforte(stato, |c| {
        if let Some(byte) = c.leggi(CHIAVE_DI_RETE)? {
            let byte: [u8; 32] = byte
                .try_into()
                .map_err(|_| anyhow::anyhow!("chiave di rete rotta"))?;
            return Ok(SecretKey::from_bytes(&byte));
        }
        let chiave = SecretKey::generate();
        c.scrivi(CHIAVE_DI_RETE, &chiave.to_bytes())?;
        Ok(chiave)
    })
}

async fn rete<'a>(stato: &'a State<'_, StatoApp>) -> Esito<&'a Rete> {
    stato
        .rete
        .get_or_try_init(|| async {
            let chiave = chiave_di_rete(stato)?;
            Rete::apri(chiave).await.map_err(|e| format!("{e:#}"))
        })
        .await
}

fn casa(stato: &State<'_, StatoApp>) -> Esito<Option<Casa>> {
    con_cassaforte(stato, |c| match c.leggi(CASA)? {
        Some(byte) => Ok(Some(serde_json::from_slice(&byte)?)),
        None => Ok(None),
    })
}

#[derive(Serialize)]
struct Ambiente {
    os: &'static str,
    arch: &'static str,
    versione: &'static str,
    cassaforte: Option<Stato>,
    errore_cassaforte: Option<String>,
    /// La chiave pubblica della Casa, se il dispositivo è già entrato.
    casa: Option<String>,
}

/// Che cosa l'interfaccia deve sapere all'avvio: se c'è una Casa, e se la
/// cassaforte si è aperta.
#[tauri::command]
fn ambiente(stato: State<'_, StatoApp>) -> Ambiente {
    let (cassaforte, errore_cassaforte) = match stato.cassaforte.lock() {
        Ok(g) => match g.as_ref() {
            Ok(c) => (Some(c.stato.clone()), None),
            Err(e) => (None, Some(e.clone())),
        },
        Err(e) => (None, Some(e.to_string())),
    };
    Ambiente {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        versione: env!("CARGO_PKG_VERSION"),
        cassaforte,
        errore_cassaforte,
        casa: casa(&stato).ok().flatten().map(|c| c.chiave),
    }
}

#[tauri::command]
fn cassaforte_leggi(stato: State<'_, StatoApp>, nome: String) -> Esito<Option<String>> {
    riservato(&nome)?;
    con_cassaforte(&stato, |c| {
        Ok(c.leggi(&nome)?
            .map(|b| String::from_utf8_lossy(&b).into_owned()))
    })
}

#[tauri::command]
fn cassaforte_scrivi(stato: State<'_, StatoApp>, nome: String, valore: String) -> Esito<()> {
    riservato(&nome)?;
    con_cassaforte(&stato, |c| c.scrivi(&nome, valore.as_bytes()))
}

#[tauri::command]
fn cassaforte_svuota(stato: State<'_, StatoApp>, prefisso: String) -> Esito<()> {
    if prefisso.is_empty() {
        return Err("serve un prefisso".into());
    }
    riservato(&prefisso)?;
    con_cassaforte(&stato, |c| c.svuota(&prefisso))
}

/// La chiave di rete pubblica di questo dispositivo.
#[tauri::command]
async fn rete_chiave(stato: State<'_, StatoApp>) -> Esito<String> {
    Ok(rete(&stato).await?.chiave_pubblica())
}

/// L'ingresso con il collegamento del QR. Se la Casa accetta, la si ricorda.
#[tauri::command]
async fn ingresso(
    stato: State<'_, StatoApp>,
    collegamento: String,
    etichetta: String,
) -> Esito<serde_json::Value> {
    let collegamento = CollegamentoIngresso::leggi(&collegamento).map_err(errore)?;
    let rete = rete(&stato).await?;
    let (casa, utente) = rete
        .entra(&collegamento, etichetta.trim())
        .await
        .map_err(|e| format!("{e:#}"))?;
    let byte = serde_json::to_vec(&casa).map_err(errore)?;
    con_cassaforte(&stato, |c| c.scrivi(CASA, &byte))?;
    rete.chiudi().await;
    Ok(utente)
}

/// Il dispositivo esce dalla Casa: dimentica la Casa, non la chiave. La revoca
/// vera la fa la Casa (ADR 0040).
#[tauri::command]
async fn dimentica_casa(stato: State<'_, StatoApp>) -> Esito<()> {
    if let Some(rete) = stato.rete.get() {
        rete.chiudi().await;
    }
    con_cassaforte(&stato, |c| c.cancella(CASA))
}

#[derive(Serialize)]
struct RispostaWeb {
    stato: u16,
    intestazioni: BTreeMap<String, String>,
    /// Il corpo in base64: un comando Tauri viaggia in JSON.
    corpo: String,
}

/// Una richiesta dell'API dei membri, sul filo verso la Casa. È quello che il
/// client web chiama al posto di `fetch` quando gira nell'app.
#[tauri::command]
async fn richiesta(
    stato: State<'_, StatoApp>,
    metodo: String,
    percorso: String,
    intestazioni: BTreeMap<String, String>,
    corpo: Option<String>,
) -> Esito<RispostaWeb> {
    let casa = casa(&stato)?.ok_or("il dispositivo non è ancora entrato in una Casa")?;
    let intestazione =
        IntestazioneRichiesta::nuova(&metodo, &percorso, intestazioni).map_err(errore)?;
    let corpo = match corpo {
        Some(b) => B64.decode(b).map_err(errore)?,
        None => Vec::new(),
    };
    let risposta = rete(&stato)
        .await?
        .chiedi(&casa, intestazione, corpo)
        .await
        .map_err(|e| format!("{e:#}"))?;
    Ok(RispostaWeb {
        stato: risposta.stato,
        intestazioni: risposta.intestazioni,
        corpo: B64.encode(risposta.corpo),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let cassaforte = app
                .path()
                .app_data_dir()
                .map_err(errore)
                .and_then(|dir| Cassaforte::apri(&dir).map_err(|e| format!("{e:#}")));
            app.manage(StatoApp {
                cassaforte: Mutex::new(cassaforte),
                rete: OnceCell::new(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ambiente,
            cassaforte_leggi,
            cassaforte_scrivi,
            cassaforte_svuota,
            rete_chiave,
            ingresso,
            dimentica_casa,
            richiesta
        ])
        .run(tauri::generate_context!())
        .expect("l'app non parte");
}
