//! Le due cose che il nucleo chiede all'app, e che solo l'app sa fare.

use crate::ErroreNucleo;

/// Dove si conserva lo stato. L'app lo implementa con la sua cassaforte: file
/// sigillati con la chiave che sta nel Keychain o nel Keystore (S6). Il nucleo
/// scrive dopo ogni operazione che cambia lo stato, e il nome è suo.
#[uniffi::export(with_foreign)]
pub trait Deposito: Send + Sync {
    fn leggi(&self, nome: String) -> Result<Option<Vec<u8>>, ErroreNucleo>;
    fn scrivi(&self, nome: String, dati: Vec<u8>) -> Result<(), ErroreNucleo>;
}

/// Le chiavi di firma che l'istanza riconosce per un membro (`<username>@<casa>`).
///
/// È l'`AuthenticationService` di `apps/web/src/mls/gruppo.ts`, con lo stesso
/// limite: ferma l'estraneo, non chi ospita il registro (S4). L'app la risponde
/// dalla Casa del membro; il nucleo la chiede solo per le foglie nuove.
#[uniffi::export(with_foreign)]
pub trait Registro: Send + Sync {
    fn chiavi_di_firma(&self, membro: String) -> Result<Vec<Vec<u8>>, ErroreNucleo>;
}
