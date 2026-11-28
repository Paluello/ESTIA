//! Il filo fra il Dispositivo e la Casa: come una richiesta dell'API dei
//! membri viaggia su uno stream iroh.
//!
//! È il formato concordato con il lato Casa (`estia/dispositivo/1`):
//!
//! - **una richiesta, uno stream bidirezionale**;
//! - richiesta: 4 byte big-endian con la lunghezza di un'intestazione JSON
//!   `{"metodo","percorso","intestazioni"}`, poi il corpo grezzo fino alla
//!   fine dello stream;
//! - risposta: 4 byte big-endian con la lunghezza di `{"stato","intestazioni"}`,
//!   poi il corpo fino alla fine dello stream.
//!
//! Nessun cookie e nessuna `Authorization`: l'identità è la chiave iroh del
//! dispositivo, provata dall'handshake, e la Casa la lega alla sessione del
//! membro. Qui sta solo la forma dei byte, senza rete, perché si possa provare
//! da sola.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// L'ALPN dell'API dei membri, distinto da `estia/1` fra le Case (ADR 0044 §4).
pub const ALPN_DISPOSITIVO: &[u8] = b"estia/dispositivo/1";

/// L'ALPN dell'ingresso: l'unico che una chiave non ancora ammessa può usare,
/// e solo con un codice monouso.
pub const ALPN_INGRESSO: &[u8] = b"estia/ingresso/1";

/// Il tetto di un'intestazione, in tutte e due le direzioni.
pub const TETTO_INTESTAZIONE: usize = 64 * 1024;

/// Il tetto del corpo di una richiesta, come lo applica la Casa.
pub const TETTO_CORPO_RICHIESTA: usize = 32 * 1024 * 1024;

/// Il tetto del corpo di una risposta letta dal dispositivo. Nessuna domanda
/// senza tetto (ADR 0041): un'immagine originale sta sotto i 32 MB.
pub const TETTO_CORPO_RISPOSTA: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntestazioneRichiesta {
    pub metodo: String,
    pub percorso: String,
    #[serde(default)]
    pub intestazioni: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntestazioneRisposta {
    pub stato: u16,
    #[serde(default)]
    pub intestazioni: BTreeMap<String, String>,
}

/// Le intestazioni che il dispositivo non manda mai: l'identità è la chiave,
/// e la Casa le scarterebbe comunque.
const MAI: [&str; 3] = ["authorization", "cookie", "host"];

impl IntestazioneRichiesta {
    /// Controlla la richiesta prima che parta: solo l'API, metodi noti, nessuna
    /// credenziale.
    pub fn nuova(
        metodo: &str,
        percorso: &str,
        intestazioni: BTreeMap<String, String>,
    ) -> Result<Self> {
        let metodo = metodo.to_ascii_uppercase();
        if !matches!(
            metodo.as_str(),
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
        ) {
            bail!("metodo non ammesso: {metodo}");
        }
        if !percorso.starts_with("/api/") || percorso.contains("..") {
            bail!("solo i percorsi dell'API passano dal filo");
        }
        let intestazioni = intestazioni
            .into_iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v))
            .filter(|(k, _)| !MAI.contains(&k.as_str()))
            .collect();
        Ok(Self {
            metodo,
            percorso: percorso.to_owned(),
            intestazioni,
        })
    }
}

/// Mette davanti a un'intestazione la sua lunghezza.
pub fn incornicia<T: Serialize>(intestazione: &T) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(intestazione)?;
    if json.len() > TETTO_INTESTAZIONE {
        bail!("intestazione oltre il tetto di {TETTO_INTESTAZIONE} byte");
    }
    let mut cornice = Vec::with_capacity(4 + json.len());
    cornice.extend_from_slice(&(json.len() as u32).to_be_bytes());
    cornice.extend_from_slice(&json);
    Ok(cornice)
}

/// Separa un messaggio intero (letto fino a fine stream) in intestazione e corpo.
pub fn scomponi<T: for<'de> Deserialize<'de>>(grezzo: &[u8]) -> Result<(T, &[u8])> {
    if grezzo.len() < 4 {
        bail!("cornice troncata");
    }
    let lunghezza = u32::from_be_bytes(grezzo[..4].try_into().expect("4 byte")) as usize;
    if lunghezza > TETTO_INTESTAZIONE {
        bail!("intestazione oltre il tetto");
    }
    let resto = &grezzo[4..];
    if resto.len() < lunghezza {
        bail!("intestazione troncata");
    }
    let (json, corpo) = resto.split_at(lunghezza);
    let intestazione = serde_json::from_slice(json).context("intestazione illeggibile")?;
    Ok((intestazione, corpo))
}

/// Che cosa dice un collegamento d'ingresso, quello del QR:
/// `estia://ingresso?casa=<chiave>&codice=<codice>[&ticket=<ticket>]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollegamentoIngresso {
    pub casa: String,
    pub codice: String,
    pub ticket: Option<String>,
}

impl CollegamentoIngresso {
    pub fn leggi(testo: &str) -> Result<Self> {
        Self::leggi_con(testo, "estia://ingresso?")
    }

    /// Il QR d'invito, `estia://invito?...`: stessa forma, e il codice è
    /// quello dell'invito. Serve a chi non è ancora membro.
    pub fn leggi_invito(testo: &str) -> Result<Self> {
        Self::leggi_con(testo, "estia://invito?")
    }

