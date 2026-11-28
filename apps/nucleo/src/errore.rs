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
    /// Questo dispositivo non ha ancora la catena d'archivio della
    /// conversazione: è entrato o rientrato, e il mazzo non è ancora avvolto
    /// sotto la sua epoch. Finché è così non si scrive.
    #[error("la cronologia non è ancora arrivata su questo dispositivo")]
    SenzaArchivio,
    /// Questo dispositivo non è più nel gruppo della conversazione.
    #[error("fuori dal gruppo")]
    FuoriDalGruppo,
    /// L'archivio non ha sigillato: non dice mai che cosa c'era dentro.
    #[error("archivio: {0}")]
    Archivio(String),
    /// La Casa ha risposto di no: lo stato HTTP e il suo codice d'errore
    /// (`rimosso_dal_gruppo`, `no_device_available`, …), che l'app traduce.
    #[error("casa {stato}: {codice}")]
    Casa { stato: u16, codice: String },
    /// La chiave di firma di questo dispositivo non è ancora nel registro
    /// della Casa: aspetta il sì di un dispositivo già approvato (ADR 0040).
    /// Finché è così non crea e non rientra: gli altri rifiuterebbero la sua
    /// foglia, e il suo commit resterebbe in fila davanti a tutti.
    #[error("il dispositivo aspetta ancora il sì")]
    DispositivoInAttesa,
    /// Una chiave d'ingresso che dice di essere di qualcun altro.
    #[error("chiave di un altro")]
    ChiaveDiUnAltro,
    /// L'albero ha un tetto di foglie (`MAX_FOGLIE_GRUPPO`).
    #[error("gruppo pieno")]
    GruppoPieno,
    /// Nell'albero c'è chi non è fra i membri: finché resta, non si scrive.
    #[error("presenza estranea: {0}")]
    PresenzaEstranea(String),
}

impl From<crate::archivio::ErroreArchivio> for ErroreNucleo {
    fn from(e: crate::archivio::ErroreArchivio) -> Self {
        ErroreNucleo::Archivio(e.to_string())
    }
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
