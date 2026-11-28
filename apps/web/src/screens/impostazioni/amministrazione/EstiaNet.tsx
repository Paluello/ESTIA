import type { AdminDiagnostics, FederatedInstanceView, FederationView } from "@estia/contracts";
import { useCallback, useEffect, useState } from "react";

import { api } from "../../../api.js";
import { spiega } from "../../../errori.js";
import { t, tc, tf, useT } from "../../../lingua.js";
import { useSignedIn } from "../../../state.js";
import {
  Alert,
  Button,
  Icon,
  ListRow,
  MenuAzioni,
  QrCode,
  TextAreaField,
  TextField,
  type Tone,
  type VoceMenu,
} from "../../../ui/index.js";
import { Sezione } from "../Sezione.js";

import { RelayComunita } from "./RelayComunita.js";
import { ASPETTO, GRUPPI, gruppoDi, principaliDi, secondarieDi, type Azione } from "./gruppi.js";
import { etichettaDi, fraseDi, segnaleDi, type Segnale } from "./raggiungibilita.js";

/**
 * EstiaNet: la rete fra istanze, per chi amministra.
 *
 * **L'ordine della pagina è una decisione, non un accumulo.** Segue quello che
 * si fa, nell'ordine in cui lo si fa: si dà la propria chiave, si prende quella
 * di un altro, e poi si guarda com'è andata. Lo spegnimento sta in fondo, dove
 * stanno le cose che si fanno una volta o mai — prima era in cima, e la prima
 * cosa che si leggeva aprendo la pagina era come disfarla.
 *
 * I titoli non sono più numerati: un «1.» scritto a mano dice che l'ordine è
 * obbligato e si sfalsa da solo appena una scheda sparisce, come succede qui
 * quando la rete è spenta (`DESIGN_SYSTEM.md` §«Come è fatta una pagina di
 * impostazioni»).
 *
 * A rete spenta l'ordine salta e resta una cosa sola: accenderla. Un
 * interruttore in fondo a una pagina di funzioni che non funzionano sarebbe un
 * vicolo cieco (euristica 3), non un ordine coerente.
 *
 * **La lista delle case è una sola scheda** e non quattro: sono lo stesso
 * elenco in momenti diversi della stessa storia, e quattro schede separate
 * facevano sembrare quattro argomenti (euristica 8). Ogni riga dice se quella
 * casa **risponde adesso** — è il battito di ADR 0041, che senza un posto dove
 * mostrarsi resterebbe una cosa che l'istanza fa e nessuno vede.
 *
 * **Ogni riga è una `ListRow`**, la primitiva delle impostazioni, ed è il
 * burger a renderlo possibile: con tre pulsanti in fila la riga non poteva
 * essere quella degli altri nove schermi. Fuori resta la sola azione che ci si
 * aspetta di premere — «Accetta» su una richiesta in arrivo, e «Rifiuta»
 * accanto — perché una decisione che si vede solo aprendo un menu è una
 * decisione che nessuno prende (euristiche 3 e 6). Quale azione va dove sta in
 * `gruppi.ts`, con i suoi test.
 */

function nomeDi(istanza: FederatedInstanceView): string {
  return istanza.declaredName.trim() === "" ? t("estianet.senza_nome") : istanza.declaredName;
}

/** Chiave intera per chi copia, accorciata per chi legge. */
function chiaveBreve(publicKey: string): string {
  return publicKey.length <= 20 ? publicKey : `${publicKey.slice(0, 10)}…${publicKey.slice(-6)}`;
}

const PUNTO: Record<Segnale, string> = {
  "in-ascolto": "attesa",
  "non-osservata": "",
  "non-risponde": "no",
  raggiungibile: "si",
};

/**
 * Il segnale: pallino più parola, mai il pallino da solo.
 *
 * Un colore non si legge a voce e non lo vedono tutti allo stesso modo; la
 * parola accanto è l'informazione, il pallino è la scorciatoia per l'occhio.
 */
function Segnale({ istanza }: { istanza: FederatedInstanceView }): React.ReactElement | null {
  useT();
  const segnale = segnaleDi(istanza);

  if (segnale === "non-osservata") {
    return null;
  }

  return (
    <span className={`segnale segnale--${PUNTO[segnale]}`}>
      <span className={`segnale__punto segnale__punto--${PUNTO[segnale]}`} />
      {etichettaDi(segnale)}
    </span>
  );
}

