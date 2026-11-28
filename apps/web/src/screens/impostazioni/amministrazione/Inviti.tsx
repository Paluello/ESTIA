import type { InviteView, JoinRequestView } from "@estia/contracts";
import { useCallback, useEffect, useState } from "react";

import { api } from "../../../api.js";
import { InviteLink } from "../../../components/InviteLink.js";
import { spiega } from "../../../errori.js";
import { t, useT } from "../../../lingua.js";
import { useSignedIn } from "../../../state.js";
import { Alert, Avatar, Badge, Button, Choice, Live, TextField } from "../../../ui/index.js";
import { Sezione } from "../Sezione.js";
import { quandoMedio as quando } from "../../../tempo.js";

function nomeDi(richiesta: JoinRequestView): string {
  return richiesta.displayName === "" ? richiesta.username : richiesta.displayName;
}

/**
 * Gli inviti, e la porta che aprono.
 *
 * Erano due sezioni — «Inviti» e «Chi entra» — e la separazione faceva pagare
 * a chi amministra il costo di ricordarsi che sono due metà dello stesso
 * lavoro: un invito non fa entrare nessuno da solo (PRODUCT_VISION §5.1),
 * serve sempre che una persona apra la porta. Chi crea un invito lo crea *per
 * far entrare qualcuno*, e la richiesta che ne nasce arrivava in un altro
 * posto, che si scopriva solo sapendo che esisteva.
 *
 * L'ordine della pagina è quello del tempo: chi sta aspettando sta in cima
 * perché è l'unica cosa che vuole una risposta adesso; l'invito nuovo viene
 * dopo; in fondo restano quelli già in giro, che si ritirano da lì. Resta
 * vero il §8 di `DESIGN_SYSTEM.md` — una sezione, un lavoro — perché il lavoro
 * qui è uno solo: far entrare qualcuno.
 */
