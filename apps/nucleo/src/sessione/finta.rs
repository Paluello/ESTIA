//! I doppi su cui girano i test della sessione: un'istanza e un deposito.
//!
//! È l'analogo di `apps/web/src/mls/finte.ts`, e come quello non è una
//! scorciatoia ma una **riproduzione**: il canale di handshake che ordina per
//! arrivo, accetta un commit solo all'epoch successiva e consegna un Welcome
//! soltanto al suo destinatario; il mazzo e il punto di rientro con l'epoch
//! che non torna indietro; l'archivio idempotente; il registro che riconosce
//! soltanto i dispositivi approvati; i KeyPackage che si consumano.
//!
//! In più ha le leve che servono a provare ciò che in una rete vera succede
//! di rado: una risposta persa, un deposito che non arriva, una fila letta in
//! disordine.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::deposito::Deposito;
use crate::istanza::{
    leggi_identita, Autore, BustaDaDepositare, BustaHandshake, ChiSono, ConversazioneVista,
    DispositivoInElenco, DispositivoRegistrato, Istanza, PaginaHandshake, PaginaRemota,
    PersonaDaInvitare, PuntoDiRientro, RigaRemota, SessioneAperta, TipoBusta, VoceDaDepositare,
};
use crate::mls::MazzoAvvolto;
use crate::ErroreNucleo;

/// La casa dei doppi: i test di una casa sola la usano senza nominarla.
pub const CASA: &str = "casa-di-prova";

type Esito<T> = Result<T, ErroreNucleo>;

fn no(stato: u16, codice: &str) -> ErroreNucleo {
    ErroreNucleo::Casa {
        stato,
        codice: codice.into(),
    }
}

/// L'id con cui le conversazioni nominano chi ha quel nome.
pub fn id_di(username: &str) -> String {
    format!("u-{username}")
}

fn nome_di(id: &str) -> String {
    id.strip_prefix("u-").unwrap_or(id).to_string()
}

struct DispositivoFinto {
    id: String,
    utente: String,
    chiave: Vec<u8>,
    approvato: bool,
    revocato: bool,
    pacchetti: Vec<Vec<u8>>,
    creato_il: String,
}

/// Se `prova` è la firma di `messaggioDiProvaChiave(sfida, chiave)` con la
/// privata di `chiave`: `firmaValida` di `apps/core-api`, con la stessa
/// crittografia che il nucleo usa per firmare.
fn prova_valida(chiave: &[u8], sfida: &str, prova: &[u8]) -> bool {
    use base64::Engine;
    use openmls_rust_crypto::RustCrypto;
    use openmls_traits::crypto::OpenMlsCrypto;
    use openmls_traits::types::SignatureScheme;

    let messaggio = format!(
        "ESTIA-prova-chiave-v1\n{sfida}\n{}",
        base64::engine::general_purpose::STANDARD.encode(chiave)
    );
    RustCrypto::default()
        .verify_signature(
            SignatureScheme::ECDSA_SECP256R1_SHA256,
            messaggio.as_bytes(),
            chiave,
            prova,
        )
        .is_ok()
}

struct ConversazioneFinta {
    gruppo: bool,
    nome: Option<String>,
    /// Gli id dei membri, nell'ordine in cui sono entrati.
    membri: Vec<String>,
    ruoli: HashMap<String, String>,
    rimossi: Vec<String>,
    /// La ordina un'altra casa: qui non si crea, si aspetta.
    altrove: bool,
    congelata: bool,
}

/// Una busta sul canale, destinatario compreso: la rotta vera non lo restituisce.
#[derive(Clone, Debug)]
pub struct Depositata {
    pub conversazione: String,
    pub seq: u64,
    pub tipo: TipoBusta,
    pub epoch: u64,
    pub busta: String,
    pub destinatario: Option<String>,
}

struct VoceFinta {
    voce: VoceDaDepositare,
    autore: String,
}

#[derive(Default)]
pub struct Chiamate {
    pub salva_mazzo: u32,
    pub deposita_archivio: u32,
    pub chiavi_di_firma: u32,
    /// I depositi che la fila ha rifiutato con un 409.
    pub superati: u32,
}

#[derive(Default)]
struct Mondo {
    dispositivi: Vec<DispositivoFinto>,
    /// Chi ha già avuto un dispositivo approvato: il primo è il primo davvero.
    ha_avuto_un_si: HashSet<String>,
    /// Una sfida per sessione, che si usa una volta.
    sfide: HashMap<String, String>,
    conversazioni: BTreeMap<String, ConversazioneFinta>,
    handshake: Vec<Depositata>,
    mazzi: HashMap<String, MazzoAvvolto>,
    rientri: HashMap<String, PuntoDiRientro>,
    archivio: HashMap<String, Vec<VoceFinta>>,
    falsi: HashMap<String, (Option<String>, Option<String>)>,
    chiamate: Chiamate,
    seq: u64,
    /* le leve */
    in_disordine: HashSet<String>,
    per_pagina: Option<usize>,
    risposte_perse: u32,
    depositi_persi: u32,
    registro_spento: bool,
    senza_sfida: bool,
    sorpasso: Option<Depositata>,
    casa_che_ordina_spenta: bool,
}

