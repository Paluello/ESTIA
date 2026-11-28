import type {
  CommunityRelaySuggestion,
  CommunityRelaysView,
  CommunityRelayView,
} from "@estia/contracts";
import { useCallback, useEffect, useState } from "react";

import { api } from "../../../api.js";
import { spiega } from "../../../errori.js";
import { t, tc } from "../../../lingua.js";
import { Alert, Button, ListRow, TextField, type Tone } from "../../../ui/index.js";

/**
 * I relay della comunità, nella pagina EstiaNet (ADR 0045 §2-3).
 *
 * **Si adotta con un gesto, e sapendo da chi.** Il nome di chi gestisce il
 * relay è obbligatorio e compare nell'avviso prima del pulsante, non dopo:
 * ADR 0045 §«Che cosa vede chi» chiede di dirlo «nel momento in cui adotta»,
 * perché un operatore vicino conosce le persone (euristica 5, prevenire
 * l'errore). Il pulsante resta spento finché il nome manca.
 *
 * **Lo stato si legge senza premere niente**: ogni riga dice se il relay
 * risponde, e in cima c'è quale relay la Casa usa adesso e se è tornata su n0
 * perché tutti tacciono (euristica 1).
 *
 * **Un suggerimento resta un suggerimento** (§3): le Case collegate dicono
 * quale relay usano e chi lo gestisce, la scheda lo mostra con il nome della
 * Casa, e lo si adotta solo premendo. Lo stesso avviso del modulo sta sopra il
 * pulsante, perché adottare da qui è adottare come a mano.
 *
 * Senza relay adottati non cambia niente, e la scheda lo dice: è la Casa di
 * sempre, con i relay di n0.
 */
