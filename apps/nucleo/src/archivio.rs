//! L'archivio della conversazione ([ADR 0037](../../../docs/adr/0037-la-cronologia-e-un-archivio-non-una-chiave.md)),
//! come lo scrive e lo legge il client web.
//!
//! È la traduzione di `apps/web/src/mls/archivio.ts`, e deve restare uguale
//! **byte per byte**: una voce scritta dal telefono la apre il browser, e
//! viceversa. Ciò che i due lati devono fare allo stesso modo è tutto qui:
//!
//! - il sigillo è `IV(12) ‖ AES-256-GCM(chiave, IV, AAD, dati)`, con il tag di
//!   16 byte in coda, e viaggia in base64 standard con il riempimento;
//! - il mazzo è il JSON compatto di un array con le chiavi in base64,
//!   sigillato sotto la serratura dell'epoch, senza dati autenticati;
//! - `chiave_n` è 1-based, come in [S2](../../../docs/spike/S2-la-chiave-d-archivio.md);
//! - il legame di una voce ([ADR 0052](../../../docs/adr/0052-l-archivio-dei-gruppi.md) §1)
//!   sono i dati autenticati: il JSON compatto di
//!   `["estia-archivio-v2", conversazione, id, mittente, data]`;
//! - una voce che non si apre torna `None`, e non diventa mai un testo.
//!
//! Nessuna I/O e nessun MLS qui dentro: la serratura la deriva [`crate::mls`],
//! che è anche l'unico a tenere una [`Catena`]. Questo modulo non passa il
//! confine di UniFFI, a parte i due record che non portano chiavi.
//! `infra/prova-archivio` lo mette davanti al modulo vero del web.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use base64::engine::DecodePaddingMode;
use base64::{alphabet, Engine};
use zeroize::{Zeroize, Zeroizing};

/// Quanto è lunga una chiave della catena, e la serratura: AES-256.
pub const LUNGHEZZA_CHIAVE: usize = 32;
const LUNGHEZZA_IV: usize = 12;
/// Il primo elemento dei dati legati: dice che cosa si sta legando.
const ETICHETTA_LEGAME: &str = "estia-archivio-v2";

/// Legge il base64 come `atob`: con o senza riempimento, e senza badare ai bit
/// che avanzano nell'ultimo carattere.
const COME_ATOB: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ErroreArchivio {
    #[error("una catena vuota non archivia niente")]
    CatenaVuota,
    #[error("una chiave d'archivio è di {LUNGHEZZA_CHIAVE} byte")]
    ChiaveSbagliata,
    #[error("busta d'archivio troppo corta per contenere qualcosa")]
    BustaCorta,
    #[error("non è base64")]
    Base64,
    #[error("il sigillo non si apre")]
    NonSiApre,
    #[error("questo non è un mazzo di chiavi d'archivio")]
    NonEUnMazzo,
    #[error("il sistema non ha dato byte casuali")]
    Caso,
}

/// La catena `{A₁…Aₙ}`. L'ultima è quella con cui si scrive.
///
/// Le chiavi si azzerano quando la catena esce di scena, e `Debug` non le
/// stampa: un errore che finisce in un registro non deve portarle con sé.
#[derive(Clone)]
pub struct Catena(Vec<Vec<u8>>);

impl Catena {
    /// Una catena da chiavi già note: quelle lette dal deposito, o da un mazzo.
    pub fn da_chiavi(chiavi: Vec<Vec<u8>>) -> Self {
        Catena(chiavi)
    }

    pub fn chiavi(&self) -> &[Vec<u8>] {
        &self.0
    }

    pub fn lunghezza(&self) -> usize {
        self.0.len()
    }

    /// `altra` comincia con tutte le chiavi di questa, e ne ha di più.
    pub fn e_allungata_da(&self, altra: &Catena) -> bool {
        altra.0.len() > self.0.len() && altra.0[..self.0.len()] == self.0[..]
    }
}

impl Drop for Catena {
    fn drop(&mut self) {
        for chiave in &mut self.0 {
            chiave.zeroize();
        }
    }
}

impl std::fmt::Debug for Catena {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Catena({} chiavi)", self.0.len())
    }
}

/// Una voce com'è depositata: la busta, e quale chiave della catena la apre.
#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct VoceCifrata {
    /// Quale chiave della catena l'ha cifrata. È 1-based, come in S2.
    pub chiave_n: u32,
    pub busta: String,
}

