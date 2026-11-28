//! Il lato nucleo della prova di sessione fra il telefono e il browser
//! (`infra/prova-sessione/prova.mjs`).
//!
//! Una sessione per processo: lo stesso [`Motore`] che sta dentro `Sessioni`,
//! sopra la stessa [`IstanzaSuCasa`], cioè le stesse rotte e le stesse forme
//! JSON che il nucleo manda alla Casa. Cambia soltanto il filo: al posto di
//! iroh c'è questa pipe, e dall'altra parte il pilota fa la Casa.
//!
//! Su stdin arrivano i comandi, una riga JSON ciascuno. Mentre ne esegue uno il
//! ponte può chiedere qualcosa alla Casa: scrive `{"chiedi": {...}}` su stdout
//! e legge la risposta dalla riga successiva di stdin. Alla fine risponde al
//! comando con `{"ok": ...}` o `{"errore": ...}`. Da qui non esce mai una
//! chiave: escono testo, persone e ore, come dal confine di Swift e Kotlin.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use estia_nucleo::deposito::Deposito;
use estia_nucleo::istanza::{Filo, IstanzaSuCasa, PersonaDaInvitare};
use estia_nucleo::sessione::{
    Aggiornamento, Apertura, Conversazione, Messaggio, Motore, Persona, StatoMessaggio, TipoEvento,
};
use estia_nucleo::ErroreNucleo;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

#[derive(Default)]
struct DepositoInMemoria(Mutex<HashMap<String, Vec<u8>>>);

impl Deposito for DepositoInMemoria {
    fn leggi(&self, nome: String) -> Result<Option<Vec<u8>>, ErroreNucleo> {
        Ok(self.0.lock().unwrap().get(&nome).cloned())
    }
    fn scrivi(&self, nome: String, dati: Vec<u8>) -> Result<(), ErroreNucleo> {
        self.0.lock().unwrap().insert(nome, dati);
        Ok(())
    }
}

type Righe = Arc<tokio::sync::Mutex<UnboundedReceiver<String>>>;

fn scrivi(riga: &Value) {
    let mut fuori = std::io::stdout().lock();
    writeln!(fuori, "{riga}").unwrap();
    fuori.flush().unwrap();
}

/// La Casa, dall'altra parte della pipe.
struct FiloSuPipe {
    righe: Righe,
}

impl Filo for FiloSuPipe {
    async fn chiedi(
        &self,
        metodo: &'static str,
        percorso: String,
        corpo: Option<Vec<u8>>,
    ) -> Result<(u16, Vec<u8>), ErroreNucleo> {
        let corpo = corpo.map(|c| String::from_utf8_lossy(&c).into_owned());
        // Una domanda alla volta: chi chiede aspetta la sua risposta prima che
        // un altro possa scrivere.
        let mut righe = self.righe.lock().await;
        scrivi(&json!({ "chiedi": { "metodo": metodo, "percorso": percorso, "corpo": corpo } }));
        let riga = righe
            .recv()
            .await
            .ok_or_else(|| ErroreNucleo::Rete("la pipe si è chiusa".into()))?;
        let risposta: Value =
            serde_json::from_str(&riga).map_err(|e| ErroreNucleo::Rete(e.to_string()))?;
        let stato = risposta["stato"]
            .as_u64()
            .ok_or_else(|| ErroreNucleo::Rete("risposta senza stato".into()))?;
        let corpo = risposta["corpo"].as_str().unwrap_or_default();
        Ok((stato as u16, corpo.as_bytes().to_vec()))
    }
}

type Sessione = Motore<IstanzaSuCasa<FiloSuPipe>>;
type Esito = Result<Value, String>;

fn e<E: std::fmt::Debug>(err: E) -> String {
    format!("{err:?}")
}

fn testo(v: &Value, campo: &str) -> Result<String, String> {
    v[campo]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("manca {campo}"))
}

fn da_invitare(v: &Value) -> Result<PersonaDaInvitare, String> {
    Ok(PersonaDaInvitare {
        username: testo(v, "username")?,
        casa: v["casa"].as_str().map(str::to_string),
    })
}

fn persona(p: &Persona) -> Value {
    json!({ "id": p.id, "username": p.username, "nome": p.nome, "casa": p.casa, "ruolo": p.ruolo })
}

fn conversazione(c: &Conversazione) -> Value {
    json!({
        "id": c.id,
        "gruppo": c.gruppo,
        "nome": c.nome,
        "membri": c.membri.iter().map(persona).collect::<Vec<_>>(),
        "ordinataQui": c.ordinata_qui,
        "congelata": c.congelata,
    })
}

fn apertura(a: Apertura) -> &'static str {
    match a {
        Apertura::Pronta => "pronta",
        Apertura::Tolto => "tolto",
        Apertura::InAttesa => "in-attesa",
    }
}

fn messaggio(m: &Messaggio) -> Value {
    json!({
        "id": m.id,
        "creatoIl": m.creato_il,
        "mittente": m.mittente,
        "mio": m.mio,
        "stato": match m.stato {
            StatoMessaggio::Letto => "letto",
            StatoMessaggio::NonSiApre => "non-si-apre",
            StatoMessaggio::NonDisponibile => "non-disponibile",
        },
        "testo": m.testo,
        "attestato": m.attestato,
        "risponde": m.risponde,
        "evento": m.evento.as_ref().map(|e| json!({
            "tipo": match e.tipo {
                TipoEvento::Ingresso => "ingresso",
                TipoEvento::Rimozione => "rimozione",
                TipoEvento::Uscita => "uscita",
            },
            "chi": e.chi,
        })),
    })
}

