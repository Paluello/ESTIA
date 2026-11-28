//! Il nucleo comune delle app native di ESTIA ([ADR 0051](../../../docs/adr/0051-le-app-del-telefono-sono-native.md)).
//!
//! Sta sotto l'app iPhone (SwiftUI) e l'app Android (Compose), che lo vedono
//! attraverso UniFFI. Qui c'è tutto ciò che non è interfaccia, a cominciare da
//! MLS: l'interfaccia chiede «cifra questo per questa conversazione» e non tocca
//! mai una chiave.
//!
//! Il filo verso la Casa (iroh, `estia/ingresso/1` e `estia/dispositivo/1`)
//! è in [`casa`], sopra [`rete`] e [`filo`]. Anche l'app del PC
//! (`apps/app/src-tauri`) usa questi due moduli, senza UniFFI.

uniffi::setup_scaffolding!();

pub mod casa;
pub mod deposito;
pub mod errore;
pub mod filo;
pub mod mls;
pub mod rete;

pub use errore::ErroreNucleo;