/// Ciò a cui una voce è legata (ADR 0052 §1): i quattro campi che l'istanza
/// dichiara accanto a una voce, e che senza legame si mostrerebbero sulla sua
/// parola.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Legame {
    pub conversazione_id: String,
    pub id: String,
    /// `username@casa` di chi scrive.
    pub mittente: String,
    /// La data com'è depositata, carattere per carattere (`createdAt` sul web).
    pub creato_il: String,
}

/// Una voce riletta.
#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct VoceRiletta {
    pub testo: String,
    /// `true` se la voce si è aperta **con** il suo legame: mittente, data e
    /// conversazione sono quelli che chi ha scritto ha sigillato. `false` per
    /// una voce di prima del legame: lì chi e quando restano la parola
    /// dell'istanza, e chi la mostra lo deve dire.
    pub legata: bool,
}

fn a_caso(quanti: usize) -> Result<Zeroizing<Vec<u8>>, ErroreArchivio> {
    let mut byte = Zeroizing::new(vec![0u8; quanti]);
    getrandom::getrandom(&mut byte).map_err(|_| ErroreArchivio::Caso)?;
    Ok(byte)
}

fn base64(byte: &[u8]) -> String {
    STANDARD.encode(byte)
}

/// Come `atob`: salta gli spazi ASCII, poi legge.
fn da_base64(testo: &str) -> Result<Vec<u8>, ErroreArchivio> {
    let pulito: Vec<u8> = testo
        .bytes()
        .filter(|b| !matches!(b, b'\t' | b'\n' | 0x0c | b'\r' | b' '))
        .collect();
    COME_ATOB.decode(pulito).map_err(|_| ErroreArchivio::Base64)
}

fn cifrario(chiave: &[u8]) -> Result<Aes256Gcm, ErroreArchivio> {
    Aes256Gcm::new_from_slice(chiave).map_err(|_| ErroreArchivio::ChiaveSbagliata)
}

fn sigilla(chiave: &[u8], dati: &[u8], legato: Option<&[u8]>) -> Result<Vec<u8>, ErroreArchivio> {
    let cifrario = cifrario(chiave)?;
    // Un IV casuale per ogni sigillo, come sul web: 96 bit, mai riusato apposta.
    let iv = a_caso(LUNGHEZZA_IV)?;
    let cifrato = cifrario
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: dati,
                aad: legato.unwrap_or(&[]),
            },
        )
        .map_err(|_| ErroreArchivio::NonSiApre)?;
    let mut insieme = Vec::with_capacity(LUNGHEZZA_IV + cifrato.len());
    insieme.extend_from_slice(&iv);
    insieme.extend_from_slice(&cifrato);
    Ok(insieme)
}

fn apri(
    chiave: &[u8],
    insieme: &[u8],
    legato: Option<&[u8]>,
) -> Result<Zeroizing<Vec<u8>>, ErroreArchivio> {
    if insieme.len() < LUNGHEZZA_IV {
        return Err(ErroreArchivio::BustaCorta);
    }
    let (iv, cifrato) = insieme.split_at(LUNGHEZZA_IV);
    cifrario(chiave)?
        .decrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: cifrato,
                aad: legato.unwrap_or(&[]),
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| ErroreArchivio::NonSiApre)
}

/// Come `new TextDecoder().decode`: toglie il BOM iniziale e non rifiuta i byte
/// che non sono UTF-8, li sostituisce. Così una stessa voce è lo stesso testo
/// sui due lati, anche quando chi l'ha scritta ha sbagliato.
fn testo_da(byte: &[u8]) -> String {
    let senza_bom = byte.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(byte);
    String::from_utf8_lossy(senza_bom).into_owned()
}

/// La prima chiave, che nasce con la conversazione.
///
/// **Casuale, non derivata da MLS**: è ciò che la rende immune ai cambi di
/// epoch, e quindi ciò che rende la cronologia recuperabile.
pub fn catena_nuova() -> Result<Catena, ErroreArchivio> {
    Ok(Catena(vec![a_caso(LUNGHEZZA_CHIAVE)?.to_vec()]))
}