fn aggiornamento(a: &Aggiornamento) -> Value {
    json!({
        "apertura": apertura(a.apertura),
        "nuovi": a.nuovi.iter().map(messaggio).collect::<Vec<_>>(),
        "pagina": a.pagina,
        "senzaCronologia": a.senza_cronologia,
        "nonRispondono": a.non_rispondono,
        "estranei": a.estranei,
        "assenti": a.assenti,
    })
}

struct Ponte {
    righe: Righe,
    deposito: Arc<DepositoInMemoria>,
    sessione: Option<Sessione>,
}

impl Ponte {
    /// Apre la sessione sul deposito di questo processo: la prima volta crea
    /// l'identità, le altre la ritrova, come un'app che si riapre.
    async fn apri(&mut self) -> Esito {
        self.sessione = None;
        let istanza = Arc::new(IstanzaSuCasa::nuova(FiloSuPipe {
            righe: self.righe.clone(),
        }));
        let sessione = Motore::apri(istanza, self.deposito.clone())
            .await
            .map_err(e)?;
        let io = sessione.io();
        self.sessione = Some(sessione);
        Ok(json!({
            "id": io.id,
            "username": io.username,
            "casa": io.casa,
            "dispositivo": io.dispositivo,
            "approvato": io.approvato,
        }))
    }

    async fn esegui(&mut self, cmd: &str, a: &Value) -> Esito {
        if cmd == "apri" {
            return self.apri().await;
        }
        let s = self.sessione.as_ref().ok_or("la sessione non è aperta")?;
        let conv = || testo(a, "conv");
        match cmd {
            "conversazioni" => Ok(json!(s
                .conversazioni()
                .await
                .map_err(e)?
                .iter()
                .map(conversazione)
                .collect::<Vec<_>>())),
            "creaDiretta" => Ok(conversazione(
                &s.crea_diretta(da_invitare(a)?).await.map_err(e)?,
            )),
            "creaGruppo" => {
                let membri = a["membri"]
                    .as_array()
                    .ok_or("mancano i membri")?
                    .iter()
                    .map(da_invitare)
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(conversazione(
                    &s.crea_gruppo(testo(a, "nome")?, membri).await.map_err(e)?,
                ))
            }
            "apriConversazione" => Ok(json!(apertura(
                s.apri_conversazione(conv()?).await.map_err(e)?
            ))),
            "aggiorna" => Ok(aggiornamento(&s.aggiorna(conv()?).await.map_err(e)?)),
            "cronologia" => {
                let pagina = s
                    .cronologia(conv()?, a["prima"].as_str().map(str::to_string))
                    .await
                    .map_err(e)?;
                Ok(json!({
                    "messaggi": pagina.messaggi.iter().map(messaggio).collect::<Vec<_>>(),
                    "prima": pagina.prima,
                    "nonRispondono": pagina.non_rispondono,
                }))
            }
            "invia" => Ok(messaggio(
                &s.invia(
                    conv()?,
                    testo(a, "testo")?,
                    a["risponde"].as_str().map(str::to_string),
                )
                .await
                .map_err(e)?,
            )),
            "membri" => Ok(json!(s
                .membri(conv()?)
                .await
                .map_err(e)?
                .iter()
                .map(|m| json!({
                    "persona": persona(&m.persona),
                    "membro": m.membro,
                    "dispositivi": m.dispositivi,
                }))
                .collect::<Vec<_>>())),
            "aggiungiMembro" => {
                s.aggiungi_membro(conv()?, da_invitare(a)?)
                    .await
                    .map_err(e)?;
                Ok(Value::Null)
            }
            "faiEntrare" => {
                s.fai_entrare(conv()?, testo(a, "membro")?)
                    .await
                    .map_err(e)?;
                Ok(Value::Null)
            }
            "togliMembro" => {
                s.togli_membro(conv()?, testo(a, "membro")?)
                    .await
                    .map_err(e)?;
                Ok(Value::Null)
            }
            // Per la prova, non per l'app: a che epoch è il gruppo qui.
            "epoch" => Ok(json!(s.dispositivo().epoch(conv()?).map_err(e)?)),
            altro => Err(format!("comando sconosciuto: {altro}")),
        }
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let (manda, ricevi) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for riga in std::io::stdin().lock().lines() {
            let Ok(riga) = riga else { break };
            if manda.send(riga).is_err() {
                break;
            }
        }
    });

    let righe: Righe = Arc::new(tokio::sync::Mutex::new(ricevi));
    let mut ponte = Ponte {
        righe: righe.clone(),
        deposito: Arc::default(),
        sessione: None,
    };
    loop {
        // Il lucchetto si lascia prima di eseguire: le risposte della Casa
        // arrivano dalla stessa pipe.
        let riga = { righe.lock().await.recv().await };
        let Some(riga) = riga else { break };
        if riga.trim().is_empty() {
            continue;
        }
        let risposta = match serde_json::from_str::<Value>(&riga) {
            Ok(a) => {
                let cmd = a["cmd"].as_str().unwrap_or_default().to_string();
                match ponte.esegui(&cmd, &a).await {
                    Ok(v) => json!({ "ok": v }),
                    Err(errore) => json!({ "errore": errore }),
                }
            }
            Err(errore) => json!({ "errore": errore.to_string() }),
        };
        scrivi(&risposta);
    }
}
