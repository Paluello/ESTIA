//! La sessione davanti all'istanza finta: due e tre dispositivi, chi entra e
//! chi esce, la fila in disordine, le risposte perse, il registro.
//!
//! Sono le prove di `sessione.test.ts`, `gruppi.test.ts` e
//! `conversazione.test.ts`, più quelle che il nucleo deve a ciò che fa
//! diversamente: lo stato che resta nel deposito fra un avvio e l'altro, e il
//! commit lasciato in sospeso finché la fila non l'ha preso.

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

use super::finta::{id_di, DepositoFinto, IstanzaFinta, VistaFinta, CASA};
use super::*;
use crate::mls::Dichiarato;

const NOME_STATO: &str = "nucleo/mls";

struct Telefono {
    motore: Motore<VistaFinta>,
    vista: Arc<VistaFinta>,
    deposito: Arc<DepositoFinto>,
}

async fn telefono(istanza: &IstanzaFinta, nome: &str) -> Telefono {
    let vista = istanza.per(nome);
    let deposito = Arc::new(DepositoFinto::default());
    let motore = Motore::apri(vista.clone(), deposito.clone()).await.unwrap();
    Telefono {
        motore,
        vista,
        deposito,
    }
}

impl Telefono {
    /// L'app si chiude e si riapre: resta soltanto ciò che è nel deposito.
    async fn riavvia(&mut self) {
        self.motore = Motore::apri(self.vista.clone(), self.deposito.clone())
            .await
            .unwrap();
    }

    fn epoch(&self, conversazione: &str) -> u64 {
        self.motore
            .dispositivo()
            .epoch(conversazione.into())
            .unwrap()
    }

    async fn aggiorna(&self, conversazione: &str) -> Aggiornamento {
        self.motore.aggiorna(conversazione.into()).await.unwrap()
    }

    async fn scrive(&self, conversazione: &str, testo: &str) -> Messaggio {
        self.motore
            .invia(conversazione.into(), testo.into(), None)
            .await
            .unwrap()
    }

    /// I testi dell'ultima pagina, con chi li ha scritti.
    async fn legge(&self, conversazione: &str) -> Vec<(String, String)> {
        self.aggiorna(conversazione).await;
        self.motore
            .cronologia(conversazione.into(), None)
            .await
            .unwrap()
            .messaggi
            .into_iter()
            .filter(|m| m.evento.is_none())
            .map(|m| {
                let chi = m.mittente.unwrap_or_default();
                let chi = chi.strip_suffix(&format!("@{CASA}")).unwrap_or(&chi);
                (
                    chi.to_string(),
                    m.testo.unwrap_or(format!("<{:?}>", m.stato)),
                )
            })
            .collect()
    }

    fn membri_nell_albero(&self, conversazione: &str) -> Vec<String> {
        let mut nomi: Vec<String> = self
            .motore
            .dispositivo()
            .foglie(conversazione)
            .unwrap()
            .into_iter()
            .map(|f| f.membro.replace(&format!("@{CASA}"), ""))
            .collect();
        nomi.sort();
        nomi
    }
}

fn persona(nome: &str) -> PersonaDaInvitare {
    PersonaDaInvitare {
        username: nome.into(),
        casa: None,
    }
}

fn membro(nome: &str) -> String {
    format!("{nome}@{CASA}")
}

fn coppie(righe: &[(&str, &str)]) -> Vec<(String, String)> {
    righe
        .iter()
        .map(|(chi, testo)| (chi.to_string(), testo.to_string()))
        .collect()
}

fn epoch_dei_commit(istanza: &IstanzaFinta, conversazione: &str) -> Vec<u64> {
    istanza
        .depositati(conversazione)
        .iter()
        .filter(|h| h.tipo == TipoBusta::Commit)
        .map(|h| h.epoch)
        .collect()
}

/// Anna e Bruno in una chat a due, aperta da Anna e già letta da Bruno.
async fn in_due() -> (IstanzaFinta, Telefono, Telefono, String) {
    let istanza = IstanzaFinta::default();
    let anna = telefono(&istanza, "anna").await;
    let bruno = telefono(&istanza, "bruno").await;
    let conv = anna.motore.crea_diretta(persona("bruno")).await.unwrap().id;
    assert_eq!(
        anna.motore.apri_conversazione(conv.clone()).await.unwrap(),
        Apertura::Pronta
    );
    assert_eq!(bruno.aggiorna(&conv).await.apertura, Apertura::Pronta);
    (istanza, anna, bruno, conv)
}

/// Anna, Bruno e Carla in un gruppo creato da Anna, con tutti dentro.
async fn in_tre() -> (IstanzaFinta, Telefono, Telefono, Telefono, String) {
    let istanza = IstanzaFinta::default();
    let anna = telefono(&istanza, "anna").await;
    let bruno = telefono(&istanza, "bruno").await;
    let carla = telefono(&istanza, "carla").await;
    let conv = anna
        .motore
        .crea_gruppo("Scala B".into(), vec![persona("bruno"), persona("carla")])
        .await
        .unwrap()
        .id;
    assert_eq!(anna.aggiorna(&conv).await.apertura, Apertura::Pronta);
    assert_eq!(bruno.aggiorna(&conv).await.apertura, Apertura::Pronta);
    assert_eq!(carla.aggiorna(&conv).await.apertura, Apertura::Pronta);
    (istanza, anna, bruno, carla, conv)
}

/// Le chiavi d'ingresso di una persona, prelevate come farebbe la sessione.
async fn ingressi_di(chi_chiede: &Telefono, nome: &str) -> Vec<Ingresso> {
    chi_chiede
        .vista
        .pacchetti_di(&membro(nome))
        .await
        .unwrap()
        .into_iter()
        .map(|pacchetto| Ingresso {
            pacchetto,
            destinatario: id_di(nome),
        })
        .collect()
}

