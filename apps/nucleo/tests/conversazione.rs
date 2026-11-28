//! Il nucleo fra due e tre dispositivi, senza rete: le buste passano a mano.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use estia_nucleo::archivio::VoceCifrata;
use estia_nucleo::deposito::{Deposito, Registro};
use estia_nucleo::mls::{Dichiarato, Dispositivo, MazzoAvvolto, Ricevuto};
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

/* ---------- l'archivio (ADR 0037, ADR 0052) ---------- */

const QUANDO: &str = "2026-11-28T10:00:00.000Z";

fn dichiarato(id: &str, mittente: &str) -> Option<Dichiarato> {
    Some(Dichiarato {
        id: id.into(),
        mittente: mittente.into(),
        creato_il: QUANDO.into(),
    })
}

fn scrive(chi: &Dispositivo, id: &str, testo: &str) -> VoceCifrata {
    chi.archivia(C.into(), testo.into(), id.into(), QUANDO.into())
        .unwrap()
}

/// Il testo di una voce, se si apre **con il suo legame**.
fn legge(chi: &Dispositivo, voce: &VoceCifrata, id: &str, mittente: &str) -> Option<String> {
    let riletta = chi.rileggi(C.into(), voce.clone(), dichiarato(id, mittente))?;
    assert!(riletta.legata, "la voce doveva aprirsi con il suo legame");
    Some(riletta.testo)
}

/// Ciò che l'app fa dopo un cambio di epoch: chi conosce il mazzo lo riavvolge.
fn mazzo(chi: &Dispositivo) -> MazzoAvvolto {
    chi.mazzo_avvolto(C.into())
        .unwrap()
        .expect("chi ha la catena")
}

