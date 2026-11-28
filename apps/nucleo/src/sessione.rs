//! La sessione MLS delle conversazioni, per Swift e Kotlin.
//!
//! È `apps/web/src/mls/sessione.ts` portata nel nucleo, con sopra ciò che la
//! schermata chiede (`conversazione.ts`): l'interfaccia dice «apri», «leggi»,
//! «manda», e non sa che cosa sia un'epoch, un Welcome o una catena di chiavi.
//! [`crate::mls`] fa la crittografia, [`crate::archivio`] la cronologia, e qui
//! si decide **quando** e **in che ordine**, che è dove le cose si rompono
//! davvero.
//!
//! Le regole sono quelle del web, e nessuna è un dettaglio:
//!
//! 1. **Gli handshake si applicano in ordine di arrivo, uno alla volta.** Il
//!    cursore avanza solo su ciò che è stato applicato davvero: se un commit
//!    non si applica ci si ferma lì.
//! 2. **Lo stato si salva dopo ogni mutazione.** Lo fa il [`Dispositivo`], nel
//!    [`Deposito`] dell'app, commit per commit.
//! 3. **Un commit proprio va in fila prima che lo stato avanzi.** Se un altro
//!    l'ha preceduto sulla stessa epoch la fila lo rifiuta (ADR 0042 §3): ci
//!    si rimette in pari e si riprova, e qui non resta un gruppo che nessun
//!    altro conosce.
//! 4. **Il mazzo d'archivio si riavvolge a ogni cambio di epoch, e solo da chi
//!    lo conosce.** Un dispositivo appena entrato o rientrato non lo riavvolge
//!    e non scrive.
//! 5. **Il contenuto non viaggia come busta MLS** (ADR 0043): la parola va
//!    nell'archivio della casa di chi scrive, e chi legge la visita.
//!
//! Il registro delle chiavi di firma è quello dell'istanza
//! ([`Istanza::chiavi_di_firma`]): il nucleo lo interroga da sé a ogni foglia
//! nuova, e l'app non lo implementa.
//!
//! **Niente di ciò che passa il confine è un segreto**: né chiavi, né catena,
//! né serratura, né byte di MLS. Il testo esiste soltanto in memoria.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::archivio::VoceCifrata;
use crate::casa::Collegamento;
use crate::deposito::{Deposito, Registro};
use crate::istanza::{
    superata, Autore, BustaDaDepositare, BustaHandshake, ChiSono, ConversazioneVista,
    DispositivoInElenco, DispositivoRegistrato, Istanza, IstanzaSuCasa, PersonaDaInvitare,
    PuntoDiRientro, SessioneAperta, TipoBusta, VoceDaDepositare,
};
use crate::mls::{di_chi_e, Dichiarato, Dispositivo, Foglia, Ricevuto};
use crate::ErroreNucleo;

#[cfg(test)]
pub(crate) mod finta;
#[cfg(test)]
mod prove;

/// Il nome sotto cui la sessione tiene i suoi appunti nel deposito: i cursori
/// degli handshake, i commit in sospeso, la scorta. Nessun segreto.
const NOME_APPUNTI: &str = "nucleo/sessioni";
/// Quanti KeyPackage tenere pubblicati: `SCORTA` di `dispositivo.ts`.
const SCORTA: u32 = 10;
/// Quante volte si riprova un commit che un altro ha preceduto.
const TENTATIVI: u32 = 3;
/// Ogni quanto, per conversazione, si rimettono d'accordo le proprie foglie
/// con il registro (ADR 0040): è una domanda in più alla Casa.
const ALLINEA_DISPOSITIVI_OGNI: Duration = Duration::from_secs(5 * 60);

type Esito<T> = Result<T, ErroreNucleo>;

/* ---------- ciò che passa il confine ---------- */

/// Chi è questo dispositivo.
#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct Io {
    /// L'id con cui le conversazioni nominano questa persona.
    pub id: String,
    pub username: String,
    /// La chiave della Casa.
    pub casa: String,
    /// L'id del dispositivo nel registro della Casa.
    pub dispositivo: String,
    /// `false` finché un dispositivo già approvato non dice di sì (ADR 0040).
    /// Fino ad allora non si crea e non si rientra.
    pub approvato: bool,
    /// Le otto cifre di questo dispositivo, da confrontare con quelle che
    /// vede chi lo approva ([`codice_di`]).
    pub codice: String,
}

/// A che punto è un dispositivo con il sì di ADR 0040.
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatoDispositivo {
    /// La sua chiave è nel registro: entra nelle conversazioni.
    Approvato,
    /// Aspetta il sì di un dispositivo già approvato.
    InAttesa,
    /// Qualcuno ha detto di no, o l'ha tolto: la sua chiave non vale più.
    Revocato,
}

/// Un dispositivo di questa persona, come si mostra nell'elenco.
#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct MioDispositivo {
    pub id: String,
    pub stato: StatoDispositivo,
    /// È questo dispositivo.
    pub questo: bool,
    /// Le otto cifre da confrontare prima di dire di sì. **Le calcola il
    /// nucleo dalla chiave pubblica**, mai la Casa: un codice scritto da chi
    /// custodisce le chiavi coinciderebbe anche dopo averle sostituite.
    pub codice: String,
    /// Il nome che si è dato entrando, se la sua sessione è ancora aperta.
    pub etichetta: Option<String>,
    pub creato_il: String,
    pub approvato_il: Option<String>,
    pub revocato_il: Option<String>,
    /// L'ultima volta che la Casa l'ha visto, se la sessione è ancora aperta.
    /// `None` per una chiave che conta ancora da una sessione chiusa.
    pub visto_il: Option<String>,
}

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct Persona {
    /// L'id con cui la conversazione la nomina.
    pub id: String,
    pub username: String,
    /// Il nome da mostrare. Può essere vuoto.
    pub nome: String,
    /// La chiave della sua casa.
    pub casa: String,
    /// `creatore`, `amministratore` o `membro`, in un gruppo.
    pub ruolo: Option<String>,
}

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct Conversazione {
    pub id: String,
    pub gruppo: bool,
    pub nome: Option<String>,
    pub membri: Vec<Persona>,
    pub non_letti: u32,
    pub creata_il: String,
    pub ultimo_messaggio_il: Option<String>,
    /// La ordina questa Casa.
    pub ordinata_qui: bool,
    /// La casa che la ordinava è persa: si legge e basta (ADR 0042 §3).
    pub congelata: bool,
}

/// Come si è aperta una conversazione su questo dispositivo. Tre esiti, e la
/// schermata ne mostra tre diversi.
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Apertura {
    Pronta,
    /// Questo dispositivo è stato tolto dal gruppo: non c'è niente da aprire.
    Tolto,
    /// La conversazione la crea qualcun altro, e l'invito non c'è ancora.
    InAttesa,
}

/// Tre stati da mostrare, non tre frasi da inventare.
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatoMessaggio {
    Letto,
    /// La voce c'è, ma questo dispositivo non ha la chiave, o ciò che
    /// l'istanza dichiara non è ciò che chi ha scritto ha sigillato.
    NonSiApre,
    /// La casa che la custodisce non risponde.
    NonDisponibile,
}

#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum TipoEvento {
    Ingresso,
    Rimozione,
    Uscita,
}

/// Ciò che succede a un gruppo, raccontato da chi l'ha fatto: non è
/// l'autorità su chi c'è, quella sono i membri.
#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct Evento {
    pub tipo: TipoEvento,
    /// `username@casa`.
    pub chi: String,
}

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct Messaggio {
    pub id: String,
    /// L'ora, com'è arrivata: `2026-11-28T10:00:00.000Z`.
    pub creato_il: String,
    /// `username@casa`; `None` per il pregresso senza autore attestato.
    pub mittente: Option<String>,
    /// L'ha scritto questa persona, da qualunque suo dispositivo.
    pub mio: bool,
    pub stato: StatoMessaggio,
    /// Solo per un messaggio letto.
    pub testo: Option<String>,
    /// `false` quando chi e quando li dice soltanto l'istanza (ADR 0052 §1).
    pub attestato: bool,
    /// L'id del messaggio a cui risponde.
    pub risponde: Option<String>,
    pub evento: Option<Evento>,
}

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct Pagina {
    /// Dal più vecchio al più recente.
    pub messaggi: Vec<Messaggio>,
    /// Da passare per la pagina precedente, se ce n'è una.
    pub prima: Option<String>,
    /// Le case che non hanno risposto.
    pub non_rispondono: Vec<String>,
}

/// Un giro: gli handshake arretrati applicati, il mazzo riaperto se qualcuno
/// l'ha riavvolto, e l'ultima pagina di cronologia.
#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct Aggiornamento {
    pub apertura: Apertura,
    /// I messaggi dell'ultima pagina che questo giro porta di nuovo: mai
    /// visti, o che hanno cambiato stato (una voce che adesso si apre).
    /// Si sostituiscono per `id`.
    pub nuovi: Vec<Messaggio>,
    /// Gli id dell'ultima pagina, in ordine: ciò che non c'è più è stato
    /// ritirato da chi l'aveva scritto.
    pub pagina: Vec<String>,
    pub prima: Option<String>,
    /// Questo dispositivo non ha ancora la cronologia: non scrive.
    pub senza_cronologia: bool,
    pub non_rispondono: Vec<String>,
    /// Chi ha una foglia nell'albero senza essere fra i membri
    /// (`username@casa`): finché c'è, non si scrive.
    pub estranei: Vec<String>,
    /// Chi è fra i membri e non ha ancora un dispositivo nel gruppo cifrato.
    pub assenti: Vec<String>,
}

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct MembroDelGruppo {
    pub persona: Persona,
    /// `username@casa`, come lo nomina MLS.
    pub membro: String,
    /// Quanti suoi dispositivi sono nel gruppo cifrato. Zero: è fra le
    /// persone, e non legge ancora.
    pub dispositivi: u32,
}

/* ---------- gli appunti ---------- */