/* ---------- aprire una conversazione ---------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aprire_mette_sul_canale_un_commit_per_tutti_e_un_welcome_per_chi_entra() {
    let (istanza, anna, bruno, conv) = in_due().await;

    let canale = istanza.depositati(&conv);
    assert_eq!(canale.len(), 2);
    assert_eq!(
        (canale[0].tipo, canale[0].epoch, &canale[0].destinatario),
        (TipoBusta::Commit, 1, &None)
    );
    // Il Welcome va all'**id** di chi entra, non al suo nome.
    assert_eq!(
        (canale[1].tipo, canale[1].epoch, &canale[1].destinatario),
        (TipoBusta::Welcome, 1, &Some(id_di("bruno")))
    );

    // I due si trovano nello stesso gruppo, alla stessa epoch.
    assert_eq!((anna.epoch(&conv), bruno.epoch(&conv)), (1, 1));
    assert_eq!(anna.membri_nell_albero(&conv), ["anna", "bruno"]);
    assert_eq!(bruno.membri_nell_albero(&conv), ["anna", "bruno"]);

    // Il mazzo e il punto di rientro sono sull'istanza, all'epoch corrente.
    assert_eq!(istanza.mazzo(&conv).unwrap().epoch, 1);
    assert_eq!(istanza.punto_di_rientro(&conv).unwrap().epoch, 1);

    // Chi entra apre il mazzo che c'era già, e non ne crea uno nuovo: il
    // mazzo l'ha depositato soltanto Anna.
    assert!(bruno.motore.dispositivo().ha_archivio(conv.clone()));
    assert_eq!(istanza.chiamate(|c| c.salva_mazzo), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn il_welcome_lo_vede_chi_entra_e_nessun_altro() {
    let (_istanza, anna, bruno, conv) = in_due().await;
    let per_anna = anna.vista.handshake_dopo(&conv, None).await.unwrap();
    let per_bruno = bruno.vista.handshake_dopo(&conv, None).await.unwrap();
    assert_eq!(per_anna.handshake.len(), 1);
    assert_eq!(per_bruno.handshake.len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn in_un_gruppo_crea_solo_chi_deve_e_gli_altri_aspettano() {
    let istanza = IstanzaFinta::default();
    let anna = telefono(&istanza, "anna").await;
    let bruno = telefono(&istanza, "bruno").await;
    let carla = telefono(&istanza, "carla").await;
    let conv = anna
        .motore
        .crea_gruppo("Scala B".into(), vec![persona("bruno"), persona("carla")])
        .await
        .unwrap()
        .id;

    // Bruno sta nella stessa casa, ma il gruppo non l'ha creato lui.
    assert_eq!(bruno.aggiorna(&conv).await.apertura, Apertura::InAttesa);
    assert!(istanza.depositati(&conv).is_empty());

    assert_eq!(anna.aggiorna(&conv).await.apertura, Apertura::Pronta);
    // Un commit, e un Welcome per ciascuno.
    let canale = istanza.depositati(&conv);
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);
    let invitati: Vec<_> = canale
        .iter()
        .filter_map(|h| h.destinatario.clone())
        .collect();
    assert_eq!(invitati, [id_di("bruno"), id_di("carla")]);

    assert_eq!(bruno.aggiorna(&conv).await.apertura, Apertura::Pronta);
    assert_eq!(carla.aggiorna(&conv).await.apertura, Apertura::Pronta);
    assert_eq!(carla.membri_nell_albero(&conv), ["anna", "bruno", "carla"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chi_sta_altrove_e_non_ha_un_welcome_aspetta() {
    let istanza = IstanzaFinta::default();
    let anna = telefono(&istanza, "anna").await;
    let _bruno = telefono(&istanza, "bruno").await;
    let conv = anna.motore.crea_diretta(persona("bruno")).await.unwrap().id;
    istanza.ordinata_altrove(&conv);
    assert_eq!(
        anna.motore.apri_conversazione(conv.clone()).await.unwrap(),
        Apertura::InAttesa
    );
    assert!(istanza.depositati(&conv).is_empty());
    assert!(!anna.motore.dispositivo().conosce(&conv));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn un_welcome_per_una_chiave_che_non_abbiamo_non_si_apre_e_lo_dice() {
    let (_istanza, anna, bruno, conv) = in_due().await;
    // Carla non c'entra: il Welcome di Bruno non chiama nessuna sua chiave.
    let istanza = IstanzaFinta::default();
    let carla = telefono(&istanza, "carla").await;
    let welcome = bruno
        .vista
        .handshake_dopo(&conv, None)
        .await
        .unwrap()
        .handshake
        .into_iter()
        .find(|h| h.tipo == TipoBusta::Welcome)
        .unwrap();
    assert!(!carla.motore.entra(&conv, &welcome).await.unwrap());
    assert!(!carla.motore.dispositivo().conosce(&conv));
    // E chi è già dentro non lo riapre.
    assert!(anna.motore.entra(&conv, &welcome).await.is_ok_and(|e| !e));
}

/* ---------- scrivere e leggere (ADR 0043) ---------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn anna_scrive_e_bruno_legge_con_chi_e_quando() {
    let (_istanza, anna, bruno, conv) = in_due().await;

    let mandato = anna.scrive(&conv, "ciao Bruno — però 🏠").await;
    let giro = bruno.aggiorna(&conv).await;
    assert_eq!(giro.nuovi.len(), 1);
    let letto = &giro.nuovi[0];
    assert_eq!(letto.id, mandato.id);
    assert_eq!(letto.creato_il, mandato.creato_il);
    assert_eq!(letto.mittente, Some(membro("anna")));
    assert_eq!(letto.testo.as_deref(), Some("ciao Bruno — però 🏠"));
    assert_eq!(letto.stato, StatoMessaggio::Letto);
    assert!(letto.attestato && !letto.mio);
    assert!(!giro.senza_cronologia);

    // La risposta viaggia dentro la voce.
    let risposta = bruno
        .motore
        .invia(conv.clone(), "eccomi".into(), Some(mandato.id.clone()))
        .await
        .unwrap();
    let giro = anna.aggiorna(&conv).await;
    // Ciò che Anna ha scritto lei l'ha già: di nuovo c'è solo la risposta.
    assert_eq!(giro.nuovi.len(), 1);
    assert_eq!(giro.nuovi[0].risponde, Some(mandato.id.clone()));
    assert_eq!(giro.nuovi[0].mittente, Some(membro("bruno")));
    assert_eq!(giro.pagina, [mandato.id.clone(), risposta.id.clone()]);

    // Un altro giro senza novità non riporta niente.
    assert!(anna.aggiorna(&conv).await.nuovi.is_empty());
    assert!(bruno.aggiorna(&conv).await.nuovi.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scrivere_deposita_soltanto_nell_archivio_e_non_tocca_il_gruppo() {
    let (istanza, anna, _bruno, conv) = in_due().await;
    let canale = istanza.depositati(&conv).len();
    let scritture = anna.deposito.scritture(NOME_STATO);
    let archivio = istanza.chiamate(|c| c.deposita_archivio);

    anna.scrive(&conv, "testo che non deve comparire").await;

    // Nessuna busta di trasporto parte, e lo stato del gruppo non cambia.
    assert_eq!(istanza.depositati(&conv).len(), canale);
    assert_eq!(anna.deposito.scritture(NOME_STATO), scritture);
    assert_eq!(anna.epoch(&conv), 1);
    assert_eq!(istanza.chiamate(|c| c.deposita_archivio), archivio + 1);

    // Nell'archivio c'è la voce cifrata, non il testo.
    let voci = istanza.voci(&conv);
    assert_eq!(voci.len(), 1);
    let sotto = STANDARD.decode(&voci[0].voce.busta).unwrap();
    let ago = "testo che non deve".as_bytes();
    assert!(!sotto.windows(ago.len()).any(|pezzo| pezzo == ago));
    assert_eq!(voci[0].voce.chiave_n, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn una_voce_che_la_casa_falsifica_o_di_forma_ignota_non_si_apre() {
    let (istanza, anna, bruno, conv) = in_due().await;
    let vera = anna.scrive(&conv, "l'ho scritto io").await;
    // Aperta, ma non nella forma che questo client conosce.
    anna.motore
        .deposita_voce(
            &conv,
            "testo nudo".into(),
            "m-nudo",
            "2026-11-28T10:00:00.000Z",
        )
        .await
        .unwrap();

    istanza.falsifica(&conv, &vera.id, Some(&membro("bruno")), None);
    let giro = bruno.aggiorna(&conv).await;
    assert_eq!(giro.nuovi.len(), 2);
    for m in &giro.nuovi {
        assert_eq!(m.stato, StatoMessaggio::NonSiApre);
        assert_eq!(m.testo, None);
    }

    // Tolta la bugia, la voce cambia stato e torna fra le novità.
    istanza.falsifica(&conv, &vera.id, None, None);
    let giro = bruno.aggiorna(&conv).await;
    assert_eq!(giro.nuovi.len(), 1);
    assert_eq!(giro.nuovi[0].testo.as_deref(), Some("l'ho scritto io"));
}

/* ---------- lo stato nel deposito ---------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn riaperta_l_app_si_riprende_la_conversazione_di_prima() {
    let (istanza, mut anna, mut bruno, conv) = in_due().await;
    anna.scrive(&conv, "prima").await;
    let commit = istanza.depositati(&conv).len();
    let scorta = istanza.scorta_di(bruno.vista.dispositivo());
    // Dieci pubblicati, uno speso dall'invito.
    assert_eq!(scorta, 9);

    anna.riavvia().await;
    bruno.riavvia().await;

    // Nessun invito nuovo, nessun gruppo nuovo.
    assert_eq!(bruno.legge(&conv).await, coppie(&[("anna", "prima")]));
    assert_eq!(istanza.depositati(&conv).len(), commit);
    assert_eq!((anna.epoch(&conv), bruno.epoch(&conv)), (1, 1));
    bruno.scrive(&conv, "dopo").await;
    assert_eq!(
        anna.legge(&conv).await,
        coppie(&[("anna", "prima"), ("bruno", "dopo")])
    );
    // La scorta si ricarica soltanto di ciò che è stato speso.
    assert_eq!(istanza.scorta_di(bruno.vista.dispositivo()), 10);
    assert_eq!(istanza.scorta_di(anna.vista.dispositivo()), 10);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lo_stato_si_salva_a_ogni_commit_e_prima_del_cursore() {
    let (istanza, anna, bruno, carla, conv) = in_tre().await;
    let _dario = telefono(&istanza, "dario").await;
    let _elena = telefono(&istanza, "elena").await;
    for nome in ["dario", "elena"] {
        anna.motore
            .aggiungi_membro(conv.clone(), persona(nome))
            .await
            .unwrap();
    }
    assert_eq!(anna.epoch(&conv), 3);
    drop(carla);

    // Bruno applica due commit: due scritture dello stato, non una alla fine.
    let prima = bruno.deposito.scritture(NOME_STATO);
    bruno.aggiorna(&conv).await;
    assert_eq!(bruno.epoch(&conv), 3);
    assert!(bruno.deposito.scritture(NOME_STATO) >= prima + 2);

    // Sincronizzare due volte non riapplica niente.
    let prima = bruno.deposito.scritture(NOME_STATO);
    let cursore = bruno.motore.cursore(&conv);
    bruno.aggiorna(&conv).await;
    assert_eq!(bruno.deposito.scritture(NOME_STATO), prima);
    assert_eq!(bruno.motore.cursore(&conv), cursore);
    assert_eq!(bruno.epoch(&conv), 3);
}

/* ---------- la fila ---------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn una_fila_in_disordine_si_rifiuta_e_il_cursore_non_avanza() {
    let (istanza, anna, bruno, _carla, conv) = in_tre().await;
    let _dario = telefono(&istanza, "dario").await;
    let _elena = telefono(&istanza, "elena").await;
    for nome in ["dario", "elena"] {
        anna.motore
            .aggiungi_membro(conv.clone(), persona(nome))
            .await
            .unwrap();
    }
    let cursore = bruno.motore.cursore(&conv);
    let scritture = bruno.deposito.scritture(NOME_STATO);

    // L'epoch 3 arriva prima della 2: non si applica, e ci si ferma lì.
    istanza.in_disordine(&conv, true);
    let esito = bruno.motore.aggiorna(conv.clone()).await;
    assert!(matches!(esito, Err(ErroreNucleo::Mls(_))), "{esito:?}");
    assert_eq!(bruno.epoch(&conv), 1);
    assert_eq!(bruno.motore.cursore(&conv), cursore);
    assert_eq!(bruno.deposito.scritture(NOME_STATO), scritture);
    // E resta così, finché l'ordine non torna.
    assert!(bruno.motore.aggiorna(conv.clone()).await.is_err());
    assert_eq!(bruno.epoch(&conv), 1);

    istanza.in_disordine(&conv, false);
    bruno.aggiorna(&conv).await;
    assert_eq!(bruno.epoch(&conv), 3);
    assert_eq!(
        bruno.membri_nell_albero(&conv),
        ["anna", "bruno", "carla", "dario", "elena"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn la_fila_si_legge_tutta_anche_una_busta_per_pagina() {
    let (istanza, anna, bruno, _carla, conv) = in_tre().await;
    let dario = telefono(&istanza, "dario").await;
    let _elena = telefono(&istanza, "elena").await;
    for nome in ["dario", "elena"] {
        anna.motore
            .aggiungi_membro(conv.clone(), persona(nome))
            .await
            .unwrap();
    }
    istanza.per_pagina(1);
    bruno.aggiorna(&conv).await;
    assert_eq!(bruno.epoch(&conv), 3);
    // L'invito di Dario sta dopo due commit: lo trova lo stesso.
    // Entra all'epoch a cui l'invito lo chiama; il giro dopo applica il resto.
    assert_eq!(dario.aggiorna(&conv).await.apertura, Apertura::Pronta);
    assert_eq!(dario.epoch(&conv), 2);
    dario.aggiorna(&conv).await;
    assert_eq!(dario.epoch(&conv), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn due_cambi_dalla_stessa_epoch_il_secondo_si_rimette_in_pari_e_riprova() {
    let (istanza, anna, bruno, _carla, conv) = in_tre().await;
    let _dario = telefono(&istanza, "dario").await;
    istanza.riammette(&conv, "dario");

    // Bruno costruisce il suo commit dall'epoch 1, e arriva in fila un attimo
    // prima di Anna, che dall'epoch 1 sta togliendo Carla.
    let di_bruno = ingressi_di(&bruno, "dario").await;
    let pacchetti: Vec<Vec<u8>> = di_bruno.iter().map(|i| i.pacchetto.clone()).collect();
    let conv_di_bruno = conv.clone();
    let cambio = bruno
        .motore
        .fuori(move |d| d.prepara_cambio(&conv_di_bruno, &pacchetti, &[]))
        .await
        .unwrap();
    istanza.sorpassa(&conv, &cambio.commit, cambio.epoch);

    anna.motore
        .togli_foglie(&conv, &[membro("carla")], None)
        .await
        .unwrap();

    // La fila ha rifiutato il primo tentativo di Anna, e non ne è rimasto
    // niente: né in fila, né nel suo stato.
    assert_eq!(istanza.chiamate(|c| c.superati), 1);
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1, 2, 3]);
    assert_eq!(anna.epoch(&conv), 3);
    assert_eq!(anna.membri_nell_albero(&conv), ["anna", "bruno", "dario"]);
    assert_eq!(anna.motore.sospeso(&conv), None);

    // Bruno, il cui commit è passato, lo applica e raggiunge Anna: la catena
    // ha la stessa chiave nuova, senza scambiarsela.
    bruno.motore.dispositivo().conferma_cambio(&conv).unwrap();
    bruno.aggiorna(&conv).await;
    assert_eq!(bruno.epoch(&conv), 3);
    // Anna richiede chi c'è: Dario è stato ammesso mentre lei guardava.
    anna.aggiorna(&conv).await;
    anna.scrive(&conv, "senza carla").await;
    assert_eq!(bruno.legge(&conv).await, coppie(&[("anna", "senza carla")]));
    assert_eq!(istanza.voci(&conv)[0].voce.chiave_n, 2);
}

/* ---------- il commit in sospeso ---------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn un_commit_arrivato_senza_risposta_si_riconosce_anche_dopo_aver_chiuso_l_app() {
    let (istanza, mut anna, bruno, _carla, conv) = in_tre().await;
    let dario = telefono(&istanza, "dario").await;
    istanza.riammette(&conv, "dario");
    let ingressi = ingressi_di(&anna, "dario").await;

    istanza.perdi_le_risposte(1);
    let esito = anna
        .motore
        .aggiungi_foglie(&conv, &membro("dario"), ingressi, false)
        .await;
    assert!(matches!(esito, Err(ErroreNucleo::Rete(_))));
    // Non si sa com'è andata: lo stato non avanza, e il commit resta in sospeso.
    assert_eq!(anna.epoch(&conv), 1);
    assert!(anna.motore.dispositivo().cambio_in_sospeso(&conv).unwrap());
    assert!(anna.motore.sospeso(&conv).is_some());
    // L'invito non è partito.
    assert!(istanza
        .depositati(&conv)
        .iter()
        .all(|h| h.destinatario != Some(id_di("dario"))));

    anna.riavvia().await;
    anna.aggiorna(&conv).await;

    // Era in fila: si applica quello in sospeso, e si finisce il lavoro.
    assert_eq!(anna.epoch(&conv), 2);
    assert_eq!(anna.motore.sospeso(&conv), None);
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1, 2]);
    assert_eq!(istanza.mazzo(&conv).unwrap().epoch, 2);
    assert_eq!(dario.aggiorna(&conv).await.apertura, Apertura::Pronta);
    bruno.aggiorna(&conv).await;
    anna.scrive(&conv, "benvenuto").await;
    assert_eq!(dario.legge(&conv).await, coppie(&[("anna", "benvenuto")]));
    assert_eq!(bruno.legge(&conv).await, coppie(&[("anna", "benvenuto")]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn un_commit_mai_arrivato_si_butta_e_lo_stato_resta_quello_di_tutti() {
    let (istanza, anna, bruno, _carla, conv) = in_tre().await;
    let _dario = telefono(&istanza, "dario").await;
    istanza.riammette(&conv, "dario");

    istanza.perdi_i_depositi(1);
    let esito = anna
        .motore
        .aggiungi_foglie(
            &conv,
            &membro("dario"),
            ingressi_di(&anna, "dario").await,
            false,
        )
        .await;
    assert!(matches!(esito, Err(ErroreNucleo::Rete(_))));
    assert!(anna.motore.dispositivo().cambio_in_sospeso(&conv).unwrap());

    anna.aggiorna(&conv).await;
    assert_eq!(anna.epoch(&conv), 1);
    assert!(!anna.motore.dispositivo().cambio_in_sospeso(&conv).unwrap());
    assert_eq!(anna.motore.sospeso(&conv), None);
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);

    // E il gruppo non è rotto: un cambio nuovo passa, e Bruno lo applica.
    anna.motore
        .aggiungi_foglie(
            &conv,
            &membro("dario"),
            ingressi_di(&anna, "dario").await,
            false,
        )
        .await
        .unwrap();
    bruno.aggiorna(&conv).await;
    assert_eq!((anna.epoch(&conv), bruno.epoch(&conv)), (2, 2));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn una_creazione_interrotta_non_lascia_un_gruppo_che_nessuno_conosce() {
    let istanza = IstanzaFinta::default();
    let mut anna = telefono(&istanza, "anna").await;
    let bruno = telefono(&istanza, "bruno").await;
    let conv = anna.motore.crea_diretta(persona("bruno")).await.unwrap().id;

    // Il commit non arriva: alla riapertura il gruppo di prima si butta, e se
    // ne crea uno che la fila conosce.
    istanza.perdi_i_depositi(1);
    assert!(anna.motore.apri_conversazione(conv.clone()).await.is_err());
    assert!(istanza.depositati(&conv).is_empty());
    assert!(istanza.mazzo(&conv).is_none());
    anna.riavvia().await;
    assert_eq!(
        anna.motore.apri_conversazione(conv.clone()).await.unwrap(),
        Apertura::Pronta
    );
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);
    assert_eq!(bruno.aggiorna(&conv).await.apertura, Apertura::Pronta);
    anna.scrive(&conv, "ci siamo").await;
    assert_eq!(bruno.legge(&conv).await, coppie(&[("anna", "ci siamo")]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn una_creazione_arrivata_senza_risposta_tiene_la_catena_e_finisce_il_lavoro() {
    let istanza = IstanzaFinta::default();
    let mut anna = telefono(&istanza, "anna").await;
    let bruno = telefono(&istanza, "bruno").await;
    let conv = anna.motore.crea_diretta(persona("bruno")).await.unwrap().id;

    istanza.perdi_le_risposte(1);
    assert!(anna.motore.apri_conversazione(conv.clone()).await.is_err());
    // Il commit è in fila, ma né il mazzo né l'invito sono partiti: se la
    // catena andasse persa adesso, in questa conversazione non scriverebbe
    // mai nessuno.
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);
    assert!(istanza.mazzo(&conv).is_none());
    assert_eq!(bruno.aggiorna(&conv).await.apertura, Apertura::InAttesa);

    anna.riavvia().await;
    assert_eq!(
        anna.motore.apri_conversazione(conv.clone()).await.unwrap(),
        Apertura::Pronta
    );
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);
    assert_eq!(istanza.mazzo(&conv).unwrap().epoch, 1);
    assert_eq!(bruno.aggiorna(&conv).await.apertura, Apertura::Pronta);
    anna.scrive(&conv, "ci siamo").await;
    assert_eq!(bruno.legge(&conv).await, coppie(&[("anna", "ci siamo")]));
}

/* ---------- i gruppi: chi entra e chi esce ---------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chi_entra_dopo_legge_anche_il_pregresso_ed_e_detto() {
    let (istanza, anna, bruno, carla, conv) = in_tre().await;
    anna.scrive(&conv, "prima di dario").await;
    let dario = telefono(&istanza, "dario").await;

    anna.motore
        .aggiungi_membro(conv.clone(), persona("dario"))
        .await
        .unwrap();
    assert_eq!(dario.aggiorna(&conv).await.apertura, Apertura::Pronta);
    assert_eq!(
        dario.legge(&conv).await,
        coppie(&[("anna", "prima di dario")])
    );

    // L'ingresso è un momento dichiarato: chi c'era lo legge come un evento.
    let pagina = bruno.aggiorna(&conv).await;
    let evento = pagina
        .nuovi
        .iter()
        .find_map(|m| m.evento.clone())
        .expect("l'ingresso si racconta");
    assert_eq!(
        evento,
        Evento {
            tipo: TipoEvento::Ingresso,
            chi: membro("dario")
        }
    );

    let membri = carla.motore.membri(conv.clone()).await.unwrap();
    carla.aggiorna(&conv).await;
    let membri_dopo = carla.motore.membri(conv.clone()).await.unwrap();
    let dispositivi = |elenco: &[MembroDelGruppo]| -> Vec<(String, u32)> {
        elenco
            .iter()
            .map(|m| (m.persona.username.clone(), m.dispositivi))
            .collect()
    };
    // Prima di applicare il commit Dario è fra le persone, non nell'albero.
    assert_eq!(dispositivi(&membri)[3], ("dario".to_string(), 0));
    assert_eq!(dispositivi(&membri_dopo)[3], ("dario".to_string(), 1));
    assert_eq!(membri_dopo[0].persona.ruolo.as_deref(), Some("creatore"));
    assert_eq!(membri_dopo[3].membro, membro("dario"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chi_e_stato_tolto_non_legge_il_seguito_e_chi_resta_ha_la_stessa_chiave_nuova() {
    let (istanza, anna, bruno, carla, conv) = in_tre().await;
    let vecchia = anna.scrive(&conv, "la legge anche carla").await;
    carla.aggiorna(&conv).await;

    anna.motore
        .togli_membro(conv.clone(), id_di("carla"))
        .await
        .unwrap();
    assert_eq!(anna.epoch(&conv), 2);
    assert_eq!(anna.membri_nell_albero(&conv), ["anna", "bruno"]);

    // Bruno applica il commit e deriva la stessa chiave: legge ciò che Anna
    // scrive con la chiave nuova, e Anna ciò che scrive lui.
    let nuova = anna.scrive(&conv, "carla non c'è più").await;
    let di_bruno = bruno.scrive_dopo_aver_letto(&conv, "ricevuto").await;
    let testi: Vec<String> = anna
        .legge(&conv)
        .await
        .into_iter()
        .map(|(_, testo)| testo)
        .collect();
    assert_eq!(
        testi,
        ["la legge anche carla", "carla non c'è più", "ricevuto"]
    );
    let chiave_n = |id: &str| {
        istanza
            .voci(&conv)
            .iter()
            .find(|v| v.id == id)
            .unwrap()
            .voce
            .chiave_n
    };
    assert_eq!((chiave_n(&vecchia.id), chiave_n(&nuova.id)), (1, 2));
    assert_eq!(chiave_n(&di_bruno.id), 2);

    // Carla ha ancora lo stato di prima e la catena di prima: **non applica**
    // il commit che la toglie. Rilegge ciò che aveva, e non apre il seguito.
    let righe = anna.vista.cronologia(&conv, None).await.unwrap().righe;
    let con_la_vecchia = |id: &str| {
        let riga = righe.iter().find(|r| r.id == id).unwrap();
        carla.motore.dispositivo().rileggi(
            conv.clone(),
            riga.voce.clone().unwrap(),
            Some(Dichiarato {
                id: riga.id.clone(),
                mittente: riga.mittente.clone().unwrap(),
                creato_il: riga.creato_il.clone(),
            }),
        )
    };
    assert_eq!(
        con_la_vecchia(&vecchia.id).map(|v| v.testo),
        Some(scrivi_contenuto("la legge anche carla", None, None))
    );
    assert_eq!(con_la_vecchia(&nuova.id), None);
    assert_eq!(con_la_vecchia(&di_bruno.id), None);

    // Per la Casa non è più nel gruppo, e la sessione lo dice senza errore.
    let giro = carla.aggiorna(&conv).await;
    assert_eq!(giro.apertura, Apertura::Tolto);
    assert!(giro.nuovi.is_empty());
}

impl Telefono {
    async fn scrive_dopo_aver_letto(&self, conversazione: &str, testo: &str) -> Messaggio {
        self.aggiorna(conversazione).await;
        self.scrive(conversazione, testo).await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn applicato_il_commit_che_lo_toglie_il_dispositivo_non_legge_non_scrive_e_non_tocca_il_mazzo(
) {
    let (istanza, anna, _bruno, carla, conv) = in_tre().await;
    anna.scrive(&conv, "prima").await;
    carla.aggiorna(&conv).await;

    // Le foglie di Carla escono, ma per la Casa è ancora fra le persone: è
    // ciò che vede il suo telefono finché la notizia non arriva.
    anna.motore
        .togli_foglie(&conv, &[membro("carla")], None)
        .await
        .unwrap();
    anna.scrive(&conv, "dopo").await;
    let mazzi = istanza.chiamate(|c| c.salva_mazzo);

    let giro = carla.aggiorna(&conv).await;
    assert_eq!(giro.apertura, Apertura::Tolto);
    assert!(!carla.motore.dispositivo().nel_gruppo(&conv).unwrap());
    assert!(!carla.motore.dispositivo().ha_archivio(conv.clone()));
    assert_eq!(istanza.chiamate(|c| c.salva_mazzo), mazzi);
    let pagina = carla.motore.cronologia(conv.clone(), None).await.unwrap();
    assert!(pagina
        .messaggi
        .iter()
        .all(|m| m.stato == StatoMessaggio::NonSiApre && m.testo.is_none()));
    assert!(matches!(
        carla
            .motore
            .invia(conv.clone(), "ci sono?".into(), None)
            .await,
        Err(ErroreNucleo::FuoriDalGruppo)
    ));
    // E non rientra da sola, per quante volte guardi.
    assert_eq!(carla.aggiorna(&conv).await.apertura, Apertura::Tolto);
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1, 2]);

    // Finché qualcuno non la fa rientrare: allora entra dall'invito nuovo,
    // con una foglia nuova, e ritrova la cronologia.
    anna.motore
        .fai_entrare(conv.clone(), id_di("carla"))
        .await
        .unwrap();
    assert_eq!(carla.aggiorna(&conv).await.apertura, Apertura::Pronta);
    assert_eq!(carla.epoch(&conv), 3);
    assert_eq!(
        carla.legge(&conv).await,
        coppie(&[("anna", "prima"), ("anna", "dopo")])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn non_parte_nessun_commit_se_non_c_e_niente_da_togliere() {
    let (istanza, anna, _bruno, _carla, conv) = in_tre().await;
    anna.motore
        .togli_foglie(&conv, &[membro("zeno")], None)
        .await
        .unwrap();
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);
    // Non ci si toglie da soli: lo fa un altro membro.
    assert!(anna
        .motore
        .togli_foglie(&conv, &[membro("anna")], None)
        .await
        .is_err());
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);
    assert_eq!(anna.epoch(&conv), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn la_casa_che_ordina_toglie_la_foglia_di_chi_e_uscito_e_altrove_un_estraneo_si_dice() {
    let (istanza, anna, bruno, _carla, conv) = in_tre().await;

    // Carla esce, e la notizia non è ancora arrivata dove sta Bruno, che non
    // è nella casa che ordina: non toglie nessuno, lo dice, e non scrive.
    istanza.esce(&conv, "carla", false);
    istanza.ordinata_altrove(&conv);
    let giro = bruno.aggiorna(&conv).await;
    assert_eq!(giro.estranei, [membro("carla")]);
    assert_eq!(bruno.epoch(&conv), 1);
    assert!(matches!(
        bruno
            .motore
            .invia(conv.clone(), "siamo soli?".into(), None)
            .await,
        Err(ErroreNucleo::PresenzaEstranea(_))
    ));
    assert!(istanza.voci(&conv).is_empty());

    // Quando risulta tolta, la toglie il primo che se ne accorge, e la catena
    // ruota.
    istanza.esce(&conv, "carla", true);
    let giro = bruno.aggiorna(&conv).await;
    assert!(giro.estranei.is_empty());
    assert_eq!(bruno.epoch(&conv), 2);
    assert_eq!(bruno.membri_nell_albero(&conv), ["anna", "bruno"]);
    let scritto = bruno.scrive(&conv, "adesso sì").await;
    assert_eq!(
        istanza
            .voci(&conv)
            .iter()
            .find(|v| v.id == scritto.id)
            .unwrap()
            .voce
            .chiave_n,
        2
    );
    assert_eq!(anna.legge(&conv).await, coppie(&[("bruno", "adesso sì")]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chi_e_fra_i_membri_senza_una_foglia_risulta_assente() {
    let (istanza, anna, _bruno, _carla, conv) = in_tre().await;
    istanza.riammette(&conv, "dario");
    let giro = anna.aggiorna(&conv).await;
    assert_eq!(giro.assenti, [membro("dario")]);
    assert!(giro.estranei.is_empty());
    // Chi non ha un dispositivo non entra, e lo si dice con il codice della Casa.
    let esito = anna.motore.fai_entrare(conv.clone(), id_di("dario")).await;
    assert!(
        matches!(&esito, Err(ErroreNucleo::Casa { stato: 404, codice }) if codice == "no_device_available"),
        "{esito:?}"
    );
}

/* ---------- uscire, ritirare ---------- */

