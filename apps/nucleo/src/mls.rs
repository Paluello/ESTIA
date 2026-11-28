//! MLS con OpenMLS, interoperabile con il client web ([S7](../../../docs/spike/S7-openmls-e-ts-mls.md)).
//!
//! Le regole sono quelle di `apps/web/src/mls/gruppo.ts`, tradotte:
//!
//! - la ciphersuite è `MLS_128_DHKEMP256_AES128GCM_SHA256_P256` (ADR 0038 §5);
//! - la credenziale è `basic`, con identità `<username>@<casa>` (ADR 0042 §0);
//! - **ogni foglia nuova si autentica** contro il registro: OpenMLS, a
//!   differenza di `ts-mls`, non ha un `AuthenticationService` da montare, e il
//!   controllo lo fa questo modulo prima di applicare un commit o di entrare;
//! - il Welcome e il punto di rientro portano l'albero con sé;
//! - la serratura del mazzo d'archivio è l'exporter con `estia archive wrap v1`
//!   (S2), e non esce da qui.
//!
//! Lo stato vive in una `MemoryStorage` di OpenMLS che, dopo ogni operazione,
//! si scrive intera nel [`Deposito`] dell'app. Per le conversazioni di un
//! telefono pesa poco (S5: 262 byte per foglia), e tiene il formato in un posto
//! solo. Un `StorageProvider` che scrive per chiave è un'ottimizzazione che si
//! fa quando la misura la chiede.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, RwLock};

use openmls::prelude::tls_codec::{Deserialize, Serialize};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_memory_storage::MemoryStorage;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::OpenMlsProvider;

use crate::deposito::{Deposito, Registro};
use crate::errore::{formato, mls};
use crate::ErroreNucleo;

pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMP256_AES128GCM_SHA256_P256;
const ETICHETTA_ARCHIVIO: &str = "estia archive wrap v1";
/// Il nome sotto cui il nucleo scrive il proprio stato nel deposito.
const NOME_STATO: &str = "nucleo/mls";
const VERSIONE_STATO: &[u8] = b"estia-nucleo-mls-1";

/* ---------- il fornitore: RustCrypto e una MemoryStorage nostra ---------- */

#[derive(Default)]
struct Fornitore {
    crypto: RustCrypto,
    storage: MemoryStorage,
}

impl OpenMlsProvider for Fornitore {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }
    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }
    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }
}

/* ---------- ciò che passa il confine ---------- */

#[derive(uniffi::Record)]
pub struct EsitoAggiunta {
    /// Va a tutti i membri.
    pub commit: Vec<u8>,
    /// Va soltanto a chi entra.
    pub welcome: Vec<u8>,
    pub epoch: u64,
}

#[derive(uniffi::Record)]
pub struct EsitoCommit {
    pub commit: Vec<u8>,
    pub epoch: u64,
}

#[derive(uniffi::Record)]
pub struct EsitoRientro {
    pub conversazione: String,
    /// Va depositato sul canale di handshake: finché nessuno lo applica, si è
    /// nel gruppo da soli.
    pub commit: Vec<u8>,
    pub epoch: u64,
}

/// Che cosa era una busta ricevuta. **Non inventa mai un testo**: una busta che
/// non si apre è un errore, e sta all'interfaccia dirlo (come `decifra` sul web).
#[derive(uniffi::Enum, Debug, PartialEq)]
pub enum Ricevuto {
    Messaggio {
        testo: String,
        da: String,
    },
    Commit {
        epoch: u64,
    },
    Proposta,
    /// Il commit toglieva questo dispositivo: la conversazione resta, muta.
    Uscito,
}

/* ---------- lo stato di un dispositivo ---------- */

struct Stato {
    fornitore: Fornitore,
    membro: String,
    firma: SignatureKeyPair,
    conversazioni: BTreeSet<String>,
}

/// L'identità MLS di questo dispositivo e le sue conversazioni.
#[derive(uniffi::Object)]
pub struct Dispositivo {
    stato: Mutex<Stato>,
    deposito: Arc<dyn Deposito>,
    registro: Arc<dyn Registro>,
}

fn identita_valida(membro: &str) -> bool {
    match membro.rfind('@') {
        Some(taglio) => taglio > 0 && taglio < membro.len() - 1,
        None => false,
    }
}

fn credenziale(stato: &Stato) -> CredentialWithKey {
    CredentialWithKey {
        credential: BasicCredential::new(stato.membro.as_bytes().to_vec()).into(),
        signature_key: stato.firma.public().into(),
    }
}

