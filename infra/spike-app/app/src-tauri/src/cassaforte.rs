//! La cassaforte del dispositivo (ADR 0044 §2), come la misura lo spike.
//!
//! **Nella cassaforte del sistema sta una chiave sola**, di 32 byte: la chiave
//! della cassaforte. Tutto il resto — chiavi MLS, scorta di `KeyPackage`, stato
//! dei gruppi, chiave di rete — sta in file dentro la cartella dati dell'app,
//! cifrati con quella chiave (ChaCha20-Poly1305, il nome del file come dato
//! associato, così un file spostato sotto un altro nome non si apre).
//!
//! Perché non mettere tutto direttamente nella cassaforte del sistema: su
//! Windows un segreto del Credential Manager ha un tetto di 2560 byte, e lo
//! stato di un gruppo a cinquanta foglie è decine di kilobyte ([S5]). Una
//! chiave sola ci sta ovunque, e la forma è la stessa sulle quattro
//! piattaforme.
//!
//! [S5]: ../../../../docs/spike/S5-quanto-pesa-un-albero.md

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    ChaCha20Poly1305, Key, Nonce,
};
use keyring_core::Entry;
use serde::Serialize;

const SERVIZIO: &str = "org.estia.spike";
const UTENTE: &str = "chiave-cassaforte";

/// Che cosa la cassaforte sa dire di sé, per la sonda.
#[derive(Debug, Clone, Serialize)]
pub struct Stato {
    /// Quale cassaforte del sistema tiene la chiave.
    pub negozio: String,
    /// La chiave è stata creata in questo avvio (primo avvio dopo l'installazione).
    pub chiave_nuova: bool,
    /// Al primo avvio c'era già una chiave nella cassaforte del sistema, lasciata
    /// da un'installazione precedente, ed è stata cancellata. Su iOS succede:
    /// il portachiavi sopravvive alla disinstallazione dell'app.
    pub residuo_cancellato: bool,
    /// I file sigillati presenti, al momento dell'apertura.
    pub file_all_apertura: usize,
}

pub struct Cassaforte {
    cartella: PathBuf,
    cifrario: ChaCha20Poly1305,
    pub stato: Stato,
}

fn negozio() -> Result<String> {
    #[cfg(target_os = "ios")]
    {
        keyring_core::set_default_store(apple_native_keyring_store::protected::Store::new()?);
        return Ok(
            "iOS: portachiavi protetto (Data Protection Keychain), solo questo dispositivo".into(),
        );
    }
    // Sul Mac il portachiavi protetto vuole un'app firmata con un profilo di
    // provisioning; una build di prova non lo è. Il portachiavi dell'utente
    // (login keychain) è quello che usano le app desktop non sandboxate.
    #[cfg(target_os = "macos")]
    {
        keyring_core::set_default_store(apple_native_keyring_store::keychain::Store::new()?);
        return Ok("macOS: portachiavi dell'utente (login keychain)".into());
    }
    #[cfg(target_os = "android")]
    {
        keyring_core::set_default_store(android_native_keyring_store::Store::new()?);
        return Ok("Android: chiave nel Keystore, segreto cifrato in SharedPreferences".into());
    }
    #[cfg(target_os = "windows")]
    {
        keyring_core::set_default_store(windows_native_keyring_store::Store::new()?);
        return Ok("Windows: Credential Manager".into());
    }
    #[cfg(target_os = "linux")]
    {
        keyring_core::set_default_store(dbus_secret_service_keyring_store::Store::new()?);
        return Ok("Linux: Secret Service (GNOME Keyring o KWallet) via D-Bus".into());
    }
    #[allow(unreachable_code)]
    Err(anyhow!(
        "nessuna cassaforte del sistema per questa piattaforma"
    ))
}

fn voce() -> Result<Entry> {
    #[cfg(target_os = "ios")]
    {
        // «Solo questo dispositivo»: niente sincronizzazione iCloud, niente
        // backup che la porti su un altro telefono. È la condizione perché
        // reinstallare voglia dire essere un dispositivo nuovo (ADR 0044 §2).
        let modificatori = std::collections::HashMap::from([(
            "access-policy",
            "after-first-unlock-this-device-only",
        )]);
        return Ok(Entry::new_with_modifiers(SERVIZIO, UTENTE, &modificatori)?);
    }
    #[allow(unreachable_code)]
    Ok(Entry::new(SERVIZIO, UTENTE)?)
}

