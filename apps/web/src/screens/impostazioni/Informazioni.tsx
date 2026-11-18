import type { ConnectionView } from "@estia/contracts";
import { useEffect, useState } from "react";

import { api } from "../../api.js";
import { t, tc, tn, useT } from "../../lingua.js";
import { nomeIstanza, useSignedIn } from "../../state.js";
import { Alert } from "../../ui/index.js";
import { Sezione } from "./Sezione.js";

/**
 * Questa casa e questo software.
 *
 * Comprende ciò che prima stava in «L'istanza»: chi ci abita e da dove stai
 * arrivando adesso (SECURITY_BASELINE §1). La chiave per collegare altre
 * istanze non sta qui — sta in EstiaNet, dove serve.
 */
export function Informazioni(): React.ReactElement {
  useT();
  const { instance } = useSignedIn();
  const [connessione, setConnessione] = useState<ConnectionView | undefined>();

  useEffect(() => {
    void api
      .connection()
      .then(setConnessione)
      .catch(() => undefined);
  }, []);

  return (
    <Sezione titolo={t("sezioni.informazioni")}>
      <div className="card">
        <h2>{nomeIstanza(instance)}</h2>
        {instance.description !== undefined && instance.description !== "" && (
          <p>{instance.description}</p>
        )}
        <p className="muted">{tn("informazioni.persone", instance.memberCount)}</p>
      </div>

      <div className="card">
        <h2>{t("informazioni.connessione.titolo")}</h2>
        {connessione === undefined ? (
          <p className="muted">{t("informazioni.connessione.guardo")}</p>
        ) : connessione.origin === "public" ? (
          <Alert tone="error">{connessione.detail}</Alert>
        ) : (
          <p className="muted">{connessione.detail}</p>
        )}
      </div>

      <div className="card">
        <h2>{t("informazioni.estia.titolo")}</h2>
        <p>{t("informazioni.estia.testo")}</p>
        <p className="muted">{t("informazioni.estia.copie")}</p>
      </div>

      <div className="card">
        <h2>{t("informazioni.licenza.titolo")}</h2>
        <p className="muted">
          {tc("informazioni.licenza.testo", { licenza: <strong>AGPL-3.0</strong> })}
        </p>
      </div>
    </Sezione>
  );
}
