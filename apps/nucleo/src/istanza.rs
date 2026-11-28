//! Ciò che la sessione chiede all'istanza, e come lo chiede alla Casa.
//!
//! È l'`Istanza` di `apps/web/src/mls/sessione.ts`, con accanto ciò che sul
//! web sta in `adattatori.ts` (`istanzaSuApi`, `anagrafeSuApi`) e in
//! `Messaggi.tsx`: le conversazioni, le chiavi d'ingresso, il registro. La
//! sessione ([`crate::sessione`]) non conosce né iroh né JSON: chiede
//! un'[`Istanza`] e la riceve. È ciò che la rende provabile senza rete.
//!
//! Le implementazioni sono due. [`IstanzaSuCasa`] parla con la Casa sulle
//! rotte `/api/v1/...` di `apps/core-api`, **con le loro forme JSON e nessuna
//! in più**, sopra un [`Filo`]: in produzione il [`Collegamento`] via iroh
//! (`estia/dispositivo/1`), così l'app non porta i byte di MLS. L'altra è
//! l'istanza finta dei test, l'analogo di `finte.ts`.
//!
//! Nessuna logica di protocollo in questo file. Se ce ne finisce, è nel posto
//! sbagliato.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::archivio::VoceCifrata;
use crate::casa::Collegamento;
use crate::mls::MazzoAvvolto;
use crate::ErroreNucleo;

/// Come si chiama questa crittografia in `device_keys`: `ALGORITMO` di
/// `apps/web/src/mls/dispositivo.ts`. Chi legge il registro scarta le righe
/// che non parlano questa lingua.
pub const ALGORITMO: &str = "MLS-P256-v1";

/* ---------- le forme ---------- */

/// Chi è questo dispositivo per la Casa: `GET /api/v1/auth/me` e la casa di
/// `GET /api/v1/mls/casa`, che ogni credenziale porta con sé (ADR 0042 §0).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChiSono {
    /// L'id con cui le conversazioni nominano questa persona.
    pub id: String,
    pub username: String,
    pub casa: String,
}

/// La riga di `device_keys` di questa sessione.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispositivoRegistrato {
    pub id: String,
    /// `false` finché un dispositivo già approvato non dice di sì (ADR 0040).
    pub approvato: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TipoBusta {
    Commit,
    Welcome,
}

impl TipoBusta {
    fn nome(self) -> &'static str {
        match self {
            TipoBusta::Commit => "commit",
            TipoBusta::Welcome => "welcome",
        }
    }
}

/// Una busta del canale di handshake, com'è in fila. La busta è in base64.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct BustaHandshake {
    pub id: String,
    pub tipo: TipoBusta,
    pub epoch: u64,
    pub busta: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct PaginaHandshake {
    pub handshake: Vec<BustaHandshake>,
    #[serde(default)]
    pub prossimo: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BustaDaDepositare {
    pub tipo: TipoBusta,
    pub epoch: u64,
    pub busta: String,
    /// Solo per un Welcome: l'**id** con cui la conversazione nomina chi
    /// entra, non il suo nome (`listHandshakePer` consegna per id).
    pub destinatario: Option<String>,
}

/// Un dispositivo di chi chiede, come lo elenca `GET /api/v1/dispositivi`:
/// **quelli in attesa compresi**, ed è da qui che una richiesta si vede.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispositivoInElenco {
    pub id: String,
    /// La sessione a cui la chiave è legata.
    pub sessione: String,
    /// La chiave pubblica di firma, in base64 com'è nel registro: è da lei
    /// che il client calcola il codice da confrontare.
    pub chiave_pubblica: String,
    pub creato_il: String,
    /// `None` finché nessuno ha detto di sì (ADR 0040).
    pub approvato_il: Option<String>,
    pub revocato_il: Option<String>,
}

/// Una sessione aperta di chi chiede (`GET /api/v1/auth/sessions`): da qui
/// il nome che il dispositivo si è dato entrando.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessioneAperta {
    pub id: String,
    pub etichetta: String,
    pub visto_il: String,
}

/// Il punto da cui si rientra: per l'istanza un blob e un'epoch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PuntoDiRientro {
    pub group_info: String,
    pub epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoceDaDepositare {
    pub id: String,
    pub voce: VoceCifrata,
    pub creato_il: String,
}

