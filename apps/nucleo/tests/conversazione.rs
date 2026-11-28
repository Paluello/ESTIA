//! Il nucleo fra due e tre dispositivi, senza rete: le buste passano a mano.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use estia_nucleo::deposito::{Deposito, Registro};
use estia_nucleo::mls::{Dispositivo, Ricevuto};
use estia_nucleo::ErroreNucleo;

#[derive(Default)]
struct DepositoInMemoria(Mutex<HashMap<String, Vec<u8>>>);

impl Deposito for DepositoInMemoria {
    fn leggi(&self, nome: String) -> Result<Option<Vec<u8>>, ErroreNucleo> {
        Ok(self.0.lock().unwrap().get(&nome).cloned())
    }
    fn scrivi(&self, nome: String, dati: Vec<u8>) -> Result<(), ErroreNucleo> {
        self.0.lock().unwrap().insert(nome, dati);
        Ok(())
    }
}

/// Il registro dell'istanza: membro -> chiavi di firma.
#[derive(Default)]
struct RegistroInMemoria(Mutex<HashMap<String, Vec<Vec<u8>>>>);

impl Registro for RegistroInMemoria {
    fn chiavi_di_firma(&self, membro: String) -> Result<Vec<Vec<u8>>, ErroreNucleo> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(&membro)
            .cloned()
            .unwrap_or_default())
    }
}

struct Mondo {
    registro: Arc<RegistroInMemoria>,
}

impl Mondo {
    fn new() -> Self {
        Mondo {
            registro: Arc::default(),
        }
    }

    fn dispositivo(&self, membro: &str) -> (Arc<Dispositivo>, Arc<DepositoInMemoria>) {
        let deposito = Arc::new(DepositoInMemoria::default());
        let d = self.riapri(membro, &deposito);
        self.registra(&d);
        (d, deposito)
    }

    fn riapri(&self, membro: &str, deposito: &Arc<DepositoInMemoria>) -> Arc<Dispositivo> {
        Dispositivo::apri(membro.into(), deposito.clone(), self.registro.clone()).unwrap()
    }

    fn registra(&self, d: &Dispositivo) {
        self.registro
            .0
            .lock()
            .unwrap()
            .entry(d.membro())
            .or_default()
            .push(d.chiave_di_firma());
    }
}

const C: &str = "conv-1";

fn testo(r: Ricevuto) -> String {
    match r {
        Ricevuto::Messaggio { testo, .. } => testo,
        altro => panic!("atteso un messaggio, arrivato {altro:?}"),
    }
}

#[test]
fn due_dispositivi_si_parlano() {
    let mondo = Mondo::new();
    let (anna, _) = mondo.dispositivo("anna@casa");
    let (bruno, _) = mondo.dispositivo("bruno@casa");

    anna.crea_conversazione(C.into()).unwrap();
    let kp = bruno.nuovi_pacchetti(1).unwrap().remove(0);
    let esito = anna.aggiungi(C.into(), kp).unwrap();
    assert_eq!(bruno.entra(esito.welcome).unwrap(), C);
    assert_eq!(
        anna.epoch(C.into()).unwrap(),
        bruno.epoch(C.into()).unwrap()
    );
    assert_eq!(
        anna.serratura_archivio(C).unwrap(),
        bruno.serratura_archivio(C).unwrap()
    );

    let busta = anna.cifra(C.into(), "ciao bruno".into()).unwrap();
    let r = bruno.applica(C.into(), busta).unwrap();
    assert_eq!(
        r,
        Ricevuto::Messaggio {
            testo: "ciao bruno".into(),
            da: "anna@casa".into()
        }
    );
    let busta = bruno.cifra(C.into(), "ciao anna".into()).unwrap();
    assert_eq!(testo(anna.applica(C.into(), busta).unwrap()), "ciao anna");
}

#[test]
fn lo_stato_sopravvive_alla_riapertura() {
    let mondo = Mondo::new();
    let (anna, _) = mondo.dispositivo("anna@casa");
    let (bruno, deposito_bruno) = mondo.dispositivo("bruno@casa");
    anna.crea_conversazione(C.into()).unwrap();
    let kp = bruno.nuovi_pacchetti(1).unwrap().remove(0);
    bruno
        .entra(anna.aggiungi(C.into(), kp).unwrap().welcome)
        .unwrap();
    let chiave = bruno.chiave_di_firma();
    drop(bruno);

    // L'app si chiude e si riapre: stessa identità, stesse conversazioni.
    let bruno = mondo.riapri("bruno@casa", &deposito_bruno);
    assert_eq!(bruno.chiave_di_firma(), chiave);
    assert_eq!(bruno.conversazioni(), vec![C.to_string()]);
    let busta = anna.cifra(C.into(), "dopo il riavvio".into()).unwrap();
    assert_eq!(
        testo(bruno.applica(C.into(), busta).unwrap()),
        "dopo il riavvio"
    );

    // E un deposito non si apre per un altro membro.
    assert!(
        Dispositivo::apri("carla@casa".into(), deposito_bruno, mondo.registro.clone()).is_err()
    );
}

