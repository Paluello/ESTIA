import type { AvvisoView, CategoriaSegnalazione, ProvenienzaView } from "@estia/contracts";
import { useCallback, useEffect, useState } from "react";

import { api } from "../api.js";
import { spiega } from "../errori.js";
import { t, useT } from "../lingua.js";
import { useSignedIn } from "../state.js";
import { Alert, Button, Choice, Live, Sheet, TextAreaField } from "../ui/index.js";

/** Quanto è lungo un motivo, come lo dice ADR 0049 Decisione 3. */
const MAX_MOTIVO = 400;

/** «novembre 2026», da `AAAA-MM`: la data sul filo è il mese, e così si legge. */
function meseLeggibile(mese: string, lingua: string): string {
  const [anno, numero] = mese.split("-").map(Number);

  if (anno === undefined || numero === undefined || Number.isNaN(anno) || Number.isNaN(numero)) {
    return mese;
  }

  return new Date(Date.UTC(anno, numero - 1, 15)).toLocaleDateString(lingua, {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });
}

/**
 * Che cosa dicono le istanze collegate di un'altra istanza ([ADR 0047]).
 *
 * **Un avviso, non un verdetto**, e la neutralità sta tutta nella forma:
 *
 * - niente rosso, niente icone di pericolo: la scatola è quella di una nota;
 * - le due categorie hanno **titoli e segni diversi** e non stanno mai sotto
 *   la stessa etichetta, perché «non autentica» afferma un fatto e «non
 *   gradita» è un'opinione;
 * - si dice **da quante istanze** e **tramite quali**, mai quante persone;
 * - la replica sta **accanto**, nello stesso blocco, non in un'altra pagina;
 * - un avviso incompleto lo dice, e così uno che l'admin ha deciso di non
 *   mostrare.
 *
 * Chi guarda può anche segnalare, e prima di farlo legge chi lo vedrà.
 */
export function AvvisoIstanza({
  instanceKey,
  nomeIstanza,
}: {
  instanceKey: string;
  /** Il nome che l'istanza dichiara di sé, se lo si sa. */
  nomeIstanza?: string;
}): React.ReactElement | null {
  const { lingua, tn } = useT();
  const { token, user } = useSignedIn();
  const amministra = user.role === "instance_admin";
  const [avviso, setAvviso] = useState<AvvisoView | undefined>();
  const [errore, setErrore] = useState<string | undefined>();
  const [nota, setNota] = useState<string | undefined>();
  const [segnalando, setSegnalando] = useState(false);
  const [decidendo, setDecidendo] = useState(false);

  const nome =
    nomeIstanza === undefined || nomeIstanza === "" ? t("avviso.quell_istanza") : nomeIstanza;

  const carica = useCallback(async () => {
    try {
      setAvviso(await api.avvisoIstanza(token, instanceKey));
    } catch (causa) {
      setErrore(spiega(causa, t("avviso.non_caricato")));
    }
  }, [instanceKey, token]);

  useEffect(() => {
    void carica();
  }, [carica]);

  if (avviso === undefined) {
    return errore === undefined ? null : (
      <div className="feed-pad">
        <Alert>{errore}</Alert>
      </div>
    );
  }

  const nessuna = avviso.nonAutentica.length === 0 && avviso.nonGradita.length === 0;

  return (
    <section aria-label={t("avviso.titolo")} className="avviso-istanza feed-pad">
      <Live>{nota ?? ""}</Live>

      {avviso.ignorate && !amministra ? (
        <p className="muted">{t("avviso.ignorate")}</p>
      ) : (
        <>
          {avviso.ignorate && <p className="muted">{t("avviso.ignorate_admin")}</p>}

          {nessuna ? (
            avviso.interpellate > 0 && (
              <p className="muted">{tn("avviso.nessuna", avviso.interpellate)}</p>
            )
          ) : (
            <div className="avviso-istanza__blocco">
              <Categoria
                categoria="non_autentica"
                lingua={lingua}
                provenienze={avviso.nonAutentica}
              />
              <Categoria categoria="non_gradita" lingua={lingua} provenienze={avviso.nonGradita} />

              <div className="avviso-istanza__replica">
                <h3 className="avviso-istanza__titolo">{t("avviso.replica_di", { nome })}</h3>
                {avviso.replica.stato === "disponibile" ? (
                  <>
                    <p>{avviso.replica.testo}</p>
                    <p className="muted">{meseLeggibile(avviso.replica.mese ?? "", lingua)}</p>
                  </>
                ) : (
                  <p className="muted">
                    {avviso.replica.stato === "assente"
                      ? t("avviso.replica_assente")
                      : t("avviso.replica_non_disponibile")}
                  </p>
                )}
              </div>
            </div>
          )}

          {avviso.senzaRisposta > 0 && (
            <p className="muted">{tn("avviso.incompleto", avviso.senzaRisposta)}</p>
          )}
        </>
      )}

      {nota !== undefined && <Alert>{nota}</Alert>}

      <div className="cluster">
        <Button onClick={() => setSegnalando(true)} variant="quiet">
          {t("avviso.segnala")}
        </Button>
        {amministra && (
          <Button onClick={() => setDecidendo(true)} variant="quiet">
            {avviso.verdetto === undefined ? t("avviso.decidi") : t("avviso.rivedi_decisione")}
          </Button>
        )}
      </div>

      <Segnala
        aperta={segnalando}
        instanceKey={instanceKey}
        nome={nome}
        onChiudi={() => setSegnalando(false)}
        onFatto={() => {
          setSegnalando(false);
          setNota(t("avviso.segnalata"));
        }}
      />

      {amministra && (
        <Decidi
          aperta={decidendo}
          avviso={avviso}
          nome={nome}
          onChiudi={() => setDecidendo(false)}
          onFatto={(detto) => {
            setDecidendo(false);
            setNota(detto);
            void carica();
          }}
        />
      )}
    </section>
  );
}