/// Una riga come la ricompone l'istanza: la voce c'è solo se la sua casa ha
/// risposto.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RigaRemota {
    pub id: String,
    /// `username@casa`; `None` per il pregresso senza autore attestato.
    pub mittente: Option<String>,
    pub creato_il: String,
    pub casa: String,
    pub voce: Option<VoceCifrata>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PaginaRemota {
    pub righe: Vec<RigaRemota>,
    pub prima: Option<String>,
    /// Le case che non hanno risposto.
    pub non_rispondono: Vec<String>,
}

/// Una persona come la nomina una conversazione (`AuthorView`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Autore {
    pub id: String,
    pub username: String,
    #[serde(rename = "displayName")]
    pub nome: String,
}

/// Una conversazione come la descrive la Casa (`ConversazioneView`), per ciò
/// che serve alla sessione.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversazioneVista {
    pub id: String,
    pub gruppo: bool,
    pub nome: Option<String>,
    pub membri: Vec<Autore>,
    /// Per id: `creatore`, `amministratore`, `membro`.
    pub ruoli: HashMap<String, String>,
    /// Chi è stato tolto o è uscito, come `username@casa`.
    pub rimossi: Vec<String>,
    pub ordinata_qui: bool,
    pub congelata: bool,
    pub non_letti: u32,
    pub creata_il: String,
    pub ultimo_messaggio_il: Option<String>,
}

/// Una persona da cercare: di questa casa, o di un'altra.
#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct PersonaDaInvitare {
    pub username: String,
    /// La chiave della sua casa, se non è questa.
    pub casa: Option<String>,
}

/* ---------- ciò che la sessione chiede ---------- */

type Esito<T> = Result<T, ErroreNucleo>;

