import type { SessionView } from "@estia/contracts";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../api.js";
import { useAvvisi } from "../../avvisi.js";
import { t, useT } from "../../lingua.js";
import { useSignedIn } from "../../state.js";
import { Badge, Button, Sheet } from "../../ui/index.js";
import { Sezione } from "./Sezione.js";
import { avvisoDiUscita } from "./chiavi-stato.js";
import { useChiavi } from "./useChiavi.js";
import { quandoMedio as quando } from "../../tempo.js";

/**
 * Da dove sei entrato, e come si esce.
 *
 * Un lavoro solo (euristica 8): le chiavi delle chat stanno in **Chat**, che è
 * dove si governano. Qui restano perché uscire le porta via, e un pulsante che
 * cancella deve poterlo dire — ma la copia si fa di là, e il link ci porta.
 */
export function Dispositivi(): React.ReactElement {
  useT();
  const { signOut, token } = useSignedIn();
  const { errore: mostraErrore } = useAvvisi();
  const [sessioni, setSessioni] = useState<SessionView[]>([]);
  const [confermaUscita, setConfermaUscita] = useState(false);
  const { stato } = useChiavi(token);

  const avviso = avvisoDiUscita(stato);

  const carica = useCallback(async () => {
    try {
      setSessioni((await api.sessions(token)).sessions);
    } catch (err: unknown) {
      mostraErrore(err, t("dispositivi.errore_elenco"));
    }
  }, [mostraErrore, token]);

  useEffect(() => {
    void carica();
  }, [carica]);

  const esci = async (): Promise<void> => {
    setConfermaUscita(false);
    try {
      await api.logout(token);
    } catch {
      // La sessione può essere già finita: lo stato locale si pulisce comunque.
    }

    signOut();
  };

  const chiediDiUscire = (): void => {
    if (avviso === undefined) {
      void esci();
      return;
    }
    setConfermaUscita(true);
  };

  const revoca = async (sessione: SessionView): Promise<void> => {
    // Uscire da qui porta via le chiavi: si passa dalla stessa domanda.
    if (sessione.current) {
      chiediDiUscire();
      return;
    }

    await api.revokeSession(token, sessione.id);
    await carica();
  };

  return (
    <Sezione chiave="dispositivi" scopo={t("dispositivi.scopo")}>
      <div className="card card--flush">
        <h2 className="gruppo">{t("dispositivi.da_dove")}</h2>
        {sessioni.length === 0 && <p className="empty-inline">{t("dispositivi.nessuno")}</p>}
        {sessioni.map((sessione) => (
          <div className="row" key={sessione.id}>
            <span className="row__body">
              <span className="row__title">
                {sessione.deviceLabel === "" ? t("dispositivi.dispositivo") : sessione.deviceLabel}{" "}
                {sessione.current && <Badge tone="on">{t("dispositivi.questo")}</Badge>}
              </span>
              <span className="row__note">
                {t("dispositivi.collegato", {
                  collegato: quando(sessione.createdAt),
                  visto: quando(sessione.lastSeenAt),
                })}
              </span>
            </span>
            <span className="row__end">
              <Button onClick={() => void revoca(sessione)} variant="danger">
                {sessione.current ? t("dispositivi.esci_da_qui") : t("dispositivi.disconnetti")}
              </Button>
            </span>
          </div>
        ))}
        <p className="muted chiavi__testo" style={{ padding: "var(--s-3) var(--s-4)" }}>
          {t("dispositivi.disconnettere")}
        </p>
      </div>

      <div className="card">
        <h2 className="gruppo">{t("dispositivi.uscire")}</h2>
        <p className="muted chiavi__testo">{avviso ?? t("dispositivi.uscire.con_copia")}</p>
        <Button block onClick={chiediDiUscire} variant="secondary">
          {t("dispositivi.esci_da_questo")}
        </Button>
      </div>

      <Sheet
        onClose={() => setConfermaUscita(false)}
        open={confermaUscita}
        title={t("dispositivi.senza_copia.titolo")}
        variant="centrato"
      >
        <div className="feed-pad stack" style={{ paddingBlock: "var(--s-4)" }}>
          <p className="chiavi__testo">{avviso}</p>
          <Link className="btn btn--block" to="/impostazioni/chat">
            {t("dispositivi.senza_copia.crea")}
          </Link>
          <Button block onClick={() => void esci()} variant="danger">
            {t("dispositivi.senza_copia.esci")}
          </Button>
        </div>
      </Sheet>
    </Sezione>
  );
}