function Categoria({
  categoria,
  provenienze,
  lingua,
}: {
  categoria: CategoriaSegnalazione;
  provenienze: ProvenienzaView[];
  lingua: string;
}): React.ReactElement | null {
  const { tn } = useT();

  if (provenienze.length === 0) {
    return null;
  }

  const tramite = provenienze.map((provenienza) => provenienza.tramite).join(", ");

  return (
    <div className={`avviso-istanza__categoria avviso-istanza__categoria--${categoria}`}>
      <h3 className="avviso-istanza__titolo">
        {categoria === "non_autentica"
          ? tn("avviso.non_autentica", provenienze.length, { tramite })
          : tn("avviso.non_gradita", provenienze.length, { tramite })}
      </h3>
      <p className="muted">
        {categoria === "non_autentica"
          ? t("avviso.non_autentica.spiega")
          : t("avviso.non_gradita.spiega")}
      </p>
      <ul className="avviso-istanza__motivi">
        {provenienze.flatMap((provenienza) =>
          provenienza.motivi.map((motivo, indice) => (
            <li key={`${provenienza.tramite}:${String(indice)}`}>
              «{motivo.motivo}»{" "}
              <span className="muted">
                {t("avviso.da_quando", {
                  quando: meseLeggibile(motivo.mese, lingua),
                  tramite: provenienza.tramite,
                })}
              </span>
            </li>
          )),
        )}
      </ul>
    </div>
  );
}