impl Mondo {
    fn ultima_epoch(&self, conversazione: &str) -> u64 {
        self.handshake
            .iter()
            .filter(|h| h.conversazione == conversazione && h.tipo == TipoBusta::Commit)
            .map(|h| h.epoch)
            .max()
            .unwrap_or(0)
    }

    fn vista(&self, id: &str) -> Esito<ConversazioneVista> {
        let c = self
            .conversazioni
            .get(id)
            .ok_or(no(404, "conversazione_inesistente"))?;
        Ok(ConversazioneVista {
            id: id.to_string(),
            gruppo: c.gruppo,
            nome: c.nome.clone(),
            membri: c
                .membri
                .iter()
                .map(|m| Autore {
                    id: m.clone(),
                    username: nome_di(m),
                    nome: String::new(),
                })
                .collect(),
            ruoli: c.ruoli.clone(),
            rimossi: c.rimossi.clone(),
            ordinata_qui: !c.altrove,
            congelata: c.congelata,
            non_letti: 0,
            creata_il: "2026-11-28T09:00:00.000Z".into(),
            ultimo_messaggio_il: None,
        })
    }

    /// `#richiediMembro` della rotta vera.
    fn richiedi_membro(&self, conversazione: &str, id: &str) -> Esito<()> {
        let c = self
            .conversazioni
            .get(conversazione)
            .ok_or(no(404, "conversazione_inesistente"))?;
        if c.membri.iter().any(|m| m == id) {
            return Ok(());
        }
        let indirizzo = format!("{}@{CASA}", nome_di(id));
        Err(if c.rimossi.contains(&indirizzo) {
            no(403, "rimosso_dal_gruppo")
        } else {
            no(403, "non_membro")
        })
    }

    fn gestisce(&self, conversazione: &str, id: &str) -> Esito<()> {
        self.richiedi_membro(conversazione, id)?;
        let ruolo = self.conversazioni[conversazione].ruoli.get(id);
        if matches!(
            ruolo.map(String::as_str),
            Some("creatore" | "amministratore")
        ) {
            Ok(())
        } else {
            Err(no(403, "solo_amministratori"))
        }
    }
}

/// Un'istanza in memoria che si comporta come quella vera.
#[derive(Clone, Default)]
pub struct IstanzaFinta {
    mondo: Arc<Mutex<Mondo>>,
}