fn config_creazione() -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
        .use_ratchet_tree_extension(true)
        // Gli ingressi esterni arrivano in chiaro per forza; il resto si cifra.
        .wire_format_policy(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .build()
}

fn config_ingresso() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .wire_format_policy(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY)
        .build()
}

fn sul_filo(m: &MlsMessageOut) -> Result<Vec<u8>, ErroreNucleo> {
    m.tls_serialize_detached().map_err(formato)
}

fn dal_filo(bytes: &[u8]) -> Result<MlsMessageIn, ErroreNucleo> {
    MlsMessageIn::tls_deserialize_exact(bytes).map_err(formato)
}

impl Stato {
    fn gruppo(&self, id: &str) -> Result<MlsGroup, ErroreNucleo> {
        MlsGroup::load(
            self.fornitore.storage(),
            &GroupId::from_slice(id.as_bytes()),
        )
        .map_err(mls)?
        .ok_or_else(|| ErroreNucleo::ConversazioneSconosciuta(id.to_string()))
    }

    /* Il formato del deposito: versione, membro, chiave pubblica di firma,
     * conversazioni, poi la MemoryStorage intera. Tutto con lunghezze u32. */

    fn scrivi(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut campo = |b: &[u8]| {
            out.extend_from_slice(&(b.len() as u32).to_be_bytes());
            out.extend_from_slice(b);
        };
        campo(VERSIONE_STATO);
        campo(self.membro.as_bytes());
        campo(self.firma.public());
        campo(&(self.conversazioni.len() as u32).to_be_bytes());
        for c in &self.conversazioni {
            campo(c.as_bytes());
        }
        let valori = self.fornitore.storage.values.read().unwrap();
        campo(&(valori.len() as u32).to_be_bytes());
        for (k, v) in valori.iter() {
            campo(k);
            campo(v);
        }
        out
    }

    fn leggi(dati: &[u8]) -> Result<Stato, ErroreNucleo> {
        let rotto = || ErroreNucleo::Deposito("stato del nucleo illeggibile".into());
        let mut resto = dati;
        let mut campo = || -> Result<Vec<u8>, ErroreNucleo> {
            if resto.len() < 4 {
                return Err(rotto());
            }
            let n = u32::from_be_bytes(resto[..4].try_into().unwrap()) as usize;
            if resto.len() < 4 + n {
                return Err(rotto());
            }
            let v = resto[4..4 + n].to_vec();
            resto = &resto[4 + n..];
            Ok(v)
        };
        let numero = |b: Vec<u8>| -> Result<usize, ErroreNucleo> {
            Ok(u32::from_be_bytes(b.try_into().map_err(|_| rotto())?) as usize)
        };
        if campo()? != VERSIONE_STATO {
            return Err(rotto());
        }
        let membro = String::from_utf8(campo()?).map_err(|_| rotto())?;
        let chiave = campo()?;
        let mut conversazioni = BTreeSet::new();
        for _ in 0..numero(campo()?)? {
            conversazioni.insert(String::from_utf8(campo()?).map_err(|_| rotto())?);
        }
        let mut valori = HashMap::new();
        for _ in 0..numero(campo()?)? {
            let k = campo()?;
            valori.insert(k, campo()?);
        }
        let fornitore = Fornitore {
            crypto: RustCrypto::default(),
            storage: MemoryStorage {
                values: RwLock::new(valori),
            },
        };
        let firma = SignatureKeyPair::read(
            fornitore.storage(),
            &chiave,
            CIPHERSUITE.signature_algorithm(),
        )
        .ok_or_else(rotto)?;
        Ok(Stato {
            fornitore,
            membro,
            firma,
            conversazioni,
        })
    }
}

impl Dispositivo {
    fn salva(&self, stato: &Stato) -> Result<(), ErroreNucleo> {
        self.deposito.scrivi(NOME_STATO.into(), stato.scrivi())
    }

    /// La regola 1 di `gruppo.ts`: nessuna foglia entra senza che il registro
    /// ne riconosca la chiave di firma.
    fn autentica(
        &self,
        foglia_credenziale: &Credential,
        chiave: &[u8],
    ) -> Result<(), ErroreNucleo> {
        let membro = String::from_utf8(foglia_credenziale.serialized_content().to_vec())
            .map_err(|_| ErroreNucleo::NonAutenticato("identità non UTF-8".into()))?;
        if foglia_credenziale.credential_type() != CredentialType::Basic
            || !identita_valida(&membro)
        {
            return Err(ErroreNucleo::NonAutenticato(membro));
        }
        let ammesse = self.registro.chiavi_di_firma(membro.clone())?;
        if ammesse.iter().any(|k| k.as_slice() == chiave) {
            Ok(())
        } else {
            Err(ErroreNucleo::NonAutenticato(membro))
        }
    }

