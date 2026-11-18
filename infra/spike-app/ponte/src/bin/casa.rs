//! Una Casa finta, da accendere sul NAS (o su qualunque macchina) per la prova
//! Milano–Campello. Stampa la propria chiave e aspetta.
//!
//!     casa --chiave-file casa.key --ammetti <chiave-dispositivo> [--locale]

use std::path::PathBuf;

use anyhow::{Context, Result};
use estia_ponte::{casa, chiave_da_hex, chiave_in_hex, Ammessi, Modo};
use iroh::{EndpointId, SecretKey};

fn chiave_persistente(percorso: &PathBuf) -> Result<SecretKey> {
    if let Ok(testo) = std::fs::read_to_string(percorso) {
        return chiave_da_hex(&testo);
    }
    let chiave = SecretKey::generate();
    std::fs::write(percorso, chiave_in_hex(&chiave)).context("non riesco a salvare la chiave")?;
    Ok(chiave)
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut argomenti = std::env::args().skip(1);
    let mut file = PathBuf::from("casa.key");
    let mut modo = Modo::Internet;
    let ammessi = Ammessi::default();
    while let Some(a) = argomenti.next() {
        match a.as_str() {
            "--chiave-file" => file = argomenti.next().context("manca il file")?.into(),
            "--ammetti" => {
                let chiave: EndpointId = argomenti.next().context("manca la chiave")?.parse()?;
                ammessi.ammetti(chiave);
            }
            "--locale" => modo = Modo::Locale,
            altro => anyhow::bail!("argomento sconosciuto: {altro}"),
        }
    }

    let router = casa(chiave_persistente(&file)?, modo, ammessi).await?;
    let endpoint = router.endpoint();
    if modo == Modo::Internet {
        endpoint.online().await;
    }
    println!("CASA {}", endpoint.id());
    println!("INDIRIZZO {}", serde_json::to_string(&endpoint.addr())?);
    eprintln!("In ascolto. Ctrl-C per chiudere.");
    tokio::signal::ctrl_c().await?;
    router.shutdown().await?;
    Ok(())
}