impl IstanzaFinta {
    fn mondo(&self) -> MutexGuard<'_, Mondo> {
        self.mondo.lock().unwrap()
    }

    /// La vista che l'istanza dà a una **sessione** di quella persona: un
    /// dispositivo. Due viste della stessa persona sono due dispositivi.
    pub fn per(&self, username: &str) -> Arc<VistaFinta> {
        let mut mondo = self.mondo();
        mondo.seq += 1;
        Arc::new(VistaFinta {
            mondo: self.mondo.clone(),
            username: username.to_string(),
            dispositivo: format!("dev-{}", mondo.seq),
        })
    }

    /* ----- per guardare dai test ----- */

    pub fn depositati(&self, conversazione: &str) -> Vec<Depositata> {
        self.mondo()
            .handshake
            .iter()
            .filter(|h| h.conversazione == conversazione)
            .cloned()
            .collect()
    }

    pub fn mazzo(&self, conversazione: &str) -> Option<MazzoAvvolto> {
        self.mondo().mazzi.get(conversazione).cloned()
    }

    pub fn punto_di_rientro(&self, conversazione: &str) -> Option<PuntoDiRientro> {
        self.mondo().rientri.get(conversazione).cloned()
    }

    /// Le voci dell'archivio come sono custodite: cifrate.
    pub fn voci(&self, conversazione: &str) -> Vec<VoceDaDepositare> {
        self.mondo()
            .archivio
            .get(conversazione)
            .map(|voci| voci.iter().map(|v| v.voce.clone()).collect())
            .unwrap_or_default()
    }

    pub fn chiamate<T>(&self, f: impl FnOnce(&Chiamate) -> T) -> T {
        f(&self.mondo().chiamate)
    }

    /// Quanti KeyPackage non ancora prelevati ha quel dispositivo.
    pub fn scorta_di(&self, dispositivo: &str) -> usize {
        self.mondo()
            .dispositivi
            .iter()
            .find(|d| d.id == dispositivo)
            .map_or(0, |d| d.pacchetti.len())
    }

    /* ----- le leve ----- */

    /// Un dispositivo già approvato dice di sì a un altro (ADR 0040).
    pub fn approva(&self, dispositivo: &str) {
        let mut mondo = self.mondo();
        let d = mondo
            .dispositivi
            .iter_mut()
            .find(|d| d.id == dispositivo)
            .expect("dispositivo");
        d.approvato = true;
        let utente = d.utente.clone();
        mondo.ha_avuto_un_si.insert(utente);
    }

    /// Revoca un dispositivo: la sua chiave esce dal registro, per sempre.
    pub fn revoca(&self, dispositivo: &str) {
        let mut mondo = self.mondo();
        mondo
            .dispositivi
            .iter_mut()
            .find(|d| d.id == dispositivo)
            .expect("dispositivo")
            .revocato = true;
    }

    /// Sostituisce il primo KeyPackage in scorta di quella persona con un
    /// altro: è una casa che consegna la chiave d'ingresso sbagliata.
    pub fn scambia_il_pacchetto(&self, username: &str, pacchetto: Vec<u8>) {
        let mut mondo = self.mondo();
        let d = mondo
            .dispositivi
            .iter_mut()
            .find(|d| d.utente == username && d.approvato && !d.revocato)
            .expect("dispositivo");
        d.pacchetti[0] = pacchetto;
    }

    /// La conversazione la ordina un'altra casa.
    pub fn ordinata_altrove(&self, conversazione: &str) {
        self.mondo()
            .conversazioni
            .get_mut(conversazione)
            .expect("conversazione")
            .altrove = true;
    }

    pub fn congela(&self, conversazione: &str) {
        self.mondo()
            .conversazioni
            .get_mut(conversazione)
            .expect("conversazione")
            .congelata = true;
    }

    /// Quella persona esce dal gruppo: `POST …/uscita`. La sua foglia resta
    /// nell'albero finché qualcuno non la toglie.
    ///
    /// Con `dichiarato: false` la casa non lo conta fra i tolti: è ciò che
    /// vede una casa che partecipa, a cui la notizia non è ancora arrivata.
    pub fn esce(&self, conversazione: &str, username: &str, dichiarato: bool) {
        let mut mondo = self.mondo();
        let c = mondo
            .conversazioni
            .get_mut(conversazione)
            .expect("conversazione");
        c.membri.retain(|m| m != &id_di(username));
        let indirizzo = format!("{username}@{CASA}");
        if dichiarato && !c.rimossi.contains(&indirizzo) {
            c.rimossi.push(indirizzo);
        }
    }

    /// Rimette fra i membri chi era uscito, senza passare dal gruppo cifrato.
    pub fn riammette(&self, conversazione: &str, username: &str) {
        let mut mondo = self.mondo();
        let c = mondo
            .conversazioni
            .get_mut(conversazione)
            .expect("conversazione");
        c.membri.push(id_di(username));
        c.rimossi.retain(|r| r != &format!("{username}@{CASA}"));
    }

    /// La fila di quella conversazione arriva in disordine: dall'ultima busta
    /// alla prima. Una rete vera non lo fa; un'istanza guasta, o che mente, sì.
    pub fn in_disordine(&self, conversazione: &str, si: bool) {
        let mut mondo = self.mondo();
        if si {
            mondo.in_disordine.insert(conversazione.to_string());
        } else {
            mondo.in_disordine.remove(conversazione);
        }
    }

    /// La casa che ordina non risponde a chi chiede di uscire: è il 503 che
    /// la rotta vera dà quando il gruppo lo ordina una casa spenta.
    pub fn spegni_la_casa_che_ordina(&self, spenta: bool) {
        self.mondo().casa_che_ordina_spenta = spenta;
    }

    /// Quante buste per pagina di handshake.
    pub fn per_pagina(&self, quante: usize) {
        self.mondo().per_pagina = Some(quante);
    }

    /// I prossimi depositi di handshake **arrivano**, ma la risposta si perde.
    pub fn perdi_le_risposte(&self, quante: u32) {
        self.mondo().risposte_perse = quante;
    }

    /// I prossimi depositi di handshake non arrivano affatto.
    pub fn perdi_i_depositi(&self, quanti: u32) {
        self.mondo().depositi_persi = quanti;
    }

    /// Un commit di un altro che arriva in fila **un attimo prima** del
    /// prossimo deposito: è la corsa che ADR 0042 §3 risolve con il 409.
    pub fn sorpassa(&self, conversazione: &str, commit: &[u8], epoch: u64) {
        use base64::Engine;
        self.mondo().sorpasso = Some(Depositata {
            conversazione: conversazione.to_string(),
            seq: 0,
            tipo: TipoBusta::Commit,
            epoch,
            busta: base64::engine::general_purpose::STANDARD.encode(commit),
            destinatario: None,
        });
    }

    /// Una Casa di prima, senza la rotta della sfida: 404.
    pub fn senza_la_sfida(&self, senza: bool) {
        self.mondo().senza_sfida = senza;
    }

    /// Le sfide date e non ancora usate.
    pub fn sfide_aperte(&self) -> usize {
        self.mondo().sfide.len()
    }

    /// La casa di chi si chiede non risponde: è un errore, non un elenco vuoto.
    pub fn spegni_il_registro(&self, spento: bool) {
        self.mondo().registro_spento = spento;
    }

    /// Riscrive ciò che l'istanza dichiara accanto a una voce, come farebbe
    /// una casa che mente: il testo cifrato resta quello.
    pub fn falsifica(
        &self,
        conversazione: &str,
        id: &str,
        mittente: Option<&str>,
        creato_il: Option<&str>,
    ) {
        self.mondo().falsi.insert(
            format!("{conversazione}/{id}"),
            (mittente.map(str::to_string), creato_il.map(str::to_string)),
        );
    }
}