/// Aggiunge una chiave. Si fa **a ogni rimozione dal gruppo**: chi esce
/// conserva quelle che aveva, ma non ottiene questa, quindi non legge il
/// seguito.
///
/// Per una rimozione la chiave è quella derivata dall'epoch che la rimozione
/// ha creato (ADR 0052 §2) e la passa [`crate::mls`]. Senza, è casuale.
pub fn catena_ruotata(catena: &Catena, nuova: Option<Vec<u8>>) -> Result<Catena, ErroreArchivio> {
    let nuova = match nuova {
        Some(chiave) => chiave,
        None => a_caso(LUNGHEZZA_CHIAVE)?.to_vec(),
    };
    let mut chiavi = catena.0.clone();
    chiavi.push(nuova);
    Ok(Catena(chiavi))
}

/// Avvolge il mazzo sotto la serratura dell'epoch corrente.
pub fn avvolgi(catena: &Catena, serratura: &[u8]) -> Result<String, ErroreArchivio> {
    let pezzi: Zeroizing<Vec<String>> =
        Zeroizing::new(catena.0.iter().map(|chiave| base64(chiave)).collect());
    // Lo stesso testo di `JSON.stringify`: un array di stringhe, senza spazi.
    let payload =
        Zeroizing::new(serde_json::to_vec(&*pezzi).map_err(|_| ErroreArchivio::NonEUnMazzo)?);
    Ok(base64(&sigilla(serratura, &payload, None)?))
}

/// Apre il mazzo. Ci riesce chi è nel gruppo a quell'epoch, e nessun altro.
pub fn svolgi(mazzo_avvolto: &str, serratura: &[u8]) -> Result<Catena, ErroreArchivio> {
    let testo = apri(serratura, &da_base64(mazzo_avvolto)?, None)?;
    let pezzi: Zeroizing<Vec<String>> =
        Zeroizing::new(serde_json::from_slice(&testo).map_err(|_| ErroreArchivio::NonEUnMazzo)?);
    let mut catena = Catena(Vec::with_capacity(pezzi.len()));
    for pezzo in pezzi.iter() {
        catena.0.push(da_base64(pezzo)?);
    }
    Ok(catena)
}

fn scrivi(
    catena: &Catena,
    testo: &str,
    legato: Option<&[u8]>,
) -> Result<VoceCifrata, ErroreArchivio> {
    let ultima = catena.0.last().ok_or(ErroreArchivio::CatenaVuota)?;
    Ok(VoceCifrata {
        busta: base64(&sigilla(ultima, testo.as_bytes(), legato)?),
        chiave_n: catena.0.len() as u32,
    })
}

/// La chiave che una voce cita, se la catena ce l'ha.
fn chiave_di<'a>(catena: &'a Catena, voce: &VoceCifrata) -> Option<&'a [u8]> {
    let indice = (voce.chiave_n as usize).checked_sub(1)?;
    catena.0.get(indice).map(Vec::as_slice)
}

/// Ricifra un testo con l'ultima chiave della catena, senza legarlo a niente.
/// È la voce di prima di ADR 0052: resta per leggerla e per provarla.
pub fn archivia(catena: &Catena, testo: &str) -> Result<VoceCifrata, ErroreArchivio> {
    scrivi(catena, testo, None)
}

/// Rilegge una voce. **Torna `None` invece di inventare un testo**: una voce
/// che non si apre è uno stato da mostrare, non una frase da scrivere nella
/// nuvoletta.
pub fn rileggi(catena: &Catena, voce: &VoceCifrata) -> Option<String> {
    let chiave = chiave_di(catena, voce)?;
    let busta = da_base64(&voce.busta).ok()?;
    apri(chiave, &busta, None).ok().map(|t| testo_da(&t))
}

/// I dati autenticati di AES-GCM: entrano nel sigillo e non nella busta.
///
/// Un array JSON di stringhe, non una concatenazione: nessuna scelta dei campi
/// ne produce un'altra con gli stessi byte. `serde_json` e `JSON.stringify`
/// scrivono una stringa allo stesso modo, ed è `infra/prova-archivio` a
/// tenerlo vero anche per virgolette, caratteri di controllo e non ASCII.
fn dati_legati(legame: &Legame) -> Vec<u8> {
    serde_json::to_vec(&[
        ETICHETTA_LEGAME,
        &legame.conversazione_id,
        &legame.id,
        &legame.mittente,
        &legame.creato_il,
    ])
    .expect("un array di stringhe si scrive sempre in JSON")
}

