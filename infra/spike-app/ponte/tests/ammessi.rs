//! ADR 0044, «Come si verifica» §2, in rete locale: un dispositivo ammesso
//! riceve, una chiave sconosciuta non riceve niente.

use estia_ponte::{bussa, bussa_da_estraneo, casa, dispositivo, Ammessi, Modo};
use iroh::SecretKey;

#[tokio::test]
async fn ammesso_riceve_estraneo_no() {
    let chiave_dispositivo = SecretKey::generate();
    let ammessi = Ammessi::default();
    ammessi.ammetti(chiave_dispositivo.public());

    let router = casa(SecretKey::generate(), Modo::Locale, ammessi)
        .await
        .unwrap();
    let indirizzo = router.endpoint().addr();

    let mio = dispositivo(chiave_dispositivo, Modo::Locale).await.unwrap();
    let resoconto = bussa(&mio, indirizzo.clone(), 3).await.unwrap();
    assert_eq!(resoconto.domande, 3);
    assert_eq!(resoconto.strada_finale.tipo, "diretta");

    let estraneo = dispositivo(SecretKey::generate(), Modo::Locale)
        .await
        .unwrap();
    let esito = bussa_da_estraneo(&estraneo, indirizzo).await;
    assert!(
        !esito.contains("RISPOSTA"),
        "l'estraneo ha ricevuto: {esito}"
    );

    mio.close().await;
    estraneo.close().await;
    router.shutdown().await.unwrap();
}
