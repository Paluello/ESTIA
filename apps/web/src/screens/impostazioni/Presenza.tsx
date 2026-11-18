import type { FollowsView, Presence, ProfileView } from "@estia/contracts";
import type { Chiave } from "@estia/lingue";
import { useCallback, useEffect, useState } from "react";

import { api } from "../../api.js";
import { spiega } from "../../errori.js";
import { t, useT } from "../../lingua.js";
import { useSignedIn } from "../../state.js";
import { Alert, Button, Choice, Live, SegmentedControl } from "../../ui/index.js";
import { Sezione } from "./Sezione.js";

/**
 * Privacy della persona: due pannelli e un interruttore di rete.
 *
 * Il toggle Istanza/Rete **non** decide se sei fuori casa: serve solo a
 * mostrare le impostazioni di quel contesto. Privato/pubblico **non** parla
 * della ricerca — in EstiaNet (e in istanza) si è cercabili comunque. Decide
 * che cosa vede chi apre il tuo profilo dalla lista: la richiesta di follow,
 * oppure i tuoi post.
 *
 * - Istanza → `openFollows` (chiuso = privato, aperto = pubblico)
 * - Rete → `presente_privato` / `presente_pubblico` (se sei su EstiaNet;
 *   altrimenti resta una preferenza finché non entri)
 * - EstiaNet → `non_presente` oppure la preferenza di rete
 */

type Pannello = "istanza" | "rete";
type ReteVisibilita = "privato" | "pubblico";

const PANNELLI = [
  {
    icon: "instance" as const,
    get label(): string {
      return t("modo.istanza");
    },
    value: "istanza" as const,
  },
  {
    icon: "globe" as const,
    get label(): string {
      return t("modo.rete");
    },
    value: "rete" as const,
  },
];

function inEstiaNet(presence: Presence): boolean {
  return presence !== "non_presente";
}

function reteDi(presence: Presence): ReteVisibilita {
  return presence === "presente_pubblico" ? "pubblico" : "privato";
}

function presenzaRete(rete: ReteVisibilita): Presence {
  return rete === "pubblico" ? "presente_pubblico" : "presente_privato";
}

/** Che cosa sta succedendo, per gli interruttori che ne hanno uno solo. */
const DETTO: Readonly<Record<string, Chiave>> = {
  "estianet:entra": "presenza.entro_estianet",
  "estianet:esci": "presenza.esco_estianet",
  "istanza:privato": "presenza.istanza_privato_in_corso",
  "istanza:pubblico": "presenza.istanza_pubblico_in_corso",
  "rete:privato": "presenza.rete_privato_in_corso",
  "rete:pubblico": "presenza.rete_pubblico_in_corso",
};

function dettoDi(lavoro: string): string | undefined {
  const chiave = DETTO[lavoro];
  return chiave === undefined ? undefined : t(chiave);
}

/** E per i gesti sulle righe, dove l'id porta con sé quale riga. */
function dettoPerRiga(lavoro: string): string | undefined {
  const azione = lavoro.split(":")[0];

  switch (azione) {
    case "accetta":
      return t("presenza.accetto");
    case "rifiuta":
      return t("presenza.rifiuto");
    case "smetti":
      return t("presenza.smetto_di_seguire");
    case "controlla":
      return t("comune.controllo");
    default:
      return undefined;
  }
}

