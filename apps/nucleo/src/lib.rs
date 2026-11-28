//! Il nucleo comune delle app native di ESTIA ([ADR 0051](../../../docs/adr/0051-le-app-del-telefono-sono-native.md)).
//!
//! Sta sotto l'app iPhone (SwiftUI) e l'app Android (Compose), che lo vedono
//! attraverso UniFFI. Qui c'è tutto ciò che non è interfaccia, a cominciare da
//! MLS: l'interfaccia chiede «cifra questo per questa conversazione» e non tocca
//! mai una chiave.
//!
//! Il filo verso la Casa (iroh, `estia/ingresso/1` e `estia/dispositivo/1`)
//! arriva qui da `apps/app/src-tauri` nel passo successivo.

uniffi::setup_scaffolding!();

pub mod deposito;
pub mod errore;
pub mod mls;

pub use errore::ErroreNucleo;
