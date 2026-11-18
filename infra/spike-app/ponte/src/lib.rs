//! Spike S6 — il collegamento fra il Dispositivo e la Casa ([ADR 0044] §4).
//!
//! È il pezzo che l'app porta in Rust nativo: un endpoint iroh che si collega
//! **per chiave** alla propria Casa, su un ALPN suo, e ci fa passare
//! richieste. Non è il codice dell'app: è quanto basta a misurare tre cose.
//!
//! 1. Che un dispositivo raggiunga la Casa da lontano, e per quale strada
//!    (diretta o via relay), con quale tempo di andata e ritorno.
//! 2. Che una chiave non registrata non riceva niente.
//! 3. Che questo iroh in Rust parli con quello della Casa vera, che usa il
//!    binding Node `@number0/iroh` 1.1.0.
//!
//! La «Casa» qui dentro è finta di proposito: risponde a `salute` e a `eco`.
//! Portare l'API vera su uno stream iroh è lavoro della milestone, non dello
//! spike.
//!
//! [ADR 0044]: ../../../docs/adr/0044-il-dispositivo-e-l-app.md

use std::{
    collections::HashSet,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use iroh::{
    endpoint::{presets, Connection},
    protocol::{AcceptError, ProtocolHandler, Router},
    Endpoint, EndpointAddr, EndpointId, SecretKey,
};
use serde::{Deserialize, Serialize};

/// L'ALPN dei dispositivi, distinto da `estia/1` della rete fra Case
/// ([ADR 0021]): la Casa sa dalla connessione con chi sta parlando.
///
/// Il nome vero si sceglie con la milestone; questo dice che è uno spike.
pub const ALPN_DISPOSITIVO: &[u8] = b"estia/dispositivo/spike-0";

/// Il tetto di una risposta letta dal dispositivo. Nessuna domanda senza tetto
/// ([ADR 0041]).
const TETTO_RISPOSTA: usize = 256 * 1024;

/// Quanto aspetta un dispositivo prima di dire «la Casa non risponde».
pub const ATTESA_COLLEGAMENTO: Duration = Duration::from_secs(30);

/// Una richiesta del dispositivo alla Casa. Nella milestone sarà l'API dei
/// membri; qui basta a misurare.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
#[serde(tag = "tipo", rename_all = "kebab-case")]
pub enum Richiesta {
    Salute,
    Eco { byte: usize },
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct Risposta {
    pub stato: u16,
    pub corpo: String,
}

/// Le chiavi che la Casa ha ammesso. Nella Casa vera è `device_keys`.
#[derive(Debug, Clone, Default)]
pub struct Ammessi(Arc<RwLock<HashSet<EndpointId>>>);

impl Ammessi {
    pub fn ammetti(&self, chiave: EndpointId) {
        self.0.write().expect("lock").insert(chiave);
    }

    pub fn contiene(&self, chiave: &EndpointId) -> bool {
        self.0.read().expect("lock").contains(chiave)
    }
}

/// Il servizio dei dispositivi, lato Casa.
#[derive(Debug, Clone)]
pub struct ServizioDispositivi {
    ammessi: Ammessi,
}

impl ServizioDispositivi {
    pub fn new(ammessi: Ammessi) -> Self {
        Self { ammessi }
    }
}

/// Il codice con cui la Casa chiude una connessione che non vuole.
///
/// È lo stesso per ogni rifiuto, senza motivo, perché ADR 0044 «Come si
/// verifica» §2 vuole che chi bussa non distingua i casi.
const CHIUSURA: u32 = 0;

impl ProtocolHandler for ServizioDispositivi {
    async fn accept(&self, connessione: Connection) -> Result<(), AcceptError> {
        // L'identità viene dall'handshake QUIC: non si dichiara, si prova.
        let chi = connessione.remote_id();
        if !self.ammessi.contiene(&chi) {
            // Nessun byte applicativo: si chiude e basta.
            connessione.close(CHIUSURA.into(), b"");
            return Ok(());
        }

        loop {
            let (mut invio, mut ricezione) = match connessione.accept_bi().await {
                Ok(stream) => stream,
                Err(_) => return Ok(()),
            };
            let grezzo = match ricezione.read_to_end(64 * 1024).await {
                Ok(grezzo) => grezzo,
                Err(_) => return Ok(()),
            };
            let risposta = match serde_json::from_slice::<Richiesta>(&grezzo) {
                Ok(Richiesta::Salute) => Risposta {
                    stato: 200,
                    corpo: "ok".into(),
                },
                Ok(Richiesta::Eco { byte }) if byte <= TETTO_RISPOSTA - 64 => Risposta {
                    stato: 200,
                    corpo: "x".repeat(byte),
                },
                Ok(Richiesta::Eco { .. }) => Risposta {
                    stato: 413,
                    corpo: String::new(),
                },
                Err(_) => Risposta {
                    stato: 400,
                    corpo: String::new(),
                },
            };
            let corpo = serde_json::to_vec(&risposta).expect("serializzabile");
            if invio.write_all(&corpo).await.is_err() || invio.finish().is_err() {
                return Ok(());
            }
        }
    }
}

/// Come si apre l'endpoint: con i server di n0 (scoperta e relay), o soltanto
/// in rete locale, senza toccare niente fuori.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modo {
    Internet,
    Locale,
}

async fn apri(chiave: SecretKey, modo: Modo, alpns: Vec<Vec<u8>>) -> Result<Endpoint> {
    let builder = match modo {
        Modo::Internet => Endpoint::builder(presets::N0),
        Modo::Locale => Endpoint::builder(presets::Minimal),
    };
    builder
        .secret_key(chiave)
        .alpns(alpns)
        .proxy_from_env()
        .bind()
        .await
        .context("l'endpoint non si apre")
}

/// Una Casa finta che ammette le chiavi date.
pub async fn casa(chiave: SecretKey, modo: Modo, ammessi: Ammessi) -> Result<Router> {
    let endpoint = apri(chiave, modo, vec![ALPN_DISPOSITIVO.to_vec()]).await?;
    Ok(Router::builder(endpoint)
        .accept(ALPN_DISPOSITIVO, ServizioDispositivi::new(ammessi))
        .spawn())
}

/// Il lato del dispositivo: un endpoint con la sua chiave di rete.
pub async fn dispositivo(chiave: SecretKey, modo: Modo) -> Result<Endpoint> {
    apri(chiave, modo, vec![]).await
}

/// Da che strada passa la connessione, adesso.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Strada {
    /// `diretta`, `relay`, o `nessuna` se non c'è un percorso scelto.
    pub tipo: String,
    /// Il relay o l'indirizzo dall'altra parte.
    pub verso: String,
    pub rtt_ms: f64,
}