export function Presenza(): React.ReactElement {
  useT();
  const { token } = useSignedIn();
  const [profilo, setProfilo] = useState<ProfileView | undefined>();
  const [follows, setFollows] = useState<FollowsView | undefined>();
  const [errore, setErrore] = useState<string | undefined>();
  /** Com’è andata, quando è andata bene: la riga che sparisce non lo dice a chi ascolta. */
  const [esito, setEsito] = useState<string | undefined>();
  const [lavoro, setLavoro] = useState<string | undefined>();
  /** Solo visuale: quale blocco di impostazioni stai guardando. */
  const [pannello, setPannello] = useState<Pannello>("istanza");
  /**
   * Preferenza di rete quando sei fuori da EstiaNet (lo schema tiene un solo
   * `non_presente`, e non ricorda se eri privato o pubblico).
   */
  const [retePreferita, setRetePreferita] = useState<ReteVisibilita>("privato");

  const carica = useCallback(async () => {
    const [mio, relazioni] = await Promise.all([api.profile(token), api.follows(token)]);

    setProfilo(mio);
    setFollows(relazioni);

    if (inEstiaNet(mio.presence)) {
      setRetePreferita(reteDi(mio.presence));
    }
  }, [token]);

  useEffect(() => {
    void carica();
  }, [carica]);

  if (profilo === undefined) {
    return (
      <Sezione titolo={t("sezioni.presenza")}>
        <p className="muted">{t("comune.carico")}</p>
      </Sezione>
    );
  }

  const salva = async (
    cambio: Partial<Pick<ProfileView, "presence" | "openFollows">>,
    id: string,
  ): Promise<void> => {
    setErrore(undefined);
    setEsito(undefined);
    setLavoro(id);
    setProfilo({
      ...profilo,
      openFollows: cambio.openFollows ?? profilo.openFollows,
      presence: cambio.presence ?? profilo.presence,
    });

    try {
      setProfilo(
        await api.updateProfile(token, {
          bio: profilo.bio,
          openFollows: cambio.openFollows ?? profilo.openFollows,
          presence: cambio.presence ?? profilo.presence,
        }),
      );
    } catch (causa) {
      setErrore(spiega(causa, t("aspetto.errore")));
      await carica();
    } finally {
      setLavoro(undefined);
    }
  };

  /**
   * Accetta, Rifiuta, Smetti: gesti brevi che passano comunque dalla rete.
   *
   * Il `try` non è una formalità — senza, un rifiuto che fallisce non lascia
   * niente sullo schermo e finisce in una promise non gestita (euristica 1 e 9).
   */
  const decidi = async (id: string, azione: () => Promise<void>, detto: string): Promise<void> => {
    setErrore(undefined);
    setEsito(undefined);
    setLavoro(id);

    try {
      await azione();
      await carica();
      setEsito(detto);
    } catch (causa) {
      setErrore(spiega(causa, t("comune.non_ha_funzionato")));
    } finally {
      setLavoro(undefined);
    }
  };

  /**
   * Richiedere, che è il modo di scoprire una risposta già data.
   *
   * Fuori casa chi accetta non spedisce niente a nessuno (ADR 0022): la metà
   * di chi ha chiesto resta «in attesa» finché non richiede. Non si duplica
   * niente — la riga che c'è viene riusata — e resta un gesto, mai un ciclo:
   * un rifiuto non lascia traccia, quindi un richiamo automatico farebbe
   * rinascere per sempre una richiesta che qualcuno ha respinto.
   */
  const controlla = async (row: {
    id: string;
    instanceKey: string;
    username: string;
  }): Promise<void> => {
    setErrore(undefined);
    setEsito(undefined);
    setLavoro(`controlla:${row.id}`);

    try {
      await api.follow(token, { instanceKey: row.instanceKey, username: row.username });
      await carica();
      setEsito(t("presenza.controllato"));
    } catch (causa) {
      setErrore(spiega(causa, t("presenza.controllo_fallito")));
    } finally {
      setLavoro(undefined);
    }
  };

  const inAttesa = follows?.followers.filter((row) => row.state === "in_attesa") ?? [];
  const suEstiaNet = inEstiaNet(profilo.presence);
  const rete = suEstiaNet ? reteDi(profilo.presence) : retePreferita;
  const occupato = lavoro !== undefined;
  const durante = lavoro === undefined ? undefined : (dettoDi(lavoro) ?? dettoPerRiga(lavoro));

  const scegliRete = (prossima: ReteVisibilita): void => {
    if (prossima === rete || occupato) {
      return;
    }

    setRetePreferita(prossima);

    if (!suEstiaNet) {
      return;
    }

    void salva({ presence: presenzaRete(prossima) }, `rete:${prossima}`);
  };

  const entraEstiaNet = (): void => {
    if (suEstiaNet || occupato) {
      return;
    }

    void salva({ presence: presenzaRete(retePreferita) }, "estianet:entra");
  };

  const esciEstiaNet = (): void => {
    if (!suEstiaNet || occupato) {
      return;
    }

    setRetePreferita(reteDi(profilo.presence));
    void salva({ presence: "non_presente" }, "estianet:esci");
  };

  return (
    <Sezione titolo={t("sezioni.presenza")}>
      {errore !== undefined && <Alert tone="error">{errore}</Alert>}
      <Live>{durante ?? esito ?? ""}</Live>

      {inAttesa.length > 0 && (
        <div className="card card--flush">
          <h2 className="gruppo">{t("presenza.vogliono_seguirti")}</h2>
          {inAttesa.map((row) => (
            <div className="row" key={row.id}>
              <span className="row__body">
                <span className="row__title">@{row.username}</span>
                <span className="row__note">
                  {row.instanceKey === "locale"
                    ? t("presenza.da_questa_istanza")
                    : t("presenza.da_altra_istanza", { chiave: row.instanceKey.slice(0, 16) })}
                </span>
              </span>
              <span className="row__end">
                <Button
                  disabled={occupato}
                  onClick={() =>
                    void decidi(
                      `accetta:${row.id}`,
                      () => api.acceptFollower(token, row.id),
                      t("presenza.ora_ti_segue", { nome: row.username }),
                    )
                  }
                >
                  {lavoro === `accetta:${row.id}` ? t("presenza.accetto") : t("presenza.accetta")}
                </Button>
                <Button
                  disabled={occupato}
                  onClick={() =>
                    void decidi(
                      `rifiuta:${row.id}`,
                      () => api.removeFollower(token, row.id),
                      t("presenza.richiesta_rifiutata"),
                    )
                  }
                  variant="secondary"
                >
                  {lavoro === `rifiuta:${row.id}` ? t("presenza.rifiuto") : t("presenza.rifiuta")}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>{t("presenza.il_tuo_profilo")}</h2>
        <SegmentedControl
          label={t("presenza.quali_impostazioni")}
          onChange={setPannello}
          options={PANNELLI}
          value={pannello}
        />

        {pannello === "istanza" ? (
          <>
            <p className="muted">{t("presenza.istanza.intro")}</p>
            <Choice
              checked={!profilo.openFollows}
              disabled={occupato}
              name="istanza-profilo"
              note={t("presenza.privato.nota")}
              onChoose={() => void salva({ openFollows: false }, "istanza:privato")}
              title={
                lavoro === "istanza:privato"
                  ? t("presenza.privato.in_corso")
                  : t("presenza.privato")
              }
            />
            <Choice
              checked={profilo.openFollows}
              disabled={occupato}
              name="istanza-profilo"
              note={t("presenza.istanza.pubblico.nota")}
              onChoose={() => void salva({ openFollows: true }, "istanza:pubblico")}
              title={
                lavoro === "istanza:pubblico"
                  ? t("presenza.pubblico.in_corso")
                  : t("presenza.pubblico")
              }
            />
          </>
        ) : (
          <>
            <p className="muted">
              {t("presenza.rete.intro")}
              {!suEstiaNet && t("presenza.rete.solo_preferenza")}
            </p>
            <Choice
              checked={rete === "privato"}
              disabled={occupato}
              name="rete-profilo"
              note={t("presenza.privato.nota")}
              onChoose={() => scegliRete("privato")}
              title={
                lavoro === "rete:privato" ? t("presenza.privato.in_corso") : t("presenza.privato")
              }
            />
            <Choice
              checked={rete === "pubblico"}
              disabled={occupato}
              name="rete-profilo"
              note={t("presenza.rete.pubblico.nota")}
              onChoose={() => scegliRete("pubblico")}
              title={
                lavoro === "rete:pubblico"
                  ? t("presenza.pubblico.in_corso")
                  : t("presenza.pubblico")
              }
            />
          </>
        )}
      </div>

      <div aria-busy={lavoro?.startsWith("estianet:") || undefined} className="card">
        <h2>EstiaNet</h2>
        <p className="muted">
          {suEstiaNet ? t("presenza.estianet.dentro") : t("presenza.estianet.fuori")}
        </p>
        {suEstiaNet ? (
          <Button
            aria-busy={lavoro === "estianet:esci" || undefined}
            disabled={occupato}
            onClick={esciEstiaNet}
            variant="secondary"
          >
            {lavoro === "estianet:esci" ? t("presenza.esco_estianet") : t("presenza.esci_estianet")}
          </Button>
        ) : (
          <Button
            aria-busy={lavoro === "estianet:entra" || undefined}
            disabled={occupato}
            onClick={entraEstiaNet}
          >
            {lavoro === "estianet:entra"
              ? t("presenza.entro_estianet")
              : t("presenza.entra_estianet")}
          </Button>
        )}
      </div>

      <div className="card card--flush">
        <h2 className="gruppo">{t("presenza.chi_segui")}</h2>
        {follows === undefined || follows.following.length === 0 ? (
          <p className="empty-inline">{t("presenza.nessuno")}</p>
        ) : (
          follows.following.map((row) => (
            <div className="row" key={row.id}>
              <span className="row__body">
                <span className="row__title">@{row.username}</span>
                <span className="row__note">
                  {row.instanceKey === "locale" ? t("presenza.su_questa") : t("presenza.su_altra")}
                  {row.state === "in_attesa" ? t("presenza.richiesta_in_attesa") : ""}
                  {row.state === "accettato" && !row.leggibile ? t("presenza.manca_prova") : ""}
                </span>
              </span>
              <span className="row__end">
                {(row.state === "in_attesa" || !row.leggibile) && (
                  <Button
                    disabled={occupato}
                    onClick={() => void controlla(row)}
                    variant="secondary"
                  >
                    {lavoro === `controlla:${row.id}`
                      ? t("comune.controllo")
                      : t("presenza.controlla")}
                  </Button>
                )}
                <Button
                  disabled={occupato}
                  onClick={() =>
                    void decidi(
                      `smetti:${row.id}`,
                      () => api.unfollow(token, row.id),
                      t("presenza.non_segui_piu", { nome: row.username }),
                    )
                  }
                  variant="secondary"
                >
                  {lavoro === `smetti:${row.id}` ? t("presenza.smetto") : t("presenza.smetti")}
                </Button>
              </span>
            </div>
          ))
        )}
      </div>
    </Sezione>
  );
}