export function Inviti(): React.ReactElement {
  useT();
  const { refreshInstance, token } = useSignedIn();
  const [inviti, setInviti] = useState<InviteView[]>([]);
  const [richieste, setRichieste] = useState<JoinRequestView[]>([]);
  const [caricato, setCaricato] = useState(false);
  const [etichetta, setEtichetta] = useState("");
  const [riutilizzabile, setRiutilizzabile] = useState(false);
  /** Il codice appena creato: si vede una volta sola, e non sopravvive al gesto dopo. */
  const [appena, setAppena] = useState<
    { code: string; joinUrl: string; qr?: string } | undefined
  >();
  /** Messaggio di esito riuscito, dopo. */
  const [nota, setNota] = useState<string | undefined>();
  /** Tenuto separato da `nota`: un fallimento non deve avere la faccia di un esito. */
  const [errore, setErrore] = useState<string | undefined>();
  /** Che cosa sta facendo adesso, e quale controllo (euristica 1). */
  const [lavoro, setLavoro] = useState<{ id: string; detto: string } | undefined>();

  const carica = useCallback(async () => {
    const [elencoInviti, elencoRichieste] = await Promise.all([
      api.invites(token),
      api.joinRequests(token),
    ]);

    setInviti(elencoInviti.invites);
    setRichieste(elencoRichieste.requests);
    setCaricato(true);
  }, [token]);

  useEffect(() => {
    void carica();
  }, [carica]);

  const occupato = lavoro !== undefined;
  const etichettaDi = (id: string, fermo: string, durante: string): string =>
    lavoro?.id === id ? durante : fermo;

  const agisci = async (
    id: string,
    durante: string,
    azione: () => Promise<unknown>,
    detto?: string,
  ): Promise<void> => {
    setNota(undefined);
    setErrore(undefined);
    // Il link di prima non deve restare a galleggiare sopra un altro gesto:
    // vale per l'invito che l'ha appena prodotto, e per quello soltanto.
    setAppena(undefined);
    setLavoro({ detto: durante, id });

    try {
      await azione();
      await carica();

      if (detto !== undefined) {
        setNota(detto);
      }
    } catch (causa) {
      setErrore(spiega(causa, t("inviti.non_ha_funzionato")));
    } finally {
      setLavoro(undefined);
    }
  };

  const crea = (): Promise<void> =>
    agisci(
      "crea",
      t("inviti.creo_invito"),
      async () => {
        const creato = await api.createInvite(token, {
          label: etichetta,
          ...(riutilizzabile ? { maxUses: 10 } : {}),
        });

        // Mostrato una volta sola: l'istanza ne conserva solo l'impronta.
        setAppena({
          code: creato.code,
          joinUrl: creato.joinUrl,
          ...(creato.qr === undefined ? {} : { qr: creato.qr }),
        });
        setEtichetta("");
      },
      t("inviti.creato"),
    );

  const decidi = (richiesta: JoinRequestView, entra: boolean): Promise<void> =>
    agisci(
      `${entra ? "entra" : "rifiuta"}:${richiesta.id}`,
      entra ? t("inviti.apro_porta") : t("inviti.rifiuto_richiesta"),
      async () => {
        await (entra ? api.approve(token, richiesta.id) : api.reject(token, richiesta.id));
        // Il conteggio delle persone dell'istanza cambia solo quando entra qualcuno.
        await refreshInstance();
      },
      entra ? t("inviti.entrato", { nome: nomeDi(richiesta) }) : t("inviti.rifiutata"),
    );

  if (!caricato) {
    return (
      <Sezione titolo={t("sezioni.inviti")}>
        <p className="muted">{t("comune.carico")}</p>
      </Sezione>
    );
  }

  return (
    <Sezione titolo={t("sezioni.inviti")}>
      {/*
        Lo stato passa da due canali diversi di proposito: `Live` c'è sempre e
        annuncia lavoro ed esito, l'errore lo annuncia il suo `role="alert"`.
        Un `aria-live` sull'`Alert` non funzionerebbe — vedi `Feedback.tsx`.
      */}
      <Live>{lavoro?.detto ?? nota ?? ""}</Live>

      {errore !== undefined && <Alert tone="error">{errore}</Alert>}

      {appena !== undefined && (
        <InviteLink
          code={appena.code}
          joinUrl={appena.joinUrl}
          {...(appena.qr === undefined ? {} : { qr: appena.qr })}
        />
      )}

      {/* Quando c'è un link appena creato l'esito è già quello, e ripeterlo in
          una seconda scatola sarebbe rumore: qui resta la voce di tutti gli
          altri gesti. */}
      {(lavoro !== undefined || (nota !== undefined && appena === undefined)) && (
        <Alert>{lavoro?.detto ?? nota}</Alert>
      )}

      <div className="card card--flush">
        <h2 className="gruppo">
          {t("inviti.chi_ha_chiesto")}{" "}
          {richieste.length > 0 && <Badge tone="on">{richieste.length}</Badge>}
        </h2>
        <p className="empty-inline">
          {richieste.length === 0 ? t("inviti.nessuno_aspetta") : t("inviti.decidi_qui")}
        </p>

        {richieste.map((richiesta) => (
          // `row--stack`: nella colonna stretta del dettaglio i due pulsanti
          // vanno a capo interi, invece di strizzare il nome una parola per riga.
          <div className="row row--stack" key={richiesta.id}>
            <Avatar displayName={richiesta.displayName} size="md" username={richiesta.username} />
            <span className="row__body">
              <span className="row__title">
                {nomeDi(richiesta)} <span className="muted">@{richiesta.username}</span>
              </span>
              {richiesta.message !== "" && <span className="row__note">{richiesta.message}</span>}
              <span className="row__note">
                {t("inviti.ha_chiesto", { quando: quando(richiesta.createdAt) })}
              </span>
            </span>
            <span className="row__end row__end--actions">
              <Button
                aria-busy={lavoro?.id === `entra:${richiesta.id}`}
                disabled={occupato}
                onClick={() => void decidi(richiesta, true)}
              >
                {etichettaDi(`entra:${richiesta.id}`, t("inviti.fai_entrare"), t("inviti.apro"))}
              </Button>
              <Button
                aria-busy={lavoro?.id === `rifiuta:${richiesta.id}`}
                disabled={occupato}
                onClick={() => void decidi(richiesta, false)}
                variant="danger"
              >
                {etichettaDi(
                  `rifiuta:${richiesta.id}`,
                  t("presenza.rifiuta"),
                  t("presenza.rifiuto"),
                )}
              </Button>
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>{t("inviti.nuovo.titolo")}</h2>
        <p className="muted">{t("inviti.nuovo.testo")}</p>

        <TextField
          hint={t("inviti.etichetta.aiuto")}
          label={t("inviti.etichetta")}
          onChange={(event) => setEtichetta(event.target.value)}
          placeholder={t("inviti.etichetta.esempio")}
          value={etichetta}
        />

        <Choice
          checked={riutilizzabile}
          name="riutilizzabile"
          note={t("inviti.riutilizzabile.nota")}
          onChoose={() => setRiutilizzabile(!riutilizzabile)}
          title={t("inviti.riutilizzabile", { n: 10 })}
          type="checkbox"
        />

        <Button aria-busy={lavoro?.id === "crea"} disabled={occupato} onClick={() => void crea()}>
          {etichettaDi("crea", t("inviti.crea"), t("inviti.creo"))}
        </Button>
      </div>

      <div className="card card--flush">
        <h2 className="gruppo">{t("inviti.creati")}</h2>
        {inviti.length === 0 && <p className="empty-inline">{t("inviti.nessuno")}</p>}
        {inviti.map((invito) => (
          <div className="row" key={invito.id}>
            <span className="row__body">
              <span className="row__title">
                {invito.label === "" ? t("inviti.invito") : invito.label}{" "}
                {invito.usable ? (
                  <Badge tone="on">{t("inviti.valido")}</Badge>
                ) : (
                  <Badge>{t("inviti.esaurito")}</Badge>
                )}
              </span>
              <span className="row__note">
                {t("inviti.uso", {
                  usati: invito.usedCount,
                  massimo: invito.maxUses,
                  scade: quando(invito.expiresAt),
                })}
              </span>
            </span>
            <span className="row__end">
              {invito.usable && (
                <Button
                  aria-busy={lavoro?.id === `ritira:${invito.id}`}
                  disabled={occupato}
                  onClick={() =>
                    void agisci(
                      `ritira:${invito.id}`,
                      t("inviti.ritiro_invito"),
                      () => api.revokeInvite(token, invito.id),
                      t("inviti.ritirato"),
                    )
                  }
                  variant="danger"
                >
                  {etichettaDi(`ritira:${invito.id}`, t("inviti.ritira"), t("inviti.ritiro"))}
                </Button>
              )}
            </span>
          </div>
        ))}
      </div>
    </Sezione>
  );
}