/// Un commit proprio costruito e non ancora applicato: è in fila, o sta per
/// esserlo. Si tiene finché non si sa com'è andata, anche attraverso una
/// chiusura dell'app.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Sospeso {
    busta: String,
    epoch: u64,
    welcome: Option<String>,
    destinatari: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Appunti {
    /// L'ultimo handshake visto in fila.
    #[serde(default)]
    cursore: Option<String>,
    #[serde(default)]
    sospeso: Option<Sospeso>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Taccuino {
    /// Il dispositivo per cui la scorta è stata pubblicata.
    #[serde(default)]
    dispositivo: Option<String>,
    /// Quanti KeyPackage pubblicati nessun Welcome ha ancora chiamato.
    #[serde(default)]
    scorta: u32,
    #[serde(default)]
    conversazioni: BTreeMap<String, Appunti>,
}

/// Chi entra: la sua chiave d'ingresso, e l'id con cui la conversazione lo
/// nomina. **L'id, non il nome**: è con quello che la casa che ordina consegna
/// il Welcome.
#[derive(Clone, Debug)]
pub struct Ingresso {
    pub pacchetto: Vec<u8>,
    pub destinatario: String,
}

/// Ciò che la sessione ricorda di una conversazione aperta. Niente testo.
#[derive(Default)]
struct Aperta {
    /// Aperta in questa vita dell'app: a ogni avvio si riapre, perché è lì
    /// che si riprende il mazzo e si scopre che cosa è successo intanto.
    pronta: bool,
    vista: Option<ConversazioneVista>,
    /// Lo stato con cui ogni riga è già stata consegnata all'app.
    consegnati: HashMap<String, StatoMessaggio>,
    foglie_allineate_il: Option<Instant>,
}

/* ---------- il registro, dall'istanza ---------- */

/// Il [`Registro`] che il [`Dispositivo`] interroga, risposto dall'istanza.
///
/// Il `Dispositivo` chiede in modo sincrono, e l'istanza risponde in modo
/// asincrono: per questo le operazioni che autenticano una foglia girano fuori
/// dal runtime ([`Motore::fuori`]), e qui si aspetta la risposta.
///
/// Dentro **una** validazione la stessa persona si chiede una volta sola, come
/// `perQuestaValidazione` in `gruppo.ts`: un albero di cinquanta foglie non fa
/// cinquanta domande. Fra una validazione e l'altra non si ricorda niente: una
/// chiave revocata non resta buona.
struct RegistroDellIstanza<I: Istanza> {
    istanza: Arc<I>,
    runtime: tokio::runtime::Handle,
    per_questa_validazione: Mutex<HashMap<String, Vec<Vec<u8>>>>,
}

impl<I: Istanza> Registro for RegistroDellIstanza<I> {
    fn chiavi_di_firma(&self, membro: String) -> Esito<Vec<Vec<u8>>> {
        if let Some(note) = self.per_questa_validazione.lock().unwrap().get(&membro) {
            return Ok(note.clone());
        }
        let chiavi = self
            .runtime
            .block_on(self.istanza.chiavi_di_firma(&membro))?;
        self.per_questa_validazione
            .lock()
            .unwrap()
            .insert(membro, chiavi.clone());
        Ok(chiavi)
    }
}

/* ---------- piccoli attrezzi ---------- */

fn b64(byte: &[u8]) -> String {
    STANDARD.encode(byte)
}

/// Il codice che si confronta per autorizzare un dispositivo: le otto cifre
/// della sua chiave pubblica (in base64, com'è nel registro), in due gruppi da
/// quattro. È `codiceDi` di `apps/web/src/screens/impostazioni/codice-dispositivo.ts`
/// byte per byte: i primi sei byte dello SHA-256 del testo, modulo 10⁸.
///
/// Non è un segreto: serve a distinguere il proprio dispositivo da un altro
/// che aspetta nello stesso momento, e a smascherare una chiave sostituita.
pub fn codice_di(chiave_pubblica: &str) -> String {
    use openmls_rust_crypto::RustCrypto;
    use openmls_traits::crypto::OpenMlsCrypto;
    use openmls_traits::types::HashType;

    let digest = RustCrypto::default()
        .hash(HashType::Sha2_256, chiave_pubblica.as_bytes())
        .unwrap_or_default();
    let valore = digest
        .iter()
        .take(6)
        .fold(0u64, |v, byte| (v << 8) | u64::from(*byte));
    let cifre = format!("{:08}", valore % 100_000_000);
    format!("{} {}", &cifre[..4], &cifre[4..])
}

/// Il testo che il dispositivo firma per provare di avere la chiave privata:
/// `messaggioDiProvaChiave` di `packages/contracts`. Porta la sfida, che lo
/// lega a questa sessione e a questo momento, e la chiave.
fn messaggio_di_prova(sfida: &str, chiave_pubblica: &str) -> String {
    format!("ESTIA-prova-chiave-v1\n{sfida}\n{chiave_pubblica}")
}

/// Da una riga del registro a ciò che la schermata mostra.
fn mio_dispositivo(
    d: DispositivoInElenco,
    questo: &str,
    sessioni: &[SessioneAperta],
) -> MioDispositivo {
    let stato = if d.revocato_il.is_some() {
        StatoDispositivo::Revocato
    } else if d.approvato_il.is_some() {
        StatoDispositivo::Approvato
    } else {
        StatoDispositivo::InAttesa
    };
    let sessione = sessioni.iter().find(|s| s.id == d.sessione);
    MioDispositivo {
        questo: d.id == questo,
        codice: codice_di(&d.chiave_pubblica),
        etichetta: sessione
            .map(|s| s.etichetta.trim().to_string())
            .filter(|e| !e.is_empty()),
        visto_il: sessione.map(|s| s.visto_il.clone()),
        id: d.id,
        stato,
        creato_il: d.creato_il,
        approvato_il: d.approvato_il,
        revocato_il: d.revocato_il,
    }
}

fn da_b64(testo: &str) -> Esito<Vec<u8>> {
    STANDARD
        .decode(testo)
        .map_err(|_| ErroreNucleo::Formato("busta non in base64".into()))
}

/// L'ora di adesso come la scrive `Date.prototype.toISOString`: è la forma
/// che l'istanza pretende da una voce (`istanteValido` in `forma.ts`).
fn adesso() -> String {
    let da_allora = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    istante(da_allora.as_secs(), da_allora.subsec_millis())
}

fn istante(secondi: u64, millesimi: u32) -> String {
    let giorni = (secondi / 86_400) as i64;
    let resto = secondi % 86_400;
    // Dai giorni alla data civile (Howard Hinnant, `civil_from_days`).
    let z = giorni + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let giorno = doy - (153 * mp + 2) / 5 + 1;
    let mese = if mp < 10 { mp + 3 } else { mp - 9 };
    let anno = yoe + era * 400 + i64::from(mese <= 2);
    format!(
        "{anno:04}-{mese:02}-{giorno:02}T{:02}:{:02}:{:02}.{millesimi:03}Z",
        resto / 3_600,
        resto % 3_600 / 60,
        resto % 60
    )
}

/// Un id di messaggio: un UUID versione 4, come `crypto.randomUUID()`.
fn nuovo_id() -> Esito<String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|e| ErroreNucleo::Mls(e.to_string()))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}

/// Da come la conversazione nomina un membro a come lo nomina MLS: chi abita
/// altrove ha per id `remote:<casa>:<username>`, chi abita qui un id locale.
fn casa_di(autore: &Autore, casa_mia: &str) -> String {
    let mut pezzi = autore.id.split(':');
    match (pezzi.next(), pezzi.next()) {
        (Some("remote"), Some(casa)) => casa.to_string(),
        _ => casa_mia.to_string(),
    }
}

fn membro_di(autore: &Autore, casa_mia: &str) -> String {
    format!("{}@{}", autore.username, casa_di(autore, casa_mia))
}

/// La forma del contenuto dentro la voce: `Contenuto` di `conversazione.ts`.
/// `v` c'è perché un giorno cambierà.
fn scrivi_contenuto(testo: &str, risponde: Option<&str>, evento: Option<&Evento>) -> String {
    let mut contenuto = json!({ "t": testo, "v": 1 });
    if let Some(risponde) = risponde {
        contenuto["r"] = json!(risponde);
    }
    if let Some(evento) = evento {
        let tipo = match evento.tipo {
            TipoEvento::Ingresso => "ingresso",
            TipoEvento::Rimozione => "rimozione",
            TipoEvento::Uscita => "uscita",
        };
        contenuto["e"] = json!({ "chi": evento.chi, "tipo": tipo });
    }
    contenuto.to_string()
}

struct Contenuto {
    testo: String,
    risponde: Option<String>,
    evento: Option<Evento>,
}

/// `None` per una voce aperta ma non nella forma che questo client conosce:
/// non si mostra come se fosse testo, si dice che non si apre.
fn leggi_contenuto(testo: &str) -> Option<Contenuto> {
    let letto: Value = serde_json::from_str(testo).ok()?;
    if letto.get("v")?.as_f64() != Some(1.0) {
        return None;
    }
    let evento = letto.get("e").and_then(|e| {
        let tipo = match e.get("tipo")?.as_str()? {
            "ingresso" => TipoEvento::Ingresso,
            "rimozione" => TipoEvento::Rimozione,
            "uscita" => TipoEvento::Uscita,
            _ => return None,
        };
        Some(Evento {
            tipo,
            chi: e.get("chi")?.as_str()?.to_string(),
        })
    });
    Some(Contenuto {
        testo: letto.get("t")?.as_str()?.to_string(),
        risponde: letto.get("r").and_then(Value::as_str).map(str::to_string),
        evento,
    })
}

/// L'albero accanto ai membri: `confronta` di `gruppo.ts`.
struct Confronto {
    /// Chi ha una foglia e non è fra i membri.
    estranei: Vec<String>,
    /// Chi è fra i membri e non ha una foglia.
    assenti: Vec<String>,
}

fn confronta(foglie: &[Foglia], attesi: &[String]) -> Confronto {
    let mut nell_albero: Vec<&String> = Vec::new();
    for foglia in foglie {
        if !nell_albero.contains(&&foglia.membro) {
            nell_albero.push(&foglia.membro);
        }
    }
    Confronto {
        estranei: nell_albero
            .iter()
            .filter(|m| !attesi.contains(m))
            .map(|m| (*m).clone())
            .collect(),
        assenti: attesi
            .iter()
            .filter(|m| !nell_albero.contains(m))
            .cloned()
            .collect(),
    }
}

/// In un gruppo crea chi nomina: il creatore, o un amministratore se un
/// creatore non c'è più. È `nomina` di `gruppi/logica.ts`.
fn nomina(vista: &ConversazioneVista, id: &str) -> bool {
    if vista.congelata {
        return false;
    }
    let ruolo = vista.ruoli.get(id).map(String::as_str).unwrap_or("membro");
    let c_e_un_creatore = vista.ruoli.values().any(|r| r == "creatore");
    ruolo == "creatore" || (!c_e_un_creatore && ruolo == "amministratore")
}

/// Chi crea il gruppo MLS: in una chat a due chi sta nella casa che ordina; in
/// un gruppo **chi l'ha creato**, e gli altri aspettano anche dalla stessa
/// casa. Un gruppo creato da due parti è una corsa che uno dei due perde.
fn crea_qui(vista: &ConversazioneVista, io: &str) -> bool {
    vista.ordinata_qui && (!vista.gruppo || nomina(vista, io))
}

/* ---------- il motore ---------- */

/// La sessione, sopra un'[`Istanza`] qualunque: la Casa vera dentro
/// [`Sessioni`], quella finta nei test.
pub struct Motore<I: Istanza> {
    istanza: Arc<I>,
    dispositivo: Arc<Dispositivo>,
    registro: Arc<RegistroDellIstanza<I>>,
    deposito: Arc<dyn Deposito>,
    io: ChiSono,
    /// `<username>@<casa>`: come MLS nomina questa persona.
    membro: String,
    registrato: Mutex<DispositivoRegistrato>,
    taccuino: Mutex<Taccuino>,
    aperte: Mutex<HashMap<String, Aperta>>,
    /// Una cosa alla volta: due giri insieme sulla stessa conversazione si
    /// pesterebbero i piedi sullo stato del gruppo (`inSerie` in `Messaggi.tsx`).
    in_serie: tokio::sync::Mutex<()>,
}