pub fn strada(connessione: &Connection) -> Strada {
    let percorsi = connessione.paths();
    for percorso in &percorsi {
        if percorso.is_selected() {
            return Strada {
                tipo: if percorso.is_relay() {
                    "relay"
                } else {
                    "diretta"
                }
                .into(),
                verso: format!("{:?}", percorso.remote_addr()),
                rtt_ms: percorso.rtt().as_secs_f64() * 1000.0,
            };
        }
    }
    Strada {
        tipo: "nessuna".into(),
        verso: String::new(),
        rtt_ms: 0.0,
    }
}

/// Una domanda alla Casa, su uno stream nuovo della stessa connessione.
pub async fn chiedi(connessione: &Connection, richiesta: &Richiesta) -> Result<Risposta> {
    let (mut invio, mut ricezione) = connessione.open_bi().await.context("stream rifiutato")?;
    invio.write_all(&serde_json::to_vec(richiesta)?).await?;
    invio.finish()?;
    let grezzo = ricezione
        .read_to_end(TETTO_RISPOSTA)
        .await
        .context("la Casa non ha risposto")?;
    Ok(serde_json::from_slice(&grezzo)?)
}

/// Il resoconto di una prova di collegamento, quello che finisce nello spike.
#[derive(Debug, Clone, Serialize)]
pub struct Resoconto {
    pub casa: String,
    pub dispositivo: String,
    pub collegamento_ms: f64,
    pub strada_iniziale: Strada,
    pub strada_finale: Strada,
    pub domande: usize,
    pub andata_ritorno_ms: Vec<f64>,
    pub mediana_ms: f64,
    pub eco_64k_ms: f64,
}

fn mediana(valori: &[f64]) -> f64 {
    let mut ordinati = valori.to_vec();
    ordinati.sort_by(|a, b| a.partial_cmp(b).expect("niente NaN"));
    ordinati.get(ordinati.len() / 2).copied().unwrap_or(0.0)
}