export function RelayComunita({ token }: { token: string }): React.ReactElement {
  const [vista, setVista] = useState<CommunityRelaysView | undefined>();
  const [indirizzo, setIndirizzo] = useState("");
  const [gestore, setGestore] = useState("");
  const [lavoro, setLavoro] = useState<string | undefined>();
  const [avviso, setAvviso] = useState<{ testo: string; tono: Tone } | undefined>();

  const carica = useCallback(async () => {
    try {
      setVista(await api.communityRelays(token));
    } catch (causa) {
      setAvviso({ testo: spiega(causa, t("relay.carica_fallito")), tono: "error" });
    }
  }, [token]);

  useEffect(() => {
    void carica();
  }, [carica]);

  const occupato = lavoro !== undefined;
  const nomeGestore = gestore.trim();

  const adotta = async (): Promise<void> => {
    setAvviso(undefined);
    setLavoro("adotta");

    try {
      const nuova = await api.adoptCommunityRelay(token, { gestore: nomeGestore, url: indirizzo });
      setVista(nuova);
      setIndirizzo("");
      setGestore("");
      setAvviso({ testo: t("relay.adottato"), tono: "ok" });
    } catch (causa) {
      setAvviso({ testo: spiega(causa, t("relay.adotta_fallito")), tono: "error" });
    } finally {
      setLavoro(undefined);
    }
  };

  const adottaSuggerito = async (suggerito: CommunityRelaySuggestion): Promise<void> => {
    setAvviso(undefined);
    setLavoro(`suggerito:${suggerito.url}`);

    try {
      setVista(
        await api.adoptCommunityRelay(token, { gestore: suggerito.gestore, url: suggerito.url }),
      );
      setAvviso({ testo: t("relay.adottato"), tono: "ok" });
    } catch (causa) {
      setAvviso({ testo: spiega(causa, t("relay.adotta_fallito")), tono: "error" });
    } finally {
      setLavoro(undefined);
    }
  };

  const togli = async (relay: CommunityRelayView): Promise<void> => {
    setAvviso(undefined);
    setLavoro(`togli:${relay.url}`);

    try {
      setVista(await api.removeCommunityRelay(token, relay.url));
      setAvviso({ testo: t("relay.tolto", { gestore: relay.gestore }), tono: "ok" });
    } catch (causa) {
      setAvviso({ testo: spiega(causa, t("relay.togli_fallito")), tono: "error" });
    } finally {
      setLavoro(undefined);
    }
  };

  const stato = (relay: CommunityRelayView): string =>
    relay.risponde === undefined
      ? t("relay.stato.da_controllare")
      : relay.risponde
        ? t("relay.stato.risponde")
        : t("relay.stato.non_risponde");

  return (
    <div className="card">
      <h2 className="gruppo">{t("relay.titolo")}</h2>
      <p className="muted">{t("relay.testo")}</p>

      {avviso !== undefined && <Alert tone={avviso.tono}>{avviso.testo}</Alert>}

      {vista !== undefined && (
        <>
          {!vista.attivi && <Alert>{t("relay.non_attivi")}</Alert>}

          {vista.attivi && (
            <p className="muted">
              {vista.inUso === undefined
                ? t("relay.in_uso.nessuno")
                : tc("relay.in_uso", { relay: <code>{vista.inUso}</code> })}
            </p>
          )}

          {vista.ripiegoSuN0 && <Alert tone="error">{t("relay.ripiego_n0")}</Alert>}

          {vista.relays.length === 0 ? (
            <p className="empty-inline">{t("relay.nessuno")}</p>
          ) : (
            vista.relays.map((relay) => (
              <ListRow
                end={
                  <Button
                    aria-busy={lavoro === `togli:${relay.url}`}
                    disabled={occupato}
                    onClick={() => void togli(relay)}
                    variant="secondary"
                  >
                    {lavoro === `togli:${relay.url}` ? t("relay.tolgo") : t("relay.togli")}
                  </Button>
                }
                icon="globe"
                key={relay.url}
                note={`${t("relay.gestito_da", { gestore: relay.gestore })} · ${stato(relay)}`}
                title={<code>{relay.url}</code>}
              />
            ))
          )}

          {vista.suggeriti.length > 0 && vista.relays.length < vista.massimo && (
            <>
              <h3 className="gruppo">{t("relay.suggeriti.titolo")}</h3>
              {vista.suggeriti.map((suggerito) => (
                <div key={`${suggerito.casa}:${suggerito.url}`}>
                  <ListRow
                    icon="globe"
                    note={t("relay.suggerito.nota", {
                      casa: suggerito.casa,
                      gestore: suggerito.gestore,
                    })}
                    title={
                      <>
                        {t("relay.suggerito", { casa: suggerito.casa })} ·{" "}
                        <code>{suggerito.url}</code>
                      </>
                    }
                  />
                  <Alert>{t("relay.prima_di_adottare", { gestore: suggerito.gestore })}</Alert>
                  <Button
                    aria-busy={lavoro === `suggerito:${suggerito.url}`}
                    disabled={occupato}
                    onClick={() => void adottaSuggerito(suggerito)}
                    variant="secondary"
                  >
                    {lavoro === `suggerito:${suggerito.url}`
                      ? t("relay.adotto")
                      : t("relay.adotta_suggerito", { gestore: suggerito.gestore })}
                  </Button>
                </div>
              ))}
            </>
          )}

          {vista.relays.length < vista.massimo && (
            // Un modulo vero, così che Invio adotti come il pulsante (euristica 7).
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!occupato && indirizzo.trim() !== "" && nomeGestore !== "") void adotta();
              }}
            >
              <h3 className="gruppo">{t("relay.adotta.titolo")}</h3>
              <TextField
                hint={t("relay.indirizzo.aiuto")}
                inputMode="url"
                label={t("relay.indirizzo")}
                onChange={(event) => setIndirizzo(event.target.value)}
                placeholder="https://relay.esempio.it/"
                value={indirizzo}
              />
              <TextField
                hint={t("relay.gestore.aiuto")}
                label={t("relay.gestore")}
                maxLength={120}
                onChange={(event) => setGestore(event.target.value)}
                value={gestore}
              />

              {nomeGestore !== "" && indirizzo.trim() !== "" && (
                <Alert>{t("relay.prima_di_adottare", { gestore: nomeGestore })}</Alert>
              )}

              <Button
                aria-busy={lavoro === "adotta"}
                disabled={occupato || indirizzo.trim() === "" || nomeGestore === ""}
                type="submit"
              >
                {lavoro === "adotta" ? t("relay.adotto") : t("relay.adotta")}
              </Button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