impl<I: Istanza> Motore<I> {
    /// Prepara il dispositivo, come `preparaDispositivo` sul web: chiede alla
    /// Casa chi si è, apre o crea l'identità MLS, registra la chiave di firma
    /// e tiene piena la scorta di KeyPackage.
    pub async fn apri(istanza: Arc<I>, deposito: Arc<dyn Deposito>) -> Esito<Self> {
        let io = istanza.chi_sono().await?;
        let membro = format!("{}@{}", io.username, io.casa);
        let registro = Arc::new(RegistroDellIstanza {
            istanza: istanza.clone(),
            runtime: tokio::runtime::Handle::current(),
            per_questa_validazione: Mutex::default(),
        });
        let dispositivo = Dispositivo::apri(membro.clone(), deposito.clone(), registro.clone())?;
        let taccuino = match deposito.leggi(NOME_APPUNTI.into())? {
            Some(byte) => serde_json::from_slice(&byte)
                .map_err(|_| ErroreNucleo::Deposito("appunti della sessione illeggibili".into()))?,
            None => Taccuino::default(),
        };
        let chiave = dispositivo.chiave_di_firma();
        // La prova di possesso costa una firma e un giro in più, e la si
        // manda sempre, come il web: la Casa la guarda solo quando la chiave è
        // già approvata, cioè quando chi rientra da una sessione nuova deve
        // dimostrare di averla. Una Casa senza la rotta, o che non risponde
        // alla sfida, riceve la chiave senza prova: aspetta il sì come le altre.
        let prova = match istanza.sfida().await {
            Ok(sfida) => dispositivo
                .firma_la_prova(messaggio_di_prova(&sfida, &b64(&chiave)).as_bytes())
                .ok(),
            Err(_) => None,
        };
        let registrato = istanza.registra_chiave(&chiave, prova.as_deref()).await?;
        let motore = Motore {
            istanza,
            dispositivo,
            registro,
            deposito,
            io,
            membro,
            registrato: Mutex::new(registrato),
            taccuino: Mutex::new(taccuino),
            aperte: Mutex::default(),
            in_serie: tokio::sync::Mutex::new(()),
        };
        motore.riempi_la_scorta().await?;
        Ok(motore)
    }

    pub fn io(&self) -> Io {
        let registrato = self.registrato.lock().unwrap().clone();
        Io {
            id: self.io.id.clone(),
            username: self.io.username.clone(),
            casa: self.io.casa.clone(),
            dispositivo: registrato.id,
            approvato: registrato.approvato,
            codice: codice_di(&b64(&self.dispositivo.chiave_di_firma())),
        }
    }

    /// Il [`Dispositivo`] che sta sotto. Per i test e per le prove: l'app non
    /// lo riceve.
    pub fn dispositivo(&self) -> &Arc<Dispositivo> {
        &self.dispositivo
    }

    /* ----- gli appunti ----- */

    fn annota<T>(&self, f: impl FnOnce(&mut Taccuino) -> T) -> Esito<T> {
        let mut taccuino = self.taccuino.lock().unwrap();
        let esito = f(&mut taccuino);
        let byte = serde_json::to_vec(&*taccuino)
            .map_err(|e| ErroreNucleo::Deposito(format!("appunti: {e}")))?;
        self.deposito.scrivi(NOME_APPUNTI.into(), byte)?;
        Ok(esito)
    }

    fn cursore(&self, conversazione: &str) -> Option<String> {
        let taccuino = self.taccuino.lock().unwrap();
        taccuino
            .conversazioni
            .get(conversazione)
            .and_then(|a| a.cursore.clone())
    }

    fn sospeso(&self, conversazione: &str) -> Option<Sospeso> {
        let taccuino = self.taccuino.lock().unwrap();
        taccuino
            .conversazioni
            .get(conversazione)
            .and_then(|a| a.sospeso.clone())
    }

    fn scrivi_cursore(&self, conversazione: &str, cursore: &str) -> Esito<()> {
        self.annota(|t| {
            t.conversazioni
                .entry(conversazione.to_string())
                .or_default()
                .cursore = Some(cursore.to_string());
        })
    }

    fn scrivi_sospeso(&self, conversazione: &str, sospeso: Option<Sospeso>) -> Esito<()> {
        if sospeso.is_none() && self.sospeso(conversazione).is_none() {
            return Ok(());
        }
        self.annota(|t| {
            t.conversazioni
                .entry(conversazione.to_string())
                .or_default()
                .sospeso = sospeso;
        })
    }

    /// Via lo stato di un gruppo che nessun altro conosce, e i suoi appunti.
    fn dimentica(&self, conversazione: &str) -> Esito<()> {
        self.dispositivo.dimentica(conversazione)?;
        self.annota(|t| {
            t.conversazioni.remove(conversazione);
        })
    }

    /* ----- il dispositivo ----- */