/// Ricifra un testo con l'ultima chiave della catena, **legato** a chi, dove e
/// quando.
pub fn archivia_legata(
    catena: &Catena,
    testo: &str,
    legame: &Legame,
) -> Result<VoceCifrata, ErroreArchivio> {
    scrivi(catena, testo, Some(&dati_legati(legame)))
}

/// Rilegge una voce verificandone il legame.
///
/// Una voce sigillata con un legame **non** si apre con un altro, e nemmeno
/// senza: è così che una casa che cambia il mittente ottiene una voce che non
/// si apre, invece di una voce attribuita a un altro. Il secondo tentativo,
/// senza legame, apre soltanto le voci nate prima — che nessuna casa può
/// fabbricare, perché non ha la chiave.
pub fn rileggi_legata(
    catena: &Catena,
    voce: &VoceCifrata,
    legame: Option<&Legame>,
) -> Option<VoceRiletta> {
    let chiave = chiave_di(catena, voce)?;
    let busta = da_base64(&voce.busta).ok()?;

    if let Some(legame) = legame {
        if let Ok(testo) = apri(chiave, &busta, Some(&dati_legati(legame))) {
            return Some(VoceRiletta {
                legata: true,
                testo: testo_da(&testo),
            });
        }
        // Si prova senza: può essere una voce di prima del legame.
    }

    apri(chiave, &busta, None).ok().map(|testo| VoceRiletta {
        legata: false,
        testo: testo_da(&testo),
    })
}

#[cfg(test)]
mod prove {
    //! Le stesse prove di `archivio.test.ts`, più il legame e i vettori scritti
    //! dal modulo del web.

    use super::*;

    fn serratura() -> Vec<u8> {
        a_caso(LUNGHEZZA_CHIAVE).unwrap().to_vec()
    }

    fn legame() -> Legame {
        Legame {
            conversazione_id: "conv-1".into(),
            id: "m-1".into(),
            mittente: "anna@casa".into(),
            creato_il: "2026-11-28T10:00:00.000Z".into(),
        }
    }

    /* ---------- il mazzo ---------- */

    #[test]
    fn il_mazzo_si_avvolge_e_si_riapre_con_la_stessa_serratura() {
        let catena = catena_nuova().unwrap();
        let s = serratura();
        let riaperta = svolgi(&avvolgi(&catena, &s).unwrap(), &s).unwrap();
        assert_eq!(riaperta.chiavi(), catena.chiavi());
    }

    #[test]
    fn il_mazzo_non_si_apre_con_una_serratura_diversa() {
        let avvolto = avvolgi(&catena_nuova().unwrap(), &serratura()).unwrap();
        assert_eq!(
            svolgi(&avvolto, &serratura()).unwrap_err(),
            ErroreArchivio::NonSiApre
        );
    }

    #[test]
    fn riavvolto_sotto_una_serratura_nuova_contiene_le_stesse_chiavi() {
        // È il gesto di ogni cambio di epoch: cambia la serratura, non il contenuto.
        let catena = catena_ruotata(&catena_nuova().unwrap(), None).unwrap();
        let (vecchia, nuova) = (serratura(), serratura());
        let riavvolto = avvolgi(
            &svolgi(&avvolgi(&catena, &vecchia).unwrap(), &vecchia).unwrap(),
            &nuova,
        )
        .unwrap();
        assert_eq!(
            svolgi(&riavvolto, &nuova).unwrap().chiavi(),
            catena.chiavi()
        );
    }

    #[test]
    fn cio_che_si_apre_ma_non_e_un_mazzo_si_rifiuta() {
        let s = serratura();
        for payload in [&b"{\"a\":1}"[..], b"[1,2]", b"non json"] {
            let avvolto = base64(&sigilla(&s, payload, None).unwrap());
            assert_eq!(
                svolgi(&avvolto, &s).unwrap_err(),
                ErroreArchivio::NonEUnMazzo
            );
        }
    }

    /* ---------- la catena ---------- */

    #[test]
    fn la_catena_nasce_con_una_chiave_sola_e_casuale() {
        let (a, b) = (catena_nuova().unwrap(), catena_nuova().unwrap());
        assert_eq!(a.lunghezza(), 1);
        assert_eq!(a.chiavi()[0].len(), LUNGHEZZA_CHIAVE);
        // Due conversazioni non condividono la chiave d'archivio.
        assert_ne!(a.chiavi()[0], b.chiavi()[0]);
    }