/// Ciò che l'istanza finta risponde a un dispositivo.
pub struct VistaFinta {
    mondo: Arc<Mutex<Mondo>>,
    username: String,
    dispositivo: String,
}

impl VistaFinta {
    fn mondo(&self) -> MutexGuard<'_, Mondo> {
        self.mondo.lock().unwrap()
    }

    fn io(&self) -> String {
        id_di(&self.username)
    }

    pub fn dispositivo(&self) -> &str {
        &self.dispositivo
    }

    /// Chi chiede ha un dispositivo approvato e non revocato: è il vincolo
    /// che la Casa mette davanti a un sì o a un no.
    fn approvato(mondo: &Mondo, dispositivo: &str) -> Esito<()> {
        if mondo
            .dispositivi
            .iter()
            .any(|d| d.id == dispositivo && d.approvato && !d.revocato)
        {
            Ok(())
        } else {
            Err(no(403, "device_not_approved"))
        }
    }

    /// Un dispositivo di questa persona, o un 404 che non dice se esiste.
    fn suo<'a>(&self, mondo: &'a mut Mondo, id: &str) -> Esito<&'a mut DispositivoFinto> {
        mondo
            .dispositivi
            .iter_mut()
            .find(|d| d.id == id && d.utente == self.username)
            .ok_or(no(404, "device_not_found"))
    }
}

/// La forma che l'istanza vera pretende da una voce (`forma.ts`).
fn voce_valida(voce: &VoceDaDepositare) -> bool {
    let id_buono = !voce.id.is_empty()
        && voce.id.len() <= 120
        && voce
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b));
    let t = voce.creato_il.as_bytes();
    let cifre = |da: usize, a: usize| t[da..a].iter().all(u8::is_ascii_digit);
    let istante_buono = t.len() == 24
        && cifre(0, 4)
        && t[4] == b'-'
        && cifre(5, 7)
        && t[7] == b'-'
        && cifre(8, 10)
        && t[10] == b'T'
        && cifre(11, 13)
        && t[13] == b':'
        && cifre(14, 16)
        && t[16] == b':'
        && cifre(17, 19)
        && t[19] == b'.'
        && cifre(20, 23)
        && t[23] == b'Z';
    id_buono && istante_buono
}

impl Istanza for VistaFinta {
    async fn chi_sono(&self) -> Esito<ChiSono> {
        Ok(ChiSono {
            id: self.io(),
            username: self.username.clone(),
            casa: CASA.into(),
        })
    }

    async fn sfida(&self) -> Esito<String> {
        let mut mondo = self.mondo();
        if mondo.senza_sfida {
            return Err(no(404, "not_found"));
        }
        mondo.seq += 1;
        let sfida = format!("sfida-{}", mondo.seq);
        mondo.sfide.insert(self.dispositivo.clone(), sfida.clone());
        Ok(sfida)
    }

