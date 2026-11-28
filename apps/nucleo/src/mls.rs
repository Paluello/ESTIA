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
//!   (S2), e non esce da qui;
//! - la catena d'archivio sta qui dentro, accanto allo stato del gruppo: a
//!   ogni rimozione guadagna la chiave derivata dall'epoch nuova con
//!   `estia archive chain v1` (ADR 0052 §2), come in `sessione.ts`.
//!
//! Lo stato vive in una `MemoryStorage` di OpenMLS che, dopo ogni operazione,
//! si scrive intera nel [`Deposito`] dell'app. Per le conversazioni di un
//! telefono pesa poco (S5: 262 byte per foglia), e tiene il formato in un posto
//! solo. Un `StorageProvider` che scrive per chiave è un'ottimizzazione che si
//! fa quando la misura la chiede.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, RwLock};

use openmls::prelude::tls_codec::{Deserialize, Serialize};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_memory_storage::MemoryStorage;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::OpenMlsProvider;
use zeroize::Zeroizing;

use crate::archivio::{self, Catena, Legame, VoceCifrata, VoceRiletta, LUNGHEZZA_CHIAVE};
use crate::deposito::{Deposito, Registro};
use crate::errore::{formato, mls};
use crate::ErroreNucleo;

pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMP256_AES128GCM_SHA256_P256;
/// L'etichetta con cui si deriva la serratura del mazzo d'archivio (S2).
/// Etichetta, contesto vuoto e 32 byte sono quelli di `serraturaArchivio` in
/// `gruppo.ts`: i due lati devono derivare gli stessi byte.
const ETICHETTA_ARCHIVIO: &str = "estia archive wrap v1";
/// L'etichetta con cui si deriva la chiave che la catena guadagna a ogni
/// rimozione (ADR 0052 §2): `chiaveDiRotazione` in `gruppo.ts`.
const ETICHETTA_ROTAZIONE: &str = "estia archive chain v1";
/// Il nome sotto cui il nucleo scrive il proprio stato nel deposito.
const NOME_STATO: &str = "nucleo/mls";
/// La versione 2 aggiunge in coda le catene d'archivio. Uno stato della
/// versione 1 si legge ancora: le sue conversazioni non hanno una catena, e la
/// ricevono dal mazzo.
const VERSIONE_STATO: &[u8] = b"estia-nucleo-mls-2";
const VERSIONE_STATO_1: &[u8] = b"estia-nucleo-mls-1";

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

/// Il mazzo d'archivio com'è avvolto, e l'epoch della serratura che lo apre.
/// È il blob che si deposita presso la casa che ordina: per lei è opaco.
#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct MazzoAvvolto {
    pub mazzo: String,
    pub epoch: u64,
}

/// Ciò che l'istanza dichiara accanto a una voce d'archivio: con la
/// conversazione, è il legame con cui la voce si deve aprire (ADR 0052 §1).
#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct Dichiarato {
    pub id: String,
    /// `username@casa` di chi l'istanza dice che ha scritto.
    pub mittente: String,
    /// La data com'è arrivata, carattere per carattere.
    pub creato_il: String,
}

/* ---------- lo stato di un dispositivo ---------- */

