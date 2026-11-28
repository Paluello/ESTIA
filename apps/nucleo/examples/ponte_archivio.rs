//! Il lato nucleo della prova d'archivio fra il telefono e il browser
//! (`infra/prova-archivio/prova.mjs`).
//!
//! Un [`Dispositivo`] per processo, comandato a righe JSON su stdin; ogni
//! risposta è una riga JSON su stdout. Fa ciò che farebbe l'app del telefono:
//! passa dal confine che vedono Swift e Kotlin, e quindi non vede mai una
//! chiave. I byte di MLS viaggiano in base64, come sul canale di handshake.
//!
//! I comandi `puro.*` parlano invece con [`estia_nucleo::archivio`] a chiavi
//! scoperte: servono a mettere il modulo davanti a quello del web con la stessa
//! serratura e la stessa catena, cosa che dal confine non si può chiedere.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use estia_nucleo::archivio::{self, Catena, Legame, VoceCifrata};
use estia_nucleo::deposito::{Deposito, Registro};
use estia_nucleo::mls::{Dichiarato, Dispositivo, MazzoAvvolto, Ricevuto};
use estia_nucleo::ErroreNucleo;
use serde_json::{json, Value};

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

/// Il registro dell'istanza, come lo riempie il pilota.
#[derive(Default)]
struct RegistroInMemoria(Mutex<HashMap<String, Vec<Vec<u8>>>>);

impl Registro for RegistroInMemoria {
    fn chiavi_di_firma(&self, membro: String) -> Result<Vec<Vec<u8>>, ErroreNucleo> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(&membro)
            .cloned()
            .unwrap_or_default())
    }
}

type Esito = Result<Value, String>;

fn e<E: std::fmt::Debug>(err: E) -> String {
    format!("{err:?}")
}

fn testo(v: &Value, campo: &str) -> Result<String, String> {
    v[campo]
        .as_str()
        .map(str::to_string)
        .ok_or(format!("manca {campo}"))
}

fn byte(v: &Value, campo: &str) -> Result<Vec<u8>, String> {
    STANDARD.decode(testo(v, campo)?).map_err(e)
}

fn b64(byte: &[u8]) -> String {
    STANDARD.encode(byte)
}

fn voce(v: &Value) -> Result<VoceCifrata, String> {
    Ok(VoceCifrata {
        busta: testo(v, "busta")?,
        chiave_n: v["chiaveN"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or("manca chiaveN")?,
    })
}

fn voce_fuori(voce: &VoceCifrata) -> Value {
    json!({ "busta": voce.busta, "chiaveN": voce.chiave_n })
}

/* ---------- il modulo, a chiavi scoperte ---------- */

fn catena(v: &Value) -> Result<Catena, String> {
    let chiavi = v["catena"]
        .as_array()
        .ok_or("manca catena")?
        .iter()
        .map(|c| STANDARD.decode(c.as_str().unwrap_or("")).map_err(e))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Catena::da_chiavi(chiavi))
}

fn catena_fuori(catena: &Catena) -> Value {
    json!(catena.chiavi().iter().map(|c| b64(c)).collect::<Vec<_>>())
}

/// Il legame, con i nomi dei campi che ha sul web.
fn legame(v: &Value) -> Result<Option<Legame>, String> {
    let l = &v["legame"];
    if l.is_null() {
        return Ok(None);
    }
    Ok(Some(Legame {
        conversazione_id: testo(l, "conversazioneId")?,
        id: testo(l, "id")?,
        mittente: testo(l, "mittente")?,
        creato_il: testo(l, "createdAt")?,
    }))
}

fn puro(cmd: &str, v: &Value) -> Esito {
    match cmd {
        "puro.catenaNuova" => Ok(catena_fuori(&archivio::catena_nuova().map_err(e)?)),
        "puro.catenaRuotata" => Ok(catena_fuori(
            &archivio::catena_ruotata(&catena(v)?, None).map_err(e)?,
        )),
        "puro.avvolgi" => Ok(json!(archivio::avvolgi(
            &catena(v)?,
            &byte(v, "serratura")?
        )
        .map_err(e)?)),
        "puro.svolgi" => Ok(catena_fuori(
            &archivio::svolgi(&testo(v, "mazzo")?, &byte(v, "serratura")?).map_err(e)?,
        )),
        "puro.archivia" => {
            let (catena, testo) = (catena(v)?, testo(v, "testo")?);
            let voce = match legame(v)? {
                Some(l) => archivio::archivia_legata(&catena, &testo, &l),
                None => archivio::archivia(&catena, &testo),
            };
            Ok(voce_fuori(&voce.map_err(e)?))
        }
        "puro.rileggi" => Ok(json!(archivio::rileggi(&catena(v)?, &voce(&v["voce"])?))),
        "puro.rileggiLegata" => Ok(
            match archivio::rileggi_legata(&catena(v)?, &voce(&v["voce"])?, legame(v)?.as_ref()) {
                Some(r) => json!({ "testo": r.testo, "legata": r.legata }),
                None => Value::Null,
            },
        ),
        altro => Err(format!("comando sconosciuto: {altro}")),
    }
}

/* ---------- il dispositivo, dal confine ---------- */

struct Ponte {
    deposito: Arc<DepositoInMemoria>,
    registro: Arc<RegistroInMemoria>,
    membro: Option<String>,
    io: Option<Arc<Dispositivo>>,
}