function Segnala({
  aperta,
  instanceKey,
  nome,
  onChiudi,
  onFatto,
}: {
  aperta: boolean;
  instanceKey: string;
  nome: string;
  onChiudi: () => void;
  onFatto: () => void;
}): React.ReactElement {
  const { token } = useSignedIn();
  const [categoria, setCategoria] = useState<CategoriaSegnalazione | undefined>();
  const [motivo, setMotivo] = useState("");
  const [errore, setErrore] = useState<string | undefined>();
  const [invio, setInvio] = useState(false);

  const invia = async (): Promise<void> => {
    if (categoria === undefined) {
      return;
    }

    setErrore(undefined);
    setInvio(true);

    try {
      await api.segnala(token, { categoria, istanza: instanceKey, motivo });
      setMotivo("");
      setCategoria(undefined);
      onFatto();
    } catch (causa) {
      setErrore(spiega(causa, t("avviso.non_segnalata")));
    } finally {
      setInvio(false);
    }
  };

  return (
    <Sheet
      onClose={onChiudi}
      open={aperta}
      title={t("avviso.segnala_titolo", { nome })}
      variant="centrato"
    >
      <div className="stack">
        {/* Chi segnala deve saperlo prima, non dopo (ADR 0047 Decisione 6). */}
        <Alert>{t("avviso.chi_vede")}</Alert>

        <fieldset className="stack stack--tight">
          <legend className="field__label">{t("avviso.categoria")}</legend>
          <Choice
            checked={categoria === "non_autentica"}
            name="categoria"
            note={t("avviso.non_autentica.nota")}
            onChoose={() => setCategoria("non_autentica")}
            title={t("avviso.non_autentica.scelta")}
          />
          <Choice
            checked={categoria === "non_gradita"}
            name="categoria"
            note={t("avviso.non_gradita.nota")}
            onChoose={() => setCategoria("non_gradita")}
            title={t("avviso.non_gradita.scelta")}
          />
        </fieldset>

        <TextAreaField
          hint={t("avviso.motivo.aiuto", { max: MAX_MOTIVO })}
          label={t("avviso.motivo")}
          maxLength={MAX_MOTIVO}
          onChange={(evento) => setMotivo(evento.target.value)}
          value={motivo}
        />

        {errore !== undefined && <Alert tone="error">{errore}</Alert>}

        <div className="cluster">
          <Button
            aria-busy={invio}
            disabled={invio || categoria === undefined || motivo.trim() === ""}
            onClick={() => void invia()}
          >
            {invio ? t("avviso.invio") : t("avviso.invia")}
          </Button>
          <Button onClick={onChiudi} variant="quiet">
            {t("comune.annulla")}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * Il verdetto locale ([ADR 0047] Decisione 5). **La nota è dell'admin**: parte
 * da quella che aveva già scritto, o vuota, e mai dal testo delle segnalazioni.
 * Il blocco non si duplica qui: sta in EstiaNet, dove sta già.
 */
function Decidi({
  aperta,
  avviso,
  nome,
  onChiudi,
  onFatto,
}: {
  aperta: boolean;
  avviso: AvvisoView;
  nome: string;
  onChiudi: () => void;
  onFatto: (detto: string) => void;
}): React.ReactElement {
  const { token } = useSignedIn();
  const [nota, setNota] = useState(avviso.verdetto?.nota ?? "");
  const [ignora, setIgnora] = useState(avviso.verdetto?.ignora ?? false);
  const [errore, setErrore] = useState<string | undefined>();
  const [lavoro, setLavoro] = useState(false);

  const fai = async (azione: () => Promise<unknown>, detto: string): Promise<void> => {
    setErrore(undefined);
    setLavoro(true);

    try {
      await azione();
      onFatto(detto);
    } catch (causa) {
      setErrore(spiega(causa, t("avviso.decisione_non_salvata")));
    } finally {
      setLavoro(false);
    }
  };

  return (
    <Sheet
      onClose={onChiudi}
      open={aperta}
      title={t("avviso.decidi_titolo", { nome })}
      variant="centrato"
    >
      <div className="stack">
        <p className="muted">{t("avviso.decidi_spiega")}</p>

        <TextAreaField
          label={t("avviso.tua_nota")}
          onChange={(evento) => setNota(evento.target.value)}
          value={nota}
        />

        <Choice
          checked={ignora}
          name="ignora"
          note={t("avviso.ignora.nota")}
          onChoose={() => setIgnora(!ignora)}
          title={t("avviso.ignora")}
          type="checkbox"
        />

        {errore !== undefined && <Alert tone="error">{errore}</Alert>}

        <div className="cluster">
          <Button
            aria-busy={lavoro}
            disabled={lavoro}
            onClick={() =>
              void fai(
                () => api.decidiVerdetto(token, avviso.istanza, { ignora, nota }),
                t("avviso.decisione_salvata"),
              )
            }
          >
            {t("avviso.salva_decisione")}
          </Button>
          {avviso.verdetto !== undefined && (
            <Button
              disabled={lavoro}
              onClick={() =>
                void fai(
                  () => api.revocaVerdetto(token, avviso.istanza),
                  t("avviso.decisione_tolta"),
                )
              }
              variant="quiet"
            >
              {t("avviso.togli_decisione")}
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