struct Stato {
    fornitore: Fornitore,
    membro: String,
    firma: SignatureKeyPair,
    conversazioni: BTreeSet<String>,
    /// La catena d'archivio delle conversazioni di cui questo dispositivo ha
    /// aperto il mazzo. Chi manca non è un guasto: è entrato o rientrato, e
    /// aspetta il mazzo avvolto sotto la sua epoch. Finché manca non si scrive.
    catene: BTreeMap<String, Catena>,
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

/// Le chiavi di firma delle foglie, com'è l'albero adesso.
fn chiavi_delle_foglie(gruppo: &MlsGroup) -> Vec<Vec<u8>> {
    gruppo.members().map(|m| m.signature_key).collect()
}

/// Fra due alberi consecutivi, qualche foglia è stata tolta? Si guarda la
/// **chiave di firma**, non il posto, come `qualcunoTolto` in `gruppo.ts`: un
/// rientro con la stessa chiave sostituisce la foglia e non toglie nessuno.
fn qualcuno_tolto(prima: &[Vec<u8>], dopo: &[Vec<u8>]) -> bool {
    prima.iter().any(|chiave| !dopo.contains(chiave))
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

    /// Un segreto dell'epoch corrente, dall'exporter di MLS: contesto vuoto e
    /// 32 byte, come `mlsExporter` sul web. Non esce dal nucleo.
    fn deriva(
        &self,
        gruppo: &MlsGroup,
        etichetta: &str,
    ) -> Result<Zeroizing<Vec<u8>>, ErroreNucleo> {
        gruppo
            .export_secret(self.fornitore.crypto(), etichetta, &[], LUNGHEZZA_CHIAVE)
            .map(Zeroizing::new)
            .map_err(mls)
    }

    /// Dopo un commit, proprio o applicato: se ha tolto qualcuno, la catena
    /// guadagna la chiave di **questa** epoch, la stessa per tutti quelli che
    /// restano (ADR 0052 §2). Si chiama commit per commit, perché la chiave è
    /// di quest'epoch e non della prossima. Chi non ha la catena non aggiunge
    /// niente: la riceverà intera dal mazzo.
    fn dopo_un_commit(
        &mut self,
        conversazione: &str,
        prima: &[Vec<u8>],
        gruppo: &MlsGroup,
    ) -> Result<(), ErroreNucleo> {
        if !qualcuno_tolto(prima, &chiavi_delle_foglie(gruppo)) {
            return Ok(());
        }
        let Some(catena) = self.catene.get(conversazione) else {
            return Ok(());
        };
        let nuova = self.deriva(gruppo, ETICHETTA_ROTAZIONE)?;
        let ruotata = archivio::catena_ruotata(catena, Some(nuova.to_vec()))?;
        self.catene.insert(conversazione.to_string(), ruotata);
        Ok(())
    }

    /* Il formato del deposito: versione, membro, chiave pubblica di firma,
     * conversazioni, la MemoryStorage intera, e dalla versione 2 le catene
     * d'archivio (conversazione, poi le sue chiavi). Tutto con lunghezze u32.
     *
     * Le catene stanno in chiaro dentro questo blob, come le chiavi di MLS che
     * gli stanno accanto: è l'app a sigillarlo nella sua cassaforte (S6). */

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
        campo(&(self.catene.len() as u32).to_be_bytes());
        for (conversazione, catena) in &self.catene {
            campo(conversazione.as_bytes());
            campo(&(catena.lunghezza() as u32).to_be_bytes());
            for chiave in catena.chiavi() {
                campo(chiave);
            }
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
        let versione = campo()?;
        if versione != VERSIONE_STATO && versione != VERSIONE_STATO_1 {
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
        let mut catene = BTreeMap::new();
        if versione == VERSIONE_STATO {
            for _ in 0..numero(campo()?)? {
                let conversazione = String::from_utf8(campo()?).map_err(|_| rotto())?;
                let mut chiavi = Vec::new();
                for _ in 0..numero(campo()?)? {
                    chiavi.push(campo()?);
                }
                catene.insert(conversazione, Catena::da_chiavi(chiavi));
            }
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
            catene,
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
        f: impl FnOnce(&mut Stato, &mut MlsGroup) -> Result<T, ErroreNucleo>,
    ) -> Result<T, ErroreNucleo> {
        let mut stato = self.stato.lock().unwrap();
        // Tutto o niente. OpenMLS consuma la chiave di una busta nel momento
        // in cui la apre: se poi l'operazione si ferma (il registro non
        // risponde, una foglia non è riconosciuta, il deposito non scrive) e
        // lo stato in memoria restasse avanti, la stessa busta non si
        // aprirebbe più al giro dopo, e la fila resterebbe ferma per sempre.
        // Sul web lo stato è immutabile e il problema non esiste; qui si
        // torna alla fotografia di prima.
        let prima = stato.scrivi();
        let esito = stato
            .gruppo(conversazione)
            .and_then(|mut gruppo| f(&mut stato, &mut gruppo))
            .and_then(|esito| self.salva(&stato).map(|()| esito));
        if esito.is_err() {
            *stato = Stato::leggi(&prima)?;
        }
        esito
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
                    catene: BTreeMap::new(),
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

    /// Crea la conversazione, e con lei la sua catena d'archivio: il mazzo
    /// nasce qui e soltanto qui, perché chi crea il gruppo è l'unico che non
    /// trova una cronologia da rispettare.
    pub fn crea_conversazione(&self, conversazione: String) -> Result<(), ErroreNucleo> {
        let mut stato = self.stato.lock().unwrap();
        // Rifarla sostituirebbe la catena, e con lei la cronologia.
        if stato.conversazioni.contains(&conversazione) {
            return Err(ErroreNucleo::Formato(
                "questa conversazione esiste già".into(),
            ));
        }
        let catena = archivio::catena_nuova()?;
        MlsGroup::new_with_group_id(
            &stato.fornitore,
            &stato.firma,
            &config_creazione(),
            GroupId::from_slice(conversazione.as_bytes()),
            credenziale(&stato),
        )
        .map_err(mls)?;
        stato.catene.insert(conversazione.clone(), catena);
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

    /// Toglie un membro, tutte le sue foglie. La catena d'archivio guadagna
    /// una chiave che chi esce non ottiene: non leggerà il seguito.
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
            if foglie.contains(&gruppo.own_leaf_index()) {
                return Err(ErroreNucleo::Formato(
                    "non ci si toglie da soli: lo fa un altro membro".into(),
                ));
            }
            let prima = chiavi_delle_foglie(gruppo);
            let (commit, _, _) = gruppo
                .remove_members(&stato.fornitore, &stato.firma, &foglie)
                .map_err(mls)?;
            gruppo.merge_pending_commit(&stato.fornitore).map_err(mls)?;
            // Chi è stato tolto tiene le chiavi che aveva, e non ottiene questa.
            stato.dopo_un_commit(&conversazione, &prima, gruppo)?;
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
        self.entra_se_chiamato(&welcome, None)?
            .ok_or_else(|| ErroreNucleo::Mls("NoMatchingKeyPackage".into()))
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
        // Si torna nel gruppo, non ancora nella cronologia (S3): il mazzo è
        // avvolto sotto l'epoch di prima, e si riapre quando un altro membro
        // applica questo commit e lo riavvolge.
        stato.catene.remove(&nome);
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
        self.applica_in_fila(&conversazione, &busta, None)
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

/* ---------- l'archivio ---------- */

/// L'archivio della conversazione (ADR 0037, ADR 0052), visto dall'interfaccia.
///
/// L'interfaccia porta le buste: deposita le voci e il mazzo presso l'istanza
/// e li va a riprendere. Non riceve mai una chiave, né la catena, né la
/// serratura: si aprono e si chiudono qui dentro. Le regole sono quelle di
/// `apps/web/src/mls/sessione.ts`, e chi le applica è il nucleo:
///
/// - la catena nasce con `crea_conversazione`, ruota da sola a ogni rimozione
///   (in `rimuovi` e in `applica`), e si perde quando si viene tolti;
/// - chi entra o rientra non ce l'ha finché non apre un mazzo con `apri_mazzo`;
/// - **dopo ogni cambio di epoch** l'app chiede `mazzo_avvolto` e lo deposita.
///   Chi non conosce la catena riceve `None` e non deposita niente:
///   riavvolgere un mazzo che non si conosce lo sostituirebbe.
#[uniffi::export]
impl Dispositivo {
    /// Questo dispositivo ha aperto il mazzo della conversazione? Finché è
    /// `false` non si scrive, e le voci non si aprono.
    pub fn ha_archivio(&self, conversazione: String) -> bool {
        self.stato
            .lock()
            .unwrap()
            .catene
            .contains_key(&conversazione)
    }

    /// Il mazzo avvolto sotto l'epoch corrente, da depositare presso
    /// l'istanza. `None` se questo dispositivo non conosce la catena, o non è
    /// più nel gruppo.
    pub fn mazzo_avvolto(
        &self,
        conversazione: String,
    ) -> Result<Option<MazzoAvvolto>, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        let gruppo = stato.gruppo(&conversazione)?;
        let Some(catena) = stato.catene.get(&conversazione) else {
            return Ok(None);
        };
        if !gruppo.is_active() {
            return Ok(None);
        }
        let serratura = stato.deriva(&gruppo, ETICHETTA_ARCHIVIO)?;
        Ok(Some(MazzoAvvolto {
            mazzo: archivio::avvolgi(catena, &serratura)?,
            epoch: gruppo.epoch().as_u64(),
        }))
    }

    /// Apre il mazzo che l'istanza custodisce, con la serratura dell'epoch in
    /// cui si è. Dice se, dopo, questo dispositivo ha la catena.
    ///
    /// Un mazzo di un'altra epoch, o che non si apre, non cambia niente e non
    /// è un errore: è il dispositivo appena rientrato, che aspetta che un
    /// altro lo riavvolga. **Non si crea mai un mazzo nuovo qui.**
    ///
    /// Chi la catena ce l'ha già la cambia soltanto se quella trovata la
    /// **allunga**: così arriva una chiave aggiunta a mano da un altro, e un
    /// mazzo riavvolto da chi era rimasto indietro non toglie chiavi a nessuno.
    pub fn apri_mazzo(
        &self,
        conversazione: String,
        avvolto: MazzoAvvolto,
    ) -> Result<bool, ErroreNucleo> {
        let mut stato = self.stato.lock().unwrap();
        let gruppo = stato.gruppo(&conversazione)?;
        let nota = stato.catene.contains_key(&conversazione);
        if !gruppo.is_active() || gruppo.epoch().as_u64() != avvolto.epoch {
            return Ok(nota);
        }
        let serratura = stato.deriva(&gruppo, ETICHETTA_ARCHIVIO)?;
        let Ok(trovata) = archivio::svolgi(&avvolto.mazzo, &serratura) else {
            return Ok(nota);
        };
        if trovata.lunghezza() == 0 {
            return Ok(nota);
        }
        let si_adotta = match stato.catene.get(&conversazione) {
            None => true,
            Some(mia) => mia.e_allungata_da(&trovata),
        };
        if si_adotta {
            stato.catene.insert(conversazione, trovata);
            self.salva(&stato)?;
        }
        Ok(true)
    }

    /// Ricifra un testo per l'archivio della propria casa: è tutto l'invio
    /// (ADR 0043 §2). La voce è legata a questa conversazione, all'`id` e alla
    /// data che l'app deposita con lei, e a chi scrive.
    ///
    /// **Chi scrive lo dice la propria foglia, non un parametro**: è
    /// l'identità che il gruppo ha autenticato, ed è quella che la casa
    /// dichiarerà accanto alla voce.
    ///
    /// Senza catena non si scrive: una voce chiusa con una chiave che nessun
    /// altro ha sarebbe un messaggio che nessuno legge, mostrato come mandato.
    pub fn archivia(
        &self,
        conversazione: String,
        testo: String,
        id: String,
        creato_il: String,
    ) -> Result<VoceCifrata, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        let gruppo = stato.gruppo(&conversazione)?;
        let io = gruppo
            .own_leaf_node()
            .filter(|_| gruppo.is_active())
            .ok_or(ErroreNucleo::FuoriDalGruppo)?;
        let mittente = String::from_utf8(io.credential().serialized_content().to_vec())
            .map_err(|_| ErroreNucleo::FuoriDalGruppo)?;
        let catena = stato
            .catene
            .get(&conversazione)
            .ok_or(ErroreNucleo::SenzaArchivio)?;
        Ok(archivio::archivia_legata(
            catena,
            &testo,
            &Legame {
                conversazione_id: conversazione,
                id,
                mittente,
                creato_il,
            },
        )?)
    }

    /// Rilegge una voce della cronologia. `dichiarato` è ciò che l'istanza
    /// dice della voce; manca per il pregresso senza autore attestato.
    ///
    /// `None` quando la voce non si apre: perché questo dispositivo non ha la
    /// chiave, o perché ciò che l'istanza dichiara non è ciò che chi ha
    /// scritto ha sigillato. È uno stato da mostrare, mai un testo. Con
    /// `legata: false` la voce è di prima del legame, e mittente e orario
    /// restano la parola dell'istanza.
    pub fn rileggi(
        &self,
        conversazione: String,
        voce: VoceCifrata,
        dichiarato: Option<Dichiarato>,
    ) -> Option<VoceRiletta> {
        let stato = self.stato.lock().unwrap();
        let catena = stato.catene.get(&conversazione)?;
        let legame = dichiarato.map(|d| Legame {
            conversazione_id: conversazione.clone(),
            id: d.id,
            mittente: d.mittente,
            creato_il: d.creato_il,
        });
        archivio::rileggi_legata(catena, &voce, legame.as_ref())
    }
}

impl Dispositivo {
    /// La serratura del mazzo d'archivio (S2). Non è esportata a Swift e
    /// Kotlin: il mazzo si apre e si chiude qui dentro, con `apri_mazzo` e
    /// `mazzo_avvolto`.
    pub fn serratura_archivio(&self, conversazione: &str) -> Result<Vec<u8>, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        let gruppo = stato.gruppo(conversazione)?;
        Ok(stato.deriva(&gruppo, ETICHETTA_ARCHIVIO)?.to_vec())
    }
}

/* ---------- ciò che serve alla sessione ---------- */

/// Quante foglie può avere un albero: `MAX_FOGLIE_GRUPPO` di `@estia/contracts`.
pub const MAX_FOGLIE_GRUPPO: usize = 50;

/// Una foglia dell'albero: un dispositivo di un membro.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Foglia {
    pub indice: u32,
    /// `<username>@<casa>`, come lo dice la credenziale.
    pub membro: String,
    pub chiave_di_firma: Vec<u8>,
}

/// Un commit che cambia le foglie, **costruito e non ancora applicato**: lo
/// stato resta all'epoch di prima finché la fila non l'ha accettato.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CambioPreparato {
    pub commit: Vec<u8>,
    /// C'è quando qualcuno entra: va a ciascuno di loro.
    pub welcome: Option<Vec<u8>>,
    /// L'epoch che il commit crea.
    pub epoch: u64,
}

/// Di chi è un KeyPackage, e con che chiave firma: senza validarlo.
pub fn di_chi_e(pacchetto: &[u8]) -> Result<(String, Vec<u8>), ErroreNucleo> {
    let MlsMessageBodyIn::KeyPackage(kp) = dal_filo(pacchetto)?.extract() else {
        return Err(ErroreNucleo::Formato("atteso un KeyPackage".into()));
    };
    let dichiarata = kp.unverified_credential();
    let membro = String::from_utf8(dichiarata.credential.serialized_content().to_vec())
        .map_err(|_| ErroreNucleo::ChiaveDiUnAltro)?;
    Ok((membro, dichiarata.signature_key.as_slice().to_vec()))
}

/// Le operazioni che usa [`crate::sessione`], e che non passano il confine di
/// UniFFI: la sessione è nel nucleo, e l'app non porta più i byte di MLS.
///
/// La differenza da `aggiungi` e `rimuovi` è l'ordine, ed è la regola di
/// `sessione.ts`: **il commit va in fila prima che lo stato avanzi**. Se un
/// altro l'ha preceduto sulla stessa epoch la fila lo rifiuta (ADR 0042 §3), e
/// allora qui non deve restare un gruppo a un'epoch che nessun altro conosce.
/// Con OpenMLS vuol dire lasciare il commit *in sospeso* (`prepara_cambio`),
/// e poi applicarlo (`conferma_cambio`) o buttarlo (`annulla_cambio`).
impl Dispositivo {
    /// Questo dispositivo ha lo stato del gruppo di questa conversazione?
    pub fn conosce(&self, conversazione: &str) -> bool {
        self.stato
            .lock()
            .unwrap()
            .conversazioni
            .contains(conversazione)
    }