    #[test]
    fn ruotando_conserva_le_vecchie_e_ne_aggiunge_una() {
        let prima = catena_nuova().unwrap();
        let dopo = catena_ruotata(&prima, None).unwrap();
        assert_eq!(dopo.lunghezza(), 2);
        assert_eq!(dopo.chiavi()[0], prima.chiavi()[0]);
        assert!(prima.e_allungata_da(&dopo));
        assert!(!dopo.e_allungata_da(&prima));
        assert!(!prima.e_allungata_da(&prima));

        let data = catena_ruotata(&prima, Some(vec![7; 32])).unwrap();
        assert_eq!(data.chiavi()[1], vec![7; 32]);
    }

    #[test]
    fn la_catena_non_si_stampa() {
        let catena = Catena::da_chiavi(vec![vec![0xAB; 32]]);
        assert_eq!(format!("{catena:?}"), "Catena(1 chiavi)");
    }

    /* ---------- le voci ---------- */

    #[test]
    fn le_voci_si_scrivono_con_l_ultima_chiave_e_si_rileggono() {
        let catena = catena_nuova().unwrap();
        let voce = archivia(&catena, "i preventivi del tetto").unwrap();
        assert_eq!(voce.chiave_n, 1);
        assert_eq!(
            rileggi(&catena, &voce).as_deref(),
            Some("i preventivi del tetto")
        );
    }

    #[test]
    fn la_busta_non_contiene_il_testo_in_chiaro_e_ha_la_forma_attesa() {
        let voce = archivia(&catena_nuova().unwrap(), "PAROLA_SEGRETA").unwrap();
        let byte = STANDARD.decode(&voce.busta).unwrap();
        assert!(!byte.windows(14).any(|f| f == b"PAROLA_SEGRETA"));
        // IV, testo cifrato lungo quanto il testo, tag.
        assert_eq!(byte.len(), 12 + 14 + 16);
    }

    #[test]
    fn due_sigilli_dello_stesso_testo_non_hanno_lo_stesso_iv() {
        let catena = catena_nuova().unwrap();
        let (a, b) = (
            archivia(&catena, "uguale").unwrap(),
            archivia(&catena, "uguale").unwrap(),
        );
        assert_ne!(a.busta, b.busta);
    }

    #[test]
    fn dopo_una_rotazione_si_scrive_con_la_chiave_nuova() {
        let dopo = catena_ruotata(&catena_nuova().unwrap(), None).unwrap();
        let voce = archivia(&dopo, "detto dopo l'uscita").unwrap();
        assert_eq!(voce.chiave_n, 2);
        assert_eq!(
            rileggi(&dopo, &voce).as_deref(),
            Some("detto dopo l'uscita")
        );
    }

    #[test]
    fn chi_ha_solo_le_chiavi_vecchie_legge_il_pregresso_e_non_il_seguito() {
        // ADR 0037 §«Che cosa non copre» punto 2.
        let prima = catena_nuova().unwrap();
        let pregresso = archivia(&prima, "prima che uscisse").unwrap();
        let dopo = catena_ruotata(&prima, None).unwrap();
        let seguito = archivia(&dopo, "dopo che è uscito").unwrap();

        // Chi è uscito ha `prima`, non `dopo`.
        assert_eq!(
            rileggi(&prima, &pregresso).as_deref(),
            Some("prima che uscisse")
        );
        assert_eq!(rileggi(&prima, &seguito), None);
        // Chi è rimasto legge tutto.
        assert_eq!(
            rileggi(&dopo, &pregresso).as_deref(),
            Some("prima che uscisse")
        );
        assert_eq!(
            rileggi(&dopo, &seguito).as_deref(),
            Some("dopo che è uscito")
        );
    }

    #[test]
    fn chi_entra_dopo_riceve_il_mazzo_intero_e_legge_anche_il_pregresso() {
        // La scelta del proprietario in ADR 0037 §4.
        let catena = catena_nuova().unwrap();
        let pregresso = archivia(&catena, "detto prima che entrasse").unwrap();
        let s = serratura();
        let sua_copia = svolgi(&avvolgi(&catena, &s).unwrap(), &s).unwrap();
        assert_eq!(
            rileggi(&sua_copia, &pregresso).as_deref(),
            Some("detto prima che entrasse")
        );
    }