impl Cassaforte {
    /// Apre la cassaforte nella cartella dati dell'app.
    pub fn apri(cartella_dati: &Path) -> Result<Self> {
        let negozio = negozio()?;
        let cartella = cartella_dati.join("cassaforte");
        fs::create_dir_all(&cartella).context("cartella della cassaforte")?;

        // Il segno dell'installazione sta nella cartella dati, che sparisce con
        // l'app. Se manca e nella cassaforte del sistema c'è una chiave, quella
        // chiave è di un'installazione precedente e non deve tornare.
        let segno = cartella_dati.join("installazione");
        let mut residuo_cancellato = false;
        if !segno.exists() {
            if let Ok(entry) = voce() {
                if entry.get_secret().is_ok() {
                    entry.delete_credential().ok();
                    residuo_cancellato = true;
                }
            }
            for file in fs::read_dir(&cartella)?.flatten() {
                fs::remove_file(file.path()).ok();
            }
            fs::write(&segno, b"1").context("segno dell'installazione")?;
        }

        let entry = voce()?;
        let (chiave, chiave_nuova) = match entry.get_secret() {
            Ok(byte) if byte.len() == 32 => (*Key::from_slice(&byte), false),
            Ok(_) => return Err(anyhow!("la chiave nella cassaforte non ha 32 byte")),
            Err(keyring_core::Error::NoEntry) => {
                let chiave = ChaCha20Poly1305::generate_key(&mut OsRng);
                entry
                    .set_secret(chiave.as_slice())
                    .context("la cassaforte del sistema rifiuta la chiave")?;
                (chiave, true)
            }
            Err(errore) => return Err(anyhow!("cassaforte del sistema: {errore}")),
        };

        let file_all_apertura = fs::read_dir(&cartella)?.flatten().count();
        Ok(Self {
            cartella,
            cifrario: ChaCha20Poly1305::new(&chiave),
            stato: Stato {
                negozio,
                chiave_nuova,
                residuo_cancellato,
                file_all_apertura,
            },
        })
    }

    fn percorso(&self, nome: &str) -> PathBuf {
        let esadecimale: String = nome.bytes().map(|b| format!("{b:02x}")).collect();
        self.cartella.join(format!("{esadecimale}.sigillo"))
    }

    pub fn scrivi(&self, nome: &str, valore: &[u8]) -> Result<()> {
        let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        let cifrato = self
            .cifrario
            .encrypt(
                &nonce,
                Payload {
                    msg: valore,
                    aad: nome.as_bytes(),
                },
            )
            .map_err(|_| anyhow!("cifratura fallita"))?;
        let mut tutto = nonce.to_vec();
        tutto.extend_from_slice(&cifrato);
        // Scrittura atomica: un'app uccisa a metà non lascia un sigillo rotto.
        let finale = self.percorso(nome);
        let provvisorio = finale.with_extension("tmp");
        fs::write(&provvisorio, &tutto)?;
        fs::rename(&provvisorio, &finale)?;
        Ok(())
    }

    pub fn leggi(&self, nome: &str) -> Result<Option<Vec<u8>>> {
        let tutto = match fs::read(self.percorso(nome)) {
            Ok(tutto) => tutto,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if tutto.len() < 12 {
            return Err(anyhow!("sigillo troppo corto"));
        }
        let (nonce, cifrato) = tutto.split_at(12);
        let chiaro = self
            .cifrario
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: cifrato,
                    aad: nome.as_bytes(),
                },
            )
            .map_err(|_| anyhow!("sigillo che non si apre con questa chiave"))?;
        Ok(Some(chiaro))
    }

    pub fn svuota(&self) -> Result<()> {
        for file in fs::read_dir(&self.cartella)?.flatten() {
            fs::remove_file(file.path())?;
        }
        Ok(())
    }

    /// Quanti byte occupa sul disco un sigillo: è la prova che il file non è in chiaro.
    pub fn grezzo(&self, nome: &str) -> Result<Option<Vec<u8>>> {
        match fs::read(self.percorso(nome)) {
            Ok(tutto) => Ok(Some(tutto)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}