    /// `false` quando un commit applicato ha tolto la foglia di questo
    /// dispositivo: è `toltoDalGruppo` di `gruppo.ts`.
    pub fn nel_gruppo(&self, conversazione: &str) -> Result<bool, ErroreNucleo> {
        Ok(self
            .stato
            .lock()
            .unwrap()
            .gruppo(conversazione)?
            .is_active())
    }

    /// Le foglie dell'albero, com'è adesso.
    pub fn foglie(&self, conversazione: &str) -> Result<Vec<Foglia>, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        Ok(stato
            .gruppo(conversazione)?
            .members()
            .map(|m| Foglia {
                indice: m.index.u32(),
                membro: String::from_utf8_lossy(m.credential.serialized_content()).into_owned(),
                chiave_di_firma: m.signature_key,
            })
            .collect())
    }

    /// La prova di possesso della chiave di firma (ADR 0040): la firma, DER,
    /// di `messaggio` con la chiave privata. Il messaggio lo compone la
    /// sessione, con il prefisso che lo lega a quell'uso
    /// (`messaggioDiProvaChiave` di `packages/contracts`): niente che MLS
    /// firmerebbe a sua volta.
    pub fn firma_la_prova(&self, messaggio: &[u8]) -> Result<Vec<u8>, ErroreNucleo> {
        use openmls_traits::signatures::Signer;
        self.stato
            .lock()
            .unwrap()
            .firma
            .sign(messaggio)
            .map_err(mls)
    }