    /// Un'operazione del [`Dispositivo`] che può interrogare il registro:
    /// gira fuori dal runtime, perché lì dentro la risposta si aspetta.
    async fn fuori<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Dispositivo) -> Esito<T> + Send + 'static,
    ) -> Esito<T> {
        self.registro.per_questa_validazione.lock().unwrap().clear();
        let dispositivo = self.dispositivo.clone();
        let esito = tokio::task::spawn_blocking(move || f(&dispositivo))
            .await
            .map_err(|e| ErroreNucleo::Mls(format!("operazione interrotta: {e}")));
        self.registro.per_questa_validazione.lock().unwrap().clear();
        esito?
    }

    /// Tiene pubblicati [`SCORTA`] KeyPackage per questo dispositivo: ognuno
    /// vale un invito, e l'istanza lo consuma quando qualcuno lo preleva.
    async fn riempi_la_scorta(&self) -> Esito<()> {
        let dispositivo = self.registrato.lock().unwrap().id.clone();
        let gia = {
            let taccuino = self.taccuino.lock().unwrap();
            if taccuino.dispositivo.as_deref() == Some(dispositivo.as_str()) {
                taccuino.scorta
            } else {
                0
            }
        };
        if gia >= SCORTA {
            return Ok(());
        }
        let nuovi = self.dispositivo.nuovi_pacchetti(SCORTA - gia)?;
        self.istanza.pubblica_pacchetti(nuovi).await?;
        self.annota(|t| {
            t.dispositivo = Some(dispositivo);
            t.scorta = SCORTA;
        })
    }

    /// La propria chiave di firma è nel registro della Casa?
    ///
    /// Chi crea un gruppo o rientra porta **da sé** la propria foglia davanti
    /// agli altri, che la autenticano contro il registro: una chiave che
    /// aspetta ancora il sì verrebbe rifiutata da tutti, e il suo commit
    /// resterebbe in fila davanti a ogni altro.
    async fn richiedi_il_si(&self) -> Esito<()> {
        let mia = self.dispositivo.chiave_di_firma();
        let approvato = self
            .istanza
            .chiavi_di_firma(&self.membro)
            .await?
            .contains(&mia);
        self.registrato.lock().unwrap().approvato = approvato;
        if approvato {
            Ok(())
        } else {
            Err(ErroreNucleo::DispositivoInAttesa)
        }
    }

    /* ----- la sincronizzazione ----- */

    /// Applica gli handshake che mancano, **in ordine e uno alla volta**.
    ///
    /// Il cursore avanza solo su ciò che è stato applicato davvero: se un
    /// commit non si applica ci si ferma lì, perché saltarlo lascerebbe lo
    /// stato a un'epoch che il resto del gruppo ha già superato, e da lì non
    /// si torna indietro. Lo stato lo salva il `Dispositivo` a ogni commit,
    /// **prima** del cursore: un cursore rimasto indietro rilegge buste già
    /// applicate e le salta, uno andato avanti ne perderebbe.
    ///
    /// Dice se questo dispositivo risulta tolto dal gruppo.
    async fn sincronizza(&self, conversazione: &str) -> Esito<bool> {
        if !self.dispositivo.nel_gruppo(conversazione)? {
            return Ok(true);
        }

        let mut cursore = self.cursore(conversazione);
        let mut mutato = false;
        let mut tolto = false;
        let mut ripreso: Option<Sospeso> = None;

        loop {
            let pagina = self
                .istanza
                .handshake_dopo(conversazione, cursore.as_deref())
                .await?;
            if pagina.handshake.is_empty() {
                break;
            }

            let mut ultimo_applicato: Option<&str> = None;
            let mut guasto = None;
            for voce in &pagina.handshake {
                // Un Welcome non si «applica»: o si è già dentro, o si entra,
                // e in quel caso non si passa di qui. Un commit di un'epoch
                // già superata è nostro, o è vecchio: non si riapplica.
                if voce.tipo != TipoBusta::Welcome
                    && !tolto
                    && voce.epoch > self.dispositivo.epoch(conversazione.into())?
                {
                    match self.applica(conversazione, voce).await {
                        Ok(Applicato::Uscito) => {
                            mutato = true;
                            tolto = true;
                        }
                        Ok(Applicato::Commit { proprio }) => {
                            mutato = true;
                            if proprio.is_some() {
                                ripreso = proprio;
                            }
                        }
                        Ok(Applicato::Altro) => {}
                        Err(e) => {
                            guasto = Some(e);
                            break;
                        }
                    }
                }
                ultimo_applicato = Some(&voce.id);
            }

            if let Some(ultimo) = ultimo_applicato {
                self.scrivi_cursore(conversazione, ultimo)?;
            }
            if let Some(guasto) = guasto {
                return Err(guasto);
            }
            match pagina.prossimo {
                Some(prossimo) => cursore = Some(prossimo),
                None => break,
            }
        }

        if tolto {
            // Chi è stato tolto non ha più niente da riavvolgere né da
            // pubblicare: lo stato resta com'è, a dire che cosa è successo.
            self.scrivi_sospeso(conversazione, None)?;
            return Ok(true);
        }

        // Un commit proprio che la fila non ha mai visto: il deposito non era
        // arrivato. Si butta, e lo stato resta all'epoch che tutti conoscono.
        if self.sospeso(conversazione).is_some() {
            if self.dispositivo.cambio_in_sospeso(conversazione)? {
                self.dispositivo.annulla_cambio(conversazione)?;
            }
            self.scrivi_sospeso(conversazione, None)?;
        }

        if mutato {
            self.dopo_il_cambio_di_epoch(conversazione).await?;
        }
        // Il commit era nostro, ed era arrivato: si finisce ciò che l'app
        // chiusa aveva lasciato a metà.
        if let Some(sospeso) = ripreso {
            self.consegna_welcome(conversazione, &sospeso).await?;
        }
        Ok(false)
    }

    async fn applica(&self, conversazione: &str, voce: &BustaHandshake) -> Esito<Applicato> {
        let busta = da_b64(&voce.busta)?;
        let sospeso = self.sospeso(conversazione);
        // Il proprio commit si riconosce byte per byte.
        let proprio = sospeso.clone().filter(|s| s.busta == voce.busta);
        let e_proprio = proprio.is_some();
        let conv = conversazione.to_string();
        let ricevuto = self
            .fuori(move |d| d.applica_in_fila(&conv, &busta, e_proprio.then_some(&busta[..])))
            .await?;
        Ok(match ricevuto {
            Ricevuto::Uscito => Applicato::Uscito,
            Ricevuto::Commit { .. } => {
                // Qualunque commit applicato chiude quello in sospeso: o era
                // lui, o un altro ha preso la sua epoch.
                if sospeso.is_some() {
                    self.scrivi_sospeso(conversazione, None)?;
                }
                Applicato::Commit { proprio }
            }
            Ricevuto::Messaggio { .. } | Ricevuto::Proposta => Applicato::Altro,
        })
    }

    /// Quello che si fa quando l'epoch cambia: il mazzo si riavvolge, e il
    /// punto da cui si rientra si aggiorna. Lo fa **chiunque** noti il cambio,
    /// non solo chi ha fatto il commit: l'istanza non lascia tornare indietro
    /// l'epoch, quindi due depositi insieme non fanno vincere il più vecchio.
    async fn dopo_il_cambio_di_epoch(&self, conversazione: &str) -> Esito<()> {
        // Chi non conosce il mazzo riceve `None` e non lo riavvolge: lo
        // sostituirebbe (regola 4).
        if let Some(avvolto) = self.dispositivo.mazzo_avvolto(conversazione.into())? {
            self.istanza.salva_mazzo(conversazione, avvolto).await?;
        }
        let punto = PuntoDiRientro {
            group_info: b64(&self.dispositivo.punto_di_rientro(conversazione.into())?),
            epoch: self.dispositivo.epoch(conversazione.into())?,
        };
        self.istanza
            .salva_punto_di_rientro(conversazione, punto)
            .await
    }

    /// Apre il mazzo dell'istanza, se è dell'epoch in cui si è. **Non si crea
    /// mai un mazzo nuovo qui**: lo fa soltanto chi crea il gruppo.
    async fn apri_il_mazzo(&self, conversazione: &str) -> Esito<()> {
        if let Some(avvolto) = self.istanza.mazzo(conversazione).await? {
            self.dispositivo.apri_mazzo(conversazione.into(), avvolto)?;
        }
        Ok(())
    }

    /// Riprende una conversazione che esiste già su questo dispositivo.
    /// `None` se non c'è; altrimenti dice se si risulta tolti.
    async fn riprendi(&self, conversazione: &str) -> Esito<Option<bool>> {
        if !self.dispositivo.conosce(conversazione) {
            return Ok(None);
        }
        if !self.dispositivo.nel_gruppo(conversazione)? {
            return Ok(Some(true));
        }

        // Un gruppo all'epoch 0 è una creazione che non si sa se è arrivata:
        // l'app si è chiusa, o la rete è caduta, a metà di `apri_con`. Vale
        // soltanto se il primo commit in fila è proprio quello rimasto in
        // sospeso; altrimenti è un gruppo che nessun altro conosce, e si butta.
        if self.dispositivo.epoch(conversazione.into())? == 0 {
            let sospeso = self.sospeso(conversazione);
            let prima = self.istanza.handshake_dopo(conversazione, None).await?;
            let primo = prima.handshake.iter().find(|h| h.tipo == TipoBusta::Commit);
            let nostro = matches!((&sospeso, primo), (Some(s), Some(h)) if s.busta == h.busta);
            if !nostro {
                self.dimentica(conversazione)?;
                return Ok(None);
            }
        }

        // Il mazzo si apre **prima** di sincronizzare, se è ancora all'epoch
        // del proprio stato, e si riprova dopo, all'epoch raggiunta: è il caso
        // di chi ritrova il mazzo già riavvolto da altri.
        self.apri_il_mazzo(conversazione).await?;
        if self.sincronizza(conversazione).await? {
            return Ok(Some(true));
        }
        if !self.dispositivo.ha_archivio(conversazione.into()) {
            self.apri_il_mazzo(conversazione).await?;
        }
        Ok(Some(false))
    }

    /* ----- entrare, creare, rientrare ----- */

    /// Entra da un Welcome trovato sul canale. `false` quando quel Welcome non
    /// chiama nessuna chiave di questo dispositivo.
    async fn entra(&self, conversazione: &str, welcome: &BustaHandshake) -> Esito<bool> {
        let busta = da_b64(&welcome.busta)?;
        let attesa = conversazione.to_string();
        if self
            .fuori(move |d| d.entra_se_chiamato(&busta, Some(&attesa)))
            .await?
            .is_none()
        {
            return Ok(false);
        }
        self.apri_il_mazzo(conversazione).await?;
        let cursore = welcome.id.clone();
        self.annota(|t| {
            let appunti = t
                .conversazioni
                .entry(conversazione.to_string())
                .or_default();
            appunti.cursore = Some(cursore);
            appunti.sospeso = None;
            // Il KeyPackage che il Welcome ha chiamato è speso.
            t.scorta = t.scorta.saturating_sub(1);
        })?;
        Ok(true)
    }

    /// Un Welcome solo chiama tutti quelli che entrano: va a ciascuno di loro.
    async fn consegna_welcome(&self, conversazione: &str, sospeso: &Sospeso) -> Esito<()> {
        let Some(welcome) = &sospeso.welcome else {
            return Ok(());
        };
        for destinatario in &sospeso.destinatari {
            self.istanza
                .deposita_handshake(
                    conversazione,
                    BustaDaDepositare {
                        tipo: TipoBusta::Welcome,
                        epoch: sospeso.epoch,
                        busta: welcome.clone(),
                        destinatario: Some(destinatario.clone()),
                    },
                )
                .await?;
        }
        Ok(())
    }

    /// Un commit che cambia le foglie, portato fino in fondo: in fila, poi
    /// applicato, con il mazzo riavvolto e gli inviti consegnati.
    ///
    /// **In fila prima di applicarlo**: uno stato che la fila ha rifiutato è
    /// un gruppo che nessun altro conosce. Se la fila dice 409 il commit si
    /// butta e l'errore torna a chi chiama, che si rimette in pari. Se la
    /// risposta non arriva non si sa com'è andata: il commit resta in sospeso,
    /// e lo scioglie la prossima sincronizzazione.
    async fn proponi(
        &self,
        conversazione: &str,
        entrano: &[Ingresso],
        escono: &[u32],
    ) -> Esito<()> {
        let conv = conversazione.to_string();
        let pacchetti: Vec<Vec<u8>> = entrano.iter().map(|i| i.pacchetto.clone()).collect();
        let uscenti = escono.to_vec();
        let cambio = self
            .fuori(move |d| d.prepara_cambio(&conv, &pacchetti, &uscenti))
            .await?;

        let mut destinatari: Vec<String> = Vec::new();
        for ingresso in entrano {
            if !destinatari.contains(&ingresso.destinatario) {
                destinatari.push(ingresso.destinatario.clone());
            }
        }
        let sospeso = Sospeso {
            busta: b64(&cambio.commit),
            epoch: cambio.epoch,
            welcome: cambio.welcome.as_deref().map(b64),
            destinatari,
        };
        self.scrivi_sospeso(conversazione, Some(sospeso.clone()))?;

        let deposito = self
            .istanza
            .deposita_handshake(
                conversazione,
                BustaDaDepositare {
                    tipo: TipoBusta::Commit,
                    epoch: sospeso.epoch,
                    busta: sospeso.busta.clone(),
                    destinatario: None,
                },
            )
            .await;
        if let Err(causa) = deposito {
            if superata(&causa) {
                self.dispositivo.annulla_cambio(conversazione)?;
                self.scrivi_sospeso(conversazione, None)?;
            }
            return Err(causa);
        }

        // A ogni rimozione la catena guadagna una chiave (ADR 0052 §2), e lo
        // stato si salva: lo fa `conferma_cambio`.
        self.dispositivo.conferma_cambio(conversazione)?;
        self.scrivi_sospeso(conversazione, None)?;
        // Prima il mazzo, poi gli inviti: chi entra lo trova già avvolto
        // sotto l'epoch del suo Welcome, e legge subito.
        self.dopo_il_cambio_di_epoch(conversazione).await?;
        self.consegna_welcome(conversazione, &sospeso).await
    }

    /// Crea la conversazione e ci fa entrare chi c'è: uno in una chat a due,
    /// tutti quelli che hanno un dispositivo in un gruppo. Il mazzo nasce qui,
    /// e soltanto qui.
    async fn apri_con(&self, conversazione: &str, ingressi: &[Ingresso]) -> Esito<()> {
        if ingressi.is_empty() {
            return Err(ErroreNucleo::Formato(
                "una conversazione non si apre da soli".into(),
            ));
        }
        self.richiedi_il_si().await?;
        self.dispositivo
            .crea_conversazione(conversazione.to_string())?;
        match self.proponi(conversazione, ingressi, &[]).await {
            Ok(()) => Ok(()),
            Err(causa) => {
                // Se il commit è rimasto in sospeso non si sa se è in fila:
                // lo dirà `riprendi`. In ogni altro caso questo gruppo non lo
                // conosce nessuno, e non deve restare.
                if self.sospeso(conversazione).is_none() {
                    self.dimentica(conversazione)?;
                }
                Err(causa)
            }
        }
    }

    /// Rientra dal punto pubblicato, con una foglia nuova (S3, via A). `false`
    /// se la conversazione non ha un punto di rientro.
    ///
    /// **Si torna nel gruppo, non ancora nella cronologia**: il mazzo è
    /// avvolto sotto l'epoch di prima, e si riapre quando un altro membro
    /// applica il commit di rientro e lo riavvolge.
    async fn rientra_in(&self, conversazione: &str) -> Esito<bool> {
        let Some(punto) = self.istanza.punto_di_rientro(conversazione).await? else {
            return Ok(false);
        };
        self.richiedi_il_si().await?;
        let group_info = da_b64(&punto.group_info)?;
        let tornata = match self.fuori(move |d| d.rientra(group_info)).await {
            Ok(tornata) if tornata.conversazione == conversazione => tornata,
            Ok(altra) => {
                self.dimentica(&altra.conversazione)?;
                return Err(ErroreNucleo::Formato(
                    "il punto di rientro è di un'altra conversazione".into(),
                ));
            }
            Err(causa) => {
                self.dimentica(conversazione)?;
                return Err(causa);
            }
        };
        let deposito = self
            .istanza
            .deposita_handshake(
                conversazione,
                BustaDaDepositare {
                    tipo: TipoBusta::Commit,
                    epoch: tornata.epoch,
                    busta: b64(&tornata.commit),
                    destinatario: None,
                },
            )
            .await;
        if let Err(causa) = deposito {
            // Un rientro che la fila non ha preso è uno stato che nessun
            // altro conosce: si ricomincia dal punto di rientro di allora.
            self.dimentica(conversazione)?;
            return Err(causa);
        }
        Ok(true)
    }

    /* ----- le foglie ----- */

    /// `calcola` riceve l'albero **su cui il commit verrà costruito** e dice
    /// che cosa cambiare: si richiama a ogni tentativo, perché se un altro è
    /// arrivato prima ci si rimette in pari e il cambio va ricalcolato. Se
    /// non c'è niente da cambiare non parte nessun commit.
    async fn commit_di_foglie(
        &self,
        conversazione: &str,
        calcola: impl Fn(&[Foglia]) -> (Vec<Ingresso>, Vec<u32>),
    ) -> Esito<()> {
        let mut tolto = self.sincronizza(conversazione).await?;
        let mut tentativo = 1;
        loop {
            if tolto {
                return Err(ErroreNucleo::FuoriDalGruppo);
            }
            let (entrano, escono) = calcola(&self.dispositivo.foglie(conversazione)?);
            if entrano.is_empty() && escono.is_empty() {
                return Ok(());
            }
            match self.proponi(conversazione, &entrano, &escono).await {
                Ok(()) => return Ok(()),
                Err(causa) if superata(&causa) && tentativo < TENTATIVI => {
                    tentativo += 1;
                    tolto = self.sincronizza(conversazione).await?;
                }
                Err(causa) => return Err(causa),
            }
        }
    }

    /// Aggiunge le foglie di un membro: una per ogni chiave d'ingresso, cioè
    /// una per dispositivo.
    ///
    /// Con `al_posto_delle_vecchie`, le foglie che quella persona ha già
    /// escono **nello stesso commit**: è la riammissione. Le foglie che
    /// firmano con una delle chiavi che stanno entrando escono comunque,
    /// perché MLS non accetta due volte la stessa chiave.
    ///
    /// Ogni chiave d'ingresso dev'essere **di quella persona**.
    async fn aggiungi_foglie(
        &self,
        conversazione: &str,
        membro: &str,
        ingressi: Vec<Ingresso>,
        al_posto_delle_vecchie: bool,
    ) -> Esito<()> {
        let mut stesse_chiavi = Vec::new();
        for ingresso in &ingressi {
            let (suo, chiave) = di_chi_e(&ingresso.pacchetto)?;
            if suo != membro {
                return Err(ErroreNucleo::ChiaveDiUnAltro);
            }
            stesse_chiavi.push(chiave);
        }
        self.commit_di_foglie(conversazione, |foglie| {
            let escono = foglie
                .iter()
                .filter(|f| f.membro == membro)
                .filter(|f| al_posto_delle_vecchie || stesse_chiavi.contains(&f.chiave_di_firma))
                .map(|f| f.indice)
                .collect();
            (ingressi.clone(), escono)
        })
        .await
    }

    /// Toglie le foglie di alcuni membri: tutte, o soltanto quelle che
    /// firmano con `solo_chiavi`. La catena d'archivio guadagna una chiave che
    /// chi è uscito non ottiene: **non riceverà più i messaggi nuovi**. Quelli
    /// che ha già letto li ha letti.
    async fn togli_foglie(
        &self,
        conversazione: &str,
        membri: &[String],
        solo_chiavi: Option<&[Vec<u8>]>,
    ) -> Esito<()> {
        self.commit_di_foglie(conversazione, |foglie| {
            let escono = foglie
                .iter()
                .filter(|f| membri.contains(&f.membro))
                .filter(|f| solo_chiavi.is_none_or(|k| k.contains(&f.chiave_di_firma)))
                .map(|f| f.indice)
                .collect();
            (Vec::new(), escono)
        })
        .await
    }

    /// Rimette l'albero d'accordo con chi è nel gruppo: `allinea` di
    /// `conversazione.ts`.
    ///
    /// Si toglie soltanto ciò di cui si è **certi**: chi risulta tolto, e,
    /// dalla casa che ordina un gruppo, chiunque abbia una foglia senza essere
    /// fra i membri. Altrove un nome sconosciuto può essere qualcuno appena
    /// entrato di cui la notizia non è ancora arrivata: lì si **dice**, e
    /// finché resta non si scrive.
    async fn allinea(&self, conversazione: &str, vista: &ConversazioneVista) -> Esito<Confronto> {
        let attesi = self.attesi(vista);
        let prima = confronta(&self.dispositivo.foglie(conversazione)?, &attesi);
        let autorevole = vista.ordinata_qui && vista.gruppo;
        let da_togliere: Vec<String> = prima
            .estranei
            .iter()
            .filter(|m| autorevole || vista.rimossi.contains(m))
            .cloned()
            .collect();
        if da_togliere.is_empty() {
            return Ok(prima);
        }
        self.togli_foglie(conversazione, &da_togliere, None).await?;
        Ok(confronta(&self.dispositivo.foglie(conversazione)?, &attesi))
    }

    /// Rimette d'accordo **le proprie foglie** con il registro della propria
    /// casa: è il «sì» e la revoca di ADR 0040 che arrivano dentro le
    /// conversazioni (`allineaMieiDispositivi`).
    ///
    /// Un dispositivo che nel registro non c'è non tocca niente: non è lui a
    /// decidere.
    async fn allinea_i_miei_dispositivi(&self, conversazione: &str) -> Esito<()> {
        let registro = self.istanza.chiavi_di_firma(&self.membro).await?;
        let mia = self.dispositivo.chiave_di_firma();
        if !registro.contains(&mia) {
            return Ok(());
        }
        let questa = self.dispositivo.mia_foglia(conversazione)?;
        let mie: Vec<Foglia> = self
            .dispositivo
            .foglie(conversazione)?
            .into_iter()
            .filter(|f| f.membro == self.membro)
            .collect();

        // Una foglia mia che il registro non riconosce più esce, e la catena
        // ruota: il telefono rubato non legge il seguito.
        let vecchie: Vec<Vec<u8>> = mie
            .iter()
            .filter(|f| f.indice != questa && !registro.contains(&f.chiave_di_firma))
            .map(|f| f.chiave_di_firma.clone())
            .collect();
        if !vecchie.is_empty() {
            self.togli_foglie(
                conversazione,
                std::slice::from_ref(&self.membro),
                Some(&vecchie),
            )
            .await?;
        }

        // Un dispositivo approvato che nell'albero non c'è entra.
        let mancanti: Vec<Vec<u8>> = registro
            .into_iter()
            .filter(|r| !mie.iter().any(|f| &f.chiave_di_firma == r))
            .collect();
        if mancanti.is_empty() {
            return Ok(());
        }
        // Si fa entrare soltanto ciò che si è chiesto: una chiave d'ingresso
        // che firma con un'altra chiave, o che nomina un'altra persona, resta
        // fuori.
        let ingressi: Vec<Ingresso> = self
            .istanza
            .miei_pacchetti(&mancanti)
            .await?
            .into_iter()
            .filter(|p| {
                di_chi_e(p)
                    .is_ok_and(|(suo, chiave)| suo == self.membro && mancanti.contains(&chiave))
            })
            .map(|pacchetto| Ingresso {
                pacchetto,
                destinatario: self.io.id.clone(),
            })
            .collect();
        if ingressi.is_empty() {
            return Ok(());
        }
        self.aggiungi_foglie(conversazione, &self.membro, ingressi, false)
            .await
    }

    /* ----- scrivere e leggere ----- */

    /// Scrive: la voce va nell'archivio della propria casa, e basta. È tutto
    /// l'invio (ADR 0043 §2): nessuna busta di trasporto parte, perché
    /// consegnarla in casa d'altri sarebbe la copia che quell'ADR vieta.
    ///
    /// Senza catena non si scrive, e chi scrive lo dice la propria foglia: lo
    /// garantisce `Dispositivo::archivia`.
    async fn deposita_voce(
        &self,
        conversazione: &str,
        contenuto: String,
        id: &str,
        quando: &str,
    ) -> Esito<()> {
        let voce = self.dispositivo.archivia(
            conversazione.to_string(),
            contenuto,
            id.to_string(),
            quando.to_string(),
        )?;
        self.istanza
            .deposita_archivio(
                conversazione,
                vec![VoceDaDepositare {
                    id: id.to_string(),
                    voce,
                    creato_il: quando.to_string(),
                }],
            )
            .await
    }

    /// Scrive nella conversazione che cosa è successo al gruppo. Se non
    /// riesce il gesto è fatto lo stesso: è un racconto, non il gesto. Dice
    /// l'id della voce, se è partita.
    async fn racconta(&self, conversazione: &str, tipo: TipoEvento, chi: &str) -> Option<String> {
        let evento = Evento {
            tipo,
            chi: chi.to_string(),
        };
        let id = nuovo_id().ok()?;
        let contenuto = scrivi_contenuto("", None, Some(&evento));
        self.deposita_voce(conversazione, contenuto, &id, &adesso())
            .await
            .ok()?;
        Some(id)
    }

    /// Una pagina di cronologia, dalla più recente, decifrata con la catena.
    /// Il testo esiste soltanto qui, in memoria: non si scrive da nessuna
    /// parte (ADR 0043 §5).
    async fn pagina(&self, conversazione: &str, prima: Option<&str>) -> Esito<Pagina> {
        let remota = self.istanza.cronologia(conversazione, prima).await?;
        let messaggi = remota
            .righe
            .into_iter()
            .map(|riga| {
                let vuoto = |stato| Messaggio {
                    id: riga.id.clone(),
                    creato_il: riga.creato_il.clone(),
                    mio: riga.mittente.as_deref() == Some(self.membro.as_str()),
                    mittente: riga.mittente.clone(),
                    stato,
                    testo: None,
                    attestato: false,
                    risponde: None,
                    evento: None,
                };
                let Some(voce) = &riga.voce else {
                    return vuoto(StatoMessaggio::NonDisponibile);
                };
                let dichiarato = riga.mittente.as_ref().map(|mittente| Dichiarato {
                    id: riga.id.clone(),
                    mittente: mittente.clone(),
                    creato_il: riga.creato_il.clone(),
                });
                let voce = VoceCifrata {
                    busta: voce.busta.clone(),
                    chiave_n: voce.chiave_n,
                };
                let Some(riletta) =
                    self.dispositivo
                        .rileggi(conversazione.to_string(), voce, dichiarato)
                else {
                    return vuoto(StatoMessaggio::NonSiApre);
                };
                match leggi_contenuto(&riletta.testo) {
                    None => vuoto(StatoMessaggio::NonSiApre),
                    Some(contenuto) => Messaggio {
                        testo: Some(contenuto.testo),
                        attestato: riletta.legata,
                        risponde: contenuto.risponde,
                        evento: contenuto.evento,
                        ..vuoto(StatoMessaggio::Letto)
                    },
                }
            })
            .collect();
        Ok(Pagina {
            messaggi,
            prima: remota.prima,
            non_rispondono: remota.non_rispondono,
        })
    }

    /* ----- le conversazioni ----- */

    fn attesi(&self, vista: &ConversazioneVista) -> Vec<String> {
        vista
            .membri
            .iter()
            .map(|a| membro_di(a, &self.io.casa))
            .collect()
    }

    fn persona(&self, vista: &ConversazioneVista, autore: &Autore) -> Persona {
        Persona {
            id: autore.id.clone(),
            username: autore.username.clone(),
            nome: autore.nome.clone(),
            casa: casa_di(autore, &self.io.casa),
            ruolo: vista.ruoli.get(&autore.id).cloned(),
        }
    }

    fn conversazione_da(&self, vista: &ConversazioneVista) -> Conversazione {
        Conversazione {
            id: vista.id.clone(),
            gruppo: vista.gruppo,
            nome: vista.nome.clone(),
            membri: vista
                .membri
                .iter()
                .map(|a| self.persona(vista, a))
                .collect(),
            non_letti: vista.non_letti,
            creata_il: vista.creata_il.clone(),
            ultimo_messaggio_il: vista.ultimo_messaggio_il.clone(),
            ordinata_qui: vista.ordinata_qui,
            congelata: vista.congelata,
        }
    }

    fn ricorda(&self, vista: &ConversazioneVista) {
        self.aperte
            .lock()
            .unwrap()
            .entry(vista.id.clone())
            .or_default()
            .vista = Some(vista.clone());
    }

    /// La conversazione com'è adesso per la Casa. `None` se la Casa dice che
    /// questa persona ne è stata tolta.
    async fn vista(&self, conversazione: &str) -> Esito<Option<ConversazioneVista>> {
        match self.istanza.conversazione(conversazione).await {
            Ok(vista) => {
                self.ricorda(&vista);
                Ok(Some(vista))
            }
            Err(ErroreNucleo::Casa { stato: 403, codice }) if codice == "rimosso_dal_gruppo" => {
                Ok(None)
            }
            Err(altro) => Err(altro),
        }
    }

    /// Le chiavi d'ingresso di chi si invita, una per ciascun suo dispositivo,
    /// chieste alla sua casa. In un gruppo entra chi ha un dispositivo pronto,
    /// e gli altri restano «non ancora dentro»; se non entra nessuno, la
    /// ragione del primo è la ragione che si dice.
    async fn invito(&self, vista: &ConversazioneVista) -> Esito<Vec<Ingresso>> {
        let mut ingressi = Vec::new();
        let mut prima_causa = None;
        for altro in vista.membri.iter().filter(|m| m.id != self.io.id) {
            match self.chiavi_di(altro).await {
                Ok(suoi) => ingressi.extend(suoi),
                Err(causa) => {
                    prima_causa.get_or_insert(causa);
                }
            }
        }
        if ingressi.is_empty() {
            return Err(prima_causa.unwrap_or(ErroreNucleo::Formato(
                "una conversazione non si apre da soli".into(),
            )));
        }
        Ok(ingressi)
    }

    async fn chiavi_di(&self, autore: &Autore) -> Esito<Vec<Ingresso>> {
        let membro = membro_di(autore, &self.io.casa);
        let ingressi: Vec<Ingresso> = self
            .istanza
            .pacchetti_di(&membro)
            .await?
            .into_iter()
            // Una chiave d'ingresso che nomina un altro non fa entrare nessuno.
            .filter(|p| di_chi_e(p).is_ok_and(|(suo, _)| suo == membro))
            .map(|pacchetto| Ingresso {
                pacchetto,
                destinatario: autore.id.clone(),
            })
            .collect();
        if ingressi.is_empty() {
            return Err(ErroreNucleo::Casa {
                stato: 404,
                codice: "no_device_available".into(),
            });
        }
        Ok(ingressi)
    }

    /// Apre una conversazione su questo dispositivo, dal caso più comune al
    /// più raro: si riprende, si entra da un Welcome, si rientra dal punto di
    /// rientro, e si crea soltanto se tocca a questo dispositivo. È
    /// `apriConversazione` di `conversazione.ts`.
    async fn apri_la(&self, vista: &ConversazioneVista) -> Esito<Apertura> {
        let id = vista.id.as_str();

        // Un gruppo congelato non fa nessun passo oltre il primo: la casa che
        // lo ordinava è persa, e non c'è una coda da leggere né un gruppo da
        // creare. La catena sta già nello stato di questo dispositivo.
        if vista.congelata {
            return Ok(if self.dispositivo.conosce(id) {
                Apertura::Pronta
            } else {
                Apertura::InAttesa
            });
        }

        let ripresa = self.riprendi(id).await?;
        if ripresa == Some(false) {
            return Ok(Apertura::Pronta);
        }

        // Dal più recente. Chi è stato tolto e poi riammesso ha sul canale due
        // inviti: quello di allora, che porta a un'epoch da cui è già stato
        // tolto, e quello nuovo. Per la stessa ragione chi riprende uno stato
        // da cui risulta tolto guarda soltanto gli inviti **venuti dopo**.
        let dopo_di = match ripresa {
            Some(_) => self.dispositivo.epoch(id.to_string())?,
            None => 0,
        };
        // Si scorre **tutta** la fila, non la prima pagina.
        let mut inviti: Vec<BustaHandshake> = Vec::new();
        let mut dopo: Option<String> = None;
        loop {
            let pagina = self.istanza.handshake_dopo(id, dopo.as_deref()).await?;
            let vuota = pagina.handshake.is_empty();
            inviti.extend(
                pagina
                    .handshake
                    .into_iter()
                    .filter(|b| b.tipo == TipoBusta::Welcome && b.epoch > dopo_di),
            );
            match pagina.prossimo {
                Some(prossimo) if !vuota => dopo = Some(prossimo),
                _ => break,
            }
        }
        inviti.sort_by_key(|b| std::cmp::Reverse(b.epoch));
        for busta in &inviti {
            if self.entra(id, busta).await? {
                return Ok(Apertura::Pronta);
            }
        }

        // Tolto, e nessuno l'ha fatto rientrare: non si rientra da soli.
        if ripresa.is_some() {
            return Ok(Apertura::Tolto);
        }

        if self.rientra_in(id).await? {
            return Ok(Apertura::Pronta);
        }

        if !crea_qui(vista, &self.io.id) {
            return Ok(Apertura::InAttesa);
        }

        let ingressi = self.invito(vista).await?;
        match self.apri_con(id, &ingressi).await {
            Ok(()) => Ok(Apertura::Pronta),
            // In una chat a due la crea il primo che la apre: se due la aprono
            // insieme uno dei due perde (ADR 0042 §3), e la fila glielo dice
            // con un 409. Non è un guasto: il suo gruppo è già stato buttato,
            // e l'invito dell'altro sta arrivando.
            Err(causa) if superata(&causa) => Ok(Apertura::InAttesa),
            Err(causa) => Err(causa),
        }
    }

    fn e_aperta(&self, conversazione: &str) -> bool {
        self.dispositivo.conosce(conversazione)
            && self
                .aperte
                .lock()
                .unwrap()
                .get(conversazione)
                .is_some_and(|a| a.pronta)
    }

    fn segna(&self, conversazione: &str, pronta: bool) {
        self.aperte
            .lock()
            .unwrap()
            .entry(conversazione.to_string())
            .or_default()
            .pronta = pronta;
    }

    /* ----- ciò che l'app chiede ----- */

    /// Le conversazioni di questa persona, come le elenca la Casa.
    pub async fn conversazioni(&self) -> Esito<Vec<Conversazione>> {
        let viste = self.istanza.conversazioni().await?;
        Ok(viste.iter().map(|v| self.conversazione_da(v)).collect())
    }

    /// Crea, o ritrova, la conversazione a due con una persona. Il gruppo
    /// cifrato nasce quando la si apre.
    pub async fn crea_diretta(&self, con: PersonaDaInvitare) -> Esito<Conversazione> {
        let vista = self.istanza.crea_diretta(&con).await?;
        self.ricorda(&vista);
        Ok(self.conversazione_da(&vista))
    }

    /// Crea un gruppo: un nome, e almeno altre due persone.
    pub async fn crea_gruppo(
        &self,
        nome: String,
        membri: Vec<PersonaDaInvitare>,
    ) -> Esito<Conversazione> {
        let vista = self.istanza.crea_gruppo(&nome, &membri).await?;
        self.ricorda(&vista);
        Ok(self.conversazione_da(&vista))
    }

    /// Apre una conversazione su questo dispositivo.
    pub async fn apri_conversazione(&self, conversazione: String) -> Esito<Apertura> {
        let _una_alla_volta = self.in_serie.lock().await;
        self.apri_senza_fila(&conversazione).await
    }

    async fn apri_senza_fila(&self, conversazione: &str) -> Esito<Apertura> {
        let apertura = match self.vista(conversazione).await? {
            Some(vista) => self.apri_la(&vista).await?,
            None => Apertura::Tolto,
        };
        self.segna(conversazione, apertura == Apertura::Pronta);
        Ok(apertura)
    }

    /// Un giro completo: si applicano gli handshake arretrati, si riapre il
    /// mazzo se nel frattempo qualcuno l'ha riavvolto, l'albero si mette
    /// accanto ai membri, e si legge l'ultima pagina di cronologia. È `leggi`
    /// di `conversazione.ts`, con davanti l'apertura se non c'è ancora stata.
    pub async fn aggiorna(&self, conversazione: String) -> Esito<Aggiornamento> {
        let _una_alla_volta = self.in_serie.lock().await;
        let id = conversazione.as_str();
        let chiusa = |apertura| Aggiornamento {
            apertura,
            nuovi: Vec::new(),
            pagina: Vec::new(),
            prima: None,
            senza_cronologia: true,
            non_rispondono: Vec::new(),
            estranei: Vec::new(),
            assenti: Vec::new(),
        };

        // Di un gruppo si chiede ogni volta chi c'è: è la domanda a cui la
        // Casa risponde «non sei più in questo gruppo» a chi è stato tolto.
        let Some(vista) = self.vista(id).await? else {
            return Ok(chiusa(Apertura::Tolto));
        };

        let mut confronto = None;
        if !self.e_aperta(id) || !self.dispositivo.nel_gruppo(id)? {
            // Una sessione da cui si risulta tolti si riapre a ogni giro: è lì
            // che si trova l'invito di chi ci ha fatti rientrare.
            let apertura = self.apri_la(&vista).await?;
            self.segna(id, apertura == Apertura::Pronta);
            if apertura != Apertura::Pronta {
                return Ok(chiusa(apertura));
            }
        } else if !vista.congelata {
            // Con la catena in mano basta applicare gli handshake: richiedere
            // il mazzo a ogni giro sarebbe una domanda in più verso la casa
            // che ordina. Senza catena si riprende da capo, perché è lì che si
            // scopre se qualcuno l'ha riavvolta.
            let tolto = if self.dispositivo.ha_archivio(conversazione.clone()) {
                self.sincronizza(id).await?
            } else {
                self.riprendi(id).await? != Some(false)
            };
            if tolto {
                self.segna(id, false);
                return Ok(chiusa(Apertura::Tolto));
            }
        }

        if !vista.congelata {
            // L'albero accanto alle persone, a ogni giro: è qui che la foglia
            // di chi è uscito viene tolta, e che un estraneo si vede.
            confronto = Some(self.allinea(id, &vista).await?);

            // Il «sì» e la revoca dei propri dispositivi (ADR 0040), al più
            // ogni cinque minuti per conversazione e senza fermare la lettura
            // se non riesce.
            let tocca = {
                let mut aperte = self.aperte.lock().unwrap();
                let aperta = aperte.entry(conversazione.clone()).or_default();
                let tocca = aperta
                    .foglie_allineate_il
                    .is_none_or(|quando| quando.elapsed() > ALLINEA_DISPOSITIVI_OGNI);
                if tocca {
                    aperta.foglie_allineate_il = Some(Instant::now());
                }
                tocca
            };
            if tocca {
                let _ = self.allinea_i_miei_dispositivi(id).await;
            }
        }

        let pagina = self.pagina(id, None).await?;
        let nuovi = {
            let mut aperte = self.aperte.lock().unwrap();
            let consegnati = &mut aperte.entry(conversazione.clone()).or_default().consegnati;
            let in_pagina: HashSet<&str> = pagina.messaggi.iter().map(|m| m.id.as_str()).collect();
            consegnati.retain(|id, _| in_pagina.contains(id.as_str()));
            pagina
                .messaggi
                .iter()
                .filter(|m| consegnati.insert(m.id.clone(), m.stato) != Some(m.stato))
                .cloned()
                .collect()
        };
        let confronto = confronto.unwrap_or(Confronto {
            estranei: Vec::new(),
            assenti: Vec::new(),
        });
        Ok(Aggiornamento {
            apertura: Apertura::Pronta,
            nuovi,
            pagina: pagina.messaggi.iter().map(|m| m.id.clone()).collect(),
            prima: pagina.prima,
            senza_cronologia: !self.dispositivo.ha_archivio(conversazione),
            non_rispondono: pagina.non_rispondono,
            estranei: confronto.estranei,
            assenti: confronto.assenti,
        })
    }

    /// Una pagina di cronologia più vecchia (`prima` viene dalla pagina
    /// dopo), o l'ultima. Non applica handshake: lo fa `aggiorna`.
    pub async fn cronologia(&self, conversazione: String, prima: Option<String>) -> Esito<Pagina> {
        let _una_alla_volta = self.in_serie.lock().await;
        if !self.dispositivo.conosce(&conversazione) {
            return Err(ErroreNucleo::ConversazioneSconosciuta(conversazione));
        }
        self.pagina(&conversazione, prima.as_deref()).await
    }

    /// Manda una riga: va nell'archivio della propria casa, e basta. Il testo
    /// e la risposta viaggiano insieme dentro la voce cifrata.
    ///
    /// Se nell'albero c'è chi non è fra i membri la riga **non parte**: chi
    /// ha una foglia apre il mazzo, e scrivere sarebbe scrivere anche a lui.
    pub async fn invia(
        &self,
        conversazione: String,
        testo: String,
        risponde: Option<String>,
    ) -> Esito<Messaggio> {
        let _una_alla_volta = self.in_serie.lock().await;
        let id = conversazione.as_str();
        if !self.e_aperta(id) && self.apri_senza_fila(id).await? != Apertura::Pronta {
            return Err(ErroreNucleo::FuoriDalGruppo);
        }
        let vista = self
            .aperte
            .lock()
            .unwrap()
            .get(id)
            .and_then(|a| a.vista.clone());
        if let Some(vista) = vista {
            let estranei = confronta(&self.dispositivo.foglie(id)?, &self.attesi(&vista)).estranei;
            if !estranei.is_empty() {
                return Err(ErroreNucleo::PresenzaEstranea(estranei.join(", ")));
            }
        }

        let messaggio = Messaggio {
            id: nuovo_id()?,
            creato_il: adesso(),
            mittente: Some(self.membro.clone()),
            mio: true,
            stato: StatoMessaggio::Letto,
            testo: Some(testo.clone()),
            attestato: true,
            risponde: risponde.clone(),
            evento: None,
        };
        let contenuto = scrivi_contenuto(&testo, risponde.as_deref(), None);
        self.deposita_voce(id, contenuto, &messaggio.id, &messaggio.creato_il)
            .await?;
        self.aperte
            .lock()
            .unwrap()
            .entry(conversazione)
            .or_default()
            .consegnati
            .insert(messaggio.id.clone(), StatoMessaggio::Letto);
        Ok(messaggio)
    }

    /// Chi è nella conversazione per la Casa, e con quanti dispositivi è nel
    /// gruppo cifrato su questo dispositivo.
    pub async fn membri(&self, conversazione: String) -> Esito<Vec<MembroDelGruppo>> {
        let _una_alla_volta = self.in_serie.lock().await;
        let id = conversazione.as_str();
        let vista = self.vista(id).await?.ok_or(ErroreNucleo::FuoriDalGruppo)?;
        let foglie = if self.dispositivo.conosce(id) {
            self.dispositivo.foglie(id)?
        } else {
            Vec::new()
        };
        Ok(vista
            .membri
            .iter()
            .map(|autore| {
                let membro = membro_di(autore, &self.io.casa);
                MembroDelGruppo {
                    persona: self.persona(&vista, autore),
                    dispositivi: foglie.iter().filter(|f| f.membro == membro).count() as u32,
                    membro,
                }
            })
            .collect())
    }

    /// Aggiunge una persona a un gruppo, e la fa entrare nel gruppo cifrato.
    ///
    /// Sono due passi, e il secondo può non riuscire: se la persona non ha un
    /// dispositivo pronto resta fra i membri senza leggere, e la si fa
    /// entrare dopo con [`Self::fai_entrare`]. In quel caso l'errore è quello
    /// del secondo passo.
    pub async fn aggiungi_membro(
        &self,
        conversazione: String,
        chi: PersonaDaInvitare,
    ) -> Esito<()> {
        let _una_alla_volta = self.in_serie.lock().await;
        let vista = self
            .istanza
            .aggiungi_al_gruppo(&conversazione, &chi)
            .await?;
        self.ricorda(&vista);
        let casa = chi.casa.as_deref().unwrap_or(&self.io.casa);
        let membro = format!("{}@{casa}", chi.username);
        let autore = vista
            .membri
            .iter()
            .find(|a| membro_di(a, &self.io.casa) == membro)
            .cloned()
            .ok_or(ErroreNucleo::Formato(
                "la Casa non nomina la persona aggiunta".into(),
            ))?;
        self.entra_nel_gruppo(&conversazione, &autore).await
    }

    /// Fa entrare nel gruppo cifrato una persona che è già fra i membri, con
    /// tutti i dispositivi che ha. Se era stata tolta ed è ancora nell'albero,
    /// le sue foglie vecchie escono nello stesso commit.
    pub async fn fai_entrare(&self, conversazione: String, membro_id: String) -> Esito<()> {
        let _una_alla_volta = self.in_serie.lock().await;
        let vista = self
            .vista(&conversazione)
            .await?
            .ok_or(ErroreNucleo::FuoriDalGruppo)?;
        let autore = vista
            .membri
            .iter()
            .find(|a| a.id == membro_id)
            .cloned()
            .ok_or(ErroreNucleo::NonAutenticato(membro_id))?;
        self.entra_nel_gruppo(&conversazione, &autore).await
    }

    async fn entra_nel_gruppo(&self, conversazione: &str, autore: &Autore) -> Esito<()> {
        if !self.dispositivo.conosce(conversazione) {
            return Err(ErroreNucleo::ConversazioneSconosciuta(
                conversazione.to_string(),
            ));
        }
        let membro = membro_di(autore, &self.io.casa);
        let ingressi = self.chiavi_di(autore).await?;
        self.aggiungi_foglie(conversazione, &membro, ingressi, true)
            .await?;
        self.racconta(conversazione, TipoEvento::Ingresso, &membro)
            .await;
        Ok(())
    }

    /// Toglie una persona da un gruppo: prima per la Casa, poi dal gruppo
    /// cifrato, con tutte le sue foglie in un commit. La catena d'archivio
    /// guadagna la chiave che non avrà: è questo che «non riceverà più» vuol
    /// dire.
    ///
    /// Se il secondo passo non riesce la persona non è più fra i membri ma la
    /// sua foglia c'è ancora, e la toglie il prossimo giro di chiunque
    /// ([`Self::aggiorna`]). **Finché c'è, legge**: l'errore lo dice, e va
    /// detto a chi guarda.
    pub async fn togli_membro(&self, conversazione: String, membro_id: String) -> Esito<()> {
        let _una_alla_volta = self.in_serie.lock().await;
        let prima = self
            .vista(&conversazione)
            .await?
            .ok_or(ErroreNucleo::FuoriDalGruppo)?;
        let autore = prima
            .membri
            .iter()
            .find(|a| a.id == membro_id)
            .cloned()
            .ok_or(ErroreNucleo::NonAutenticato(membro_id.clone()))?;
        let vista = self
            .istanza
            .togli_dal_gruppo(&conversazione, &membro_id)
            .await?;
        self.ricorda(&vista);
        if !self.dispositivo.conosce(&conversazione) {
            return Ok(());
        }
        let membro = membro_di(&autore, &self.io.casa);
        self.togli_foglie(&conversazione, std::slice::from_ref(&membro), None)
            .await?;
        self.racconta(&conversazione, TipoEvento::Rimozione, &membro)
            .await;
        Ok(())
    }

    /// Esce da un gruppo. È un gesto di chi esce e non chiede permesso a
    /// nessuno; come sul web (`esci` in `Messaggi.tsx`) sono due passi:
    ///
    /// 1. **prima si racconta l'uscita**, finché si può ancora scrivere: dopo,
    ///    l'istanza non accetta più niente da chi è uscito;
    /// 2. poi `POST …/uscita`.
    ///
    /// Nessun commit parte da qui: la foglia di chi esce la toglie chi resta,
    /// al suo giro ([`Self::aggiorna`]), e la catena ruota allora. Fino a quel
    /// momento questo dispositivo non legge comunque, perché la Casa non gli
    /// dà più la cronologia.
    ///
    /// Se la Casa dice di no, il racconto già scritto si ritira: non resta
    /// scritto che si è usciti da un gruppo in cui si è ancora. Lo stato del
    /// gruppo cifrato resta su questo dispositivo, come sul web: se qualcuno
    /// fa rientrare questa persona, è da lì che si riparte.
    pub async fn esci(&self, conversazione: String) -> Esito<()> {
        let _una_alla_volta = self.in_serie.lock().await;
        let id = conversazione.as_str();
        let vista = self.vista(id).await?.ok_or(ErroreNucleo::FuoriDalGruppo)?;
        if !vista.gruppo {
            // La stessa risposta della Casa: da una chat a due non si esce.
            return Err(ErroreNucleo::Casa {
                stato: 400,
                codice: "non_un_gruppo".into(),
            });
        }
        let racconto = if vista.congelata || !self.dispositivo.conosce(id) {
            None
        } else {
            let io = self.membro.clone();
            self.racconta(id, TipoEvento::Uscita, &io).await
        };
        if let Err(causa) = self.istanza.esci(id).await {
            if let Some(voce) = racconto {
                let _ = self.istanza.ritira_voce(id, &voce).await;
            }
            return Err(causa);
        }
        let mut aperte = self.aperte.lock().unwrap();
        if let Some(aperta) = aperte.get_mut(id) {
            aperta.pronta = false;
            aperta.vista = None;
            aperta.consegnati.clear();
        }
        Ok(())
    }

    /// Ritira un messaggio proprio (ADR 0043 §2): la voce esce dall'archivio
    /// della propria casa, che è l'unico posto dove sta. Chi l'ha già letto
    /// l'ha letto; al prossimo giro di chiunque l'id non è più nella pagina
    /// ([`Aggiornamento::pagina`]).
    ///
    /// Si ritira soltanto il proprio: una voce d'altri, o che non c'è, è il
    /// 404 della Casa (`messaggio_inesistente`).
    pub async fn ritira(&self, conversazione: String, messaggio: String) -> Esito<()> {
        let _una_alla_volta = self.in_serie.lock().await;
        self.istanza.ritira_voce(&conversazione, &messaggio).await?;
        if let Some(aperta) = self.aperte.lock().unwrap().get_mut(&conversazione) {
            aperta.consegnati.remove(&messaggio);
        }
        Ok(())
    }

    /* ----- i propri dispositivi (ADR 0040) ----- */

    /// I dispositivi di questa persona: questo per primo, poi quelli che
    /// aspettano un sì, poi gli approvati e i revocati, i più recenti prima.
    ///
    /// Il nome di ciascuno viene dalle sessioni aperte: se la Casa non le dà,
    /// l'elenco resta, senza nomi. Di questo dispositivo si aggiorna anche
    /// [`Io::approvato`]: è così che chi aspettava si accorge del sì.
    pub async fn dispositivi(&self) -> Esito<Vec<MioDispositivo>> {
        let elenco = self.istanza.dispositivi().await?;
        let sessioni = self.istanza.sessioni().await.unwrap_or_default();
        let mio = self.registrato.lock().unwrap().id.clone();
        let mut fuori: Vec<MioDispositivo> = elenco
            .into_iter()
            .map(|d| mio_dispositivo(d, &mio, &sessioni))
            .collect();
        if let Some(questo) = fuori.iter().find(|d| d.questo) {
            self.registrato.lock().unwrap().approvato = questo.stato == StatoDispositivo::Approvato;
        }
        let rango = |d: &MioDispositivo| match (d.questo, d.stato) {
            (true, _) => 0,
            (false, StatoDispositivo::InAttesa) => 1,
            (false, StatoDispositivo::Approvato) => 2,
            (false, StatoDispositivo::Revocato) => 3,
        };
        fuori.sort_by(|a, b| {
            rango(a)
                .cmp(&rango(b))
                .then_with(|| b.creato_il.cmp(&a.creato_il))
        });
        Ok(fuori)
    }

    /// Il sì a un dispositivo che aspetta. Poi la sua foglia entra in ogni
    /// conversazione che questo dispositivo conosce ([`Self::allinea_ovunque`]).
    /// Lo può dire soltanto un dispositivo già approvato: per gli altri è il
    /// 403 della Casa (`device_not_approved`).
    pub async fn approva_dispositivo(&self, id: String) -> Esito<()> {
        self.istanza.approva_dispositivo(&id).await?;
        self.allinea_ovunque().await;
        Ok(())
    }

    /// Il no, o la revoca di un dispositivo che aveva il sì: la Casa gli toglie
    /// la chiave e la sessione, e la sua foglia esce da ogni conversazione che
    /// questo dispositivo conosce, con la catena che ruota: **non legge il
    /// seguito**. Ciò che ha già letto l'ha letto.
    ///
    /// Questo dispositivo non si revoca da qui: si esce
    /// ([`Collegamento::dimentica_casa`]).
    pub async fn revoca_dispositivo(&self, id: String) -> Esito<()> {
        if id == self.registrato.lock().unwrap().id {
            return Err(ErroreNucleo::Formato(
                "questo dispositivo non si revoca: si esce".into(),
            ));
        }
        self.istanza.rifiuta_dispositivo(&id).await?;
        self.allinea_ovunque().await;
        Ok(())
    }

    /// Dopo un sì o una revoca le proprie foglie si rimettono d'accordo con il
    /// registro in ogni conversazione che questo dispositivo conosce, invece
    /// di aspettare che ciascuna venga guardata: un telefono revocato non
    /// legge il seguito nemmeno di quelle che nessuno apre.
    ///
    /// È [`Self::allinea_i_miei_dispositivi`], una conversazione alla volta e
    /// ciascuna tutto o niente. Un gruppo congelato non si tocca. Una che non
    /// riesce non ferma le altre: ci si riprova al suo prossimo giro, perché
    /// l'orologio di ciascuna riparte da zero.
    async fn allinea_ovunque(&self) {
        let _una_alla_volta = self.in_serie.lock().await;
        for aperta in self.aperte.lock().unwrap().values_mut() {
            aperta.foglie_allineate_il = None;
        }
        // Senza l'elenco non si sa quali sono congelate: ciascuna al suo giro.
        let Ok(viste) = self.istanza.conversazioni().await else {
            return;
        };
        for vista in viste {
            let id = vista.id.as_str();
            if vista.congelata || !self.dispositivo.conosce(id) {
                continue;
            }
            // Ci si rimette in pari prima di guardare l'albero, come il web
            // dopo `leggi`; chi risulta tolto non decide niente.
            if !matches!(self.sincronizza(id).await, Ok(false)) {
                continue;
            }
            if self.allinea_i_miei_dispositivi(id).await.is_ok() {
                self.aperte
                    .lock()
                    .unwrap()
                    .entry(vista.id.clone())
                    .or_default()
                    .foglie_allineate_il = Some(Instant::now());
            }
        }
    }
}