    fn autentica_foglia(&self, foglia: &LeafNode) -> Result<(), ErroreNucleo> {
        self.autentica(foglia.credential(), foglia.signature_key().as_slice())
    }

    fn con_gruppo<T>(
        &self,
        conversazione: &str,
        f: impl FnOnce(&Stato, &mut MlsGroup) -> Result<T, ErroreNucleo>,
    ) -> Result<T, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        let mut gruppo = stato.gruppo(conversazione)?;
        let esito = f(&stato, &mut gruppo)?;
        self.salva(&stato)?;
        Ok(esito)
    }
}

#[uniffi::export]
impl Dispositivo {
    /// Apre l'identità di questo dispositivo dal deposito, o ne crea una nuova
    /// per `membro` (`<username>@<casa>`) se il deposito è vuoto.
    #[uniffi::constructor]
    pub fn apri(
        membro: String,
        deposito: Arc<dyn Deposito>,
        registro: Arc<dyn Registro>,
    ) -> Result<Arc<Self>, ErroreNucleo> {
        if !identita_valida(&membro) {
            return Err(ErroreNucleo::NonAutenticato(membro));
        }
        let stato = match deposito.leggi(NOME_STATO.into())? {
            Some(dati) => {
                let stato = Stato::leggi(&dati)?;
                if stato.membro != membro {
                    return Err(ErroreNucleo::Deposito(
                        "il deposito appartiene a un altro membro".into(),
                    ));
                }
                stato
            }
            None => {
                let fornitore = Fornitore::default();
                let firma =
                    SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(mls)?;
                firma.store(fornitore.storage()).map_err(mls)?;
                Stato {
                    fornitore,
                    membro,
                    firma,
                    conversazioni: BTreeSet::new(),
                }
            }
        };
        let io = Arc::new(Dispositivo {
            stato: Mutex::new(stato),
            deposito,
            registro,
        });
        io.salva(&io.stato.lock().unwrap())?;
        Ok(io)
    }

    /// La chiave pubblica di firma: è quella che si registra sull'istanza.
    pub fn chiave_di_firma(&self) -> Vec<u8> {
        self.stato.lock().unwrap().firma.public().to_vec()
    }

    pub fn membro(&self) -> String {
        self.stato.lock().unwrap().membro.clone()
    }

    pub fn conversazioni(&self) -> Vec<String> {
        self.stato
            .lock()
            .unwrap()
            .conversazioni
            .iter()
            .cloned()
            .collect()
    }