    async fn registra_chiave(
        &self,
        chiave_di_firma: &[u8],
        prova: Option<&[u8]>,
    ) -> Esito<DispositivoRegistrato> {
        let mut mondo = self.mondo();
        // La sfida si consuma comunque: vale una volta.
        let sfida = mondo.sfide.remove(&self.dispositivo);
        // Una chiave già approvata, e mai tolta da qualcuno, che si
        // ripresenta con la prova di possesso: è chi rientra con la propria
        // chiave da una sessione nuova (`registerKey` della Casa).
        let stessa_chiave = |d: &DispositivoFinto| {
            d.utente == self.username && d.chiave == chiave_di_firma && d.approvato
        };
        let gia_approvata = mondo.dispositivi.iter().any(stessa_chiave)
            && !mondo
                .dispositivi
                .iter()
                .any(|d| stessa_chiave(d) && d.revocato);
        let provata = match (sfida, prova) {
            (Some(sfida), Some(prova)) => prova_valida(chiave_di_firma, &sfida, prova),
            _ => false,
        };
        // Il primo dispositivo di una persona si approva da solo; ogni altro
        // aspetta. «Primo» una volta sola.
        let da_solo = !mondo.ha_avuto_un_si.contains(&self.username) || (gia_approvata && provata);
        let approvato = match mondo
            .dispositivi
            .iter_mut()
            .find(|d| d.id == self.dispositivo)
        {
            Some(d) => {
                // La stessa chiave tiene il sì che ha; una chiave diversa lo perde.
                if d.chiave != chiave_di_firma {
                    d.chiave = chiave_di_firma.to_vec();
                    d.approvato = da_solo;
                }
                d.approvato
            }
            None => {
                mondo.seq += 1;
                let creato_il = format!("2026-11-28T10:00:{:02}.000Z", mondo.seq % 60);
                mondo.dispositivi.push(DispositivoFinto {
                    id: self.dispositivo.clone(),
                    utente: self.username.clone(),
                    chiave: chiave_di_firma.to_vec(),
                    approvato: da_solo,
                    revocato: false,
                    pacchetti: Vec::new(),
                    creato_il,
                });
                da_solo
            }
        };
        if approvato {
            mondo.ha_avuto_un_si.insert(self.username.clone());
        }
        Ok(DispositivoRegistrato {
            id: self.dispositivo.clone(),
            approvato,
        })
    }

    async fn dispositivi(&self) -> Esito<Vec<DispositivoInElenco>> {
        use base64::Engine;
        let mondo = self.mondo();
        Ok(mondo
            .dispositivi
            .iter()
            .filter(|d| d.utente == self.username)
            .map(|d| DispositivoInElenco {
                id: d.id.clone(),
                sessione: d.id.clone(),
                chiave_pubblica: base64::engine::general_purpose::STANDARD.encode(&d.chiave),
                creato_il: d.creato_il.clone(),
                approvato_il: d.approvato.then(|| d.creato_il.clone()),
                revocato_il: d.revocato.then(|| "2026-11-28T11:00:00.000Z".to_string()),
            })
            .collect())
    }

    async fn sessioni(&self) -> Esito<Vec<SessioneAperta>> {
        // Il no della Casa chiude anche la sessione: un revocato non c'è.
        let mondo = self.mondo();
        Ok(mondo
            .dispositivi
            .iter()
            .filter(|d| d.utente == self.username && !d.revocato)
            .map(|d| SessioneAperta {
                id: d.id.clone(),
                etichetta: format!("Telefono {}", d.id),
                visto_il: "2026-11-28T10:30:00.000Z".into(),
            })
            .collect())
    }

    async fn approva_dispositivo(&self, id: &str) -> Esito<()> {
        let mut mondo = self.mondo();
        Self::approvato(&mondo, &self.dispositivo)?;
        self.suo(&mut mondo, id)?.approvato = true;
        mondo.ha_avuto_un_si.insert(self.username.clone());
        Ok(())
    }

    async fn rifiuta_dispositivo(&self, id: &str) -> Esito<()> {
        let mut mondo = self.mondo();
        Self::approvato(&mondo, &self.dispositivo)?;
        self.suo(&mut mondo, id)?.revocato = true;
        Ok(())
    }

    async fn pubblica_pacchetti(&self, pacchetti: Vec<Vec<u8>>) -> Esito<()> {
        let mut mondo = self.mondo();
        let d = mondo
            .dispositivi
            .iter_mut()
            .find(|d| d.id == self.dispositivo)
            .ok_or(no(400, "device_not_registered"))?;
        d.pacchetti.extend(pacchetti);
        Ok(())
    }

    async fn chiavi_di_firma(&self, membro: &str) -> Esito<Vec<Vec<u8>>> {
        let mut mondo = self.mondo();
        mondo.chiamate.chiavi_di_firma += 1;
        if mondo.registro_spento {
            return Err(no(503, "istanza_non_raggiungibile"));
        }
        // Un registro per casa: il nome da solo non è una chiave di ricerca.
        let Some((username, CASA)) = leggi_identita(membro) else {
            return Ok(Vec::new());
        };
        Ok(mondo
            .dispositivi
            .iter()
            .filter(|d| d.utente == username && d.approvato && !d.revocato)
            .map(|d| d.chiave.clone())
            .collect())
    }

    async fn pacchetti_di(&self, membro: &str) -> Esito<Vec<Vec<u8>>> {
        let mut mondo = self.mondo();
        let Some((username, CASA)) = leggi_identita(membro) else {
            return Err(no(404, "no_device_available"));
        };
        let presi: Vec<Vec<u8>> = mondo
            .dispositivi
            .iter_mut()
            .filter(|d| d.utente == username && d.approvato && !d.revocato)
            .filter(|d| !d.pacchetti.is_empty())
            .map(|d| d.pacchetti.remove(0))
            .take(10)
            .collect();
        if presi.is_empty() {
            return Err(no(404, "no_device_available"));
        }
        Ok(presi)
    }