enum Applicato {
    /// Un commit; se era quello proprio rimasto in sospeso, eccolo.
    Commit {
        proprio: Option<Sospeso>,
    },
    Uscito,
    Altro,
}

/* ---------- il confine ---------- */

/// Le conversazioni di questo dispositivo, per l'interfaccia.
///
/// Sta sopra il [`Collegamento`] con la Casa e il [`Deposito`] dell'app. Non
/// chiede un `Registro`: le chiavi di firma le domanda alla Casa da sé. E non
/// restituisce mai una chiave, una catena, una serratura o un byte di MLS.
#[derive(uniffi::Object)]
pub struct Sessioni {
    motore: Motore<IstanzaSuCasa<Arc<Collegamento>>>,
}

#[uniffi::export(async_runtime = "tokio")]
impl Sessioni {
    /// Prepara il dispositivo per le conversazioni: chiede alla Casa chi si
    /// è, apre o crea l'identità MLS nel deposito, registra la chiave di firma
    /// (`POST /api/v1/dispositivi/chiave`) e pubblica i KeyPackage che
    /// mancano. Il dispositivo dev'essere già entrato nella Casa.
    ///
    /// Il primo dispositivo di una persona si approva da solo; ogni altro
    /// aspetta il sì di uno già approvato (ADR 0040), e [`Io::approvato`] lo
    /// dice.
    #[uniffi::constructor]
    pub async fn apri(
        collegamento: Arc<Collegamento>,
        deposito: Arc<dyn Deposito>,
    ) -> Result<Arc<Self>, ErroreNucleo> {
        let istanza = Arc::new(IstanzaSuCasa::nuova(collegamento));
        Ok(Arc::new(Sessioni {
            motore: Motore::apri(istanza, deposito).await?,
        }))
    }