export function EstiaNet(): React.ReactElement {
  useT();
  const { token } = useSignedIn();
  const [diagnostica, setDiagnostica] = useState<AdminDiagnostics | undefined>();
  const [federazione, setFederazione] = useState<FederationView | undefined>();
  const [chiave, setChiave] = useState("");
  const [messaggio, setMessaggio] = useState<{ testo: string; tono: Tone } | undefined>();
  const [copiati, setCopiati] = useState<Record<string, boolean>>({});
  const [mostraQr, setMostraQr] = useState(false);
  const [lavoro, setLavoro] = useState<{ id: string; detto: string } | undefined>();

  const caricaDiagnostica = useCallback(async () => {
    setDiagnostica(await api.diagnostics(token));
  }, [token]);

  const caricaFederazione = useCallback(async () => {
    setFederazione(await api.federation(token));
  }, [token]);

  useEffect(() => {
    void caricaDiagnostica();
    void caricaFederazione();

    const interval = setInterval(() => {
      void caricaFederazione();
    }, 5000);

    return () => clearInterval(interval);
  }, [caricaDiagnostica, caricaFederazione]);

  const occupato = lavoro !== undefined;
  const etichetta = (id: string, fermo: string, durante: string): string =>
    lavoro?.id === id ? durante : fermo;

  const segnaCopiato = (id: string) => {
    setCopiati((prev) => ({ ...prev, [id]: true }));
    setTimeout(() => {
      setCopiati((prev) => ({ ...prev, [id]: false }));
    }, 2500);
  };

  const copiaNegliAppunti = async (testo: string, id: string) => {
    try {
      await navigator.clipboard.writeText(testo);
      segnaCopiato(id);
      setMessaggio({ testo: t("estianet.copiato"), tono: "ok" });
    } catch {
      setMessaggio({
        testo: t("estianet.copia_fallita"),
        tono: "neutral",
      });
    }
  };

  const accendi = async (modo: "off" | "local" | "internet"): Promise<void> => {
    const id = `accendi:${modo}`;
    setMessaggio(undefined);
    setLavoro({
      detto:
        modo === "off"
          ? t("estianet.spengo_estianet")
          : modo === "local"
            ? t("estianet.accendo_casa")
            : t("estianet.accendo_fuori"),
      id,
    });

    try {
      await api.setNetworkProbe(token, modo);
      await Promise.all([caricaDiagnostica(), caricaFederazione()]);
      setMessaggio({
        testo:
          modo === "off"
            ? t("estianet.spento")
            : modo === "local"
              ? t("estianet.acceso_casa")
              : t("estianet.acceso_fuori"),
        tono: "ok",
      });
    } catch (causa) {
      setMessaggio({
        testo: spiega(
          causa,
          modo === "off" ? t("estianet.spegni_fallito") : t("estianet.accendi_fallito"),
        ),
        tono: "error",
      });
    } finally {
      setLavoro(undefined);
    }
  };

  const agisci = async (
    id: string,
    durante: string,
    azione: () => Promise<FederationView>,
    messaggioSuccesso?: string,
  ): Promise<void> => {
    setMessaggio(undefined);
    setLavoro({ detto: durante, id });

    try {
      const nuovaFederazione = await azione();
      setFederazione(nuovaFederazione);
      if (messaggioSuccesso !== undefined) {
        setMessaggio({ testo: messaggioSuccesso, tono: "ok" });
      }
    } catch (causa) {
      setMessaggio({
        testo: spiega(causa, t("estianet.operazione_fallita")),
        tono: "error",
      });
    } finally {
      setLavoro(undefined);
    }
  };

  const eseguiPing = async (publicKey: string): Promise<void> => {
    const id = `ping:${publicKey}`;
    setMessaggio(undefined);
    setLavoro({ detto: t("estianet.provo"), id });

    try {
      const ping = await api.pingInstance(token, publicKey);
      await caricaFederazione();
      setMessaggio({
        testo: tf(ping.detailFrasi, ping.detail),
        tono: ping.reached ? "ok" : "error",
      });
    } catch (causa) {
      setMessaggio({
        testo: spiega(causa, t("estianet.verifica_fallita")),
        tono: "error",
      });
    } finally {
      setLavoro(undefined);
    }
  };

  const chiediCollegamento = async (): Promise<void> => {
    const pulita = chiave.trim();
    if (pulita === "") return;

    if (diagnostica?.network.endpointId === pulita) {
      setMessaggio({
        testo: t("estianet.chiave_propria"),
        tono: "error",
      });
      return;
    }

    setMessaggio(undefined);
    setLavoro({
      detto: t("estianet.chiedendo"),
      id: "chiedi",
    });

    try {
      const nuovaFederazione = await api.connectInstance(token, pulita);
      setFederazione(nuovaFederazione);
      setChiave("");

      const record = nuovaFederazione.instances.find((r) => r.publicKey === pulita);
      if (record?.state === "collegata") {
        setMessaggio({
          testo: t("estianet.collegate"),
          tono: "ok",
        });
      } else if (record?.lastSeenAt !== null && record?.lastSeenAt !== undefined) {
        setMessaggio({
          testo: t("estianet.recapitata"),
          tono: "ok",
        });
      } else {
        setMessaggio({
          testo: t("estianet.salvata"),
          tono: "neutral",
        });
      }
    } catch (causa) {
      setMessaggio({
        testo: spiega(causa, t("estianet.chiedi_fallito")),
        tono: "error",
      });
    } finally {
      setLavoro(undefined);
    }
  };

  const rete = diagnostica?.network;
  const accesa = rete?.state === "ready";

  /**
   * Le voci del burger di una casa, dal catalogo di `gruppi.ts`.
   *
   * Il catalogo dice **quali** azioni valgono per quello stato e quali chiedono
   * conferma; qui si dice che cosa fanno e come si chiamano. Le due cose stanno
   * separate perché la prima si può provare senza un browser, e la seconda no.
   */
  const catalogoDi = (istanza: FederatedInstanceView): Record<Azione, VoceMenu> => {
    const gruppo = gruppoDi(istanza);
    const nome = nomeDi(istanza);

    const catalogo: Record<Azione, VoceMenu> = {
      accetta: {
        id: "accetta",
        onClick: () =>
          void agisci(
            `accetta:${istanza.publicKey}`,
            t("estianet.accetto_collegamento"),
            () => api.acceptInstance(token, istanza.publicKey),
            t("estianet.accettato"),
          ),
        title: t("presenza.accetta"),
      },
      blocca: {
        conferma: {
          etichetta: t("estianet.si_blocca"),
          testo: t("estianet.blocca.testo"),
          titolo: t("estianet.blocca.titolo", { nome }),
        },
        icon: "shield",
        id: "blocca",
        onClick: () =>
          void agisci(
            `blocca:${istanza.publicKey}`,
            t("estianet.blocco"),
            () => api.blockInstance(token, istanza.publicKey),
            t("estianet.bloccata"),
          ),
        title: t("estianet.blocca"),
        tono: "danger",
      },
      copia: {
        icon: "key",
        id: "copia",
        note: t("estianet.copia.nota"),
        onClick: () => void copiaNegliAppunti(istanza.publicKey, istanza.publicKey),
        title: t("estianet.copia"),
      },
      /*
       * «Dimentica» toglie la casa dall'elenco davvero: lato istanza è
       * `remotes.remove`. Prima, sulla riga di una bloccata, si chiamava «Togli
       * il blocco» e diceva «Blocco rimosso» — cioè prometteva un ritorno allo
       * stato di prima che non avviene. Qui la parola dice quello che succede.
       */
      dimentica: {
        conferma: {
          etichetta: t("estianet.si_dimentica"),
          testo:
            gruppo === "collegata"
              ? t("estianet.dimentica.collegata")
              : gruppo === "bloccata"
                ? t("estianet.dimentica.bloccata")
                : t("estianet.dimentica.richiesta"),
          titolo:
            gruppo === "in-attesa"
              ? t("estianet.dimentica.richiesta.titolo")
              : t("estianet.dimentica.titolo", { nome }),
        },
        id: "dimentica",
        onClick: () =>
          void agisci(
            `dimentica:${istanza.publicKey}`,
            t("estianet.dimentico"),
            () => api.forgetInstance(token, istanza.publicKey),
            t("estianet.dimenticata"),
          ),
        title:
          gruppo === "in-attesa" ? t("estianet.dimentica_richiesta") : t("estianet.dimentica_casa"),
        tono: "danger",
      },
      rifiuta: {
        id: "rifiuta",
        onClick: () =>
          void agisci(
            `rifiuta:${istanza.publicKey}`,
            t("inviti.rifiuto_richiesta"),
            () => api.forgetInstance(token, istanza.publicKey),
            t("presenza.richiesta_rifiutata"),
          ),
        title: t("presenza.rifiuta"),
        tono: "danger",
      },
      rimanda: {
        icon: "send",
        id: "rimanda",
        note: t("estianet.rimanda.nota"),
        onClick: () =>
          void agisci(
            `di-nuovo:${istanza.publicKey}`,
            t("estianet.rimando"),
            () => api.connectInstance(token, istanza.publicKey),
            t("estianet.rimandata"),
          ),
        title: t("estianet.rimanda"),
      },
      verifica: {
        icon: "check",
        id: "verifica",
        note: t("estianet.verifica.nota"),
        onClick: () => void eseguiPing(istanza.publicKey),
        title: t("estianet.verifica"),
      },
    };

    return catalogo;
  };

  const RigaCasa = (istanza: FederatedInstanceView): React.ReactElement => {
    const gruppo = gruppoDi(istanza);
    const catalogo = catalogoDi(istanza);

    return (
      <ListRow
        end={
          <>
            {principaliDi(gruppo).map((azione) => (
              <Button
                disabled={occupato}
                key={azione}
                onClick={catalogo[azione].onClick}
                variant={catalogo[azione].tono === "danger" ? "secondary" : "primary"}
              >
                {etichetta(
                  `${azione === "accetta" ? "accetta" : "rifiuta"}:${istanza.publicKey}`,
                  catalogo[azione].title,
                  azione === "accetta" ? t("presenza.accetto") : t("presenza.rifiuto"),
                )}
              </Button>
            ))}
            <MenuAzioni
              etichetta={t("estianet.azioni_su", { nome: nomeDi(istanza) })}
              occupato={occupato}
              titolo={nomeDi(istanza)}
              voci={secondarieDi(gruppo).map((azione) => catalogo[azione])}
            />
          </>
        }
        key={istanza.publicKey}
        note={
          <span className="riga-segnale">
            <Segnale istanza={istanza} />
            <span>{fraseDi(istanza)}</span>
            <code title={istanza.publicKey}>{chiaveBreve(istanza.publicKey)}</code>
          </span>
        }
        title={nomeDi(istanza)}
      />
    );
  };

  return (
    <Sezione
      avviso={messaggio}
      caricamento={diagnostica === undefined || federazione === undefined}
      chiave="estianet"
      lavoro={lavoro?.detto}
      scopo={t("estianet.scopo")}
    >
      {rete !== undefined && federazione !== undefined && (
        <>
          {/*
            A rete spenta c'è una cosa sola da fare, e sta in cima: qui l'ordine
            della pagina non vale, perché niente sotto funzionerebbe, e un
            interruttore in fondo a funzioni morte è un vicolo cieco.
          */}
          {!accesa && (
            <div className="card">
              <h2 className="gruppo">{t("estianet.accendi.titolo")}</h2>
              <p className="muted">{tf(rete.detailFrasi, rete.detail)}</p>

              {rete.editable ? (
                <>
                  <div className="cluster">
                    <Button
                      aria-busy={lavoro?.id === "accendi:local"}
                      disabled={occupato}
                      onClick={() => void accendi("local")}
                    >
                      {etichetta(
                        "accendi:local",
                        t("estianet.accendi_casa"),
                        t("estianet.accendo"),
                      )}
                    </Button>
                    <Button
                      aria-busy={lavoro?.id === "accendi:internet"}
                      disabled={occupato}
                      onClick={() => void accendi("internet")}
                      variant="secondary"
                    >
                      {etichetta(
                        "accendi:internet",
                        t("estianet.accendi_fuori"),
                        t("estianet.accendo"),
                      )}
                    </Button>
                  </div>
                  <p className="muted">{t("estianet.modi.spiegazione")}</p>
                </>
              ) : (
                <p className="muted">
                  {tc("estianet.da_ambiente", { variabile: <code>ESTIA_NETWORK_PROBE</code> })}
                </p>
              )}
            </div>
          )}

          {accesa && (
            <div className="card">
              <h2 className="gruppo">{t("estianet.tua_chiave")}</h2>
              <p className="muted">
                {tc("estianet.chiave.testo", {
                  mai: <strong>{t("estianet.chiave.mai")}</strong>,
                })}
              </p>
              <div className="cluster chiave-propria">
                <code className="secret">{rete.endpointId ?? ""}</code>
                {rete.endpointId !== undefined && rete.endpointId !== "" && (
                  <>
                    <Button
                      onClick={() =>
                        void copiaNegliAppunti(rete.endpointId ?? "", "chiave_propria")
                      }
                      variant="secondary"
                    >
                      {copiati["chiave_propria"]
                        ? t("estianet.copiata")
                        : t("estianet.copia_chiave")}
                    </Button>
                    <Button onClick={() => setMostraQr(!mostraQr)} variant="secondary">
                      {mostraQr ? t("estianet.nascondi_qr") : t("estianet.mostra_qr")}
                    </Button>
                  </>
                )}
              </div>

              {mostraQr && rete.endpointId !== undefined && rete.endpointId !== "" && (
                <div className="qr-riquadro">
                  <QrCode
                    size={220}
                    title={t("estianet.qr.titolo")}
                    value={rete.reachableByKey ? (rete.endpointId ?? "") : (rete.ticket ?? "")}
                  />
                  <p className="muted qr-riquadro__nota">{t("estianet.qr.nota")}</p>
                </div>
              )}

              {rete.reachableByKey !== true && (
                <>
                  <p className="muted">
                    {tc("estianet.ticket.testo", { modo: <code>local</code> })}
                  </p>
                  <TextAreaField
                    label={t("estianet.ticket.etichetta")}
                    readOnly
                    rows={2}
                    value={rete.ticket ?? ""}
                  />
                  {rete.ticket !== undefined && rete.ticket !== "" && (
                    <Button
                      onClick={() => void copiaNegliAppunti(rete.ticket ?? "", "ticket_proprio")}
                      variant="secondary"
                    >
                      {copiati["ticket_proprio"]
                        ? t("estianet.ticket.copiato")
                        : t("estianet.ticket.copia")}
                    </Button>
                  )}
                </>
              )}
            </div>
          )}

          {accesa && (
            <div className="card">
              <h2 className="gruppo">{t("estianet.collega.titolo")}</h2>
              <p className="muted">
                {tc(
                  federazione.reachableByKey
                    ? "estianet.collega.testo_chiave"
                    : "estianet.collega.testo_codice",
                  { anche: <strong>{t("estianet.collega.anche")}</strong> },
                )}
              </p>

              {!federazione.reachableByKey && <Alert>{t("estianet.collega.locale")}</Alert>}

              <TextField
                label={
                  federazione.reachableByKey
                    ? t("estianet.altra.chiave")
                    : t("estianet.altra.codice")
                }
                onChange={(event) => setChiave(event.target.value)}
                placeholder={t("estianet.altra.esempio")}
                value={chiave}
              />

              <Button
                aria-busy={lavoro?.id === "chiedi"}
                disabled={occupato || chiave.trim() === ""}
                onClick={() => void chiediCollegamento()}
              >
                {etichetta("chiedi", t("estianet.chiedi"), t("estianet.sto_chiedendo"))}
              </Button>
            </div>
          )}

          {accesa && (
            <div className="card card--flush">
              <h2 className="gruppo">{t("estianet.le_case")}</h2>
              <p className="empty-inline muted">
                {tc("estianet.case.testo", {
                  ogni: <strong>{t("estianet.case.ogni")}</strong>,
                })}
              </p>

              {GRUPPI.map((gruppo) => {
                const case_ = federazione.instances.filter(
                  (istanza) => gruppoDi(istanza) === gruppo,
                );

                if (case_.length === 0 && gruppo !== "collegata") {
                  return null;
                }

                const aspetto = ASPETTO[gruppo];

                return (
                  <div key={gruppo}>
                    <h3
                      className={`gruppo gruppo--casa${aspetto.tinta === "" ? "" : ` gruppo--casa-${aspetto.tinta}`}`}
                    >
                      <Icon name={aspetto.icona} size={18} />
                      {aspetto.titolo}
                    </h3>

                    {case_.length === 0 ? (
                      <p className="empty-inline">{t("estianet.case.nessuna")}</p>
                    ) : (
                      case_.map((istanza) => RigaCasa(istanza))
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/*
            I relay della comunità servono solo dove la Casa si fa trovare da
            fuori: su «local» non si usano relay (ADR 0045 §2).
          */}
          {accesa && rete.mode === "internet" && <RelayComunita token={token} />}

          {/*
            In fondo, dove stanno le cose che si fanno una volta o mai: la prima
            cosa che si legge aprendo la pagina non deve essere come disfarla.
          */}
          {accesa && (
            <div className="card card--grave">
              <h2 className="gruppo">{t("estianet.spegni")}</h2>
              {rete.editable ? (
                <>
                  <p className="muted">{t("estianet.spegni.testo")}</p>
                  <Button
                    aria-busy={lavoro?.id === "accendi:off"}
                    disabled={occupato}
                    onClick={() => void accendi("off")}
                    variant="danger"
                  >
                    {etichetta("accendi:off", t("estianet.spegni"), t("estianet.spengo"))}
                  </Button>
                </>
              ) : (
                <p className="muted">
                  {tc("estianet.da_ambiente", { variabile: <code>ESTIA_NETWORK_PROBE</code> })}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Sezione>
  );
}
