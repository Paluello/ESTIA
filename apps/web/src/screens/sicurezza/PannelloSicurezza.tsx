import type { AuthorView } from "@estia/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type { StatoAvvisi } from "../../avvisi.js";
import { t, useT } from "../../lingua.js";
import type { Membro } from "../../mls/gruppo.js";
import { inGruppi } from "../../mls/numero-di-sicurezza.js";
import {
  leggiSicurezza,
  segnaVerificato,
  togliVerifica,
  type Dipendenze,
  type Sicurezza,
} from "../../mls/sicurezza.js";
import { quandoMedio } from "../../tempo.js";
import { Alert, Badge, Button, Live } from "../../ui/index.js";
import { membroDi } from "./membri.js";

/** Ciò che serve per calcolare: chi sono io, e da dove vengono chiavi e verifiche. */
export interface Ambiente {
  io: Membro;
  dip: Dipendenze;
}

export interface PannelloSicurezzaProps {
  /** Si chiede a ogni lettura: prepararlo può voler dire parlare con l'istanza. */
  ambiente: () => Promise<Ambiente>;
  altro: AuthorView;
  avvisi: Pick<StatoAvvisi, "errore" | "successo">;
  /** Dopo un «verificato» o un «togli»: chi sta intorno ha un avviso da rivedere. */
  onCambio?: () => void;
}

type Lettura = { fase: "carico" } | { fase: "errore" } | { fase: "letto"; sicurezza: Sicurezza };

/**
 * Il numero di sicurezza fra chi guarda e **una** persona
 * ([ADR 0050](../../../../../docs/adr/0050-il-numero-di-sicurezza.md)).
 *
 * È lo stesso pannello nei messaggi privati e in un gruppo, perché è lo stesso
 * numero: non prende una conversazione, prende una persona.
 *
 * **Il numero lo calcola questo browser**, dalle chiavi; l'istanza non lo vede
 * e non lo fornisce. È la regola del codice di ADR 0040: un numero che arriva
 * già scritto da chi tiene il registro coinciderebbe sempre.
 *
 * Tre cose stanno sulla schermata e non in una guida (euristica 10): con che
 * cosa confrontarlo, su quale canale, e quante chiavi ci sono dentro — l'ultima
 * perché un dispositivo in più che non si riconosce è l'unico segno di una
 * chiave aggiunta di nascosto **prima** del confronto.
 */