impl Ponte {
    fn io(&self) -> Result<&Dispositivo, String> {
        self.io.as_deref().ok_or("nessun dispositivo".into())
    }

    fn apri(&mut self) -> Esito {
        let membro = self.membro.clone().ok_or("nessun membro")?;
        // Prima via il vecchio: un dispositivo riaperto è un processo nuovo.
        self.io = None;
        let io =
            Dispositivo::apri(membro, self.deposito.clone(), self.registro.clone()).map_err(e)?;
        let chiave = io.chiave_di_firma();
        self.io = Some(io);
        Ok(json!({ "chiaveDiFirma": b64(&chiave) }))
    }

    fn comando(&mut self, cmd: &str, v: &Value) -> Esito {
        let conv = || testo(v, "conv");
        match cmd {
            "apri" => {
                self.membro = Some(testo(v, "membro")?);
                self.apri()
            }
            "riapri" => self.apri(),
            "registra" => {
                self.registro
                    .0
                    .lock()
                    .unwrap()
                    .entry(testo(v, "membro")?)
                    .or_default()
                    .push(byte(v, "chiave")?);
                Ok(Value::Null)
            }
            "pacchetto" => {
                let kp = self.io()?.nuovi_pacchetti(1).map_err(e)?.remove(0);
                Ok(json!({ "keyPackage": b64(&kp) }))
            }
            "crea" => self
                .io()?
                .crea_conversazione(conv()?)
                .map(|_| Value::Null)
                .map_err(e),
            "aggiungi" => {
                let r = self
                    .io()?
                    .aggiungi(conv()?, byte(v, "keyPackage")?)
                    .map_err(e)?;
                Ok(
                    json!({ "commit": b64(&r.commit), "welcome": b64(&r.welcome), "epoch": r.epoch }),
                )
            }
            "rimuovi" => {
                let r = self
                    .io()?
                    .rimuovi(conv()?, testo(v, "membro")?)
                    .map_err(e)?;
                Ok(json!({ "commit": b64(&r.commit), "epoch": r.epoch }))
            }
            "aggiorna" => {
                let r = self.io()?.aggiorna(conv()?).map_err(e)?;
                Ok(json!({ "commit": b64(&r.commit), "epoch": r.epoch }))
            }
            "entra" => Ok(json!({ "conv": self.io()?.entra(byte(v, "welcome")?).map_err(e)? })),
            "applica" => Ok(
                match self.io()?.applica(conv()?, byte(v, "busta")?).map_err(e)? {
                    Ricevuto::Commit { epoch } => json!({ "kind": "commit", "epoch": epoch }),
                    Ricevuto::Uscito => json!({ "kind": "uscito" }),
                    Ricevuto::Proposta => json!({ "kind": "proposta" }),
                    Ricevuto::Messaggio { testo, da } => {
                        json!({ "kind": "messaggio", "testo": testo, "da": da })
                    }
                },
            ),
            "epoch" => Ok(json!(self.io()?.epoch(conv()?).map_err(e)?)),
            "membri" => Ok(json!(self.io()?.membri(conv()?).map_err(e)?)),

            "haArchivio" => Ok(json!(self.io()?.ha_archivio(conv()?))),
            "mazzo" => Ok(match self.io()?.mazzo_avvolto(conv()?).map_err(e)? {
                Some(m) => json!({ "mazzo": m.mazzo, "epoch": m.epoch }),
                None => Value::Null,
            }),
            "apriMazzo" => {
                let avvolto = MazzoAvvolto {
                    mazzo: testo(v, "mazzo")?,
                    epoch: v["epoch"].as_u64().ok_or("manca epoch")?,
                };
                Ok(json!(self.io()?.apri_mazzo(conv()?, avvolto).map_err(e)?))
            }
            "archivia" => {
                let voce = self
                    .io()?
                    .archivia(
                        conv()?,
                        testo(v, "testo")?,
                        testo(v, "id")?,
                        testo(v, "creatoIl")?,
                    )
                    .map_err(e)?;
                Ok(voce_fuori(&voce))
            }
            "rileggi" => {
                let d = &v["dichiarato"];
                let dichiarato = if d.is_null() {
                    None
                } else {
                    Some(Dichiarato {
                        id: testo(d, "id")?,
                        mittente: testo(d, "mittente")?,
                        creato_il: testo(d, "creatoIl")?,
                    })
                };
                Ok(
                    match self.io()?.rileggi(conv()?, voce(&v["voce"])?, dichiarato) {
                        Some(r) => json!({ "testo": r.testo, "legata": r.legata }),
                        None => Value::Null,
                    },
                )
            }
            altro => puro(altro, v),
        }
    }
}

fn main() {
    let mut ponte = Ponte {
        deposito: Arc::default(),
        registro: Arc::default(),
        membro: None,
        io: None,
    };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for riga in stdin.lock().lines() {
        let Ok(riga) = riga else { break };
        let esito = match serde_json::from_str::<Value>(&riga) {
            Ok(v) => ponte.comando(v["cmd"].as_str().unwrap_or(""), &v),
            Err(err) => Err(e(err)),
        };
        let risposta = match esito {
            Ok(v) => json!({ "ok": v }),
            Err(err) => json!({ "errore": err }),
        };
        writeln!(stdout, "{risposta}").unwrap();
        stdout.flush().unwrap();
    }
}