/// Ciò che la sessione chiede all'istanza. Niente di più.
///
/// Un membro si scrive `<username>@<casa>`. Le chiavi e i KeyPackage sono
/// byte; le buste restano in base64 come viaggiano, perché la sessione le
/// confronta e le riconsegna così.
pub trait Istanza: Send + Sync + 'static {
    fn chi_sono(&self) -> impl Future<Output = Esito<ChiSono>> + Send;

    /// Una sfida per la prova di possesso della chiave
    /// (`POST /api/v1/dispositivi/sfida`): vale per questa sessione, cinque
    /// minuti, una volta.
    fn sfida(&self) -> impl Future<Output = Esito<String>> + Send;

    /// Registra la chiave di firma di questo dispositivo per la sessione.
    /// Ripetibile: la stessa chiave non perde il sì che ha. `prova` è la
    /// firma della sfida: con lei una chiave già approvata, che si ripresenta
    /// da una sessione nuova, si fa riconoscere senza aspettare un altro sì.
    fn registra_chiave(
        &self,
        chiave_di_firma: &[u8],
        prova: Option<&[u8]>,
    ) -> impl Future<Output = Esito<DispositivoRegistrato>> + Send;

    /// I dispositivi di chi chiede, quelli in attesa e i revocati compresi.
    fn dispositivi(&self) -> impl Future<Output = Esito<Vec<DispositivoInElenco>>> + Send;

    /// Le sessioni aperte di chi chiede.
    fn sessioni(&self) -> impl Future<Output = Esito<Vec<SessioneAperta>>> + Send;

    /// Il sì a un dispositivo che aspetta: `POST …/:id/approva`. Lo può dire
    /// soltanto un dispositivo già approvato.
    fn approva_dispositivo(&self, id: &str) -> impl Future<Output = Esito<()>> + Send;

    /// Il no, fino in fondo: `POST …/:id/rifiuta`. Il dispositivo perde la
    /// chiave e la sessione, che aspettasse o no.
    fn rifiuta_dispositivo(&self, id: &str) -> impl Future<Output = Esito<()>> + Send;

    /// Pubblica KeyPackage monouso per questo dispositivo.
    fn pubblica_pacchetti(&self, pacchetti: Vec<Vec<u8>>)
        -> impl Future<Output = Esito<()>> + Send;

    /// Le chiavi di firma che l'istanza riconosce per un membro, di qualunque
    /// casa. È il registro su cui poggia l'autenticazione delle foglie (S4):
    /// ferma l'estraneo, non chi ospita. **Una casa che non risponde è un
    /// errore, non un elenco vuoto.**
    fn chiavi_di_firma(&self, membro: &str) -> impl Future<Output = Esito<Vec<Vec<u8>>>> + Send;

    /// Un KeyPackage per ciascun dispositivo di un membro: monouso, consumati
    /// dal prelievo.
    fn pacchetti_di(&self, membro: &str) -> impl Future<Output = Esito<Vec<Vec<u8>>>> + Send;

    /// I KeyPackage di altri dispositivi propri, per chiave di firma (ADR 0040).
    fn miei_pacchetti(
        &self,
        chiavi_di_firma: &[Vec<u8>],
    ) -> impl Future<Output = Esito<Vec<Vec<u8>>>> + Send;

    fn conversazioni(&self) -> impl Future<Output = Esito<Vec<ConversazioneVista>>> + Send;
    fn conversazione(&self, id: &str) -> impl Future<Output = Esito<ConversazioneVista>> + Send;
    fn crea_diretta(
        &self,
        con: &PersonaDaInvitare,
    ) -> impl Future<Output = Esito<ConversazioneVista>> + Send;
    fn crea_gruppo(
        &self,
        nome: &str,
        membri: &[PersonaDaInvitare],
    ) -> impl Future<Output = Esito<ConversazioneVista>> + Send;
    fn aggiungi_al_gruppo(
        &self,
        id: &str,
        chi: &PersonaDaInvitare,
    ) -> impl Future<Output = Esito<ConversazioneVista>> + Send;
    /// `membro` è l'id con cui la conversazione lo nomina.
    fn togli_dal_gruppo(
        &self,
        id: &str,
        membro: &str,
    ) -> impl Future<Output = Esito<ConversazioneVista>> + Send;
    /// Chi chiede esce dal gruppo: `POST …/uscita`. Non chiede permesso a
    /// nessuno, e la sua foglia la toglie chi resta.
    fn esci(&self, id: &str) -> impl Future<Output = Esito<()>> + Send;

    /// Gli handshake che spettano a chi chiede, **in ordine di arrivo**.
    fn handshake_dopo(
        &self,
        id: &str,
        dopo: Option<&str>,
    ) -> impl Future<Output = Esito<PaginaHandshake>> + Send;
    /// Un commit entra solo all'epoch successiva all'ultima in fila: chi
    /// arriva secondo riceve [`ErroreNucleo::Casa`] con stato 409.
    fn deposita_handshake(
        &self,
        id: &str,
        busta: BustaDaDepositare,
    ) -> impl Future<Output = Esito<()>> + Send;

    fn mazzo(&self, id: &str) -> impl Future<Output = Esito<Option<MazzoAvvolto>>> + Send;
    /// Un mazzo che la fila ha già superato non è un errore: lo deposita chi
    /// è all'epoch giusta.
    fn salva_mazzo(&self, id: &str, mazzo: MazzoAvvolto) -> impl Future<Output = Esito<()>> + Send;
    fn punto_di_rientro(
        &self,
        id: &str,
    ) -> impl Future<Output = Esito<Option<PuntoDiRientro>>> + Send;
    fn salva_punto_di_rientro(
        &self,
        id: &str,
        punto: PuntoDiRientro,
    ) -> impl Future<Output = Esito<()>> + Send;

    /// La cronologia ricomposta dalle custodie (ADR 0043 §2), dalla pagina
    /// più recente.
    fn cronologia(
        &self,
        id: &str,
        prima: Option<&str>,
    ) -> impl Future<Output = Esito<PaginaRemota>> + Send;
    fn deposita_archivio(
        &self,
        id: &str,
        voci: Vec<VoceDaDepositare>,
    ) -> impl Future<Output = Esito<()>> + Send;
    /// Il ritiro (ADR 0043 §2): via una voce propria dalla propria casa,
    /// `DELETE …/archivio/:voce`. Una voce che non c'è, o d'altri, è un 404.
    fn ritira_voce(&self, id: &str, voce: &str) -> impl Future<Output = Esito<()>> + Send;
}

/// Un deposito che la fila rifiuta perché **qualcuno è arrivato prima** sulla
/// stessa epoch (ADR 0042 §3). Non è un guasto: ci si rimette in pari.
pub fn superata(errore: &ErroreNucleo) -> bool {
    matches!(errore, ErroreNucleo::Casa { stato: 409, .. })
}

