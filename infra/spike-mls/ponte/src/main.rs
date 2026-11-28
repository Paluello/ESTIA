//! S7: il lato OpenMLS della prova di interoperabilità con `ts-mls`.
//!
//! Un membro MLS per processo, comandato a righe JSON su stdin; ogni risposta è
//! una riga JSON su stdout. I byte viaggiano in esadecimale e sono sempre
//! `MLSMessage` di RFC 9420, cioè quello che il filo di ESTIA porta davvero.
//! Il pilota (`../prova.mjs`) fa parlare questo processo con dei client
//! `ts-mls` nella stessa conversazione.

use std::io::{BufRead, Write};

use openmls::prelude::tls_codec::{Deserialize, Serialize};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use serde_json::{json, Value};

const CS: Ciphersuite = Ciphersuite::MLS_128_DHKEMP256_AES128GCM_SHA256_P256;
const ETICHETTA_ARCHIVIO: &str = "estia archive wrap v1";

struct Membro {
    provider: OpenMlsRustCrypto,
    firma: Option<SignatureKeyPair>,
    credenziale: Option<CredentialWithKey>,
    gruppo: Option<MlsGroup>,
}

type Esito = Result<Value, String>;

fn e<E: std::fmt::Debug>(err: E) -> String {
    format!("{err:?}")
}

fn esa(v: &Value, campo: &str) -> Result<Vec<u8>, String> {
    let s = v[campo].as_str().ok_or(format!("manca {campo}"))?;
    hex::decode(s).map_err(e)
}

fn fuori(m: &MlsMessageOut) -> Result<String, String> {
    Ok(hex::encode(m.tls_serialize_detached().map_err(e)?))
}

fn dentro(bytes: &[u8]) -> Result<MlsMessageBodyIn, String> {
    Ok(MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(e)?
        .extract())
}

fn config_creazione() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .ciphersuite(CS)
        .use_ratchet_tree_extension(true)
        .wire_format_policy(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .build()
}

fn config_ingresso() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .wire_format_policy(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .build()
}

impl Membro {
    fn gruppo(&mut self) -> Result<&mut MlsGroup, String> {
        self.gruppo.as_mut().ok_or("nessun gruppo".into())
    }

    fn firma(&self) -> Result<&SignatureKeyPair, String> {
        self.firma.as_ref().ok_or("nessuna identità".into())
    }

    fn identita(&mut self, v: &Value) -> Esito {
        let membro = v["membro"].as_str().ok_or("manca membro")?;
        let firma = SignatureKeyPair::new(CS.signature_algorithm()).map_err(e)?;
        firma.store(self.provider.storage()).map_err(e)?;
        let credenziale = CredentialWithKey {
            credential: BasicCredential::new(membro.as_bytes().to_vec()).into(),
            signature_key: firma.public().into(),
        };
        self.firma = Some(firma);
        self.credenziale = Some(credenziale);
        self.pacchetto()
    }

    /// Un `KeyPackage` nuovo, sulla stessa chiave di firma.
    fn pacchetto(&mut self) -> Esito {
        let firma = self.firma()?;
        let pacchetto = KeyPackage::builder()
            .build(CS, &self.provider, firma, self.credenziale.clone().unwrap())
            .map_err(e)?;
        let msg = MlsMessageOut::from(pacchetto.key_package().clone());
        Ok(json!({ "keyPackage": fuori(&msg)? }))
    }

    fn crea(&mut self, v: &Value) -> Esito {
        let id = v["gruppo"].as_str().ok_or("manca gruppo")?;
        let gruppo = MlsGroup::new_with_group_id(
            &self.provider,
            self.firma()?,
            &config_creazione(),
            GroupId::from_slice(id.as_bytes()),
            self.credenziale.clone().unwrap(),
        )
        .map_err(e)?;
        self.gruppo = Some(gruppo);
        self.stato()
    }