    pub fn io(&self) -> Io {
        self.motore.io()
    }

    /// Le conversazioni di questa persona, come le elenca la Casa.
    pub async fn conversazioni(&self) -> Result<Vec<Conversazione>, ErroreNucleo> {
        self.motore.conversazioni().await
    }

    /// Crea, o ritrova, la conversazione a due con una persona.
    pub async fn crea_diretta(
        &self,
        con: PersonaDaInvitare,
    ) -> Result<Conversazione, ErroreNucleo> {
        self.motore.crea_diretta(con).await
    }

    /// Crea un gruppo: un nome, e almeno altre due persone.
    pub async fn crea_gruppo(
        &self,
        nome: String,
        membri: Vec<PersonaDaInvitare>,
    ) -> Result<Conversazione, ErroreNucleo> {
        self.motore.crea_gruppo(nome, membri).await
    }

    /// Apre una conversazione su questo dispositivo: la riprende, entra da un
    /// invito, rientra, o la crea se tocca a lui.
    pub async fn apri_conversazione(
        &self,
        conversazione: String,
    ) -> Result<Apertura, ErroreNucleo> {
        self.motore.apri_conversazione(conversazione).await
    }

    /// Un giro: applica ciò che è successo al gruppo e restituisce i messaggi
    /// nuovi, con chi li ha scritti e quando. Apre la conversazione se non è
    /// ancora aperta. Da chiamare quando la schermata guarda, non più spesso
    /// di ogni dieci secondi.
    pub async fn aggiorna(&self, conversazione: String) -> Result<Aggiornamento, ErroreNucleo> {
        self.motore.aggiorna(conversazione).await
    }