    /// Il posto della propria foglia.
    pub fn mia_foglia(&self, conversazione: &str) -> Result<u32, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        Ok(stato.gruppo(conversazione)?.own_leaf_index().u32())
    }

    /// C'è un commit proprio costruito e non ancora applicato?
    pub fn cambio_in_sospeso(&self, conversazione: &str) -> Result<bool, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        Ok(stato.gruppo(conversazione)?.pending_commit().is_some())
    }

    /// Entra da un Welcome, se chiama una chiave di questo dispositivo.
    ///
    /// `None` quando non ne chiama nessuna. Non è un guasto e non si tira a
    /// indovinare: è `perWelcome` del web, che dice `undefined`.
    ///
    /// Se di quel gruppo c'è già uno stato da cui si risulta **tolti**, il
    /// Welcome lo sostituisce: è la riammissione. Uno stato ancora vivo non si
    /// sostituisce mai.
    ///
    /// `attesa` è la conversazione sul cui canale il Welcome è arrivato: uno
    /// che porta in un altro gruppo si rifiuta prima di toccare qualunque cosa.
    pub fn entra_se_chiamato(
        &self,
        welcome: &[u8],
        attesa: Option<&str>,
    ) -> Result<Option<String>, ErroreNucleo> {
        let MlsMessageBodyIn::Welcome(welcome) = dal_filo(welcome)?.extract() else {
            return Err(ErroreNucleo::Formato("atteso un Welcome".into()));
        };
        let mut stato = self.stato.lock().unwrap();
        let elaborato =
            match ProcessedWelcome::new_from_welcome(&stato.fornitore, &config_ingresso(), welcome)
            {
                Ok(elaborato) => elaborato,
                Err(WelcomeError::NoMatchingKeyPackage) => return Ok(None),
                Err(altro) => return Err(mls(altro)),
            };
        let id = elaborato.unverified_group_info().group_id().clone();
        if attesa.is_some_and(|attesa| attesa.as_bytes() != id.as_slice()) {
            return Err(ErroreNucleo::Formato(
                "il Welcome è di un'altra conversazione".into(),
            ));
        }
        if let Some(mut di_prima) = MlsGroup::load(stato.fornitore.storage(), &id).map_err(mls)? {
            if di_prima.is_active() {
                return Err(ErroreNucleo::Formato(
                    "questo dispositivo è già in questa conversazione".into(),
                ));
            }
            di_prima.delete(stato.fornitore.storage()).map_err(mls)?;
        }
        let in_attesa = elaborato
            .into_staged_welcome(&stato.fornitore, None)
            .map_err(mls)?;
        // Chi entra autentica tutto l'albero: è la prima volta che lo vede.
        for m in in_attesa.members() {
            self.autentica(&m.credential, &m.signature_key)?;
        }
        let gruppo = in_attesa.into_group(&stato.fornitore).map_err(mls)?;
        let nome = String::from_utf8(gruppo.group_id().as_slice().to_vec()).map_err(formato)?;
        // Chi entra non ha la catena, e una rimasta da prima non è più quella:
        // arriva dal mazzo, con `apri_mazzo`.
        stato.catene.remove(&nome);
        stato.conversazioni.insert(nome.clone());
        self.salva(&stato)?;
        Ok(Some(nome))
    }

    /// Costruisce un commit che fa entrare e uscire foglie insieme, e lo lascia
    /// in sospeso: è `cambiaFoglie` di `gruppo.ts`, fermato un passo prima.
    ///
    /// Ogni KeyPackage si autentica contro il registro. Non ci si toglie da
    /// soli, e l'albero ha un tetto.
    pub fn prepara_cambio(
        &self,
        conversazione: &str,
        entrano: &[Vec<u8>],
        escono: &[u32],
    ) -> Result<CambioPreparato, ErroreNucleo> {
        let stato = self.stato.lock().unwrap();
        let mut gruppo = stato.gruppo(conversazione)?;
        if !gruppo.is_active() {
            return Err(ErroreNucleo::FuoriDalGruppo);
        }
        if escono.contains(&gruppo.own_leaf_index().u32()) {
            return Err(ErroreNucleo::Formato(
                "non ci si toglie da soli: lo fa un altro membro".into(),
            ));
        }
        let quante = (gruppo.members().count() + entrano.len()).saturating_sub(escono.len());
        if quante > MAX_FOGLIE_GRUPPO {
            return Err(ErroreNucleo::GruppoPieno);
        }
        let mut pacchetti = Vec::with_capacity(entrano.len());
        for pacchetto in entrano {
            let MlsMessageBodyIn::KeyPackage(kp) = dal_filo(pacchetto)?.extract() else {
                return Err(ErroreNucleo::Formato("atteso un KeyPackage".into()));
            };
            let kp = kp
                .validate(stato.fornitore.crypto(), ProtocolVersion::Mls10)
                .map_err(mls)?;
            self.autentica_foglia(kp.leaf_node())?;
            pacchetti.push(kp);
        }
        // Un commit rimasto in sospeso da un tentativo che la fila non ha mai
        // visto non si porta dietro: se ne fa uno nuovo, sull'epoch di adesso.
        gruppo
            .clear_pending_commit(stato.fornitore.storage())
            .map_err(mls)?;
        let bundle = gruppo
            .commit_builder()
            .propose_removals(escono.iter().map(|i| LeafNodeIndex::new(*i)))
            .propose_adds(pacchetti)
            .load_psks(stato.fornitore.storage())
            .map_err(mls)?
            .build(
                stato.fornitore.rand(),
                stato.fornitore.crypto(),
                &stato.firma,
                |_| true,
            )
            .map_err(mls)?
            .stage_commit(&stato.fornitore)
            .map_err(mls)?;
        if !entrano.is_empty() && bundle.welcome().is_none() {
            return Err(ErroreNucleo::Mls(
                "un ingresso senza Welcome non è un ingresso".into(),
            ));
        }
        let (commit, welcome, _) = bundle.into_messages();
        self.salva(&stato)?;
        Ok(CambioPreparato {
            commit: sul_filo(&commit)?,
            welcome: welcome.as_ref().map(sul_filo).transpose()?,
            epoch: gruppo.epoch().as_u64() + 1,
        })
    }

    /// La fila ha accettato il commit in sospeso: lo stato avanza, e se ha
    /// tolto qualcuno la catena guadagna la chiave dell'epoch nuova.
    pub fn conferma_cambio(&self, conversazione: &str) -> Result<u64, ErroreNucleo> {
        self.con_gruppo(conversazione, |stato, gruppo| {
            if gruppo.pending_commit().is_none() {
                return Err(ErroreNucleo::Mls("nessun commit in sospeso".into()));
            }
            let prima = chiavi_delle_foglie(gruppo);
            gruppo.merge_pending_commit(&stato.fornitore).map_err(mls)?;
            stato.dopo_un_commit(conversazione, &prima, gruppo)?;
            Ok(gruppo.epoch().as_u64())
        })
    }

    /// La fila ha rifiutato il commit in sospeso, o non l'ha mai visto: si
    /// butta, e lo stato resta all'epoch che tutti conoscono.
    pub fn annulla_cambio(&self, conversazione: &str) -> Result<(), ErroreNucleo> {
        self.con_gruppo(conversazione, |stato, gruppo| {
            gruppo
                .clear_pending_commit(stato.fornitore.storage())
                .map_err(mls)
        })
    }

    /// Toglie da questo dispositivo lo stato di un gruppo, e la sua catena.
    ///
    /// Serve a una cosa sola: un gruppo creato o un rientro che la fila ha
    /// rifiutato, cioè uno stato che nessun altro conosce. Tenerlo vorrebbe
    /// dire riprenderlo al posto di quello vero.
    pub fn dimentica(&self, conversazione: &str) -> Result<(), ErroreNucleo> {
        let mut stato = self.stato.lock().unwrap();
        if let Ok(mut gruppo) = stato.gruppo(conversazione) {
            gruppo.delete(stato.fornitore.storage()).map_err(mls)?;
        }
        stato.conversazioni.remove(conversazione);
        stato.catene.remove(conversazione);
        self.salva(&stato)
    }

    /// Applica una busta della fila di handshake.
    ///
    /// `proprio` sono i byte del commit che questo dispositivo ha lasciato in
    /// sospeso, se ce n'è uno: quando la fila lo restituisce — il deposito era
    /// riuscito, e l'app si è chiusa prima di saperlo — non lo si può
    /// decifrare, perché è proprio, ma lo si riconosce byte per byte e si
    /// applica quello in sospeso. Un commit proprio che non si riconosce è un
    /// errore: lo stato che lo aveva prodotto non c'è più.
    pub fn applica_in_fila(
        &self,
        conversazione: &str,
        busta: &[u8],
        proprio: Option<&[u8]>,
    ) -> Result<Ricevuto, ErroreNucleo> {
        let messaggio = dal_filo(busta)?
            .try_into_protocol_message()
            .map_err(formato)?;
        self.con_gruppo(conversazione, |stato, gruppo| {
            let prima = chiavi_delle_foglie(gruppo);
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
                    if uscito {
                        // Chi è stato tolto non legge il seguito e non scrive:
                        // come sul web, la catena non resta su questo dispositivo.
                        stato.catene.remove(conversazione);
                    } else {
                        stato.dopo_un_commit(conversazione, &prima, gruppo)?;
                    }
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
                    if gruppo.pending_commit().is_none() || proprio != Some(busta) {
                        return Err(ErroreNucleo::Formato("busta propria".into()));
                    }
                    gruppo.merge_pending_commit(&stato.fornitore).map_err(mls)?;
                    stato.dopo_un_commit(conversazione, &prima, gruppo)?;
                    Ok(Ricevuto::Commit {
                        epoch: gruppo.epoch().as_u64(),
                    })
                }
            }
        })
    }
}

