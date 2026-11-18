//! Spike S6 — il lato Rust dell'app: cassaforte e collegamento alla Casa.
//!
//! L'interfaccia e MLS (`ts-mls`, lo stesso codice del client web) girano
//! nella WebView; qui sta quello che la WebView non può fare: tenere una chiave
//! nella cassaforte del sistema, e parlare iroh.

mod cassaforte;

use std::sync::Mutex;

use cassaforte::{Cassaforte, Stato};
use estia_ponte::{bussa as bussa_casa, dispositivo, Modo, Resoconto};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};
use serde::Serialize;
use tauri::{Manager, State};
use tokio::sync::OnceCell;

struct StatoApp {
    cassaforte: Mutex<Result<Cassaforte, String>>,
    rete: OnceCell<Endpoint>,
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
        Ok(c) => f(c).map_err(errore),
        Err(e) => Err(format!("cassaforte non disponibile: {e}")),
    }
}

#[derive(Serialize)]
struct Nativo {
    os: &'static str,
    arch: &'static str,
    cassaforte: Option<Stato>,
    errore_cassaforte: Option<String>,
}

#[tauri::command]
fn ambiente_nativo(stato: State<'_, StatoApp>) -> Nativo {
    let guardia = stato.cassaforte.lock().expect("lock");
    let (cassaforte, errore_cassaforte) = match guardia.as_ref() {
        Ok(c) => (Some(c.stato.clone()), None),
        Err(e) => (None, Some(e.clone())),
    };
    Nativo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        cassaforte,
        errore_cassaforte,
    }
}

#[tauri::command]
fn cassaforte_leggi(stato: State<'_, StatoApp>, nome: String) -> Esito<Option<String>> {
    con_cassaforte(&stato, |c| {
        Ok(c.leggi(&nome)?
            .map(|b| String::from_utf8_lossy(&b).into_owned()))
    })
}

#[tauri::command]
fn cassaforte_scrivi(stato: State<'_, StatoApp>, nome: String, valore: String) -> Esito<()> {
    con_cassaforte(&stato, |c| c.scrivi(&nome, valore.as_bytes()))
}

#[tauri::command]
fn cassaforte_svuota(stato: State<'_, StatoApp>) -> Esito<()> {
    con_cassaforte(&stato, |c| c.svuota())
}

/// I primi byte del file com'è sul disco, per far vedere che non è in chiaro.
#[tauri::command]
fn cassaforte_grezzo(stato: State<'_, StatoApp>, nome: String) -> Esito<Option<String>> {
    con_cassaforte(&stato, |c| {
        Ok(c.grezzo(&nome)?.map(|b| {
            b.iter()
                .take(48)
                .map(|x| format!("{x:02x}"))
                .collect::<String>()
                + &format!("… ({} byte)", b.len())
        }))
    })
}

const CHIAVE_DI_RETE: &str = "chiave-di-rete";

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

#[tauri::command]
fn rete_chiave(stato: State<'_, StatoApp>) -> Esito<String> {
    Ok(chiave_di_rete(&stato)?.public().to_string())
}

#[tauri::command]
async fn bussa(stato: State<'_, StatoApp>, casa: String, domande: usize) -> Esito<Resoconto> {
    let endpoint = stato
        .rete
        .get_or_try_init(|| async {
            let chiave = chiave_di_rete(&stato)?;
            dispositivo(chiave, Modo::Internet).await.map_err(errore)
        })
        .await?;
    let id: EndpointId = casa.trim().parse().map_err(errore)?;
    bussa_casa(endpoint, EndpointAddr::new(id), domande.clamp(1, 100))
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Per le prove senza mani: se `ESTIA_SONDA_USCITA` è impostata, la sonda vi
/// scrive il suo risultato e l'app si chiude.
#[tauri::command]
fn sonda_fine(app: tauri::AppHandle, risultato: String) -> Esito<bool> {
    match std::env::var("ESTIA_SONDA_USCITA") {
        Ok(percorso) => {
            std::fs::write(percorso, risultato).map_err(errore)?;
            app.exit(0);
            Ok(true)
        }
        Err(_) => Ok(false),
    }
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
            ambiente_nativo,
            cassaforte_leggi,
            cassaforte_scrivi,
            cassaforte_svuota,
            cassaforte_grezzo,
            rete_chiave,
            bussa,
            sonda_fine
        ])
        .run(tauri::generate_context!())
        .expect("l'app non parte");
}