    #[test]
    fn una_voce_che_non_si_apre_torna_none_e_non_diventa_testo() {
        let catena = catena_nuova().unwrap();
        let voce = archivia(&catena_nuova().unwrap(), "non per te").unwrap();
        assert_eq!(rileggi(&catena, &voce), None);
    }

    #[test]
    fn una_voce_che_cita_una_chiave_che_non_c_e_non_esplode() {
        let catena = catena_nuova().unwrap();
        for chiave_n in [99, 0, u32::MAX] {
            let voce = VoceCifrata {
                busta: "abc".into(),
                chiave_n,
            };
            assert_eq!(rileggi(&catena, &voce), None);
            assert_eq!(rileggi_legata(&catena, &voce, Some(&legame())), None);
        }
    }

    #[test]
    fn una_busta_rotta_torna_none() {
        let catena = catena_nuova().unwrap();
        for busta in ["", "abc", "AAAA", "non è base64!", "AAAAAAAAAAAAAAAAAAAA"] {
            let voce = VoceCifrata {
                busta: busta.into(),
                chiave_n: 1,
            };
            assert_eq!(rileggi(&catena, &voce), None, "{busta}");
        }
    }

    #[test]
    fn una_catena_vuota_non_archivia_niente() {
        let vuota = Catena::da_chiavi(vec![]);
        assert_eq!(
            archivia(&vuota, "x").unwrap_err(),
            ErroreArchivio::CatenaVuota
        );
        assert_eq!(
            archivia_legata(&vuota, "x", &legame()).unwrap_err(),
            ErroreArchivio::CatenaVuota
        );
    }

    #[test]
    fn una_chiave_della_lunghezza_sbagliata_non_sigilla_e_non_apre() {
        let corta = Catena::da_chiavi(vec![vec![1; 16]]);
        assert_eq!(
            archivia(&corta, "x").unwrap_err(),
            ErroreArchivio::ChiaveSbagliata
        );
        let voce = archivia(&catena_nuova().unwrap(), "x").unwrap();
        assert_eq!(rileggi(&corta, &voce), None);
    }

    /* ---------- il legame (ADR 0052 §1) ---------- */

    #[test]
    fn una_voce_legata_si_apre_con_il_suo_legame() {
        let catena = catena_nuova().unwrap();
        let voce = archivia_legata(&catena, "ciao", &legame()).unwrap();
        assert_eq!(
            rileggi_legata(&catena, &voce, Some(&legame())),
            Some(VoceRiletta {
                legata: true,
                testo: "ciao".into()
            })
        );
    }

    #[test]
    fn una_voce_legata_non_si_apre_con_un_altro_legame_ne_senza() {
        let catena = catena_nuova().unwrap();
        let voce = archivia_legata(&catena, "ciao", &legame()).unwrap();

        let cambia = |f: fn(&mut Legame)| {
            let mut l = legame();
            f(&mut l);
            l
        };
        for falso in [
            cambia(|l| l.mittente = "bruno@casa".into()),
            cambia(|l| l.creato_il = "2026-11-27T10:00:00.000Z".into()),
            cambia(|l| l.id = "m-2".into()),
            cambia(|l| l.conversazione_id = "conv-2".into()),
        ] {
            assert_eq!(rileggi_legata(&catena, &voce, Some(&falso)), None);
        }
        assert_eq!(rileggi_legata(&catena, &voce, None), None);
        assert_eq!(rileggi(&catena, &voce), None);
    }

    #[test]
    fn una_voce_di_prima_si_apre_come_non_legata() {
        let catena = catena_nuova().unwrap();
        let voce = archivia(&catena, "di prima").unwrap();
        let attesa = Some(VoceRiletta {
            legata: false,
            testo: "di prima".into(),
        });
        assert_eq!(rileggi_legata(&catena, &voce, Some(&legame())), attesa);
        assert_eq!(rileggi_legata(&catena, &voce, None), attesa);
    }

    #[test]
    fn i_campi_del_legame_non_si_confondono_fra_loro() {
        // Con una concatenazione, ("a", "bc") e ("ab", "c") sarebbero gli
        // stessi byte.
        let a = Legame {
            conversazione_id: "a".into(),
            id: "bc".into(),
            ..legame()
        };
        let b = Legame {
            conversazione_id: "ab".into(),
            id: "c".into(),
            ..legame()
        };
        assert_ne!(dati_legati(&a), dati_legati(&b));
    }

