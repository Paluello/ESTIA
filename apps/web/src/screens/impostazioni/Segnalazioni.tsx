import type { ReplicaView, SegnalazioneView } from "@estia/contracts";
import { useCallback, useEffect, useState } from "react";

import { api } from "../../api.js";
import { spiega } from "../../errori.js";
import { t, useT } from "../../lingua.js";
import { useSignedIn } from "../../state.js";
import { Alert, Button, TextAreaField } from "../../ui/index.js";
import { meseEAnno } from "../../tempo.js";

import { Sezione } from "./Sezione.js";

/** Quanto è lunga la replica, come lo dice il servizio. */
const MAX_REPLICA = 1000;

function nomeIstanza(segnalazione: SegnalazioneView): string {
  return segnalazione.nomeIstanza ?? `${segnalazione.istanza.slice(0, 10)}…`;
}

function categoria(segnalazione: SegnalazioneView): string {
  return segnalazione.categoria === "non_autentica"
    ? t("avviso.non_autentica.scelta")
    : t("avviso.non_gradita.scelta");
}

/**
 * Le segnalazioni scritte qui ([ADR 0047] Decisione 1 e 6).
 *
 * Tre cerchi, in quest'ordine: le **proprie**, che chiunque rilegge e ritira;
 * quelle di **tutta la casa**, che vede soltanto chi modera, perché ne
 * risponde; e la **replica** di questa istanza alle segnalazioni su di sé,
 * che scrive chi amministra. Le segnalazioni delle altre case non stanno qui:
 * si visitano sul profilo di chi è di là.
 */
export function Segnalazioni(): React.ReactElement {
  useT();
  const { token, user } = useSignedIn();
  const modera = user.role === "instance_admin" || user.role === "instance_moderator";
  const amministra = user.role === "instance_admin";

  const [mie, setMie] = useState<SegnalazioneView[]>([]);
  const [diQui, setDiQui] = useState<SegnalazioneView[]>([]);
  const [replica, setReplica] = useState<ReplicaView | null>(null);
  const [testo, setTesto] = useState("");
  const [caricato, setCaricato] = useState(false);
  const [lavoro, setLavoro] = useState<string | undefined>();
  const [avviso, setAvviso] = useState<{ testo: string; tono: "error" | "ok" } | undefined>();

  const carica = useCallback(async () => {
    const [proprie, tutte, sua] = await Promise.all([
      api.mieSegnalazioni(token),
      modera ? api.segnalazioniDiQui(token) : Promise.resolve({ segnalazioni: [] }),
      modera ? api.replicaSegnalazioni(token) : Promise.resolve({ replica: null }),
    ]);

    setMie(proprie.segnalazioni);
    setDiQui(tutte.segnalazioni);
    setReplica(sua.replica);
    setTesto(sua.replica?.testo ?? "");
    setCaricato(true);
  }, [modera, token]);

  useEffect(() => {
    void carica();
  }, [carica]);

  const agisci = async (
    durante: string,
    azione: () => Promise<unknown>,
    detto: string,
  ): Promise<void> => {
    setAvviso(undefined);
    setLavoro(durante);

    try {
      await azione();
      await carica();
      setAvviso({ testo: detto, tono: "ok" });
    } catch (causa) {
      setAvviso({ testo: spiega(causa, t("segnalazioni.non_ha_funzionato")), tono: "error" });
    } finally {
      setLavoro(undefined);
    }
  };

  const occupato = lavoro !== undefined;

  return (
    <Sezione
      avviso={avviso}
      caricamento={!caricato}
      chiave="segnalazioni"
      lavoro={lavoro}
      scopo={t("segnalazioni.scopo")}
    >
      <div className="card card--flush">
        <h2 className="gruppo">{t("segnalazioni.tue")}</h2>
        <p className="empty-inline">
          {mie.length === 0 ? t("segnalazioni.nessuna_tua") : t("segnalazioni.tue.spiega")}
        </p>
        {mie.map((segnalazione) => (
          <div className="row row--stack" key={segnalazione.id}>
            <span className="row__body">
              <span className="row__title">
                {nomeIstanza(segnalazione)} · {categoria(segnalazione)}
              </span>
              <span className="row__note">«{segnalazione.motivo}»</span>
              <span className="row__note">{meseEAnno(segnalazione.creataIl)}</span>
            </span>
            <span className="row__end row__end--actions">
              <Button
                disabled={occupato}
                onClick={() =>
                  void agisci(
                    t("segnalazioni.ritiro"),
                    () => api.ritiraSegnalazione(token, segnalazione.id),
                    t("segnalazioni.ritirata"),
                  )
                }
                variant="secondary"
              >
                {t("segnalazioni.ritira")}
              </Button>
            </span>
          </div>
        ))}
      </div>

      {modera && (
        <div className="card card--flush">
          <h2 className="gruppo">{t("segnalazioni.di_qui")}</h2>
          <p className="empty-inline">
            {diQui.length === 0
              ? t("segnalazioni.nessuna_di_qui")
              : t("segnalazioni.di_qui.spiega")}
          </p>
          {diQui.map((segnalazione) => (
            <div className="row row--stack" key={segnalazione.id}>
              <span className="row__body">
                <span className="row__title">
                  {nomeIstanza(segnalazione)} · {categoria(segnalazione)}
                </span>
                <span className="row__note">«{segnalazione.motivo}»</span>
                <span className="row__note">
                  {t("segnalazioni.scritta_da", {
                    chi: segnalazione.autore ?? "",
                    quando: meseEAnno(segnalazione.creataIl),
                  })}
                </span>
              </span>
              <span className="row__end row__end--actions">
                <Button
                  disabled={occupato}
                  onClick={() =>
                    void agisci(
                      t("segnalazioni.ritiro"),
                      () => api.ritiraSegnalazione(token, segnalazione.id),
                      t("segnalazioni.rimossa"),
                    )
                  }
                  variant="secondary"
                >
                  {t("segnalazioni.rimuovi")}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      {modera && (
        <div className="card">
          <h2 className="gruppo">{t("segnalazioni.replica")}</h2>
          <p className="muted">{t("segnalazioni.replica.spiega")}</p>
          {amministra ? (
            <div className="stack">
              <TextAreaField
                hint={t("segnalazioni.replica.aiuto", { max: MAX_REPLICA })}
                label={t("segnalazioni.replica.campo")}
                maxLength={MAX_REPLICA}
                onChange={(evento) => setTesto(evento.target.value)}
                value={testo}
              />
              <div className="cluster">
                <Button
                  disabled={occupato || testo.trim() === ""}
                  onClick={() =>
                    void agisci(
                      t("segnalazioni.salvo"),
                      () => api.scriviReplica(token, testo),
                      t("segnalazioni.replica.salvata"),
                    )
                  }
                >
                  {t("segnalazioni.replica.salva")}
                </Button>
                {replica !== null && (
                  <Button
                    disabled={occupato}
                    onClick={() =>
                      void agisci(
                        t("segnalazioni.salvo"),
                        () => api.togliReplica(token),
                        t("segnalazioni.replica.tolta"),
                      )
                    }
                    variant="quiet"
                  >
                    {t("segnalazioni.replica.togli")}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p>{replica?.testo ?? t("segnalazioni.replica.nessuna")}</p>
          )}
        </div>
      )}

      {!modera && <Alert>{t("segnalazioni.altre_case")}</Alert>}
    </Sezione>
  );
}