    fn aggiungi(&mut self, v: &Value) -> Esito {
        let MlsMessageBodyIn::KeyPackage(kp) = dentro(&esa(v, "keyPackage")?)? else {
            return Err("non è un KeyPackage".into());
        };
        let kp = kp
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(e)?;
        let firma = self.firma.take().unwrap();
        let provider = &self.provider;
        let gruppo = self.gruppo.as_mut().ok_or("nessun gruppo")?;
        let esito = gruppo.add_members(provider, &firma, &[kp]);
        self.firma = Some(firma);
        let (commit, welcome, _) = esito.map_err(e)?;
        self.gruppo
            .as_mut()
            .unwrap()
            .merge_pending_commit(&self.provider)
            .map_err(e)?;
        Ok(
            json!({ "commit": fuori(&commit)?, "welcome": fuori(&welcome)?, "epoch": self.gruppo()?.epoch().as_u64() }),
        )
    }

    fn rimuovi(&mut self, v: &Value) -> Esito {
        let chi = v["membro"].as_str().ok_or("manca membro")?;
        let indice = self
            .gruppo()?
            .members()
            .find(|m| m.credential.serialized_content() == chi.as_bytes())
            .ok_or("membro non trovato")?
            .index;
        let firma = self.firma.take().unwrap();
        let provider = &self.provider;
        let esito = self
            .gruppo
            .as_mut()
            .unwrap()
            .remove_members(provider, &firma, &[indice]);
        self.firma = Some(firma);
        let (commit, _, _) = esito.map_err(e)?;
        self.gruppo
            .as_mut()
            .unwrap()
            .merge_pending_commit(&self.provider)
            .map_err(e)?;
        Ok(json!({ "commit": fuori(&commit)?, "epoch": self.gruppo()?.epoch().as_u64() }))
    }

    fn aggiorna(&mut self) -> Esito {
        let firma = self.firma.take().unwrap();
        let provider = &self.provider;
        let esito = self.gruppo.as_mut().ok_or("nessun gruppo")?.self_update(
            provider,
            &firma,
            LeafNodeParameters::default(),
        );
        self.firma = Some(firma);
        let commit = esito.map_err(e)?.into_contents().0;
        self.gruppo
            .as_mut()
            .unwrap()
            .merge_pending_commit(&self.provider)
            .map_err(e)?;
        Ok(json!({ "commit": fuori(&commit)?, "epoch": self.gruppo()?.epoch().as_u64() }))
    }

    fn entra(&mut self, v: &Value) -> Esito {
        let MlsMessageBodyIn::Welcome(welcome) = dentro(&esa(v, "welcome")?)? else {
            return Err("non è un Welcome".into());
        };
        let gruppo =
            StagedWelcome::new_from_welcome(&self.provider, &config_ingresso(), welcome, None)
                .map_err(e)?
                .into_group(&self.provider)
                .map_err(e)?;
        self.gruppo = Some(gruppo);
        self.stato()
    }

    fn punto(&mut self) -> Esito {
        let firma = self.firma.take().unwrap();
        let esito = self
            .gruppo
            .as_ref()
            .ok_or("nessun gruppo")?
            .export_group_info(self.provider.crypto(), &firma, true);
        self.firma = Some(firma);
        Ok(json!({ "groupInfo": fuori(&esito.map_err(e)?)? }))
    }

    fn rientra(&mut self, v: &Value) -> Esito {
        let MlsMessageBodyIn::GroupInfo(gi) = dentro(&esa(v, "groupInfo")?)? else {
            return Err("non è un GroupInfo".into());
        };
        let firma = self.firma.take().unwrap();
        let esito = MlsGroup::external_commit_builder()
            .with_config(config_ingresso())
            .build_group(&self.provider, gi, self.credenziale.clone().unwrap())
            .map_err(e)
            .and_then(|b| b.load_psks(self.provider.storage()).map_err(e))
            .and_then(|b| {
                b.build(self.provider.rand(), self.provider.crypto(), &firma, |_| {
                    true
                })
                .map_err(e)
            })
            .and_then(|b| b.finalize(&self.provider).map_err(e));
        self.firma = Some(firma);
        let (gruppo, bundle) = esito?;
        let commit = bundle.into_contents().0;
        self.gruppo = Some(gruppo);
        Ok(json!({ "commit": fuori(&commit)?, "epoch": self.gruppo()?.epoch().as_u64() }))
    }

