import { useState } from "react";

import { api } from "../../api.js";
import { useAvvisi } from "../../avvisi.js";
import { t, tc, tn, useT } from "../../lingua.js";
import { ripristina, salvaCopia as salvaCopiaMls } from "../../mls/motore.js";
import { useSignedIn } from "../../state.js";
import { Alert, Button, TextField } from "../../ui/index.js";
import { Sezione } from "./Sezione.js";
import { codiceDi } from "./codice-dispositivo.js";
import { comeFunzionano, piuDispositivi, raccontoDi } from "./chiavi-stato.js";
import { useChiavi } from "./useChiavi.js";
import { quandoMedio as quando } from "../../tempo.js";

/**
 * Le chat: le chiavi, la copia che le riporta altrove, e chi può leggerle.
 *
 * Sta separata da «Accesso e dispositivi» perché sono due lavori diversi — là
 * si guarda da dove si è entrati e si esce, qui si governa che cosa può leggere
 * i propri messaggi (euristica 8: una sezione, un lavoro).
 *
 * **Qui arrivano le richieste di autorizzazione di un dispositivo nuovo**
 * ([ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md),
 * strada B): a dire di sì è un dispositivo che già possiedi, e il codice da
 * confrontare lo calcola **questo browser** dalla chiave pubblica — se lo
 * fornisse l'istanza, l'istanza potrebbe mostrarne uno che coincide anche dopo
 * aver sostituito la chiave.
 *
 * Che cosa il sì fa: mette il dispositivo nel registro, e da lì il dispositivo
 * entra da solo in ciascuna conversazione la prima volta che la apre — un
 * rientro dal punto pubblicato, un commit MLS per conversazione. Gli altri
 * dispositivi restano accesi, ed è quello che dice l'avviso in cima.
 */