    fn leggi_con(testo: &str, prefisso: &str) -> Result<Self> {
        let testo = testo.trim();
        let Some(domanda) = testo.strip_prefix(prefisso) else {
            bail!("non è un collegamento ESTIA di questo tipo");
        };
        let (mut casa, mut codice, mut ticket) = (None, None, None);
        for coppia in domanda.split('&') {
            let (k, v) = coppia.split_once('=').unwrap_or((coppia, ""));
            let v = decodifica_percento(v)?;
            match k {
                "casa" => casa = Some(v),
                "codice" => codice = Some(v),
                "ticket" if !v.is_empty() => ticket = Some(v),
                _ => {}
            }
        }
        match (casa, codice) {
            (Some(casa), Some(codice)) if !casa.is_empty() && !codice.is_empty() => Ok(Self {
                casa,
                codice,
                ticket,
            }),
            _ => bail!("al collegamento mancano la Casa o il codice"),
        }
    }
}

fn decodifica_percento(v: &str) -> Result<String> {
    let byte = v.as_bytes();
    let mut out = Vec::with_capacity(byte.len());
    let mut i = 0;
    while i < byte.len() {
        match byte[i] {
            b'%' if i + 3 <= byte.len() => {
                let h = std::str::from_utf8(&byte[i + 1..i + 3])?;
                out.push(u8::from_str_radix(h, 16).context("percento non valido")?);
                i += 3;
            }
            b'%' => bail!("percento troncato"),
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    Ok(String::from_utf8(out)?)
}

#[cfg(test)]
mod prove {
    use super::*;

    #[test]
    fn andata_e_ritorno_di_una_richiesta() {
        let intestazione = IntestazioneRichiesta::nuova(
            "post",
            "/api/v1/posts",
            BTreeMap::from([("Content-Type".into(), "application/json".into())]),
        )
        .unwrap();
        let mut filo = incornicia(&intestazione).unwrap();
        filo.extend_from_slice(b"{\"testo\":\"ciao\"}");

        let (letta, corpo): (IntestazioneRichiesta, _) = scomponi(&filo).unwrap();
        assert_eq!(letta.metodo, "POST");
        assert_eq!(letta.intestazioni["content-type"], "application/json");
        assert_eq!(corpo, b"{\"testo\":\"ciao\"}");
    }

    #[test]
    fn la_lunghezza_e_big_endian() {
        let filo = incornicia(&IntestazioneRisposta {
            stato: 204,
            intestazioni: BTreeMap::new(),
        })
        .unwrap();
        let json = br#"{"stato":204,"intestazioni":{}}"#;
        assert_eq!(&filo[..4], &(json.len() as u32).to_be_bytes());
        assert_eq!(&filo[4..], json);
    }

    #[test]
    fn le_credenziali_non_partono() {
        let intestazione = IntestazioneRichiesta::nuova(
            "GET",
            "/api/v1/auth/me",
            BTreeMap::from([
                ("Authorization".into(), "Bearer x".into()),
                ("Cookie".into(), "s=1".into()),
                ("accept".into(), "application/json".into()),
            ]),
        )
        .unwrap();
        assert_eq!(
            intestazione.intestazioni.keys().collect::<Vec<_>>(),
            vec!["accept"]
        );
    }

    #[test]
    fn solo_l_api_passa() {
        assert!(IntestazioneRichiesta::nuova("GET", "/index.html", BTreeMap::new()).is_err());
        assert!(IntestazioneRichiesta::nuova("GET", "/api/../x", BTreeMap::new()).is_err());
        assert!(IntestazioneRichiesta::nuova("TRACE", "/api/v1", BTreeMap::new()).is_err());
    }

    #[test]
    fn cornici_rotte() {
        assert!(scomponi::<IntestazioneRisposta>(&[0, 0]).is_err());
        assert!(scomponi::<IntestazioneRisposta>(&[0, 0, 0, 9, b'{']).is_err());
        let troppo = ((TETTO_INTESTAZIONE + 1) as u32).to_be_bytes();
        assert!(scomponi::<IntestazioneRisposta>(&troppo).is_err());
    }

    #[test]
    fn il_collegamento_del_qr() {
        let c = CollegamentoIngresso::leggi(
            "estia://ingresso?casa=abc123&codice=K7%2DQ2&ticket=endpointxyz",
        )
        .unwrap();
        assert_eq!(c.casa, "abc123");
        assert_eq!(c.codice, "K7-Q2");
        assert_eq!(c.ticket.as_deref(), Some("endpointxyz"));

        let senza = CollegamentoIngresso::leggi("estia://ingresso?casa=a&codice=b").unwrap();
        assert_eq!(senza.ticket, None);

        assert!(CollegamentoIngresso::leggi("https://esempio.it").is_err());
        assert!(CollegamentoIngresso::leggi("estia://ingresso?casa=a").is_err());
        let invito =
            CollegamentoIngresso::leggi_invito("estia://invito?casa=a&codice=K7Q2").unwrap();
        assert_eq!(invito.codice, "K7Q2");
        assert!(CollegamentoIngresso::leggi_invito("estia://ingresso?casa=a&codice=b").is_err());
        assert!(CollegamentoIngresso::leggi("estia://invito?casa=a&codice=b").is_err());
        assert!(CollegamentoIngresso::leggi("estia://ingresso?casa=a&codice=%2").is_err());
    }
}
