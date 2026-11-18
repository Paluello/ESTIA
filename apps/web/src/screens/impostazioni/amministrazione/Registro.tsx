import type { AuditEventView } from "@estia/contracts";
import { useEffect, useState } from "react";

import type { Chiave } from "@estia/lingue";

import { api } from "../../../api.js";
import { t, useT } from "../../../lingua.js";
import { useSignedIn } from "../../../state.js";
import { EmptyState } from "../../../ui/index.js";
import { Sezione } from "../Sezione.js";
import { quandoMedio as quando } from "../../../tempo.js";

const ETICHETTE: Readonly<Record<string, Chiave>> = {
  invite_created: "registro.invite_created",
  invite_revoked: "registro.invite_revoked",
  join_request_rejected: "registro.join_request_rejected",
  member_admitted: "registro.member_admitted",
};

function etichetta(azione: string): string {
  const chiave = ETICHETTE[azione];
  return chiave === undefined ? azione : t(chiave);
}

export function Registro(): React.ReactElement {
  useT();
  const { token } = useSignedIn();
  const [eventi, setEventi] = useState<AuditEventView[]>([]);

  useEffect(() => {
    void api.audit(token).then((risposta) => setEventi(risposta.events));
  }, [token]);

  return (
    <Sezione titolo={t("sezioni.registro")}>
      <div className="card card--flush">
        {eventi.length === 0 && (
          <EmptyState icon="instance" title={t("registro.vuoto.titolo")}>
            <p>{t("registro.vuoto.testo")}</p>
          </EmptyState>
        )}
        {eventi.map((evento) => (
          <div className="row" key={evento.id}>
            <span className="row__body">
              <span className="row__title">
                {etichetta(evento.action)}
                {evento.action === "member_admitted" && <> · {evento.subject}</>}
              </span>
              <span className="row__note">
                {quando(evento.createdAt)}
                {evento.actorUsername !== null && t("registro.da", { nome: evento.actorUsername })}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Sezione>
  );
}