export function Chat(): React.ReactElement {
  useT();
  const { token, user } = useSignedIn();
  const { errore: mostraErrore, successo: mostraSuccesso } = useAvvisi();
  const { copiaEsiste, daAutorizzare, ilMioCodice, inLettura, ricarica, stato } = useChiavi(token);
  const [fraseSegreta, setFraseSegreta] = useState("");
  const [inLavorazione, setInLavorazione] = useState(false);

  const racconto = raccontoDi(stato);

  const salvaCopia = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (fraseSegreta.trim().length < 8) {
      mostraErrore(null, t("chat_chiavi.frase_corta", { n: 8 }));
      return;
    }
    setInLavorazione(true);
    try {
      await salvaCopiaMls(token, fraseSegreta);
      setFraseSegreta("");
      mostraSuccesso(t("chat_chiavi.copia_creata"));
      await ricarica();
    } catch (err: unknown) {
      mostraErrore(err, t("chat_chiavi.copia_non_creata"));
    } finally {
      setInLavorazione(false);
    }
  };

  const decidi = async (deviceId: string, si: boolean): Promise<void> => {
    setInLavorazione(true);
    try {
      if (si) {
        await api.approvaDispositivo(token, deviceId);
        mostraSuccesso(t("chat_chiavi.autorizzato"));
      } else {
        await api.rifiutaDispositivo(token, deviceId);
        mostraSuccesso(t("chat_chiavi.rifiutato"));
      }
      await ricarica();
    } catch (err: unknown) {
      mostraErrore(err, t("chat_chiavi.risposta_fallita"));
    } finally {
      setInLavorazione(false);
    }
  };

  const rimettiLeChiavi = async (): Promise<void> => {
    if (fraseSegreta.trim().length === 0) {
      mostraErrore(null, t("chat_chiavi.scrivi_frase"));
      return;
    }
    setInLavorazione(true);
    try {
      await ripristina(token, user.username, fraseSegreta);
      setFraseSegreta("");
      mostraSuccesso(t("chat_chiavi.rimessa"));
      await ricarica();
    } catch (err: unknown) {
      mostraErrore(err, t("chat_chiavi.frase_sbagliata"));
    } finally {
      setInLavorazione(false);
    }
  };

  return (
    <Sezione chiave="chat" scopo={t("chat_chiavi.scopo")}>
      <Alert tone="neutral">
        <p className="chiavi__testo">{piuDispositivi()}</p>
      </Alert>

      {daAutorizzare.length > 0 && (
        <div className="card stack">
          <h2 className="gruppo">{tn("chat_chiavi.richieste", daAutorizzare.length)}</h2>
          <p className="muted chiavi__testo">
            {tc("chat_chiavi.prima_del_si", {
              guarda: <strong>{t("chat_chiavi.prima_del_si.guarda")}</strong>,
            })}
          </p>
          {daAutorizzare.map((dispositivo) => (
            <div className="richiesta" key={dispositivo.id}>
              <p className="richiesta__codice">{codiceDi(dispositivo.publicKey)}</p>
              <p className="muted chiavi__testo">
                {t("chat_chiavi.chiede_dal", { quando: quando(dispositivo.createdAt) })}
              </p>
              <div className="cluster">
                <Button
                  disabled={inLavorazione}
                  onClick={() => void decidi(dispositivo.id, true)}
                  variant="primary"
                >
                  {t("chat_chiavi.si_sono_io")}
                </Button>
                <Button
                  disabled={inLavorazione}
                  onClick={() => void decidi(dispositivo.id, false)}
                  variant="danger"
                >
                  {t("chat_chiavi.no_rifiuta")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {ilMioCodice !== undefined && (
        <div className="card stack">
          <h2 className="gruppo">{t("chat_chiavi.il_mio_codice")}</h2>
          <p className="richiesta__codice">{ilMioCodice}</p>
          <p className="muted chiavi__testo">{t("chat_chiavi.confronta")}</p>
        </div>
      )}

      <div className="card stack">
        <h2 className="gruppo">{t("chat_chiavi.le_chiavi")}</h2>
        {inLettura ? (
          <p className="empty-inline">{t("comune.un_momento")}</p>
        ) : (
          <Alert tone={racconto.tono}>
            <div className="stack stack--tight">
              <strong>{racconto.titolo}</strong>
              <p className="chiavi__testo">{racconto.testo}</p>
              {racconto.cosaFare !== undefined && (
                <p className="chiavi__testo">{racconto.cosaFare}</p>
              )}
            </div>
          </Alert>
        )}
        <p className="muted chiavi__testo">{comeFunzionano()}</p>
      </div>

      <div className="card">
        <h2 className="gruppo">{t("chat_chiavi.copia.titolo")}</h2>
        <p className="muted chiavi__testo">
          {tc("chat_chiavi.copia.testo", {
            senza_aprire: <strong>{t("chat_chiavi.copia.senza_aprire")}</strong>,
            non_conversazioni: <strong>{t("chat_chiavi.copia.non_conversazioni")}</strong>,
          })}
        </p>
        <form onSubmit={(e) => void salvaCopia(e)}>
          <TextField
            hint={t("chat_chiavi.frase.aiuto")}
            label={t("chat_chiavi.frase.etichetta")}
            onChange={(e) => setFraseSegreta(e.target.value)}
            placeholder={t("comune.password_minimo", { n: 8 })}
            type="password"
            value={fraseSegreta}
          />
          <div className="button-group">
            <Button
              disabled={inLavorazione || fraseSegreta.length < 8}
              type="submit"
              variant="primary"
            >
              {inLavorazione
                ? t("comune.un_momento")
                : copiaEsiste
                  ? t("chat_chiavi.copia.aggiorna")
                  : t("chat_chiavi.copia.crea")}
            </Button>
            {copiaEsiste && (
              <Button
                disabled={inLavorazione || fraseSegreta.length === 0}
                onClick={() => void rimettiLeChiavi()}
                type="button"
                variant="secondary"
              >
                {t("chat_chiavi.rimetti")}
              </Button>
            )}
          </div>
        </form>
      </div>
    </Sezione>
  );
}