/// anna crea, bruno entra dal Welcome e apre il mazzo che anna ha avvolto.
fn anna_e_bruno(mondo: &Mondo) -> (Arc<Dispositivo>, Arc<Dispositivo>) {
    let (anna, _) = mondo.dispositivo("anna@casa");
    let (bruno, _) = mondo.dispositivo("bruno@casa");
    anna.crea_conversazione(C.into()).unwrap();
    let e = anna
        .aggiungi(C.into(), bruno.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.entra(e.welcome).unwrap();
    assert!(bruno.apri_mazzo(C.into(), mazzo(&anna)).unwrap());
    (anna, bruno)
}

#[test]
fn chi_crea_ha_l_archivio_e_chi_entra_lo_riceve_dal_mazzo() {
    let mondo = Mondo::new();
    let (anna, _) = mondo.dispositivo("anna@casa");
    let (bruno, _) = mondo.dispositivo("bruno@casa");
    anna.crea_conversazione(C.into()).unwrap();
    assert!(anna.ha_archivio(C.into()));
    let pregresso = scrive(&anna, "m-1", "detto prima che bruno entrasse");
    assert_eq!(pregresso.chiave_n, 1);

    let e = anna
        .aggiungi(C.into(), bruno.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.entra(e.welcome).unwrap();

    // Entrato nel gruppo, non ancora nella cronologia: non legge, non scrive,
    // e non ha un mazzo da riavvolgere.
    assert!(!bruno.ha_archivio(C.into()));
    assert_eq!(legge(&bruno, &pregresso, "m-1", "anna@casa"), None);
    assert!(matches!(
        bruno.archivia(C.into(), "x".into(), "m-2".into(), QUANDO.into()),
        Err(ErroreNucleo::SenzaArchivio)
    ));
    assert_eq!(bruno.mazzo_avvolto(C.into()).unwrap(), None);

    let avvolto = mazzo(&anna);
    assert_eq!(avvolto.epoch, e.epoch);
    assert!(bruno.apri_mazzo(C.into(), avvolto).unwrap());
    assert!(bruno.ha_archivio(C.into()));

    // Legge anche il pregresso (ADR 0037 §4), e ciò che scrive lo legge anna.
    assert_eq!(
        legge(&bruno, &pregresso, "m-1", "anna@casa").as_deref(),
        Some("detto prima che bruno entrasse")
    );
    let risposta = scrive(&bruno, "m-2", "ciao anna");
    assert_eq!(
        legge(&anna, &risposta, "m-2", "bruno@casa").as_deref(),
        Some("ciao anna")
    );
}

#[test]
fn una_voce_si_apre_solo_con_cio_che_chi_scrive_ha_sigillato() {
    let mondo = Mondo::new();
    let (anna, bruno) = anna_e_bruno(&mondo);
    let voce = scrive(&anna, "m-1", "i preventivi del tetto");

    // Il mittente è la foglia di chi scrive: una casa che ne dichiara un altro,
    // o un'altra data, o un altro id, ottiene una voce che non si apre.
    let apre = |d: Option<Dichiarato>| bruno.rileggi(C.into(), voce.clone(), d);
    assert!(apre(dichiarato("m-1", "anna@casa")).is_some());
    assert_eq!(apre(dichiarato("m-1", "bruno@casa")), None);
    assert_eq!(apre(dichiarato("m-2", "anna@casa")), None);
    assert_eq!(
        apre(Some(Dichiarato {
            id: "m-1".into(),
            mittente: "anna@casa".into(),
            creato_il: "2026-11-27T10:00:00.000Z".into(),
        })),
        None
    );
    assert_eq!(apre(None), None);

    // E nemmeno in un'altra conversazione, o in una che non c'è.
    assert_eq!(
        bruno.rileggi("altra".into(), voce.clone(), dichiarato("m-1", "anna@casa")),
        None
    );
}

#[test]
fn il_mazzo_non_si_apre_a_un_altra_epoch_ne_a_chi_non_e_nel_gruppo() {
    let mondo = Mondo::new();
    let (anna, _) = mondo.dispositivo("anna@casa");
    let (bruno, _) = mondo.dispositivo("bruno@casa");
    let (estraneo, _) = mondo.dispositivo("carla@casa");
    anna.crea_conversazione(C.into()).unwrap();
    let vecchio = mazzo(&anna);
    let e = anna
        .aggiungi(C.into(), bruno.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.entra(e.welcome).unwrap();

    // Avvolto sotto l'epoch di prima: bruno non c'era, e non lo apre nemmeno
    // se l'istanza gli dice che è dell'epoch giusta.
    assert!(!bruno.apri_mazzo(C.into(), vecchio.clone()).unwrap());
    assert!(!bruno
        .apri_mazzo(
            C.into(),
            MazzoAvvolto {
                epoch: e.epoch,
                ..vecchio
            }
        )
        .unwrap());
    // Uno che non è un mazzo.
    assert!(!bruno
        .apri_mazzo(
            C.into(),
            MazzoAvvolto {
                mazzo: "non è un mazzo".into(),
                epoch: e.epoch
            }
        )
        .unwrap());
    assert!(!bruno.ha_archivio(C.into()));

    // Chi non ha la conversazione non ha una serratura con cui provarci.
    assert!(matches!(
        estraneo.apri_mazzo(C.into(), mazzo(&anna)),
        Err(ErroreNucleo::ConversazioneSconosciuta(_))
    ));
}

#[test]
fn a_ogni_rimozione_la_catena_ruota_uguale_per_chi_resta() {
    let mondo = Mondo::new();
    let (anna, bruno) = anna_e_bruno(&mondo);
    let (carla, _) = mondo.dispositivo("carla@casa");
    let e = anna
        .aggiungi(C.into(), carla.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.applica(C.into(), e.commit).unwrap();
    carla.entra(e.welcome).unwrap();
    assert!(carla.apri_mazzo(C.into(), mazzo(&anna)).unwrap());

    // Un commit che non toglie nessuno non ruota niente.
    let pregresso = scrive(&carla, "m-1", "prima che uscissi");
    assert_eq!(pregresso.chiave_n, 1);

    let e = anna.rimuovi(C.into(), "carla@casa".into()).unwrap();
    bruno.applica(C.into(), e.commit.clone()).unwrap();
    assert_eq!(carla.applica(C.into(), e.commit).unwrap(), Ricevuto::Uscito);

    // Chi toglie e chi applica derivano la stessa chiave, senza scambiarsela:
    // bruno non ha riaperto nessun mazzo (ADR 0052 §2).
    let di_anna = scrive(&anna, "m-2", "dopo che è uscita");
    let di_bruno = scrive(&bruno, "m-3", "lo leggiamo in due");
    assert_eq!((di_anna.chiave_n, di_bruno.chiave_n), (2, 2));
    assert_eq!(
        legge(&bruno, &di_anna, "m-2", "anna@casa").as_deref(),
        Some("dopo che è uscita")
    );
    assert_eq!(
        legge(&anna, &di_bruno, "m-3", "bruno@casa").as_deref(),
        Some("lo leggiamo in due")
    );
    // Il pregresso resta leggibile a chi è rimasto.
    assert_eq!(
        legge(&anna, &pregresso, "m-1", "carla@casa").as_deref(),
        Some("prima che uscissi")
    );

    // Chi è stato tolto non legge il seguito, non scrive, e non riavvolge.
    assert!(!carla.ha_archivio(C.into()));
    assert_eq!(legge(&carla, &di_anna, "m-2", "anna@casa"), None);
    assert!(carla
        .archivia(C.into(), "x".into(), "m-4".into(), QUANDO.into())
        .is_err());
    assert_eq!(carla.mazzo_avvolto(C.into()).unwrap(), None);
    // E il mazzo dell'epoch nuova non lo apre: non ne ha la serratura.
    assert!(!carla.apri_mazzo(C.into(), mazzo(&anna)).unwrap());
}

#[test]
fn chi_aveva_tenuto_la_catena_di_prima_non_legge_il_seguito() {
    // carla viene tolta, ma **non applica** il commit: tiene la catena che
    // aveva, ed è il caso che la rotazione esiste per coprire.
    let mondo = Mondo::new();
    let (anna, bruno) = anna_e_bruno(&mondo);
    let (carla, _) = mondo.dispositivo("carla@casa");
    let e = anna
        .aggiungi(C.into(), carla.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.applica(C.into(), e.commit).unwrap();
    carla.entra(e.welcome).unwrap();
    assert!(carla.apri_mazzo(C.into(), mazzo(&anna)).unwrap());
    let pregresso = scrive(&anna, "m-1", "quando c'era");

    let e = bruno.rimuovi(C.into(), "carla@casa".into()).unwrap();
    anna.applica(C.into(), e.commit).unwrap();
    let seguito = scrive(&anna, "m-2", "quando non c'era più");
    assert_eq!(seguito.chiave_n, 2);

    assert!(carla.ha_archivio(C.into()));
    assert_eq!(
        legge(&carla, &pregresso, "m-1", "anna@casa").as_deref(),
        Some("quando c'era")
    );
    assert_eq!(legge(&carla, &seguito, "m-2", "anna@casa"), None);
    // Il mazzo dell'epoch nuova non le dà niente: non ne ha la serratura.
    carla.apri_mazzo(C.into(), mazzo(&anna)).unwrap();
    assert_eq!(legge(&carla, &seguito, "m-2", "anna@casa"), None);
}

#[test]
fn la_catena_sopravvive_alla_riapertura() {
    let mondo = Mondo::new();
    let (anna, deposito) = mondo.dispositivo("anna@casa");
    let (bruno, deposito_di_bruno) = mondo.dispositivo("bruno@casa");
    let (carla, _) = mondo.dispositivo("carla@casa");
    anna.crea_conversazione(C.into()).unwrap();
    let e = anna
        .aggiungi(C.into(), bruno.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.entra(e.welcome).unwrap();
    assert!(bruno.apri_mazzo(C.into(), mazzo(&anna)).unwrap());
    let e = anna
        .aggiungi(C.into(), carla.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.applica(C.into(), e.commit).unwrap();
    let prima = scrive(&anna, "m-1", "con la prima chiave");
    let e = anna.rimuovi(C.into(), "carla@casa".into()).unwrap();
    bruno.applica(C.into(), e.commit).unwrap();
    let dopo = scrive(&anna, "m-2", "con la seconda");
    drop((anna, bruno));

    // Riaperti dal deposito: la catena c'è, intera, in tutti e due.
    for (membro, deposito) in [("anna@casa", &deposito), ("bruno@casa", &deposito_di_bruno)] {
        let riaperto = mondo.riapri(membro, deposito);
        assert!(riaperto.ha_archivio(C.into()));
        assert_eq!(
            legge(&riaperto, &prima, "m-1", "anna@casa").as_deref(),
            Some("con la prima chiave")
        );
        assert_eq!(
            legge(&riaperto, &dopo, "m-2", "anna@casa").as_deref(),
            Some("con la seconda")
        );
        assert_eq!(scrive(&riaperto, "m-3", "ancora").chiave_n, 2);
    }
}

#[test]
fn chi_rientra_aspetta_che_un_altro_riavvolga_il_mazzo() {
    let mondo = Mondo::new();
    let (anna, bruno) = anna_e_bruno(&mondo);
    let pregresso = scrive(&anna, "m-1", "prima del telefono nuovo");

    let (telefono, _) = mondo.dispositivo("bruno@casa");
    let di_prima = mazzo(&anna);
    let r = telefono
        .rientra(anna.punto_di_rientro(C.into()).unwrap())
        .unwrap();

    // Nel gruppo, non nella cronologia (S3): il mazzo è ancora dell'epoch di prima.
    assert!(!telefono.ha_archivio(C.into()));
    assert!(!telefono.apri_mazzo(C.into(), di_prima).unwrap());
    assert_eq!(telefono.mazzo_avvolto(C.into()).unwrap(), None);

    // Un altro applica il commit di rientro e riavvolge: adesso si apre.
    anna.applica(C.into(), r.commit.clone()).unwrap();
    bruno.applica(C.into(), r.commit).unwrap();
    assert!(telefono.apri_mazzo(C.into(), mazzo(&bruno)).unwrap());
    assert_eq!(
        legge(&telefono, &pregresso, "m-1", "anna@casa").as_deref(),
        Some("prima del telefono nuovo")
    );
}

#[test]
fn un_mazzo_rimasto_indietro_non_toglie_chiavi_a_chi_le_ha() {
    let mondo = Mondo::new();
    let (anna, bruno) = anna_e_bruno(&mondo);
    let (carla, _) = mondo.dispositivo("carla@casa");
    let (dario, _) = mondo.dispositivo("dario@casa");
    let e = anna
        .aggiungi(C.into(), carla.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.applica(C.into(), e.commit).unwrap();
    carla.entra(e.welcome).unwrap();
    let e = anna
        .aggiungi(C.into(), dario.nuovi_pacchetti(1).unwrap().remove(0))
        .unwrap();
    bruno.applica(C.into(), e.commit.clone()).unwrap();
    carla.applica(C.into(), e.commit).unwrap();
    dario.entra(e.welcome).unwrap();
    // dario entra nel gruppo ma **non apre il mazzo**: resta senza catena.
    let e = anna.rimuovi(C.into(), "carla@casa".into()).unwrap();
    bruno.applica(C.into(), e.commit.clone()).unwrap();
    dario.applica(C.into(), e.commit).unwrap();
    let seguito = scrive(&anna, "m-1", "con la chiave della rimozione");
    assert_eq!(seguito.chiave_n, 2);

    // dario, che non la conosce, non ha niente da riavvolgere: è la regola che
    // impedisce a un mazzo vuoto o vecchio di prendere il posto di quello vero.
    assert_eq!(dario.mazzo_avvolto(C.into()).unwrap(), None);

    // bruno riceve dall'istanza un mazzo uguale al suo: non cambia niente.
    assert!(bruno.apri_mazzo(C.into(), mazzo(&anna)).unwrap());
    assert_eq!(
        legge(&bruno, &seguito, "m-1", "anna@casa").as_deref(),
        Some("con la chiave della rimozione")
    );
    // dario lo apre adesso, e riceve la catena intera.
    assert!(dario.apri_mazzo(C.into(), mazzo(&bruno)).unwrap());
    assert_eq!(scrive(&dario, "m-2", "eccomi").chiave_n, 2);
}

#[test]
fn una_conversazione_non_si_crea_due_volte() {
    let mondo = Mondo::new();
    let (anna, _) = mondo.dispositivo("anna@casa");
    anna.crea_conversazione(C.into()).unwrap();
    let voce = scrive(&anna, "m-1", "la cronologia");
    // Rifarla darebbe una catena nuova, e la cronologia non si aprirebbe più.
    assert!(anna.crea_conversazione(C.into()).is_err());
    assert_eq!(
        legge(&anna, &voce, "m-1", "anna@casa").as_deref(),
        Some("la cronologia")
    );
}