#[cfg(test)]
mod prove {
    //! Ciò che dell'archivio si vede soltanto da dentro: il formato dello
    //! stato, e che cosa succede alla catena davanti a un mazzo diverso.

    use super::*;

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

    const C: &str = "conv-1";

    fn dispositivo(
        registro: &Arc<RegistroInMemoria>,
        membro: &str,
    ) -> (Arc<Dispositivo>, Arc<DepositoInMemoria>) {
        let deposito = Arc::new(DepositoInMemoria::default());
        let d = Dispositivo::apri(membro.into(), deposito.clone(), registro.clone()).unwrap();
        registro
            .0
            .lock()
            .unwrap()
            .entry(membro.into())
            .or_default()
            .push(d.chiave_di_firma());
        (d, deposito)
    }

    fn catena_di(d: &Dispositivo) -> Vec<Vec<u8>> {
        d.stato.lock().unwrap().catene[C].chiavi().to_vec()
    }

    fn impone(d: &Dispositivo, chiavi: Vec<Vec<u8>>) {
        d.stato
            .lock()
            .unwrap()
            .catene
            .insert(C.into(), Catena::da_chiavi(chiavi));
    }

    #[test]
    fn uno_stato_della_versione_1_si_apre_e_aspetta_il_mazzo() {
        let registro = Arc::new(RegistroInMemoria::default());
        let (anna, deposito) = dispositivo(&registro, "anna@casa");
        anna.crea_conversazione(C.into()).unwrap();

        // Lo stato com'era prima delle catene: la versione 1, senza la coda.
        let vecchio = {
            let mut stato = anna.stato.lock().unwrap();
            stato.catene.clear();
            let mut byte = stato.scrivi();
            byte.truncate(byte.len() - 8);
            let dove = 4 + VERSIONE_STATO.len() - 1;
            assert_eq!(byte[dove], b'2');
            byte[dove] = b'1';
            byte
        };
        drop(anna);
        deposito.scrivi(NOME_STATO.into(), vecchio).unwrap();

        let riaperta =
            Dispositivo::apri("anna@casa".into(), deposito.clone(), registro.clone()).unwrap();
        assert_eq!(riaperta.conversazioni(), vec![C.to_string()]);
        assert_eq!(riaperta.epoch(C.into()).unwrap(), 0);
        // Niente catena, e nessuna inventata: arriverà da un mazzo.
        assert!(!riaperta.ha_archivio(C.into()));
        assert_eq!(riaperta.mazzo_avvolto(C.into()).unwrap(), None);
        // Riaprendo, lo stato è stato riscritto nella versione nuova.
        let scritto = deposito.leggi(NOME_STATO.into()).unwrap().unwrap();
        assert_eq!(&scritto[4..4 + VERSIONE_STATO.len()], VERSIONE_STATO);
    }

