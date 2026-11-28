import type { ConversazioneView } from "@estia/contracts";
import { useState } from "react";

import { t, useT } from "../../lingua.js";
import { giornoDi } from "../../tempo.js";
import { Alert, Button, Sheet } from "../../ui/index.js";
import { haUnTrasloco, nomeDaIndirizzo, statoTrasloco } from "./logica.js";

/**
 * Il trasloco, detto sulla schermata del gruppo
 * ([ADR 0042](../../../../../docs/adr/0042-come-mls-attraversa.md) §3).
 *
 * Tre cose, ognuna con parole intere, perché nessuna si indovina:
 *
 * - un **successore** dice che cosa continua, da quando la casa di prima
 *   taceva, chi l'ha traslocato e quando — non diventa lo stesso gruppo di
 *   soppiatto;
 * - un gruppo **traslocato** dice che è congelato e porta a chi lo continua:
 *   a tutti, se sono due;
 * - un gruppo la cui casa è **persa** offre il gesto a chi può farlo, e solo
 *   allora. La conferma non è un «sei sicuro?»: dice i due costi **prima**
 *   (chi oggi non è raggiungibile resta fuori; il gruppo nuovo ha chiavi
 *   nuove), e che due traslochi insieme danno due gruppi.
 */
export function AvvisoTrasloco({
  conversazione,
  casa,
  mie,
  onApri,
  onTrasloca,
}: {
  conversazione: ConversazioneView;
  /** La chiave di questa casa, quando si sa: serve a dare un nome a chi ha traslocato. */
  casa: string | undefined;
  /** Gli id delle conversazioni di chi guarda: un legame si apre solo se porta da qualche parte. */
  mie: ReadonlySet<string>;
  onApri: (id: string) => void;
  /** Fa il trasloco, e dice da sé com'è andato. */
  onTrasloca: () => Promise<void>;
}): React.ReactElement | null {
  useT();
  const [conferma, setConferma] = useState(false);
  const [lavoro, setLavoro] = useState(false);

  const stato = statoTrasloco(conversazione, mie);
  if (!haUnTrasloco(stato)) {
    return null;
  }

  const chi = (indirizzo: string): string => nomeDaIndirizzo(indirizzo, conversazione, casa ?? "");

  const trasloca = async (): Promise<void> => {
    setLavoro(true);
    try {
      await onTrasloca();
      setConferma(false);
    } finally {
      setLavoro(false);
    }
  };

  return (
    <div className="chat-detail-alert">
      <Alert tone="neutral">
        {stato.continua !== undefined && (
          <>
            <p className="chiavi__testo">
              {t("gruppi.trasloco.continua", {
                chi: chi(stato.continua.da),
                dal: giornoDi(stato.continua.casaPersaDal),
                il: giornoDi(stato.continua.il),
                nome: stato.continua.nome,
              })}
            </p>
            {stato.continua.apribile && (
              <div className="cluster avviso-sicurezza__azioni">
                <Button
                  onClick={() => onApri(stato.continua?.conversazioneId ?? "")}
                  variant="secondary"
                >
                  {t("gruppi.trasloco.apri_di_prima")}
                </Button>
              </div>
            )}
          </>
        )}

        {stato.congelato && <p className="chiavi__testo">{t("gruppi.trasloco.congelato")}</p>}

        {stato.successori.length > 1 && (
          <p className="chiavi__testo">
            {t("gruppi.trasloco.due_successori", { n: stato.successori.length })}
          </p>
        )}
        {stato.successori.map((s) => (
          <div className="stack stack--tight" key={s.id}>
            <p className="chiavi__testo">
              {t(s.mio ? "gruppi.trasloco.successore" : "gruppi.trasloco.successore_senza_te", {
                chi: chi(s.da),
                il: giornoDi(s.il),
              })}
            </p>
            {s.mio && (
              <div className="cluster avviso-sicurezza__azioni">
                <Button onClick={() => onApri(s.id)} variant="secondary">
                  {t("gruppi.trasloco.apri_successore", { chi: chi(s.da) })}
                </Button>
              </div>
            )}
          </div>
        ))}

        {stato.persa !== undefined && (
          <>
            <p className="chiavi__testo">
              {t("gruppi.trasloco.persa", { dal: giornoDi(stato.persa.dal) })}{" "}
              {t(stato.persa.puoi ? "gruppi.trasloco.puoi" : "gruppi.trasloco.non_puoi")}
            </p>
            {stato.persa.puoi && (
              <div className="cluster avviso-sicurezza__azioni">
                <Button onClick={() => setConferma(true)} variant="secondary">
                  {t("gruppi.trasloco.voce")}
                </Button>
              </div>
            )}
          </>
        )}
      </Alert>

      <Sheet
        onClose={() => setConferma(false)}
        open={conferma}
        title={t("gruppi.trasloco.titolo", { nome: conversazione.nome ?? "" })}
        variant="centrato"
      >
        {conferma && (
          <div className="feed-pad stack">
            <p className="chiavi__testo">{t("gruppi.trasloco.testo")}</p>
            <ul className="stack stack--tight">
              <li className="chiavi__testo">{t("gruppi.trasloco.costo_assenti")}</li>
              <li className="chiavi__testo">{t("gruppi.trasloco.costo_archivio")}</li>
              <li className="chiavi__testo">{t("gruppi.trasloco.doppio")}</li>
            </ul>
            <p aria-live="polite" className="muted chiavi__testo">
              {lavoro ? t("gruppi.trasloco.lavoro") : ""}
            </p>
            <div className="cluster cluster--end">
              <Button disabled={lavoro} onClick={() => setConferma(false)} variant="secondary">
                {t("comune.annulla")}
              </Button>
              <Button disabled={lavoro} onClick={() => void trasloca()} variant="primary">
                {t("gruppi.trasloco.conferma")}
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