#[test]
fn una_chiave_che_il_registro_non_conosce_non_entra() {
    let mondo = Mondo::new();
    let (anna, _) = mondo.dispositivo("anna@casa");
    anna.crea_conversazione(C.into()).unwrap();

    // Un estraneo che si spaccia per bruno: la sua chiave non è registrata.
    let estraneo = Dispositivo::apri(
        "bruno@casa".into(),
        Arc::new(DepositoInMemoria::default()),
        mondo.registro.clone(),
    )
    .unwrap();
    let kp = estraneo.nuovi_pacchetti(1).unwrap().remove(0);
    assert!(matches!(
        anna.aggiungi(C.into(), kp),
        Err(ErroreNucleo::NonAutenticato(m)) if m == "bruno@casa"
    ));

    // E chi entra da un Welcome autentica tutto l'albero: un gruppo creato da
    // una chiave non registrata non si accetta. La finta anna usa il registro
    // vero, che conosce bruno ma non lei.
    let (bruno, _) = mondo.dispositivo("bruno@casa");
    let finta_anna = Dispositivo::apri(
        "anna@casa".into(),
        Arc::new(DepositoInMemoria::default()),
        mondo.registro.clone(),
    )
    .unwrap();
    finta_anna.crea_conversazione("trappola".into()).unwrap();
    let kp = bruno.nuovi_pacchetti(1).unwrap().remove(0);
    let welcome = finta_anna.aggiungi("trappola".into(), kp).unwrap().welcome;
    assert!(matches!(
        bruno.entra(welcome),
        Err(ErroreNucleo::NonAutenticato(_))
    ));
}

#[test]
fn chi_esce_non_legge_piu() {
    let mondo = Mondo::new();
    let (anna, _) = mondo.dispositivo("anna@casa");
    let (bruno, _) = mondo.dispositivo("bruno@casa");
    let (carla, _) = mondo.dispositivo("carla@casa");
    anna.crea_conversazione(C.into()).unwrap();
    let e = anna
        .aggiungi(C.into(), bruno.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.entra(e.welcome).unwrap();
    let e = anna
        .aggiungi(C.into(), carla.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.applica(C.into(), e.commit).unwrap();
    carla.entra(e.welcome).unwrap();

    let e = anna.rimuovi(C.into(), "carla@casa".into()).unwrap();
    assert!(matches!(
        bruno.applica(C.into(), e.commit.clone()).unwrap(),
        Ricevuto::Commit { .. }
    ));
    assert_eq!(carla.applica(C.into(), e.commit).unwrap(), Ricevuto::Uscito);

    let busta = anna.cifra(C.into(), "solo per bruno".into()).unwrap();
    assert_eq!(
        testo(bruno.applica(C.into(), busta.clone()).unwrap()),
        "solo per bruno"
    );
    assert!(carla.applica(C.into(), busta).is_err());
    assert_eq!(anna.membri(C.into()).unwrap().len(), 2);
}

#[test]
fn si_rientra_da_soli_dal_punto_di_rientro() {
    let mondo = Mondo::new();
    let (anna, _) = mondo.dispositivo("anna@casa");
    let (bruno, _) = mondo.dispositivo("bruno@casa");
    anna.crea_conversazione(C.into()).unwrap();
    let e = anna
        .aggiungi(C.into(), bruno.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.entra(e.welcome).unwrap();

    // Il telefono nuovo di bruno: un dispositivo nuovo, registrato anch'esso.
    let (telefono, _) = mondo.dispositivo("bruno@casa");
    let punto = anna.punto_di_rientro(C.into()).unwrap();
    let r = telefono.rientra(punto).unwrap();
    assert_eq!(r.conversazione, C);
    assert!(matches!(
        anna.applica(C.into(), r.commit.clone()).unwrap(),
        Ricevuto::Commit { .. }
    ));
    assert!(matches!(
        bruno.applica(C.into(), r.commit).unwrap(),
        Ricevuto::Commit { .. }
    ));

    let e = bruno.aggiorna(C.into()).unwrap();
    anna.applica(C.into(), e.commit.clone()).unwrap();
    telefono.applica(C.into(), e.commit).unwrap();
    let busta = telefono
        .cifra(C.into(), "dal telefono nuovo".into())
        .unwrap();
    assert_eq!(
        testo(anna.applica(C.into(), busta).unwrap()),
        "dal telefono nuovo"
    );
}