    /// `quanti` KeyPackage nuovi da pubblicare: sono monouso, l'istanza li
    /// consuma quando qualcuno apre una conversazione. Le metà private restano
    /// qui finché un Welcome non le chiama.
    pub fn nuovi_pacchetti(&self, quanti: u32) -> Result<Vec<Vec<u8>>, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        let mut pacchetti = Vec::new();
        for _ in 0..quanti {
            let kp = KeyPackage::builder()
                .build(
                    CIPHERSUITE,
                    &stato.fornitore,
                    &stato.firma,
                    credenziale(&stato),
                )
                .map_err(mls)?;
            pacchetti.push(sul_filo(&MlsMessageOut::from(kp.key_package().clone()))?);
        }
        self.salva(&stato)?;
        Ok(pacchetti)
    }

    pub fn crea_conversazione(&self, conversazione: String) -> Result<(), ErroreNucleo> {
        let mut stato = self.stato.lock().unwrap();
        MlsGroup::new_with_group_id(
            &stato.fornitore,
            &stato.firma,
            &config_creazione(),
            GroupId::from_slice(conversazione.as_bytes()),
            credenziale(&stato),
        )
        .map_err(mls)?;
        stato.conversazioni.insert(conversazione);
        self.salva(&stato)
    }

    /// Fa entrare qualcuno dal suo KeyPackage.
    pub fn aggiungi(
        &self,
        conversazione: String,
        pacchetto: Vec<u8>,
    ) -> Result<EsitoAggiunta, ErroreNucleo> {
        let MlsMessageBodyIn::KeyPackage(kp) = dal_filo(&pacchetto)?.extract() else {
            return Err(ErroreNucleo::Formato("atteso un KeyPackage".into()));
        };
        let stato = self.stato.lock().unwrap();
        let kp = kp
            .validate(stato.fornitore.crypto(), ProtocolVersion::Mls10)
            .map_err(mls)?;
        self.autentica_foglia(kp.leaf_node())?;
        let mut gruppo = stato.gruppo(&conversazione)?;
        let (commit, welcome, _) = gruppo
            .add_members(&stato.fornitore, &stato.firma, &[kp])
            .map_err(mls)?;
        gruppo.merge_pending_commit(&stato.fornitore).map_err(mls)?;
        self.salva(&stato)?;
        Ok(EsitoAggiunta {
            commit: sul_filo(&commit)?,
            welcome: sul_filo(&welcome)?,
            epoch: gruppo.epoch().as_u64(),
        })
    }

    /// Toglie un membro, tutte le sue foglie.
    pub fn rimuovi(
        &self,
        conversazione: String,
        membro: String,
    ) -> Result<EsitoCommit, ErroreNucleo> {
        self.con_gruppo(&conversazione, |stato, gruppo| {
            let foglie: Vec<LeafNodeIndex> = gruppo
                .members()
                .filter(|m| m.credential.serialized_content() == membro.as_bytes())
                .map(|m| m.index)
                .collect();
            if foglie.is_empty() {
                return Err(ErroreNucleo::NonAutenticato(membro.clone()));
            }
            let (commit, _, _) = gruppo
                .remove_members(&stato.fornitore, &stato.firma, &foglie)
                .map_err(mls)?;
            gruppo.merge_pending_commit(&stato.fornitore).map_err(mls)?;
            Ok(EsitoCommit {
                commit: sul_filo(&commit)?,
                epoch: gruppo.epoch().as_u64(),
            })
        })
    }

    /// Rinnova la propria foglia.
    pub fn aggiorna(&self, conversazione: String) -> Result<EsitoCommit, ErroreNucleo> {
        self.con_gruppo(&conversazione, |stato, gruppo| {
            let bundle = gruppo
                .self_update(
                    &stato.fornitore,
                    &stato.firma,
                    LeafNodeParameters::default(),
                )
                .map_err(mls)?;
            gruppo.merge_pending_commit(&stato.fornitore).map_err(mls)?;
            Ok(EsitoCommit {
                commit: sul_filo(bundle.commit())?,
                epoch: gruppo.epoch().as_u64(),
            })
        })
    }

    /// Entra dal proprio Welcome. Restituisce il nome della conversazione.
    pub fn entra(&self, welcome: Vec<u8>) -> Result<String, ErroreNucleo> {
        let MlsMessageBodyIn::Welcome(welcome) = dal_filo(&welcome)?.extract() else {
            return Err(ErroreNucleo::Formato("atteso un Welcome".into()));
        };
        let mut stato = self.stato.lock().unwrap();
        let in_attesa =
            StagedWelcome::new_from_welcome(&stato.fornitore, &config_ingresso(), welcome, None)
                .map_err(mls)?;
        // Chi entra autentica tutto l'albero: è la prima volta che lo vede.
        for m in in_attesa.members() {
            self.autentica(&m.credential, &m.signature_key)?;
        }
        let gruppo = in_attesa.into_group(&stato.fornitore).map_err(mls)?;
        let nome = String::from_utf8(gruppo.group_id().as_slice().to_vec()).map_err(formato)?;
        stato.conversazioni.insert(nome.clone());
        self.salva(&stato)?;
        Ok(nome)
    }

    /// Il punto da cui si rientra: il GroupInfo dell'epoch corrente, con
    /// l'albero e la chiave per l'ingresso esterno (S3 via A).
    pub fn punto_di_rientro(&self, conversazione: String) -> Result<Vec<u8>, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        let gruppo = stato.gruppo(&conversazione)?;
        let gi = gruppo
            .export_group_info(stato.fornitore.crypto(), &stato.firma, true)
            .map_err(mls)?;
        sul_filo(&gi)
    }

    /// Rientra da solo dal punto di rientro.
    pub fn rientra(&self, punto: Vec<u8>) -> Result<EsitoRientro, ErroreNucleo> {
        let MlsMessageBodyIn::GroupInfo(gi) = dal_filo(&punto)?.extract() else {
            return Err(ErroreNucleo::Formato("atteso un GroupInfo".into()));
        };
        let mut stato = self.stato.lock().unwrap();
        let credenziale = credenziale(&stato);
        let (gruppo, bundle) = MlsGroup::external_commit_builder()
            .with_config(config_ingresso())
            .build_group(&stato.fornitore, gi, credenziale)
            .map_err(mls)?
            .load_psks(stato.fornitore.storage())
            .map_err(mls)?
            .build(
                stato.fornitore.rand(),
                stato.fornitore.crypto(),
                &stato.firma,
                |_| true,
            )
            .map_err(mls)?
            .finalize(&stato.fornitore)
            .map_err(mls)?;
        for m in gruppo.members() {
            self.autentica(&m.credential, &m.signature_key)?;
        }
        let nome = String::from_utf8(gruppo.group_id().as_slice().to_vec()).map_err(formato)?;
        stato.conversazioni.insert(nome.clone());
        self.salva(&stato)?;
        Ok(EsitoRientro {
            conversazione: nome,
            commit: sul_filo(bundle.commit())?,
            epoch: gruppo.epoch().as_u64(),
        })
    }

    pub fn cifra(&self, conversazione: String, testo: String) -> Result<Vec<u8>, ErroreNucleo> {
        self.con_gruppo(&conversazione, |stato, gruppo| {
            let m = gruppo
                .create_message(&stato.fornitore, &stato.firma, testo.as_bytes())
                .map_err(mls)?;
            sul_filo(&m)
        })
    }

    /// Applica una busta del canale: un messaggio, un commit o una proposta.
    pub fn applica(&self, conversazione: String, busta: Vec<u8>) -> Result<Ricevuto, ErroreNucleo> {
        let messaggio = dal_filo(&busta)?
            .try_into_protocol_message()
            .map_err(formato)?;
        self.con_gruppo(&conversazione, |stato, gruppo| {
            let elaborato = gruppo
                .process_message(&stato.fornitore, messaggio)
                .map_err(mls)?;
            let da =
                String::from_utf8_lossy(elaborato.credential().serialized_content()).into_owned();
            match elaborato.into_content() {
                ProcessedMessageContent::ApplicationMessage(m) => Ok(Ricevuto::Messaggio {
                    testo: String::from_utf8(m.into_bytes()).map_err(formato)?,
                    da,
                }),
                ProcessedMessageContent::StagedCommitMessage(in_attesa) => {
                    // Le foglie che questo commit porta dentro o cambia.
                    for add in in_attesa.add_proposals() {
                        self.autentica_foglia(add.add_proposal().key_package().leaf_node())?;
                    }
                    if let Some(foglia) = in_attesa.update_path_leaf_node() {
                        self.autentica_foglia(foglia)?;
                    }
                    let uscito = in_attesa.self_removed();
                    gruppo
                        .merge_staged_commit(&stato.fornitore, *in_attesa)
                        .map_err(mls)?;
                    Ok(if uscito {
                        Ricevuto::Uscito
                    } else {
                        Ricevuto::Commit {
                            epoch: gruppo.epoch().as_u64(),
                        }
                    })
                }
                ProcessedMessageContent::ProposalMessage(p) => {
                    gruppo
                        .store_pending_proposal(stato.fornitore.storage(), *p)
                        .map_err(mls)?;
                    Ok(Ricevuto::Proposta)
                }
                ProcessedMessageContent::ExternalJoinProposalMessage(_) => Ok(Ricevuto::Proposta),
                ProcessedMessageContent::OwnPendingCommit
                | ProcessedMessageContent::OwnPrivateMessage => {
                    Err(ErroreNucleo::Formato("busta propria".into()))
                }
            }
        })
    }

    pub fn epoch(&self, conversazione: String) -> Result<u64, ErroreNucleo> {
        Ok(self
            .stato
            .lock()
            .unwrap()
            .gruppo(&conversazione)?
            .epoch()
            .as_u64())
    }

    /// I membri (`<username>@<casa>`), una volta per foglia.
    pub fn membri(&self, conversazione: String) -> Result<Vec<String>, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        Ok(stato
            .gruppo(&conversazione)?
            .members()
            .map(|m| String::from_utf8_lossy(m.credential.serialized_content()).into_owned())
            .collect())
    }
}

impl Dispositivo {
    /// La serratura del mazzo d'archivio (S2). Non è esportata a Swift e
    /// Kotlin: il mazzo si apre qui dentro, quando il nucleo avrà l'archivio.
    pub fn serratura_archivio(&self, conversazione: &str) -> Result<Vec<u8>, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        stato
            .gruppo(conversazione)?
            .export_secret(stato.fornitore.crypto(), ETICHETTA_ARCHIVIO, &[], 32)
            .map_err(mls)
    }
}