export function PannelloSicurezza({
  ambiente,
  altro,
  avvisi,
  onCambio,
}: PannelloSicurezzaProps): React.ReactElement {
  useT();
  const [lettura, setLettura] = useState<Lettura>({ fase: "carico" });
  const [inLavoro, setInLavoro] = useState(false);
  const giro = useRef(0);

  const nome = altro.displayName === "" ? altro.username : altro.displayName;
  // La schermata rilegge l'elenco delle conversazioni ogni pochi secondi, e a
  // ogni giro `altro` è un oggetto nuovo che dice la stessa persona: il numero
  // si ricalcola quando cambia **chi**, non quando cambia l'oggetto.
  const chi = useMemo(
    () => ({ id: altro.id, username: altro.username }),
    [altro.id, altro.username],
  );

  const leggi = useCallback(async (): Promise<void> => {
    const questo = ++giro.current;
    setLettura({ fase: "carico" });
    try {
      const { dip, io } = await ambiente();
      const sicurezza = await leggiSicurezza(dip, io, membroDi(chi, io.casa));
      if (giro.current === questo) {
        setLettura({ fase: "letto", sicurezza });
      }
    } catch {
      if (giro.current === questo) {
        setLettura({ fase: "errore" });
      }
    }
  }, [ambiente, chi]);

  useEffect(() => {
    void leggi();
    return () => {
      // Una lettura che torna dopo che il pannello è passato ad altri non scrive.
      giro.current += 1;
    };
  }, [leggi]);

  const cambia = async (impronta: string | undefined): Promise<void> => {
    setInLavoro(true);
    try {
      const { dip, io } = await ambiente();
      const membro = membroDi(chi, io.casa);
      if (impronta === undefined) {
        await togliVerifica(dip.cassetto, membro);
        avvisi.successo(t("sicurezza.tolta"));
      } else {
        await segnaVerificato(dip, membro, impronta);
        avvisi.successo(t("sicurezza.segnato"));
      }
      onCambio?.();
      await leggi();
    } catch (causa: unknown) {
      avvisi.errore(causa, t("sicurezza.non_salvato"));
    } finally {
      setInLavoro(false);
    }
  };

  if (lettura.fase === "carico") {
    return (
      <div className="stack">
        <p className="muted chiavi__testo">{t("sicurezza.calcolo")}</p>
        <Live>{t("sicurezza.calcolo")}</Live>
      </div>
    );
  }

  if (lettura.fase === "errore") {
    return (
      <div className="stack">
        <Alert tone="error">
          <p className="chiavi__testo">{t("sicurezza.errore", { nome })}</p>
        </Alert>
        <div className="cluster sicurezza-azioni">
          <Button onClick={() => void leggi()} variant="secondary">
            {t("sicurezza.riprova")}
          </Button>
        </div>
      </div>
    );
  }

  const { sicurezza } = lettura;

  if (sicurezza.kind === "non-approvato") {
    return (
      <div className="stack">
        <Alert>
          <p className="chiavi__testo">{t("sicurezza.non_approvato")}</p>
        </Alert>
        <p className="chiavi__testo">
          <Link to="/impostazioni/chat">{t("sicurezza.non_approvato.vai")}</Link>
        </p>
      </div>
    );
  }

  const quando =
    sicurezza.verificatoIl === undefined ? undefined : quandoMedio(sicurezza.verificatoIl);

  const cambiato = sicurezza.stato === "cambiato" && quando !== undefined && (
    <Alert tone="error">
      <p className="chiavi__testo">
        <strong>{t("sicurezza.cambiato.titolo", { nome })}</strong>
      </p>
      <p className="chiavi__testo">{t("sicurezza.cambiato.testo", { nome, quando })}</p>
    </Alert>
  );

  const togli = sicurezza.stato !== "non-verificato" && (
    <Button disabled={inLavoro} onClick={() => void cambia(undefined)} variant="secondary">
      {inLavoro ? t("sicurezza.salvo") : t("sicurezza.togli")}
    </Button>
  );

  if (sicurezza.kind === "senza-chiavi") {
    return (
      <div className="stack">
        {cambiato}
        <Alert>
          <p className="chiavi__testo">{t("sicurezza.senza_chiavi", { nome })}</p>
        </Alert>
        <div className="cluster sicurezza-azioni">
          {togli}
          <Button onClick={() => void leggi()} variant="secondary">
            {t("sicurezza.riprova")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {cambiato}

      <div className="cluster cluster--between">
        <h3 className="gruppo">{t("sicurezza.con", { nome })}</h3>
        {sicurezza.stato === "verificato" && (
          <Badge tone="ok">{t("sicurezza.stato.verificato")}</Badge>
        )}
        {sicurezza.stato === "cambiato" && (
          <Badge tone="error">{t("sicurezza.stato.cambiato")}</Badge>
        )}
      </div>

      <p className="numero-sicurezza" data-testid="numero-di-sicurezza">
        {inGruppi(sicurezza.numero).map((gruppo, i) => (
          // Lo spazio fra i gruppi è testo vero: chi copia o ascolta uno screen
          // reader riceve dodici gruppi, non un numero di sessanta cifre.
          <span key={i}>{gruppo} </span>
        ))}
      </p>

      <p className="chiavi__testo">{t("sicurezza.come", { nome })}</p>
      <p className="muted chiavi__testo">
        {t("sicurezza.dispositivi", {
          miei: sicurezza.dispositivi.miei,
          nome,
          suoi: sicurezza.dispositivi.suoi,
        })}
      </p>

      <p className="muted chiavi__testo">
        {sicurezza.stato === "verificato" && quando !== undefined
          ? t("sicurezza.verificato", { nome, quando })
          : sicurezza.stato === "non-verificato"
            ? t("sicurezza.non_verificato")
            : ""}
      </p>

      <div className="cluster sicurezza-azioni">
        {togli}
        {sicurezza.stato !== "verificato" && (
          <Button
            disabled={inLavoro}
            onClick={() => void cambia(sicurezza.impronta)}
            variant="primary"
          >
            {inLavoro ? t("sicurezza.salvo") : t("sicurezza.segna")}
          </Button>
        )}
      </div>
    </div>
  );
}