    #[test]
    fn uno_stato_troncato_o_di_un_altra_versione_non_si_apre() {
        let registro = Arc::new(RegistroInMemoria::default());
        let (anna, deposito) = dispositivo(&registro, "anna@casa");
        anna.crea_conversazione(C.into()).unwrap();
        let buono = deposito.leggi(NOME_STATO.into()).unwrap().unwrap();

        let mut troncato = buono.clone();
        troncato.truncate(buono.len() - 5);
        let mut altra = buono.clone();
        altra[4 + VERSIONE_STATO.len() - 1] = b'3';
        for rotto in [troncato, altra] {
            assert!(matches!(
                Stato::leggi(&rotto),
                Err(ErroreNucleo::Deposito(_))
            ));
        }
        assert!(Stato::leggi(&buono).is_ok());
    }

    #[test]
    fn un_mazzo_allunga_la_catena_e_non_la_accorcia_mai() {
        let registro = Arc::new(RegistroInMemoria::default());
        let (anna, _) = dispositivo(&registro, "anna@casa");
        let (bruno, _) = dispositivo(&registro, "bruno@casa");
        anna.crea_conversazione(C.into()).unwrap();
        let e = anna
            .aggiungi(C.into(), bruno.nuovi_pacchetti(1).unwrap().remove(0))
            .unwrap();
        bruno.entra(e.welcome).unwrap();
        let mazzo = |d: &Dispositivo| d.mazzo_avvolto(C.into()).unwrap().unwrap();
        assert!(bruno.apri_mazzo(C.into(), mazzo(&anna)).unwrap());
        let prima = catena_di(&anna);
        assert_eq!(catena_di(&bruno), prima);

        // bruno ha una chiave in più (una rotazione a mano, dal web): anna,
        // che ha la catena di prima, la riceve dal mazzo.
        let allungata = vec![prima[0].clone(), vec![7; 32]];
        impone(&bruno, allungata.clone());
        assert!(anna.apri_mazzo(C.into(), mazzo(&bruno)).unwrap());
        assert_eq!(catena_di(&anna), allungata);

        // Un mazzo rimasto indietro non le toglie niente.
        impone(&bruno, prima.clone());
        assert!(anna.apri_mazzo(C.into(), mazzo(&bruno)).unwrap());
        assert_eq!(catena_di(&anna), allungata);

        // E nemmeno uno che dice un'altra cosa allo stesso posto, o uno vuoto.
        impone(&bruno, vec![prima[0].clone(), vec![9; 32], vec![9; 32]]);
        assert!(anna.apri_mazzo(C.into(), mazzo(&bruno)).unwrap());
        assert_eq!(catena_di(&anna), allungata);
        impone(&bruno, vec![]);
        assert!(anna.apri_mazzo(C.into(), mazzo(&bruno)).unwrap());
        assert_eq!(catena_di(&anna), allungata);
    }