    /// Una pagina di cronologia: l'ultima, o quella prima di `prima`.
    pub async fn cronologia(
        &self,
        conversazione: String,
        prima: Option<String>,
    ) -> Result<Pagina, ErroreNucleo> {
        self.motore.cronologia(conversazione, prima).await
    }

    /// Manda un messaggio. `risponde` è l'id del messaggio a cui risponde.
    pub async fn invia(
        &self,
        conversazione: String,
        testo: String,
        risponde: Option<String>,
    ) -> Result<Messaggio, ErroreNucleo> {
        self.motore.invia(conversazione, testo, risponde).await
    }

    /// Chi è nella conversazione, e con quanti dispositivi è nel gruppo
    /// cifrato.
    pub async fn membri(
        &self,
        conversazione: String,
    ) -> Result<Vec<MembroDelGruppo>, ErroreNucleo> {
        self.motore.membri(conversazione).await
    }

    /// Aggiunge una persona a un gruppo e la fa entrare nel gruppo cifrato.
    pub async fn aggiungi_membro(
        &self,
        conversazione: String,
        chi: PersonaDaInvitare,
    ) -> Result<(), ErroreNucleo> {
        self.motore.aggiungi_membro(conversazione, chi).await
    }

    /// Fa entrare nel gruppo cifrato chi è già fra i membri e non c'è ancora.
    pub async fn fai_entrare(
        &self,
        conversazione: String,
        membro_id: String,
    ) -> Result<(), ErroreNucleo> {
        self.motore.fai_entrare(conversazione, membro_id).await
    }