/// Bussa alla Casa e misura. `domande` domande `salute` in fila, poi un'eco da
/// 64 kB, che è l'ordine di grandezza di un Welcome grande ([S5]).
///
/// [S5]: ../../../docs/spike/S5-quanto-pesa-un-albero.md
pub async fn bussa(
    endpoint: &Endpoint,
    casa: impl Into<EndpointAddr>,
    domande: usize,
) -> Result<Resoconto> {
    let indirizzo: EndpointAddr = casa.into();
    let id_casa = indirizzo.id;
    let inizio = Instant::now();
    let connessione = tokio::time::timeout(
        ATTESA_COLLEGAMENTO,
        endpoint.connect(indirizzo, ALPN_DISPOSITIVO),
    )
    .await
    .context("la Casa non risponde entro il tempo")?
    .context("collegamento fallito")?;
    let collegamento_ms = inizio.elapsed().as_secs_f64() * 1000.0;
    let strada_iniziale = strada(&connessione);

    let mut andata_ritorno_ms = Vec::with_capacity(domande);
    for _ in 0..domande {
        let t = Instant::now();
        let risposta = tokio::time::timeout(
            ATTESA_COLLEGAMENTO,
            chiedi(&connessione, &Richiesta::Salute),
        )
        .await
        .context("domanda senza risposta entro il tempo")??;
        if risposta.stato != 200 {
            bail!("la Casa ha risposto {}", risposta.stato);
        }
        andata_ritorno_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        // Lascia al buco nel NAT il tempo di riuscire, come farebbe un uso vero.
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let t = Instant::now();
    let eco = chiedi(&connessione, &Richiesta::Eco { byte: 64 * 1024 }).await?;
    if eco.corpo.len() != 64 * 1024 {
        bail!("eco troncata: {} byte", eco.corpo.len());
    }
    let eco_64k_ms = t.elapsed().as_secs_f64() * 1000.0;

    let resoconto = Resoconto {
        casa: id_casa.to_string(),
        dispositivo: endpoint.id().to_string(),
        collegamento_ms,
        strada_iniziale,
        strada_finale: strada(&connessione),
        domande,
        mediana_ms: mediana(&andata_ritorno_ms),
        andata_ritorno_ms,
        eco_64k_ms,
    };
    connessione.close(0u32.into(), b"");
    Ok(resoconto)
}

/// Che cosa riceve una chiave non registrata: si collega, apre uno stream,
/// chiede, e guarda che cosa torna. Il risultato giusto è «niente».
pub async fn bussa_da_estraneo(endpoint: &Endpoint, casa: impl Into<EndpointAddr>) -> String {
    let connessione = match tokio::time::timeout(
        ATTESA_COLLEGAMENTO,
        endpoint.connect(casa.into(), ALPN_DISPOSITIVO),
    )
    .await
    {
        Err(_) => return "tempo scaduto al collegamento".into(),
        Ok(Err(errore)) => return format!("collegamento rifiutato: {errore}"),
        Ok(Ok(connessione)) => connessione,
    };
    match tokio::time::timeout(
        Duration::from_secs(10),
        chiedi(&connessione, &Richiesta::Salute),
    )
    .await
    {
        Err(_) => "nessuna risposta (tempo scaduto)".into(),
        Ok(Ok(risposta)) => format!("RISPOSTA RICEVUTA: {risposta:?}"),
        Ok(Err(_)) => match connessione.close_reason() {
            Some(motivo) => format!("chiusa dalla Casa: {motivo}"),
            None => "chiusa senza motivo".into(),
        },
    }
}

/// Legge una chiave segreta da 64 caratteri esadecimali.
pub fn chiave_da_hex(testo: &str) -> Result<SecretKey> {
    let testo = testo.trim();
    if testo.len() != 64 {
        bail!("una chiave è di 64 caratteri esadecimali");
    }
    let mut byte = [0u8; 32];
    for (i, coppia) in byte.iter_mut().enumerate() {
        *coppia = u8::from_str_radix(&testo[i * 2..i * 2 + 2], 16)?;
    }
    Ok(SecretKey::from_bytes(&byte))
}

pub fn chiave_in_hex(chiave: &SecretKey) -> String {
    chiave
        .to_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