/// Gli eventi dell'ultima pagina, come li legge quel telefono.
async fn eventi(chi: &Telefono, conversazione: &str) -> Vec<Evento> {
    chi.motore
        .cronologia(conversazione.into(), None)
        .await
        .unwrap()
        .messaggi
        .into_iter()
        .filter_map(|m| m.evento)
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chi_esce_lo_racconta_poi_esce_e_chi_resta_toglie_la_sua_foglia() {
    let (istanza, anna, bruno, carla, conv) = in_tre().await;

    carla.motore.esci(conv.clone()).await.unwrap();
    // Nessun commit parte da chi esce: la sua foglia c'è ancora.
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);

    // Il racconto l'ha scritto lei, prima di uscire.
    let uscita = Evento {
        tipo: TipoEvento::Uscita,
        chi: membro("carla"),
    };
    assert_eq!(eventi(&bruno, &conv).await, [uscita]);

    // Per lei la conversazione è chiusa, e non scrive più.
    assert_eq!(carla.aggiorna(&conv).await.apertura, Apertura::Tolto);
    assert!(carla
        .motore
        .invia(conv.clone(), "ci sono ancora?".into(), None)
        .await
        .is_err());

    // La casa che ordina la toglie dall'albero al primo giro, e la catena
    // ruota: ciò che si scrive dopo lei non lo apre.
    let giro = anna.aggiorna(&conv).await;
    assert!(giro.estranei.is_empty());
    assert_eq!(anna.epoch(&conv), 2);
    assert_eq!(anna.membri_nell_albero(&conv), ["anna", "bruno"]);
    let dopo = anna.scrive(&conv, "siamo in due").await;
    let voce = istanza
        .voci(&conv)
        .into_iter()
        .find(|v| v.id == dopo.id)
        .unwrap();
    assert_eq!(voce.voce.chiave_n, 2);
    assert_eq!(
        bruno.legge(&conv).await,
        coppie(&[("anna", "siamo in due")])
    );
    assert!(carla
        .motore
        .dispositivo()
        .rileggi(
            conv.clone(),
            VoceCifrata {
                busta: voce.voce.busta.clone(),
                chiave_n: voce.voce.chiave_n,
            },
            None,
        )
        .is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn se_la_casa_non_lascia_uscire_il_racconto_si_ritira_e_si_resta() {
    let (istanza, anna, _bruno, carla, conv) = in_tre().await;

    istanza.spegni_la_casa_che_ordina(true);
    let esito = carla.motore.esci(conv.clone()).await;
    assert!(
        matches!(&esito, Err(ErroreNucleo::Casa { stato: 503, codice }) if codice == "casa_che_ordina_non_raggiungibile"),
        "{esito:?}"
    );
    // Niente resta scritto: né il racconto, né un commit.
    assert!(istanza.voci(&conv).is_empty());
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);
    // E si scrive come prima.
    assert_eq!(carla.aggiorna(&conv).await.apertura, Apertura::Pronta);
    carla.scrive(&conv, "sono ancora qui").await;
    assert_eq!(
        anna.legge(&conv).await,
        coppie(&[("carla", "sono ancora qui")])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn da_una_chat_a_due_non_si_esce() {
    let (istanza, anna, _bruno, conv) = in_due().await;
    let esito = anna.motore.esci(conv.clone()).await;
    assert!(
        matches!(&esito, Err(ErroreNucleo::Casa { stato: 400, codice }) if codice == "non_un_gruppo"),
        "{esito:?}"
    );
    assert!(istanza.voci(&conv).is_empty());
    assert_eq!(anna.aggiorna(&conv).await.apertura, Apertura::Pronta);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn un_messaggio_ritirato_sparisce_dalla_pagina_di_tutti_e_solo_chi_l_ha_scritto_lo_ritira() {
    let (istanza, anna, bruno, conv) = in_due().await;
    let primo = anna.scrive(&conv, "ops").await;
    let secondo = anna.scrive(&conv, "volevo dire ciao").await;
    // Scritti nello stesso millisecondo, l'ordine fra i due lo decide l'id:
    // qui conta che ci siano tutti e due.
    let mut pagina = bruno.aggiorna(&conv).await.pagina;
    pagina.sort();
    let mut attesi = vec![primo.id.clone(), secondo.id.clone()];
    attesi.sort();
    assert_eq!(pagina, attesi);

    // Bruno non ritira ciò che ha scritto Anna.
    let esito = bruno.motore.ritira(conv.clone(), primo.id.clone()).await;
    assert!(
        matches!(&esito, Err(ErroreNucleo::Casa { stato: 404, codice }) if codice == "messaggio_inesistente"),
        "{esito:?}"
    );
    assert_eq!(istanza.voci(&conv).len(), 2);

    // Anna sì: la voce esce dall'archivio, e al giro dopo non è nella pagina.
    anna.motore
        .ritira(conv.clone(), primo.id.clone())
        .await
        .unwrap();
    assert_eq!(istanza.voci(&conv).len(), 1);
    let giro = bruno.aggiorna(&conv).await;
    assert_eq!(giro.pagina, std::slice::from_ref(&secondo.id));
    assert!(giro.nuovi.is_empty());
    assert_eq!(
        anna.aggiorna(&conv).await.pagina,
        std::slice::from_ref(&secondo.id)
    );
    assert_eq!(
        bruno.legge(&conv).await,
        coppie(&[("anna", "volevo dire ciao")])
    );

    // Una seconda volta non c'è più niente da ritirare.
    assert!(anna.motore.ritira(conv.clone(), primo.id).await.is_err());
}

/* ---------- il registro delle chiavi di firma ---------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn una_chiave_che_il_registro_non_conosce_non_entra_e_non_resta_niente() {
    let istanza = IstanzaFinta::default();
    let anna = telefono(&istanza, "anna").await;
    let _bruno = telefono(&istanza, "bruno").await;
    let conv = anna.motore.crea_diretta(persona("bruno")).await.unwrap().id;

    // Qualcuno che dice di essere Bruno, con una chiave che la Casa non ha
    // mai visto: la casa che consegna le chiavi d'ingresso mente.
    let impostore = Dispositivo::apri(
        membro("bruno"),
        Arc::new(DepositoFinto::default()),
        Arc::new(NessunRegistro),
    )
    .unwrap();
    istanza.scambia_il_pacchetto("bruno", impostore.nuovi_pacchetti(1).unwrap().remove(0));

    let esito = anna.motore.apri_conversazione(conv.clone()).await;
    assert!(
        matches!(esito, Err(ErroreNucleo::NonAutenticato(_))),
        "{esito:?}"
    );
    assert!(istanza.depositati(&conv).is_empty());
    assert!(istanza.mazzo(&conv).is_none());
    assert!(!anna.motore.dispositivo().conosce(&conv));
}

struct NessunRegistro;

impl Registro for NessunRegistro {
    fn chiavi_di_firma(&self, _membro: String) -> Esito<Vec<Vec<u8>>> {
        Ok(Vec::new())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn una_chiave_d_ingresso_che_nomina_un_altro_non_fa_entrare_nessuno() {
    let (istanza, anna, _bruno, _carla, conv) = in_tre().await;
    let _dario = telefono(&istanza, "dario").await;
    let _elena = telefono(&istanza, "elena").await;
    istanza.riammette(&conv, "dario");

    // La chiave è di Elena, che il registro conosce, ma la si presenta per Dario.
    let mut ingressi = ingressi_di(&anna, "elena").await;
    ingressi[0].destinatario = id_di("dario");
    let esito = anna
        .motore
        .aggiungi_foglie(&conv, &membro("dario"), ingressi, false)
        .await;
    assert!(matches!(esito, Err(ErroreNucleo::ChiaveDiUnAltro)));
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);

    // E se è la Casa a consegnarla al posto di quella di Dario, resta fuori.
    let di_elena = ingressi_di(&anna, "elena").await.remove(0).pacchetto;
    istanza.scambia_il_pacchetto("dario", di_elena);
    let esito = anna.motore.fai_entrare(conv.clone(), id_di("dario")).await;
    assert!(matches!(esito, Err(ErroreNucleo::Casa { stato: 404, .. })));
    assert_eq!(anna.membri_nell_albero(&conv), ["anna", "bruno", "carla"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn un_commit_con_una_foglia_che_il_registro_non_riconosce_non_si_applica() {
    let (istanza, anna, bruno, _carla, conv) = in_tre().await;
    let dario = telefono(&istanza, "dario").await;
    anna.motore
        .aggiungi_membro(conv.clone(), persona("dario"))
        .await
        .unwrap();
    let cursore = bruno.motore.cursore(&conv);

    // La casa di Dario non risponde: non è un elenco vuoto, è un errore, e
    // nessuno viene rifiutato perché un NAS dorme.
    istanza.spegni_il_registro(true);
    let esito = bruno.motore.aggiorna(conv.clone()).await;
    assert!(
        matches!(esito, Err(ErroreNucleo::Casa { stato: 503, .. })),
        "{esito:?}"
    );
    assert_eq!(bruno.epoch(&conv), 1);
    istanza.spegni_il_registro(false);

    // Fra il commit di Anna e il giro di Bruno la chiave di Dario è stata
    // revocata: Bruno la autentica **adesso**, e si ferma lì.
    istanza.revoca(dario.vista.dispositivo());
    let esito = bruno.motore.aggiorna(conv.clone()).await;
    assert!(
        matches!(esito, Err(ErroreNucleo::NonAutenticato(_))),
        "{esito:?}"
    );
    assert_eq!(bruno.epoch(&conv), 1);
    assert_eq!(bruno.motore.cursore(&conv), cursore);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chi_entra_autentica_tutto_l_albero_una_domanda_per_persona() {
    let (istanza, anna, _bruno, _carla, conv) = in_tre().await;
    let dario = telefono(&istanza, "dario").await;
    anna.motore
        .aggiungi_membro(conv.clone(), persona("dario"))
        .await
        .unwrap();
    let welcome = dario
        .vista
        .handshake_dopo(&conv, None)
        .await
        .unwrap()
        .handshake
        .into_iter()
        .find(|h| h.tipo == TipoBusta::Welcome)
        .unwrap();
    let prima = istanza.chiamate(|c| c.chiavi_di_firma);
    assert!(dario.motore.entra(&conv, &welcome).await.unwrap());
    // Quattro foglie, quattro persone, quattro domande: non una di più.
    assert_eq!(istanza.chiamate(|c| c.chiavi_di_firma), prima + 4);
}

/* ---------- i propri dispositivi (ADR 0040) e il rientro ---------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn un_dispositivo_che_aspetta_il_si_non_rientra_e_non_crea() {
    let (istanza, anna, _bruno, conv) = in_due().await;
    let secondo = telefono(&istanza, "anna").await;
    assert!(anna.motore.io().approvato);
    assert!(!secondo.motore.io().approvato);

    // Il punto di rientro c'è, ma gli altri rifiuterebbero la sua foglia: il
    // commit resterebbe in fila davanti a tutti.
    let esito = secondo.motore.apri_conversazione(conv.clone()).await;
    assert!(matches!(esito, Err(ErroreNucleo::DispositivoInAttesa)));
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);
    assert!(!secondo.motore.dispositivo().conosce(&conv));

    let _carla = telefono(&istanza, "carla").await;
    let nuova = secondo
        .motore
        .crea_diretta(persona("carla"))
        .await
        .unwrap()
        .id;
    let esito = secondo.motore.apri_conversazione(nuova.clone()).await;
    assert!(matches!(esito, Err(ErroreNucleo::DispositivoInAttesa)));
    assert!(istanza.depositati(&nuova).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn il_telefono_approvato_entra_legge_e_alla_revoca_esce_con_la_catena_che_ruota() {
    let (istanza, anna, bruno, conv) = in_due().await;
    anna.scrive(&conv, "prima del secondo telefono").await;
    let secondo = telefono(&istanza, "anna").await;

    // Finché aspetta, il primo dispositivo non lo fa entrare.
    anna.motore.allinea_i_miei_dispositivi(&conv).await.unwrap();
    assert_eq!(anna.epoch(&conv), 1);

    istanza.approva(secondo.vista.dispositivo());
    anna.motore.allinea_i_miei_dispositivi(&conv).await.unwrap();
    assert_eq!(anna.epoch(&conv), 2);
    assert_eq!(anna.membri_nell_albero(&conv), ["anna", "anna", "bruno"]);

    assert_eq!(secondo.aggiorna(&conv).await.apertura, Apertura::Pronta);
    let letti = secondo.motore.cronologia(conv.clone(), None).await.unwrap();
    assert_eq!(
        letti.messaggi[0].testo.as_deref(),
        Some("prima del secondo telefono")
    );
    // È la stessa persona: ciò che ha scritto dall'altro telefono è suo.
    assert!(letti.messaggi[0].mio);
    bruno.aggiorna(&conv).await;

    // Un dispositivo revocato non decide niente, nemmeno su di sé.
    istanza.revoca(secondo.vista.dispositivo());
    secondo
        .motore
        .allinea_i_miei_dispositivi(&conv)
        .await
        .unwrap();
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1, 2]);

    // Lo toglie un dispositivo che il registro riconosce, e la catena ruota.
    anna.motore.allinea_i_miei_dispositivi(&conv).await.unwrap();
    assert_eq!(anna.epoch(&conv), 3);
    assert_eq!(anna.membri_nell_albero(&conv), ["anna", "bruno"]);
    let dopo = anna.scrive(&conv, "il telefono perso non lo legge").await;
    assert_eq!(
        istanza
            .voci(&conv)
            .iter()
            .find(|v| v.id == dopo.id)
            .unwrap()
            .voce
            .chiave_n,
        2
    );
    let pagina = secondo.motore.cronologia(conv.clone(), None).await.unwrap();
    let stati: Vec<StatoMessaggio> = pagina.messaggi.iter().map(|m| m.stato).collect();
    assert_eq!(stati, [StatoMessaggio::Letto, StatoMessaggio::NonSiApre]);
    assert_eq!(bruno.legge(&conv).await.len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn si_rientra_nel_gruppo_ma_senza_cronologia_finche_nessuno_riavvolge_il_mazzo() {
    let (istanza, anna, bruno, conv) = in_due().await;
    anna.scrive(&conv, "c'era già").await;
    let secondo = telefono(&istanza, "anna").await;
    istanza.approva(secondo.vista.dispositivo());

    // Nessun invito per lui: rientra dal punto di rientro, con una foglia sua.
    assert_eq!(
        secondo
            .motore
            .apri_conversazione(conv.clone())
            .await
            .unwrap(),
        Apertura::Pronta
    );
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1, 2]);
    assert_eq!(secondo.epoch(&conv), 2);

    // Si torna nel gruppo, non ancora nella cronologia: senza catena non si
    // scrive, e il mazzo non si tocca.
    let giro = secondo.aggiorna(&conv).await;
    assert!(giro.senza_cronologia);
    assert_eq!(giro.nuovi[0].stato, StatoMessaggio::NonSiApre);
    assert!(matches!(
        secondo
            .motore
            .invia(conv.clone(), "ci sono".into(), None)
            .await,
        Err(ErroreNucleo::SenzaArchivio)
    ));
    assert_eq!(istanza.mazzo(&conv).unwrap().epoch, 1);
    assert!(istanza.voci(&conv).len() == 1);

    // Quando Bruno applica il rientro e riavvolge, la cronologia torna.
    bruno.aggiorna(&conv).await;
    assert_eq!(istanza.mazzo(&conv).unwrap().epoch, 2);
    assert_eq!(istanza.punto_di_rientro(&conv).unwrap().epoch, 2);
    let giro = secondo.aggiorna(&conv).await;
    assert!(!giro.senza_cronologia);
    assert_eq!(giro.nuovi[0].testo.as_deref(), Some("c'era già"));
    secondo.scrive(&conv, "adesso scrivo").await;
    assert_eq!(bruno.legge(&conv).await.len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn senza_un_punto_di_rientro_non_si_rientra_e_si_aspetta() {
    let istanza = IstanzaFinta::default();
    let anna = telefono(&istanza, "anna").await;
    let bruno = telefono(&istanza, "bruno").await;
    let conv = anna.motore.crea_diretta(persona("bruno")).await.unwrap().id;
    // Bruno non crea: in una chat a due crea chi sta nella casa che ordina.
    istanza.ordinata_altrove(&conv);
    assert!(!bruno.motore.rientra_in(&conv).await.unwrap());
    assert_eq!(bruno.aggiorna(&conv).await.apertura, Apertura::InAttesa);
    assert!(istanza.depositati(&conv).is_empty());
}

/* ---------- un gruppo congelato (ADR 0042 §3) ---------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn un_gruppo_congelato_si_legge_con_cio_che_il_dispositivo_aveva() {
    let (istanza, mut anna, bruno, conv) = in_due().await;
    anna.scrive(&conv, "prima del trasloco").await;
    let ritardatario = telefono(&istanza, "anna").await;
    istanza.approva(ritardatario.vista.dispositivo());
    istanza.congela(&conv);

    // Dopo un riavvio la catena è ancora nello stato: si legge senza chiedere
    // il mazzo a nessuno, e non si scrive.
    anna.riavvia().await;
    let giro = anna.aggiorna(&conv).await;
    assert_eq!(giro.apertura, Apertura::Pronta);
    assert_eq!(giro.nuovi[0].testo.as_deref(), Some("prima del trasloco"));
    assert!(anna
        .motore
        .invia(conv.clone(), "dopo".into(), None)
        .await
        .is_err());
    assert_eq!(bruno.legge(&conv).await.len(), 1);

    // Un dispositivo che nel gruppo non c'era non lo apre, e non prova a entrarci.
    assert_eq!(
        ritardatario.aggiorna(&conv).await.apertura,
        Apertura::InAttesa
    );
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);
}

/* ---------- l'elenco, il sì e la revoca dalla sessione (ADR 0040) ---------- */

/// Un altro telefono della stessa persona, che parte da un deposito vuoto:
/// una chiave nuova, e aspetta il sì.
async fn secondo_telefono(istanza: &IstanzaFinta, nome: &str) -> Telefono {
    let secondo = telefono(istanza, nome).await;
    assert!(!secondo.motore.io().approvato);
    secondo
}

/// La stessa chiave di `chi`, da una sessione nuova: è chi è uscito dalla
/// Casa e ci rientra con il deposito di prima.
async fn rientra_con_la_stessa_chiave(
    istanza: &IstanzaFinta,
    chi: &Telefono,
    nome: &str,
) -> Motore<VistaFinta> {
    Motore::apri(istanza.per(nome), chi.deposito.clone())
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chi_aspetta_e_chi_approva_vedono_lo_stesso_codice_calcolato_qui() {
    let (istanza, anna, _bruno, _conv) = in_due().await;
    let secondo = secondo_telefono(&istanza, "anna").await;

    let elenco = anna.motore.dispositivi().await.unwrap();
    assert_eq!(elenco.len(), 2);
    // Questo per primo, poi chi aspetta.
    assert!(elenco[0].questo);
    assert_eq!(elenco[0].stato, StatoDispositivo::Approvato);
    assert_eq!(elenco[0].id, anna.motore.io().dispositivo);
    assert_eq!(elenco[1].id, secondo.motore.io().dispositivo);
    assert_eq!(elenco[1].stato, StatoDispositivo::InAttesa);
    assert!(!elenco[1].questo);
    // Il codice che chi approva vede è quello che chi aspetta mostra: lo
    // calcolano entrambi dalla chiave, nessuno dei due lo riceve dalla Casa.
    assert_eq!(elenco[1].codice, secondo.motore.io().codice);
    assert_ne!(elenco[1].codice, anna.motore.io().codice);
    assert_eq!(
        elenco[1].etichetta.as_deref(),
        Some(format!("Telefono {}", secondo.vista.dispositivo()).as_str())
    );
    assert!(elenco[1].visto_il.is_some());

    // Chi aspetta vede la stessa riga, dal suo lato.
    let suo = secondo.motore.dispositivi().await.unwrap();
    assert!(suo[0].questo && suo[0].stato == StatoDispositivo::InAttesa);
    assert_eq!(suo[0].codice, secondo.motore.io().codice);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn al_si_il_nuovo_telefono_entra_subito_in_ogni_conversazione_e_legge() {
    let (istanza, anna, bruno, conv) = in_due().await;
    let _carla = telefono(&istanza, "carla").await;
    let altra = anna.motore.crea_diretta(persona("carla")).await.unwrap().id;
    assert_eq!(
        anna.motore.apri_conversazione(altra.clone()).await.unwrap(),
        Apertura::Pronta
    );
    anna.scrive(&conv, "prima del secondo telefono").await;
    let secondo = secondo_telefono(&istanza, "anna").await;

    // Il sì entra nelle conversazioni subito, senza aspettare che qualcuno
    // le guardi: un commit per ciascuna.
    anna.motore
        .approva_dispositivo(secondo.vista.dispositivo().into())
        .await
        .unwrap();
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1, 2]);
    assert_eq!(epoch_dei_commit(&istanza, &altra), [1, 2]);
    assert_eq!(anna.membri_nell_albero(&conv), ["anna", "anna", "bruno"]);
    assert_eq!(anna.membri_nell_albero(&altra), ["anna", "anna", "carla"]);

    // Chi aspettava se ne accorge dall'elenco.
    assert!(!secondo.motore.io().approvato);
    let suo = secondo.motore.dispositivi().await.unwrap();
    assert_eq!(suo[0].stato, StatoDispositivo::Approvato);
    assert!(secondo.motore.io().approvato);

    assert_eq!(secondo.aggiorna(&conv).await.apertura, Apertura::Pronta);
    assert_eq!(
        secondo.legge(&conv).await,
        coppie(&[("anna", "prima del secondo telefono")])
    );
    bruno.aggiorna(&conv).await;
    assert_eq!(bruno.membri_nell_albero(&conv), ["anna", "anna", "bruno"]);
    secondo.scrive(&conv, "dal telefono nuovo").await;
    assert_eq!(
        bruno.legge(&conv).await,
        coppie(&[
            ("anna", "prima del secondo telefono"),
            ("anna", "dal telefono nuovo"),
        ])
    );

    // Al giro dopo non si rifà niente: le foglie sono già d'accordo.
    anna.aggiorna(&conv).await;
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1, 2]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn alla_revoca_il_telefono_esce_da_ogni_conversazione_e_non_legge_il_seguito() {
    let (istanza, anna, bruno, conv) = in_due().await;
    let secondo = secondo_telefono(&istanza, "anna").await;
    anna.motore
        .approva_dispositivo(secondo.vista.dispositivo().into())
        .await
        .unwrap();
    assert_eq!(secondo.aggiorna(&conv).await.apertura, Apertura::Pronta);
    bruno.aggiorna(&conv).await;

    anna.motore
        .revoca_dispositivo(secondo.vista.dispositivo().into())
        .await
        .unwrap();
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1, 2, 3]);
    assert_eq!(anna.membri_nell_albero(&conv), ["anna", "bruno"]);

    let elenco = anna.motore.dispositivi().await.unwrap();
    let revocato = elenco
        .iter()
        .find(|d| d.id == secondo.vista.dispositivo())
        .unwrap();
    assert_eq!(revocato.stato, StatoDispositivo::Revocato);
    // La Casa gli ha chiuso anche la sessione.
    assert_eq!(revocato.etichetta, None);
    assert!(revocato.revocato_il.is_some());
    // L'elenco mette i revocati in fondo.
    assert_eq!(elenco.last().unwrap().id, revocato.id);

    let dopo = anna
        .scrive(&conv, "il telefono revocato non lo legge")
        .await;
    assert_eq!(
        istanza
            .voci(&conv)
            .iter()
            .find(|v| v.id == dopo.id)
            .unwrap()
            .voce
            .chiave_n,
        2
    );
    assert_eq!(secondo.aggiorna(&conv).await.apertura, Apertura::Tolto);
    assert_eq!(
        bruno.legge(&conv).await.last().unwrap().1,
        "il telefono revocato non lo legge"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chi_aspetta_non_dice_si_e_non_dice_no_e_questo_non_si_revoca_da_qui() {
    let (istanza, anna, bruno, conv) = in_due().await;
    let secondo = secondo_telefono(&istanza, "anna").await;

    let esito = secondo
        .motore
        .approva_dispositivo(secondo.vista.dispositivo().into())
        .await;
    assert!(
        matches!(esito, Err(ErroreNucleo::Casa { stato: 403, ref codice }) if codice == "device_not_approved")
    );
    let esito = secondo
        .motore
        .revoca_dispositivo(anna.vista.dispositivo().into())
        .await;
    assert!(matches!(esito, Err(ErroreNucleo::Casa { stato: 403, .. })));
    assert!(!secondo.motore.io().approvato);

    // Un dispositivo d'altri non si nomina: è il 404 che non dice se esiste.
    let esito = anna
        .motore
        .approva_dispositivo(bruno.vista.dispositivo().into())
        .await;
    assert!(matches!(esito, Err(ErroreNucleo::Casa { stato: 404, .. })));

    let esito = anna
        .motore
        .revoca_dispositivo(anna.motore.io().dispositivo)
        .await;
    assert!(matches!(esito, Err(ErroreNucleo::Formato(_))));
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);
    assert!(anna.motore.io().approvato);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn se_il_registro_non_risponde_il_si_vale_e_le_foglie_entrano_al_giro_dopo() {
    let (istanza, anna, _bruno, conv) = in_due().await;
    let secondo = secondo_telefono(&istanza, "anna").await;
    // Il primo giro allinea subito: dopo, l'orologio direbbe di aspettare.
    anna.aggiorna(&conv).await;

    istanza.spegni_il_registro(true);
    anna.motore
        .approva_dispositivo(secondo.vista.dispositivo().into())
        .await
        .unwrap();
    // Niente a metà: nessun commit, lo stato è quello di prima.
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1]);
    assert_eq!(anna.epoch(&conv), 1);

    // L'orologio è ripartito: il giro dopo ci riprova senza aspettare.
    istanza.spegni_il_registro(false);
    anna.aggiorna(&conv).await;
    assert_eq!(epoch_dei_commit(&istanza, &conv), [1, 2]);
    assert_eq!(anna.membri_nell_albero(&conv), ["anna", "anna", "bruno"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chi_rientra_con_la_stessa_chiave_lo_prova_e_non_aspetta_il_si() {
    let (istanza, anna, _bruno, conv) = in_due().await;

    // Un'altra sessione, lo stesso deposito: la chiave è già approvata, e la
    // firma della sfida dice che chi la presenta ha anche la privata.
    let rientrata = rientra_con_la_stessa_chiave(&istanza, &anna, "anna").await;
    assert!(rientrata.io().approvato);
    assert_ne!(rientrata.io().dispositivo, anna.motore.io().dispositivo);
    assert_eq!(rientrata.io().codice, anna.motore.io().codice);
    assert_eq!(istanza.sfide_aperte(), 0);
    assert_eq!(
        rientrata.apri_conversazione(conv.clone()).await.unwrap(),
        Apertura::Pronta
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn senza_la_sfida_o_con_una_chiave_revocata_si_aspetta_il_si() {
    let (istanza, anna, _bruno, _conv) = in_due().await;

    // Una Casa di prima: la chiave va senza prova, e aspetta come le altre.
    istanza.senza_la_sfida(true);
    let senza = rientra_con_la_stessa_chiave(&istanza, &anna, "anna").await;
    assert!(!senza.io().approvato);
    istanza.senza_la_sfida(false);

    // Una chiave che qualcuno ha tolto non rientra ripresentandosi.
    let secondo = secondo_telefono(&istanza, "anna").await;
    anna.motore
        .approva_dispositivo(secondo.vista.dispositivo().into())
        .await
        .unwrap();
    anna.motore
        .revoca_dispositivo(secondo.vista.dispositivo().into())
        .await
        .unwrap();
    let di_nuovo = rientra_con_la_stessa_chiave(&istanza, &secondo, "anna").await;
    assert!(!di_nuovo.io().approvato);
}

/* ---------- gli attrezzi ---------- */

#[test]
fn il_codice_di_un_dispositivo_e_quello_del_web() {
    // I valori di `codiceDi` in `codice-dispositivo.ts`.
    assert_eq!(codice_di("CHIAVE_DI_ANNA"), "9725 1948");
    assert_eq!(codice_di("una chiave qualunque"), "8373 5420");
    assert_eq!(codice_di("chiave-0"), "3502 3636");
    for i in 0..2000 {
        let codice = codice_di(&format!("chiave-{i}"));
        assert_eq!(codice.len(), 9);
        assert!(codice.chars().enumerate().all(|(n, c)| if n == 4 {
            c == ' '
        } else {
            c.is_ascii_digit()
        }));
    }
}

#[test]
fn l_ora_si_scrive_come_to_iso_string() {
    assert_eq!(istante(0, 0), "1970-01-01T00:00:00.000Z");
    assert_eq!(istante(951_782_399, 999), "2000-02-28T23:59:59.999Z");
    assert_eq!(istante(951_782_400, 0), "2000-02-29T00:00:00.000Z");
    assert_eq!(istante(1_795_860_000, 7), "2026-11-28T10:00:00.007Z");
    assert_eq!(istante(4_107_542_399, 1), "2100-02-28T23:59:59.001Z");
    assert_eq!(istante(4_107_542_400, 1), "2100-03-01T00:00:00.001Z");
    assert_eq!(adesso().len(), 24);
}

#[test]
fn un_id_di_messaggio_e_un_uuid_versione_4() {
    let id = nuovo_id().unwrap();
    assert_eq!(id.len(), 36);
    let pezzi: Vec<&str> = id.split('-').collect();
    assert_eq!(
        pezzi.iter().map(|p| p.len()).collect::<Vec<_>>(),
        [8, 4, 4, 4, 12]
    );
    assert!(pezzi[2].starts_with('4'));
    assert!(matches!(pezzi[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'));
    assert_ne!(id, nuovo_id().unwrap());
}

#[test]
fn il_contenuto_ha_la_forma_del_web_e_cio_che_non_la_ha_non_e_testo() {
    // Com'è scritto da `manda` e `annuncia` in `conversazione.ts`.
    let dal_web = leggi_contenuto(r#"{"t":"ciao","v":1,"r":"m-1"}"#).unwrap();
    assert_eq!(dal_web.testo, "ciao");
    assert_eq!(dal_web.risponde.as_deref(), Some("m-1"));
    let evento = leggi_contenuto(r#"{"e":{"chi":"a@b","tipo":"uscita"},"t":"","v":1}"#).unwrap();
    assert_eq!(
        evento.evento,
        Some(Evento {
            tipo: TipoEvento::Uscita,
            chi: "a@b".into()
        })
    );
    // Un evento di un tipo sconosciuto non è un evento, ma il testo resta.
    let ignoto = leggi_contenuto(r#"{"e":{"chi":"a@b","tipo":"altro"},"t":"x","v":1}"#).unwrap();
    assert_eq!(ignoto.evento, None);

    for no in [
        "testo nudo",
        r#"{"t":"ciao","v":2}"#,
        r#"{"t":"ciao"}"#,
        r#"{"t":7,"v":1}"#,
        r#"{"v":1}"#,
        "[]",
    ] {
        assert!(leggi_contenuto(no).is_none(), "{no}");
    }

    // E ciò che il nucleo scrive lo rilegge.
    let scritto = scrivi_contenuto("ciao \"tu\"", Some("m-2"), None);
    let riletto = leggi_contenuto(&scritto).unwrap();
    assert_eq!(riletto.testo, "ciao \"tu\"");
    assert_eq!(riletto.risponde.as_deref(), Some("m-2"));
}

#[test]
fn chi_abita_altrove_porta_la_sua_casa_nell_id() {
    let qui = Autore {
        id: "7f3a".into(),
        username: "anna".into(),
        nome: String::new(),
    };
    let altrove = Autore {
        id: "remote:ab12:bruno".into(),
        username: "bruno".into(),
        nome: String::new(),
    };
    assert_eq!(membro_di(&qui, "casa-mia"), "anna@casa-mia");
    assert_eq!(membro_di(&altrove, "casa-mia"), "bruno@ab12");
}