/// `<username>@<casa>` nei suoi due pezzi, come `leggiIdentita` di `gruppo.ts`.
pub fn leggi_identita(membro: &str) -> Option<(&str, &str)> {
    let taglio = membro.rfind('@')?;
    if taglio == 0 || taglio == membro.len() - 1 {
        return None;
    }
    Some((&membro[..taglio], &membro[taglio + 1..]))
}

/* ---------- la Casa vera ---------- */

/// Una richiesta dell'API dei membri e la sua risposta: lo stato e il corpo.
///
/// È la sola cosa che [`IstanzaSuCasa`] chiede al trasporto. Il
/// [`Collegamento`] la fa via iroh; la prova fra il nucleo e il client web
/// (`infra/prova-sessione`) la fa su una pipe.
pub trait Filo: Send + Sync + 'static {
    fn chiedi(
        &self,
        metodo: &'static str,
        percorso: String,
        corpo: Option<Vec<u8>>,
    ) -> impl Future<Output = Esito<(u16, Vec<u8>)>> + Send;
}

impl Filo for Arc<Collegamento> {
    async fn chiedi(
        &self,
        metodo: &'static str,
        percorso: String,
        corpo: Option<Vec<u8>>,
    ) -> Esito<(u16, Vec<u8>)> {
        // Un `content-type` senza corpo Fastify lo rifiuta: lo si dice solo
        // quando il corpo c'è.
        let mut intestazioni = HashMap::new();
        if corpo.is_some() {
            intestazioni.insert("content-type".to_string(), "application/json".to_string());
        }
        let risposta = Collegamento::chiedi(
            self,
            metodo.into(),
            percorso,
            intestazioni,
            corpo.unwrap_or_default(),
        )
        .await?;
        Ok((risposta.stato, risposta.corpo))
    }
}

/// L'istanza vera, sulle rotte di `apps/core-api`.
pub struct IstanzaSuCasa<F: Filo> {
    filo: F,
}

/// Come `encodeURIComponent`: tutto ciò che non è un carattere libero si
/// scrive in percentuale. La Casa accetta solo ASCII stampabile.
fn componente(testo: &str) -> String {
    let mut fuori = String::with_capacity(testo.len());
    for byte in testo.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => fuori.push(byte as char),
            altro => fuori.push_str(&format!("%{altro:02X}")),
        }
    }
    fuori
}

fn b64(byte: &[u8]) -> String {
    STANDARD.encode(byte)
}

fn da_b64(testo: &str) -> Esito<Vec<u8>> {
    STANDARD
        .decode(testo)
        .map_err(|_| ErroreNucleo::Formato("base64 non valido dalla Casa".into()))
}

fn forma<E: std::fmt::Display>(e: E) -> ErroreNucleo {
    ErroreNucleo::Formato(format!("risposta della Casa: {e}"))
}

fn leggi<T: serde::de::DeserializeOwned>(corpo: &[u8]) -> Esito<T> {
    serde_json::from_slice(corpo).map_err(forma)
}

#[derive(Deserialize)]
struct ErroreDellaCasa {
    code: String,
}

/* Le forme JSON di `packages/contracts`, lette per ciò che serve. Un campo in
 * più nella risposta non è un errore: i contratti crescono. */

#[derive(Deserialize)]
struct UtenteJson {
    id: String,
    username: String,
}

