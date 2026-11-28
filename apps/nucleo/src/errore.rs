/// Gli errori che il nucleo restituisce a Swift e Kotlin.
///
/// Sono codici, non frasi: la frase la sceglie l'app dalla tabella di
/// `packages/lingue`, come fa il client web con i codici dell'istanza.
#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum ErroreNucleo {
    /// Il deposito dell'app non ha letto o scritto.
    #[error("deposito: {0}")]
    Deposito(String),
    /// Quei byte non sono il messaggio MLS che ci si aspettava.
    #[error("formato: {0}")]
    Formato(String),
    /// Una foglia con una chiave di firma che il registro non conosce.
    #[error("non autenticato: {0}")]
    NonAutenticato(String),
    /// Non c'è una conversazione con questo nome su questo dispositivo.
    #[error("conversazione sconosciuta: {0}")]
    ConversazioneSconosciuta(String),
    /// La Casa non risponde, o ha chiuso.
    #[error("rete: {0}")]
    Rete(String),
    /// La Casa ha chiuso l'ingresso: codice scaduto, già usato o sbagliato.
    /// Non dice quale dei tre, perché la Casa non lo dice.
    #[error("codice non accettato")]
    CodiceNonAccettato,
    /// Il dispositivo non è ancora entrato in una Casa.
    #[error("nessuna Casa")]
    NessunaCasa,
    /// OpenMLS ha rifiutato l'operazione.
    #[error("mls: {0}")]
    Mls(String),
}

impl From<uniffi::UnexpectedUniFFICallbackError> for ErroreNucleo {
    fn from(e: uniffi::UnexpectedUniFFICallbackError) -> Self {
        ErroreNucleo::Deposito(e.reason)
    }
}

pub(crate) fn mls<E: std::fmt::Debug>(e: E) -> ErroreNucleo {
    ErroreNucleo::Mls(format!("{e:?}"))
}

pub(crate) fn formato<E: std::fmt::Debug>(e: E) -> ErroreNucleo {
    ErroreNucleo::Formato(format!("{e:?}"))
}