    fn cifra(&mut self, v: &Value) -> Esito {
        let testo = v["testo"].as_str().ok_or("manca testo")?;
        let firma = self.firma.take().unwrap();
        let provider = &self.provider;
        let esito = self.gruppo.as_mut().ok_or("nessun gruppo")?.create_message(
            provider,
            &firma,
            testo.as_bytes(),
        );
        self.firma = Some(firma);
        Ok(json!({ "busta": fuori(&esito.map_err(e)?)? }))
    }

    fn applica(&mut self, v: &Value) -> Esito {
        let messaggio = MlsMessageIn::tls_deserialize_exact(esa(v, "busta")?.as_slice())
            .map_err(e)?
            .try_into_protocol_message()
            .map_err(e)?;
        let provider = &self.provider;
        let gruppo = self.gruppo.as_mut().ok_or("nessun gruppo")?;
        let elaborato = gruppo.process_message(provider, messaggio).map_err(e)?;
        let mittente = elaborato.credential().serialized_content().to_vec();
        match elaborato.into_content() {
            ProcessedMessageContent::ApplicationMessage(m) => Ok(json!({
                "kind": "messaggio",
                "testo": String::from_utf8(m.into_bytes()).map_err(e)?,
                "da": String::from_utf8_lossy(&mittente),
            })),
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                gruppo.merge_staged_commit(provider, *staged).map_err(e)?;
                Ok(json!({ "kind": "commit", "epoch": gruppo.epoch().as_u64() }))
            }
            ProcessedMessageContent::ProposalMessage(p) => {
                gruppo
                    .store_pending_proposal(provider.storage(), *p)
                    .map_err(e)?;
                Ok(json!({ "kind": "proposta" }))
            }
            ProcessedMessageContent::OwnPendingCommit
            | ProcessedMessageContent::OwnPrivateMessage => Ok(json!({ "kind": "proprio" })),
            ProcessedMessageContent::ExternalJoinProposalMessage(_) => {
                Ok(json!({ "kind": "proposta-esterna" }))
            }
        }
    }

    fn stato(&mut self) -> Esito {
        let provider = &self.provider;
        let gruppo = self.gruppo.as_ref().ok_or("nessun gruppo")?;
        let serratura = gruppo
            .export_secret(provider.crypto(), ETICHETTA_ARCHIVIO, &[], 32)
            .map_err(e)?;
        let membri: Vec<String> = gruppo
            .members()
            .map(|m| String::from_utf8_lossy(m.credential.serialized_content()).into_owned())
            .collect();
        Ok(json!({
            "epoch": gruppo.epoch().as_u64(),
            "serratura": hex::encode(serratura),
            "membri": membri,
            "autenticatore": hex::encode(gruppo.epoch_authenticator().as_slice()),
        }))
    }
}

fn main() {
    let mut io = Membro {
        provider: OpenMlsRustCrypto::default(),
        firma: None,
        credenziale: None,
        gruppo: None,
    };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for riga in stdin.lock().lines() {
        let Ok(riga) = riga else { break };
        let v: Value = match serde_json::from_str(&riga) {
            Ok(v) => v,
            Err(err) => {
                writeln!(stdout, "{}", json!({ "errore": e(err) })).unwrap();
                continue;
            }
        };
        let esito = match v["cmd"].as_str().unwrap_or("") {
            "identita" => io.identita(&v),
            "pacchetto" => io.pacchetto(),
            "crea" => io.crea(&v),
            "aggiungi" => io.aggiungi(&v),
            "rimuovi" => io.rimuovi(&v),
            "aggiorna" => io.aggiorna(),
            "entra" => io.entra(&v),
            "punto" => io.punto(),
            "rientra" => io.rientra(&v),
            "cifra" => io.cifra(&v),
            "applica" => io.applica(&v),
            "stato" => io.stato(),
            altro => Err(format!("comando sconosciuto: {altro}")),
        };
        let risposta = match esito {
            Ok(v) => json!({ "ok": v }),
            Err(err) => json!({ "errore": err }),
        };
        writeln!(stdout, "{risposta}").unwrap();
        stdout.flush().unwrap();
    }
}