#[derive(Deserialize)]
struct CasaJson {
    casa: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceJson {
    id: String,
    approvato_il: Option<String>,
}

#[derive(Deserialize)]
struct RegistratoJson {
    device: DeviceJson,
}

#[derive(Deserialize)]
struct SfidaJson {
    sfida: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispositivoJson {
    id: String,
    session_id: String,
    public_key: String,
    created_at: String,
    #[serde(default)]
    revoked_at: Option<String>,
    #[serde(default)]
    approvato_il: Option<String>,
}

#[derive(Deserialize)]
struct DispositiviJson {
    dispositivi: Vec<DispositivoJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessioneJson {
    id: String,
    #[serde(default)]
    device_label: String,
    last_seen_at: String,
}

#[derive(Deserialize)]
struct SessioniJson {
    sessions: Vec<SessioneJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChiaveJson {
    public_key: String,
    algorithm: String,
}

#[derive(Deserialize)]
struct ChiaviJson {
    chiavi: Vec<ChiaveJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PacchettoJson {
    key_package: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PacchettiJson {
    key_packages: Vec<PacchettoJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UltimoJson {
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversazioneJson {
    id: String,
    tipo: String,
    membri: Vec<Autore>,
    #[serde(default)]
    ultimo_messaggio: Option<UltimoJson>,
    non_letti: u32,
    created_at: String,
    ordinata_qui: bool,
    #[serde(default)]
    nome: Option<String>,
    #[serde(default)]
    ruoli: HashMap<String, String>,
    #[serde(default)]
    rimossi: Vec<String>,
    #[serde(default)]
    congelata: bool,
}

impl From<ConversazioneJson> for ConversazioneVista {
    fn from(c: ConversazioneJson) -> Self {
        ConversazioneVista {
            id: c.id,
            gruppo: c.tipo == "gruppo",
            nome: c.nome,
            membri: c.membri,
            ruoli: c.ruoli,
            rimossi: c.rimossi,
            ordinata_qui: c.ordinata_qui,
            congelata: c.congelata,
            non_letti: c.non_letti,
            creata_il: c.created_at,
            ultimo_messaggio_il: c.ultimo_messaggio.map(|u| u.created_at),
        }
    }
}

#[derive(Deserialize)]
struct UnaConversazioneJson {
    conversazione: ConversazioneJson,
}

#[derive(Deserialize)]
struct ConversazioniJson {
    conversazioni: Vec<ConversazioneJson>,
}

#[derive(Deserialize)]
struct MazzoJson {
    mazzo: String,
    epoch: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupInfoJson {
    group_info: String,
    epoch: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoceJson {
    chiave_n: u32,
    busta: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RigaJson {
    id: String,
    mittente: Option<String>,
    created_at: String,
    casa: String,
    stato: String,
    #[serde(default)]
    voce: Option<VoceJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CronologiaJson {
    righe: Vec<RigaJson>,
    #[serde(default)]
    prima: Option<String>,
    non_rispondono: Vec<String>,
}

fn persona(chi: &PersonaDaInvitare) -> Value {
    match &chi.casa {
        Some(casa) => json!({ "username": chi.username, "casa": casa }),
        None => json!({ "username": chi.username }),
    }
}

impl<F: Filo> IstanzaSuCasa<F> {
    pub fn nuova(filo: F) -> Self {
        IstanzaSuCasa { filo }
    }

    /// Una richiesta: il corpo se la Casa dice di sì, il suo codice se dice
    /// di no.
    async fn chiedi(
        &self,
        metodo: &'static str,
        percorso: String,
        corpo: Option<Value>,
    ) -> Esito<Vec<u8>> {
        let corpo = corpo.map(|c| c.to_string().into_bytes());
        let (stato, risposta) = self.filo.chiedi(metodo, percorso, corpo).await?;
        if (200..300).contains(&stato) {
            return Ok(risposta);
        }
        let codice = serde_json::from_slice::<ErroreDellaCasa>(&risposta)
            .map(|e| e.code)
            .unwrap_or_default();
        Err(ErroreNucleo::Casa { stato, codice })
    }

    /// Un 404 qui non è un guasto: vuol dire «non c'è ancora».
    async fn se_esiste(&self, percorso: String) -> Esito<Option<Vec<u8>>> {
        match self.chiedi("GET", percorso, None).await {
            Ok(corpo) => Ok(Some(corpo)),
            Err(ErroreNucleo::Casa { stato: 404, .. }) => Ok(None),
            Err(altro) => Err(altro),
        }
    }

    /// Un deposito di stato che la Casa rifiuta perché la fila è già più
    /// avanti (409) non è un guasto: è `seNonSuperato` di `adattatori.ts`.
    async fn se_non_superato(&self, percorso: String, corpo: Value) -> Esito<()> {
        match self.chiedi("PUT", percorso, Some(corpo)).await {
            Ok(_) => Ok(()),
            Err(e) if superata(&e) => Ok(()),
            Err(altro) => Err(altro),
        }
    }

    fn pacchetti(corpo: &[u8]) -> Esito<Vec<Vec<u8>>> {
        leggi::<PacchettiJson>(corpo)?
            .key_packages
            .iter()
            .map(|p| da_b64(&p.key_package))
            .collect()
    }

    fn una(corpo: &[u8]) -> Esito<ConversazioneVista> {
        Ok(leggi::<UnaConversazioneJson>(corpo)?.conversazione.into())
    }
}

fn della_conversazione(id: &str, coda: &str) -> String {
    format!("/api/v1/conversazioni/{}{coda}", componente(id))
}

impl<F: Filo> Istanza for IstanzaSuCasa<F> {
    async fn chi_sono(&self) -> Esito<ChiSono> {
        let io: UtenteJson = leggi(&self.chiedi("GET", "/api/v1/auth/me".into(), None).await?)?;
        let casa: CasaJson = leggi(&self.chiedi("GET", "/api/v1/mls/casa".into(), None).await?)?;
        Ok(ChiSono {
            id: io.id,
            username: io.username,
            casa: casa.casa,
        })
    }

    async fn sfida(&self) -> Esito<String> {
        let risposta = self
            .chiedi("POST", "/api/v1/dispositivi/sfida".into(), None)
            .await?;
        Ok(leggi::<SfidaJson>(&risposta)?.sfida)
    }

    async fn registra_chiave(
        &self,
        chiave_di_firma: &[u8],
        prova: Option<&[u8]>,
    ) -> Esito<DispositivoRegistrato> {
        let mut corpo = json!({ "publicKey": b64(chiave_di_firma), "algorithm": ALGORITMO });
        if let Some(prova) = prova {
            corpo["prova"] = json!(b64(prova));
        }
        let risposta = self
            .chiedi("POST", "/api/v1/dispositivi/chiave".into(), Some(corpo))
            .await?;
        let device = leggi::<RegistratoJson>(&risposta)?.device;
        Ok(DispositivoRegistrato {
            id: device.id,
            approvato: device.approvato_il.is_some(),
        })
    }

    async fn dispositivi(&self) -> Esito<Vec<DispositivoInElenco>> {
        let risposta = self
            .chiedi("GET", "/api/v1/dispositivi".into(), None)
            .await?;
        Ok(leggi::<DispositiviJson>(&risposta)?
            .dispositivi
            .into_iter()
            .map(|d| DispositivoInElenco {
                id: d.id,
                sessione: d.session_id,
                chiave_pubblica: d.public_key,
                creato_il: d.created_at,
                approvato_il: d.approvato_il,
                revocato_il: d.revoked_at,
            })
            .collect())
    }

    async fn sessioni(&self) -> Esito<Vec<SessioneAperta>> {
        let risposta = self
            .chiedi("GET", "/api/v1/auth/sessions".into(), None)
            .await?;
        Ok(leggi::<SessioniJson>(&risposta)?
            .sessions
            .into_iter()
            .map(|s| SessioneAperta {
                id: s.id,
                etichetta: s.device_label,
                visto_il: s.last_seen_at,
            })
            .collect())
    }

    async fn approva_dispositivo(&self, id: &str) -> Esito<()> {
        let percorso = format!("/api/v1/dispositivi/{}/approva", componente(id));
        self.chiedi("POST", percorso, None).await?;
        Ok(())
    }

    async fn rifiuta_dispositivo(&self, id: &str) -> Esito<()> {
        let percorso = format!("/api/v1/dispositivi/{}/rifiuta", componente(id));
        self.chiedi("POST", percorso, None).await?;
        Ok(())
    }

    async fn pubblica_pacchetti(&self, pacchetti: Vec<Vec<u8>>) -> Esito<()> {
        let corpo = json!({ "keyPackages": pacchetti.iter().map(|p| b64(p)).collect::<Vec<_>>() });
        self.chiedi(
            "POST",
            "/api/v1/dispositivi/key-packages".into(),
            Some(corpo),
        )
        .await?;
        Ok(())
    }

    async fn chiavi_di_firma(&self, membro: &str) -> Esito<Vec<Vec<u8>>> {
        let (username, casa) = leggi_identita(membro)
            .ok_or_else(|| ErroreNucleo::NonAutenticato(membro.to_string()))?;
        // La regola di instradamento di ADR 0042 §0 la fa la Casa: casa mia →
        // registro locale; casa d'altri → la domanda `chiavi-di-firma`.
        let percorso = format!(
            "/api/v1/mls/chiavi/{}/{}",
            componente(casa),
            componente(username)
        );
        let registro: ChiaviJson = leggi(&self.chiedi("GET", percorso, None).await?)?;
        registro
            .chiavi
            .iter()
            .filter(|c| c.algorithm == ALGORITMO)
            .map(|c| da_b64(&c.public_key))
            .collect()
    }

    async fn pacchetti_di(&self, membro: &str) -> Esito<Vec<Vec<u8>>> {
        let (username, casa) = leggi_identita(membro)
            .ok_or_else(|| ErroreNucleo::NonAutenticato(membro.to_string()))?;
        let percorso = format!(
            "/api/v1/mls/key-packages/{}/{}",
            componente(casa),
            componente(username)
        );
        Self::pacchetti(&self.chiedi("GET", percorso, None).await?)
    }

    async fn miei_pacchetti(&self, chiavi_di_firma: &[Vec<u8>]) -> Esito<Vec<Vec<u8>>> {
        let corpo =
            json!({ "chiaviDiFirma": chiavi_di_firma.iter().map(|k| b64(k)).collect::<Vec<_>>() });
        Self::pacchetti(
            &self
                .chiedi(
                    "POST",
                    "/api/v1/dispositivi/miei/key-packages".into(),
                    Some(corpo),
                )
                .await?,
        )
    }

    async fn conversazioni(&self) -> Esito<Vec<ConversazioneVista>> {
        let risposta = self
            .chiedi("GET", "/api/v1/conversazioni".into(), None)
            .await?;
        Ok(leggi::<ConversazioniJson>(&risposta)?
            .conversazioni
            .into_iter()
            .map(Into::into)
            .collect())
    }

    async fn conversazione(&self, id: &str) -> Esito<ConversazioneVista> {
        Self::una(
            &self
                .chiedi("GET", della_conversazione(id, ""), None)
                .await?,
        )
    }

    async fn crea_diretta(&self, con: &PersonaDaInvitare) -> Esito<ConversazioneVista> {
        let corpo = match &con.casa {
            Some(casa) => json!({ "recipientUsername": con.username, "remoteInstanceKey": casa }),
            None => json!({ "recipientUsername": con.username }),
        };
        Self::una(
            &self
                .chiedi("POST", "/api/v1/conversazioni".into(), Some(corpo))
                .await?,
        )
    }

    async fn crea_gruppo(
        &self,
        nome: &str,
        membri: &[PersonaDaInvitare],
    ) -> Esito<ConversazioneVista> {
        let corpo =
            json!({ "nome": nome, "membri": membri.iter().map(persona).collect::<Vec<_>>() });
        Self::una(
            &self
                .chiedi("POST", "/api/v1/gruppi".into(), Some(corpo))
                .await?,
        )
    }

    async fn aggiungi_al_gruppo(
        &self,
        id: &str,
        chi: &PersonaDaInvitare,
    ) -> Esito<ConversazioneVista> {
        Self::una(
            &self
                .chiedi(
                    "POST",
                    della_conversazione(id, "/membri"),
                    Some(persona(chi)),
                )
                .await?,
        )
    }

    async fn togli_dal_gruppo(&self, id: &str, membro: &str) -> Esito<ConversazioneVista> {
        let coda = format!("/membri/{}", componente(membro));
        Self::una(
            &self
                .chiedi("DELETE", della_conversazione(id, &coda), None)
                .await?,
        )
    }

    async fn esci(&self, id: &str) -> Esito<()> {
        self.chiedi("POST", della_conversazione(id, "/uscita"), None)
            .await?;
        Ok(())
    }

    async fn handshake_dopo(&self, id: &str, dopo: Option<&str>) -> Esito<PaginaHandshake> {
        let coda = match dopo {
            Some(dopo) => format!("/handshake?dopo={}", componente(dopo)),
            None => "/handshake".to_string(),
        };
        leggi(
            &self
                .chiedi("GET", della_conversazione(id, &coda), None)
                .await?,
        )
    }

    async fn deposita_handshake(&self, id: &str, busta: BustaDaDepositare) -> Esito<()> {
        let mut corpo = json!({
            "tipo": busta.tipo.nome(),
            "epoch": busta.epoch,
            "busta": busta.busta,
        });
        if let Some(destinatario) = busta.destinatario {
            corpo["destinatario"] = json!(destinatario);
        }
        self.chiedi("POST", della_conversazione(id, "/handshake"), Some(corpo))
            .await?;
        Ok(())
    }

    async fn mazzo(&self, id: &str) -> Esito<Option<MazzoAvvolto>> {
        let Some(corpo) = self
            .se_esiste(della_conversazione(id, "/archivio/chiavi"))
            .await?
        else {
            return Ok(None);
        };
        let letto: MazzoJson = leggi(&corpo)?;
        Ok(Some(MazzoAvvolto {
            mazzo: letto.mazzo,
            epoch: letto.epoch,
        }))
    }

    async fn salva_mazzo(&self, id: &str, mazzo: MazzoAvvolto) -> Esito<()> {
        self.se_non_superato(
            della_conversazione(id, "/archivio/chiavi"),
            json!({ "mazzo": mazzo.mazzo, "epoch": mazzo.epoch }),
        )
        .await
    }

    async fn punto_di_rientro(&self, id: &str) -> Esito<Option<PuntoDiRientro>> {
        let Some(corpo) = self
            .se_esiste(della_conversazione(id, "/group-info"))
            .await?
        else {
            return Ok(None);
        };
        let letto: GroupInfoJson = leggi(&corpo)?;
        Ok(Some(PuntoDiRientro {
            group_info: letto.group_info,
            epoch: letto.epoch,
        }))
    }

    async fn salva_punto_di_rientro(&self, id: &str, punto: PuntoDiRientro) -> Esito<()> {
        self.se_non_superato(
            della_conversazione(id, "/group-info"),
            json!({ "groupInfo": punto.group_info, "epoch": punto.epoch }),
        )
        .await
    }

    async fn cronologia(&self, id: &str, prima: Option<&str>) -> Esito<PaginaRemota> {
        let coda = match prima {
            Some(prima) => format!("/cronologia?prima={}", componente(prima)),
            None => "/cronologia".to_string(),
        };
        let pagina: CronologiaJson = leggi(
            &self
                .chiedi("GET", della_conversazione(id, &coda), None)
                .await?,
        )?;
        Ok(PaginaRemota {
            righe: pagina
                .righe
                .into_iter()
                .map(|r| RigaRemota {
                    // La voce conta solo se la sua casa ha risposto.
                    voce: r
                        .voce
                        .filter(|_| r.stato == "disponibile")
                        .map(|v| VoceCifrata {
                            busta: v.busta,
                            chiave_n: v.chiave_n,
                        }),
                    id: r.id,
                    mittente: r.mittente,
                    creato_il: r.created_at,
                    casa: r.casa,
                })
                .collect(),
            prima: pagina.prima,
            non_rispondono: pagina.non_rispondono,
        })
    }

    async fn deposita_archivio(&self, id: &str, voci: Vec<VoceDaDepositare>) -> Esito<()> {
        let voci: Vec<Value> = voci
            .iter()
            .map(|v| {
                json!({
                    "id": v.id,
                    "chiaveN": v.voce.chiave_n,
                    "busta": v.voce.busta,
                    "createdAt": v.creato_il,
                })
            })
            .collect();
        self.chiedi(
            "POST",
            della_conversazione(id, "/archivio"),
            Some(json!({ "voci": voci })),
        )
        .await?;
        Ok(())
    }

    async fn ritira_voce(&self, id: &str, voce: &str) -> Esito<()> {
        let coda = format!("/archivio/{}", componente(voce));
        self.chiedi("DELETE", della_conversazione(id, &coda), None)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod prove {
    use super::*;

    #[test]
    fn un_componente_si_scrive_come_encode_uri_component() {
        assert_eq!(componente("anna.rossi_1-2"), "anna.rossi_1-2");
        assert_eq!(componente("remote:ab12:anna"), "remote%3Aab12%3Aanna");
        assert_eq!(componente("a/b ?&=è"), "a%2Fb%20%3F%26%3D%C3%A8");
    }

    #[test]
    fn un_identita_ha_un_nome_e_una_casa() {
        assert_eq!(leggi_identita("anna@casa"), Some(("anna", "casa")));
        assert_eq!(leggi_identita("a@b@casa"), Some(("a@b", "casa")));
        assert_eq!(leggi_identita("@casa"), None);
        assert_eq!(leggi_identita("anna@"), None);
        assert_eq!(leggi_identita("anna"), None);
    }
}