    #[test]
    fn i_dati_legati_sono_quelli_di_json_stringify() {
        assert_eq!(
            dati_legati(&legame()),
            br#"["estia-archivio-v2","conv-1","m-1","anna@casa","2026-11-28T10:00:00.000Z"]"#
        );
        // Virgolette, barre, controlli e non ASCII, come li scrive il web.
        let strano = Legame {
            conversazione_id: "a\"b\\c/d".into(),
            id: "riga\nnuova\ttab\u{1}\u{1f}\u{7f}".into(),
            mittente: "però@casa 🏠".into(),
            creato_il: "\u{2028}\u{8}\u{c}\r".into(),
        };
        assert_eq!(
            String::from_utf8(dati_legati(&strano)).unwrap(),
            "[\"estia-archivio-v2\",\"a\\\"b\\\\c/d\",\"riga\\nnuova\\ttab\\u0001\\u001f\u{7f}\",\"però@casa 🏠\",\"\u{2028}\\b\\f\\r\"]"
        );
    }

    /* ---------- base64 e testo, come sul web ---------- */

    #[test]
    fn il_base64_si_legge_come_atob() {
        assert_eq!(da_base64("AQID").unwrap(), [1, 2, 3]);
        assert_eq!(da_base64("AQI=").unwrap(), [1, 2]);
        // Senza riempimento, con spazi, con bit che avanzano.
        assert_eq!(da_base64("AQI").unwrap(), [1, 2]);
        assert_eq!(da_base64(" AQ\nID\t").unwrap(), [1, 2, 3]);
        assert_eq!(da_base64("AQJ").unwrap(), [1, 2]);
        assert_eq!(da_base64("A").unwrap_err(), ErroreArchivio::Base64);
        assert_eq!(da_base64("AQ-_").unwrap_err(), ErroreArchivio::Base64);
        assert_eq!(base64(&[1, 2]), "AQI=");
    }

    #[test]
    fn il_testo_si_legge_come_text_decoder() {
        assert_eq!(testo_da(b"\xEF\xBB\xBFciao"), "ciao");
        assert_eq!(testo_da(b"ci\xFFao"), "ci\u{fffd}ao");
        assert_eq!(testo_da(b""), "");
    }

    /* ---------- vettori scritti da `archivio.ts` ---------- */

    // Prodotti dal modulo del web (`avvolgi`, `archivia`, `archiviaLegata`) con
    // le chiavi qui sotto. Se una di queste prove cade, il nucleo ha smesso di
    // leggere ciò che il browser scrive.
    const V_SERRATURA: [u8; 32] = [0x11; 32];

    fn v_catena() -> Catena {
        Catena::da_chiavi(vec![vec![0xA1; 32], vec![0xB2; 32]])
    }

    fn v_legame() -> Legame {
        Legame {
            conversazione_id: "conv-vettore".into(),
            id: "m-\"1\"".into(),
            mittente: "anna@casa-di-prova".into(),
            creato_il: "2026-11-28T10:00:00.000Z".into(),
        }
    }

    include!("archivio_vettori.rs");

    #[test]
    fn il_mazzo_del_web_si_apre() {
        let catena = svolgi(V_MAZZO, &V_SERRATURA).unwrap();
        assert_eq!(catena.chiavi(), v_catena().chiavi());
    }

    #[test]
    fn le_voci_del_web_si_rileggono() {
        let catena = v_catena();
        let semplice = VoceCifrata {
            busta: V_VOCE.into(),
            chiave_n: 2,
        };
        assert_eq!(rileggi(&catena, &semplice).as_deref(), Some(V_TESTO));

        let legata = VoceCifrata {
            busta: V_VOCE_LEGATA.into(),
            chiave_n: 2,
        };
        assert_eq!(
            rileggi_legata(&catena, &legata, Some(&v_legame())),
            Some(VoceRiletta {
                legata: true,
                testo: V_TESTO.into()
            })
        );
        assert_eq!(rileggi_legata(&catena, &legata, None), None);

        // La prima chiave della catena, e una voce scritta con quella.
        let prima = VoceCifrata {
            busta: V_VOCE_PRIMA_CHIAVE.into(),
            chiave_n: 1,
        };
        assert_eq!(rileggi(&catena, &prima).as_deref(), Some(V_TESTO));
        assert_eq!(
            rileggi(
                &catena,
                &VoceCifrata {
                    chiave_n: 2,
                    ..prima
                }
            ),
            None
        );
    }
}
