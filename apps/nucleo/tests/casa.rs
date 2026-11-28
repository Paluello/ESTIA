//! Il collegamento con una Casa finta, in rete locale: ingresso con il codice
//! del QR, poi richieste dell'API sul filo `estia/dispositivo/1`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use estia_nucleo::casa::Collegamento;
use estia_nucleo::deposito::Deposito;
use estia_nucleo::filo::{
    incornicia, scomponi, IntestazioneRichiesta, IntestazioneRisposta, ALPN_DISPOSITIVO,
    ALPN_INGRESSO,
};
use estia_nucleo::ErroreNucleo;
use iroh::endpoint::{presets, Connection};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointId, SecretKey};
use iroh_tickets::endpoint::EndpointTicket;

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

/// Le chiavi ammesse dalla Casa finta: ci entra chi ha presentato il codice.
#[derive(Debug, Clone, Default)]
struct Ammessi(Arc<Mutex<HashSet<EndpointId>>>);

#[derive(Debug, Clone)]
struct Ingresso(Ammessi);

impl ProtocolHandler for Ingresso {
    async fn accept(&self, c: Connection) -> Result<(), AcceptError> {
        let Ok((mut invio, mut ricezione)) = c.accept_bi().await else {
            return Ok(());
        };
        let Ok(grezzo) = ricezione.read_to_end(64 * 1024).await else {
            return Ok(());
        };
        let domanda: serde_json::Value = serde_json::from_slice(&grezzo).unwrap_or_default();
        if domanda["codice"] != "giusto" {
            // Come la Casa vera: si chiude, senza dire perché.
            c.close(0u32.into(), b"");
            return Ok(());
        }
        self.0 .0.lock().unwrap().insert(c.remote_id());
        let risposta = serde_json::json!({
            "esito": "ammesso",
            "utente": { "username": "anna", "etichetta": domanda["etichetta"] },
        });
        let _ = invio
            .write_all(&serde_json::to_vec(&risposta).unwrap())
            .await;
        let _ = invio.finish();
        c.closed().await;
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct Dispositivi(Ammessi);

impl ProtocolHandler for Dispositivi {
    async fn accept(&self, c: Connection) -> Result<(), AcceptError> {
        if !self.0 .0.lock().unwrap().contains(&c.remote_id()) {
            c.close(0u32.into(), b"");
            return Ok(());
        }
        while let Ok((mut invio, mut ricezione)) = c.accept_bi().await {
            let Ok(grezzo) = ricezione.read_to_end(1 << 20).await else {
                return Ok(());
            };
            let Ok((testa, corpo)) = scomponi::<IntestazioneRichiesta>(&grezzo) else {
                return Ok(());
            };
            // Un'eco: il percorso nell'intestazione, il corpo rovesciato.
            let risposta = IntestazioneRisposta {
                stato: 200,
                intestazioni: [("x-percorso".to_string(), testa.percorso.clone())].into(),
            };
            let mut indietro = corpo.to_vec();
            indietro.reverse();
            let _ = invio.write_all(&incornicia(&risposta).unwrap()).await;
            let _ = invio.write_all(&indietro).await;
            let _ = invio.finish();
        }
        Ok(())
    }
}

async fn casa_finta() -> Router {
    let ammessi = Ammessi::default();
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .alpns(vec![ALPN_INGRESSO.to_vec(), ALPN_DISPOSITIVO.to_vec()])
        .bind()
        .await
        .unwrap();
    Router::builder(endpoint)
        .accept(ALPN_INGRESSO, Ingresso(ammessi.clone()))
        .accept(ALPN_DISPOSITIVO, Dispositivi(ammessi))
        .spawn()
}

fn collegamento_qr(router: &Router, codice: &str) -> String {
    let indirizzo = router.endpoint().addr();
    let ticket = EndpointTicket::new(indirizzo.clone());
    format!(
        "estia://ingresso?casa={}&codice={codice}&ticket={ticket}",
        indirizzo.id
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn si_entra_col_codice_e_si_chiede_alla_casa() {
    let router = casa_finta().await;
    let deposito = Arc::new(DepositoInMemoria::default());
    let telefono = Collegamento::apri(deposito.clone()).await.unwrap();
    assert_eq!(telefono.casa(), None);
    assert!(matches!(
        telefono
            .chiedi("GET".into(), "/api/v1/io".into(), HashMap::new(), vec![])
            .await,
        Err(ErroreNucleo::NessunaCasa)
    ));

    // Un codice sbagliato non apre, e non dice perché.
    assert!(matches!(
        telefono
            .entra(collegamento_qr(&router, "sbagliato"), "telefono".into())
            .await,
        Err(ErroreNucleo::CodiceNonAccettato)
    ));
    assert_eq!(telefono.casa(), None);

    let ingresso = telefono
        .entra(
            collegamento_qr(&router, "giusto"),
            " telefono di anna ".into(),
        )
        .await
        .unwrap();
    assert_eq!(ingresso.casa, router.endpoint().id().to_string());
    let utente: serde_json::Value = serde_json::from_str(&ingresso.utente).unwrap();
    assert_eq!(utente["etichetta"], "telefono di anna");

    let r = telefono
        .chiedi(
            "POST".into(),
            "/api/v1/messaggi".into(),
            [(
                "content-type".to_string(),
                "application/octet-stream".to_string(),
            )]
            .into(),
            vec![1, 2, 3],
        )
        .await
        .unwrap();
    assert_eq!(r.stato, 200);
    assert_eq!(r.intestazioni["x-percorso"], "/api/v1/messaggi");
    assert_eq!(r.corpo, vec![3, 2, 1]);

    // Riaperto dallo stesso deposito: stessa chiave, Casa ricordata.
    let chiave = telefono.chiave_pubblica();
    drop(telefono);
    let telefono = Collegamento::apri(deposito.clone()).await.unwrap();
    assert_eq!(telefono.chiave_pubblica(), chiave);
    assert_eq!(telefono.casa(), Some(router.endpoint().id().to_string()));
    let r = telefono
        .chiedi("GET".into(), "/api/v1/io".into(), HashMap::new(), vec![])
        .await
        .unwrap();
    assert_eq!(r.stato, 200);

    // Fuori dall'API non si chiede, e uscire dimentica la Casa.
    assert!(telefono
        .chiedi("GET".into(), "/admin".into(), HashMap::new(), vec![])
        .await
        .is_err());
    telefono.dimentica_casa().await.unwrap();
    assert_eq!(telefono.casa(), None);

    router.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn una_chiave_non_ammessa_non_riceve_niente() {
    let router = casa_finta().await;
    // Un deposito che dice di conoscere la Casa, ma la chiave non è mai entrata.
    let deposito = Arc::new(DepositoInMemoria::default());
    let casa = serde_json::json!({
        "chiave": router.endpoint().id().to_string(),
        "ticket": EndpointTicket::new(router.endpoint().addr()).to_string(),
    });
    deposito
        .scrivi("nucleo/casa".into(), serde_json::to_vec(&casa).unwrap())
        .unwrap();
    let estraneo = Collegamento::apri(deposito).await.unwrap();
    assert!(estraneo
        .chiedi("GET".into(), "/api/v1/io".into(), HashMap::new(), vec![])
        .await
        .is_err());
    router.shutdown().await.unwrap();
}