    #[test]
    fn un_mazzo_vuoto_non_e_una_catena() {
        let registro = Arc::new(RegistroInMemoria::default());
        let (anna, _) = dispositivo(&registro, "anna@casa");
        let (bruno, _) = dispositivo(&registro, "bruno@casa");
        anna.crea_conversazione(C.into()).unwrap();
        let e = anna
            .aggiungi(C.into(), bruno.nuovi_pacchetti(1).unwrap().remove(0))
            .unwrap();
        bruno.entra(e.welcome).unwrap();
        impone(&anna, vec![]);
        let vuoto = anna.mazzo_avvolto(C.into()).unwrap().unwrap();
        assert!(!bruno.apri_mazzo(C.into(), vuoto).unwrap());
        assert!(!bruno.ha_archivio(C.into()));
    }

    #[test]
    fn le_due_etichette_non_danno_lo_stesso_segreto() {
        let registro = Arc::new(RegistroInMemoria::default());
        let (anna, _) = dispositivo(&registro, "anna@casa");
        anna.crea_conversazione(C.into()).unwrap();
        let stato = anna.stato.lock().unwrap();
        let gruppo = stato.gruppo(C).unwrap();
        let serratura = stato.deriva(&gruppo, ETICHETTA_ARCHIVIO).unwrap();
        let rotazione = stato.deriva(&gruppo, ETICHETTA_ROTAZIONE).unwrap();
        assert_eq!(serratura.len(), 32);
        assert_eq!(rotazione.len(), 32);
        assert_ne!(*serratura, *rotazione);
    }
}