    async fn miei_pacchetti(&self, chiavi_di_firma: &[Vec<u8>]) -> Esito<Vec<Vec<u8>>> {
        let mut mondo = self.mondo();
        let approvato = mondo
            .dispositivi
            .iter()
            .any(|d| d.id == self.dispositivo && d.approvato && !d.revocato);
        if !approvato {
            return Err(no(403, "device_not_approved"));
        }
        Ok(mondo
            .dispositivi
            .iter_mut()
            .filter(|d| d.utente == self.username && d.id != self.dispositivo)
            .filter(|d| d.approvato && !d.revocato && chiavi_di_firma.contains(&d.chiave))
            .filter(|d| !d.pacchetti.is_empty())
            .map(|d| d.pacchetti.remove(0))
            .collect())
    }

    async fn conversazioni(&self) -> Esito<Vec<ConversazioneVista>> {
        let mondo = self.mondo();
        mondo
            .conversazioni
            .iter()
            .filter(|(_, c)| c.membri.contains(&self.io()))
            .map(|(id, _)| mondo.vista(id))
            .collect()
    }

    async fn conversazione(&self, id: &str) -> Esito<ConversazioneVista> {
        let mondo = self.mondo();
        mondo.richiedi_membro(id, &self.io())?;
        mondo.vista(id)
    }

    async fn crea_diretta(&self, con: &PersonaDaInvitare) -> Esito<ConversazioneVista> {
        let mut mondo = self.mondo();
        let altro = id_di(&con.username);
        if altro == self.io() {
            return Err(no(400, "cannot_message_self"));
        }
        let gia = mondo
            .conversazioni
            .iter()
            .find(|(_, c)| !c.gruppo && c.membri.contains(&self.io()) && c.membri.contains(&altro))
            .map(|(id, _)| id.clone());
        let id = match gia {
            Some(id) => id,
            None => {
                mondo.seq += 1;
                let id = format!("c-{}", mondo.seq);
                mondo.conversazioni.insert(
                    id.clone(),
                    ConversazioneFinta {
                        gruppo: false,
                        nome: None,
                        membri: vec![self.io(), altro],
                        ruoli: HashMap::new(),
                        rimossi: Vec::new(),
                        altrove: false,
                        congelata: false,
                    },
                );
                id
            }
        };
        mondo.vista(&id)
    }

    async fn crea_gruppo(
        &self,
        nome: &str,
        membri: &[PersonaDaInvitare],
    ) -> Esito<ConversazioneVista> {
        let mut mondo = self.mondo();
        if membri.len() < 2 {
            return Err(no(400, "gruppo_troppo_piccolo"));
        }
        mondo.seq += 1;
        let id = format!("g-{}", mondo.seq);
        let mut tutti = vec![self.io()];
        tutti.extend(membri.iter().map(|m| id_di(&m.username)));
        let mut ruoli: HashMap<String, String> =
            tutti.iter().map(|m| (m.clone(), "membro".into())).collect();
        ruoli.insert(self.io(), "creatore".into());
        mondo.conversazioni.insert(
            id.clone(),
            ConversazioneFinta {
                gruppo: true,
                nome: Some(nome.to_string()),
                membri: tutti,
                ruoli,
                rimossi: Vec::new(),
                altrove: false,
                congelata: false,
            },
        );
        mondo.vista(&id)
    }

    async fn aggiungi_al_gruppo(
        &self,
        id: &str,
        chi: &PersonaDaInvitare,
    ) -> Esito<ConversazioneVista> {
        let mut mondo = self.mondo();
        mondo.gestisce(id, &self.io())?;
        let nuovo = id_di(&chi.username);
        let c = mondo.conversazioni.get_mut(id).expect("conversazione");
        if c.membri.contains(&nuovo) {
            return Err(no(409, "gia_nel_gruppo"));
        }
        c.membri.push(nuovo.clone());
        c.ruoli.insert(nuovo, "membro".into());
        c.rimossi
            .retain(|r| r != &format!("{}@{CASA}", chi.username));
        mondo.vista(id)
    }

    async fn togli_dal_gruppo(&self, id: &str, membro: &str) -> Esito<ConversazioneVista> {
        let mut mondo = self.mondo();
        mondo.gestisce(id, &self.io())?;
        let c = mondo.conversazioni.get_mut(id).expect("conversazione");
        if !c.membri.iter().any(|m| m == membro) {
            return Err(no(404, "non_nel_gruppo"));
        }
        c.membri.retain(|m| m != membro);
        c.ruoli.remove(membro);
        c.rimossi.push(format!("{}@{CASA}", nome_di(membro)));
        mondo.vista(id)
    }