    /// Toglie una persona da un gruppo, e le sue foglie dal gruppo cifrato.
    pub async fn togli_membro(
        &self,
        conversazione: String,
        membro_id: String,
    ) -> Result<(), ErroreNucleo> {
        self.motore.togli_membro(conversazione, membro_id).await
    }

    /// Esce da un gruppo: lo racconta, poi lo dice alla Casa. La propria
    /// foglia la toglie chi resta.
    pub async fn esci(&self, conversazione: String) -> Result<(), ErroreNucleo> {
        self.motore.esci(conversazione).await
    }

    /// Ritira un proprio messaggio: la voce esce dall'archivio della propria
    /// casa. `messaggio` è il suo [`Messaggio::id`].
    pub async fn ritira(
        &self,
        conversazione: String,
        messaggio: String,
    ) -> Result<(), ErroreNucleo> {
        self.motore.ritira(conversazione, messaggio).await
    }

    /// I dispositivi di questa persona, con chi aspetta un sì, e il codice
    /// di ciascuno da confrontare. Aggiorna anche [`Io::approvato`].
    pub async fn dispositivi(&self) -> Result<Vec<MioDispositivo>, ErroreNucleo> {
        self.motore.dispositivi().await
    }

    /// Dice di sì a un dispositivo che aspetta, e lo fa entrare nelle
    /// conversazioni. Solo da un dispositivo già approvato.
    pub async fn approva_dispositivo(&self, id: String) -> Result<(), ErroreNucleo> {
        self.motore.approva_dispositivo(id).await
    }

    /// Dice di no a un dispositivo, o revoca uno che aveva il sì: perde la
    /// chiave e la sessione, ed esce dalle conversazioni. Non questo.
    pub async fn revoca_dispositivo(&self, id: String) -> Result<(), ErroreNucleo> {
        self.motore.revoca_dispositivo(id).await
    }
}
