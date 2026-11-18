//! Il dispositivo che bussa alla Casa e misura.
//!
//!     bussa --chiave-file dispositivo.key --casa <chiave-casa> [--domande 20]
//!     bussa --chiave-file dispositivo.key --solo-chiave    (stampa la chiave da ammettere)
//!     bussa --estraneo --casa <chiave-casa>                (una chiave nuova, non ammessa)
//!
//! `--casa` accetta la chiave nuda (la trova la scoperta di n0) o l'indirizzo
//! JSON stampato da `casa`, che serve in `--locale`.

use std::path::PathBuf;

use anyhow::{Context, Result};
use estia_ponte::{bussa, bussa_da_estraneo, chiave_da_hex, chiave_in_hex, dispositivo, Modo};
use iroh::{EndpointAddr, EndpointId, SecretKey};

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
    let mut file = PathBuf::from("dispositivo.key");
    let mut casa: Option<String> = None;
    let mut domande = 20;
    let mut modo = Modo::Internet;
    let mut estraneo = false;
    let mut solo_chiave = false;
    while let Some(a) = argomenti.next() {
        match a.as_str() {
            "--chiave-file" => file = argomenti.next().context("manca il file")?.into(),
            "--casa" => casa = argomenti.next(),
            "--domande" => domande = argomenti.next().context("manca il numero")?.parse()?,
            "--locale" => modo = Modo::Locale,
            "--estraneo" => estraneo = true,
            "--solo-chiave" => solo_chiave = true,
            altro => anyhow::bail!("argomento sconosciuto: {altro}"),
        }
    }

    let chiave = if estraneo {
        SecretKey::generate()
    } else {
        chiave_persistente(&file)?
    };
    if solo_chiave {
        println!("{}", chiave.public());
        return Ok(());
    }

    let casa = casa.context("serve --casa")?;
    let indirizzo: EndpointAddr = if casa.trim_start().starts_with('{') {
        serde_json::from_str(&casa)?
    } else {
        EndpointAddr::new(casa.parse::<EndpointId>()?)
    };

    let endpoint = dispositivo(chiave, modo).await?;
    if estraneo {
        println!("{}", bussa_da_estraneo(&endpoint, indirizzo).await);
    } else {
        let resoconto = bussa(&endpoint, indirizzo, domande).await?;
        println!("{}", serde_json::to_string_pretty(&resoconto)?);
    }
    endpoint.close().await;
    Ok(())
}