    async fn esci(&self, id: &str) -> Esito<()> {
        let mut mondo = self.mondo();
        let io = self.io();
        mondo.richiedi_membro(id, &io)?;
        let c = mondo.conversazioni.get_mut(id).expect("conversazione");
        if !c.gruppo {
            return Err(no(400, "non_un_gruppo"));
        }
        if c.congelata {
            return Err(no(409, "gruppo_congelato"));
        }
        if mondo.casa_che_ordina_spenta {
            return Err(no(503, "casa_che_ordina_non_raggiungibile"));
        }
        let c = mondo.conversazioni.get_mut(id).expect("conversazione");
        c.membri.retain(|m| m != &io);
        c.ruoli.remove(&io);
        c.rimossi.push(format!("{}@{CASA}", nome_di(&io)));
        Ok(())
    }

    async fn handshake_dopo(&self, id: &str, dopo: Option<&str>) -> Esito<PaginaHandshake> {
        let mondo = self.mondo();
        mondo.richiedi_membro(id, &self.io())?;
        // Ordine di ARRIVO, come `seq` lato istanza. E un Welcome lo vede solo
        // il suo destinatario: un commit non ne ha, e va a tutti.
        let da: u64 = dopo.and_then(|d| d.parse().ok()).unwrap_or(0);
        let mut mie: Vec<&Depositata> = mondo
            .handshake
            .iter()
            .filter(|h| h.conversazione == id && h.seq > da)
            .filter(|h| h.destinatario.as_deref().is_none_or(|d| d == self.io()))
            .collect();
        let limite = mondo.per_pagina.unwrap_or(100);
        let altre = mie.len() > limite;
        mie.truncate(limite);
        let prossimo = mie.last().filter(|_| altre).map(|h| h.seq.to_string());
        if mondo.in_disordine.contains(id) {
            mie.reverse();
        }
        Ok(PaginaHandshake {
            handshake: mie
                .into_iter()
                .map(|h| BustaHandshake {
                    id: h.seq.to_string(),
                    tipo: h.tipo,
                    epoch: h.epoch,
                    busta: h.busta.clone(),
                })
                .collect(),
            prossimo,
        })
    }

    async fn deposita_handshake(&self, id: &str, busta: BustaDaDepositare) -> Esito<()> {
        let mut mondo = self.mondo();
        mondo.richiedi_membro(id, &self.io())?;
        if mondo.conversazioni[id].congelata {
            return Err(no(409, "gruppo_congelato"));
        }
        if mondo.depositi_persi > 0 {
            mondo.depositi_persi -= 1;
            return Err(ErroreNucleo::Rete("il deposito non è arrivato".into()));
        }
        if let Some(mut primo) = mondo.sorpasso.take() {
            mondo.seq += 1;
            primo.seq = mondo.seq;
            mondo.handshake.push(primo);
        }
        let ultima = mondo.ultima_epoch(id);
        match (busta.tipo, &busta.destinatario) {
            (TipoBusta::Welcome, None) | (TipoBusta::Commit, Some(_)) => {
                return Err(no(400, "invalid_request"));
            }
            (TipoBusta::Welcome, Some(destinatario)) => {
                if !mondo.conversazioni[id].membri.contains(destinatario) {
                    return Err(no(400, "invalid_request"));
                }
                // Un Welcome porta a un'epoch che la fila conosce.
                if busta.epoch < 1 || busta.epoch > ultima {
                    return Err(no(409, "conflict"));
                }
            }
            // Come la fila vera: un commit entra solo all'epoch successiva
            // all'ultima, e chi arriva secondo riceve un 409.
            (TipoBusta::Commit, None) => {
                if busta.epoch != ultima + 1 {
                    mondo.chiamate.superati += 1;
                    return Err(no(409, "conflict"));
                }
            }
        }
        mondo.seq += 1;
        let seq = mondo.seq;
        mondo.handshake.push(Depositata {
            conversazione: id.to_string(),
            seq,
            tipo: busta.tipo,
            epoch: busta.epoch,
            busta: busta.busta,
            destinatario: busta.destinatario,
        });
        if mondo.risposte_perse > 0 {
            mondo.risposte_perse -= 1;
            return Err(ErroreNucleo::Rete("la risposta si è persa".into()));
        }
        Ok(())
    }

    async fn mazzo(&self, id: &str) -> Esito<Option<MazzoAvvolto>> {
        let mondo = self.mondo();
        mondo.richiedi_membro(id, &self.io())?;
        Ok(mondo.mazzi.get(id).cloned())
    }

    async fn salva_mazzo(&self, id: &str, mazzo: MazzoAvvolto) -> Esito<()> {
        let mut mondo = self.mondo();
        mondo.richiedi_membro(id, &self.io())?;
        mondo.chiamate.salva_mazzo += 1;
        // L'epoch non torna indietro, come lato istanza.
        if mondo.mazzi.get(id).is_none_or(|m| m.epoch <= mazzo.epoch) {
            mondo.mazzi.insert(id.to_string(), mazzo);
        }
        Ok(())
    }

    async fn punto_di_rientro(&self, id: &str) -> Esito<Option<PuntoDiRientro>> {
        let mondo = self.mondo();
        mondo.richiedi_membro(id, &self.io())?;
        Ok(mondo.rientri.get(id).cloned())
    }

    async fn salva_punto_di_rientro(&self, id: &str, punto: PuntoDiRientro) -> Esito<()> {
        let mut mondo = self.mondo();
        mondo.richiedi_membro(id, &self.io())?;
        if mondo.rientri.get(id).is_none_or(|p| p.epoch <= punto.epoch) {
            mondo.rientri.insert(id.to_string(), punto);
        }
        Ok(())
    }

    async fn cronologia(&self, id: &str, _prima: Option<&str>) -> Esito<PaginaRemota> {
        let mondo = self.mondo();
        mondo.richiedi_membro(id, &self.io())?;
        // Come la rotta vera, in piccolo: le voci dalla più vecchia, tutte
        // disponibili, e il mittente è chi le ha depositate.
        let mut righe: Vec<RigaRemota> = mondo
            .archivio
            .get(id)
            .map(|voci| {
                voci.iter()
                    .map(|v| {
                        let falso = mondo.falsi.get(&format!("{id}/{}", v.voce.id));
                        RigaRemota {
                            id: v.voce.id.clone(),
                            mittente: Some(
                                falso
                                    .and_then(|f| f.0.clone())
                                    .unwrap_or(format!("{}@{CASA}", nome_di(&v.autore))),
                            ),
                            creato_il: falso
                                .and_then(|f| f.1.clone())
                                .unwrap_or(v.voce.creato_il.clone()),
                            casa: CASA.into(),
                            voce: Some(v.voce.voce.clone()),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        righe.sort_by(|a, b| (&a.creato_il, &a.id).cmp(&(&b.creato_il, &b.id)));
        Ok(PaginaRemota {
            righe,
            prima: None,
            non_rispondono: Vec::new(),
        })
    }

    async fn deposita_archivio(&self, id: &str, voci: Vec<VoceDaDepositare>) -> Esito<()> {
        let mut mondo = self.mondo();
        mondo.richiedi_membro(id, &self.io())?;
        mondo.chiamate.deposita_archivio += 1;
        if mondo.conversazioni[id].congelata {
            return Err(no(409, "gruppo_congelato"));
        }
        if !voci.iter().all(voce_valida) {
            return Err(no(400, "invalid_request"));
        }
        let io = self.io();
        let attuali = mondo.archivio.entry(id.to_string()).or_default();
        // Come l'API: un retry deve avere stesso autore e contenuto, e un
        // conflitto annulla l'intero deposito.
        let mut nuove = Vec::new();
        for voce in voci {
            match attuali.iter().find(|v| v.voce.id == voce.id) {
                Some(presente) if presente.autore != io || presente.voce != voce => {
                    return Err(no(409, "conflict"));
                }
                Some(_) => {}
                None => nuove.push(VoceFinta {
                    voce,
                    autore: io.clone(),
                }),
            }
        }
        attuali.extend(nuove);
        Ok(())
    }

    async fn ritira_voce(&self, id: &str, voce: &str) -> Esito<()> {
        let mut mondo = self.mondo();
        mondo.richiedi_membro(id, &self.io())?;
        let io = self.io();
        let voci = mondo.archivio.entry(id.to_string()).or_default();
        let prima = voci.len();
        // Come `ritiraVoce` del repository: soltanto la propria.
        voci.retain(|v| !(v.voce.id == voce && v.autore == io));
        if voci.len() == prima {
            return Err(no(404, "messaggio_inesistente"));
        }
        Ok(())
    }
}

/// Un deposito in memoria, che conta le scritture.
#[derive(Default)]
pub struct DepositoFinto {
    dati: Mutex<HashMap<String, Vec<u8>>>,
    scritture: Mutex<HashMap<String, u32>>,
}

impl DepositoFinto {
    /// Quante volte è stato scritto ciò che sta sotto quel nome.
    pub fn scritture(&self, nome: &str) -> u32 {
        self.scritture
            .lock()
            .unwrap()
            .get(nome)
            .copied()
            .unwrap_or(0)
    }
}

impl Deposito for DepositoFinto {
    fn leggi(&self, nome: String) -> Esito<Option<Vec<u8>>> {
        Ok(self.dati.lock().unwrap().get(&nome).cloned())
    }

    fn scrivi(&self, nome: String, dati: Vec<u8>) -> Esito<()> {
        *self
            .scritture
            .lock()
            .unwrap()
            .entry(nome.clone())
            .or_default() += 1;
        self.dati.lock().unwrap().insert(nome, dati);
        Ok(())
    }
}
