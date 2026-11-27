import type { AuthenticatedUser } from "@estia/contracts";
import { useState } from "react";

import { useT } from "../lingua.js";
import { entraConCollegamento } from "../piattaforma/app.js";
import { Alert, Button, TextField } from "../ui/index.js";

/**
 * La prima schermata dell'app ([ADR 0044](../../../../docs/adr/0044-il-dispositivo-e-l-app.md)):
 * il dispositivo non ha ancora una Casa, e la riceve da un collegamento
 * d'ingresso con un codice monouso. Niente nome utente e password: da fuori la
 * Casa si raggiunge solo per chiave.
 */
export function IngressoApp({
  erroreCassaforte,
  onEntrato,
}: {
  erroreCassaforte: string | null;
  onEntrato: (utente: AuthenticatedUser) => void;
}): React.ReactElement {
  const { t } = useT();
  const [collegamento, setCollegamento] = useState("");
  const [errore, setErrore] = useState<string | undefined>();
  const [occupato, setOccupato] = useState(false);

  const collega = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setOccupato(true);
    setErrore(undefined);
    try {
      const utente = await entraConCollegamento(
        collegamento,
        navigator.userAgent.includes("Mobile")
          ? t("comune.dispositivo.telefono")
          : t("comune.dispositivo.computer"),
      );
      onEntrato(utente as AuthenticatedUser);
    } catch (causa) {
      const testo = String(causa);
      setErrore(
        /non risponde|collegamento alla Casa/.test(testo)
          ? t("ingresso_app.non_raggiungibile")
          : t("ingresso_app.non_accettato"),
      );
    } finally {
      setOccupato(false);
    }
  };

  return (
    <main className="column column--narrow stack">
      <div className="card">
        <h1>{t("ingresso_app.titolo")}</h1>
        <p className="muted">{t("ingresso_app.spiegazione")}</p>

        {erroreCassaforte !== null && (
          <Alert tone="error">{t("ingresso_app.cassaforte", { motivo: erroreCassaforte })}</Alert>
        )}
        {errore !== undefined && <Alert tone="error">{errore}</Alert>}

        <form onSubmit={(event) => void collega(event)}>
          <TextField
            autoCapitalize="none"
            autoCorrect="off"
            label={t("ingresso_app.collegamento")}
            onChange={(event) => setCollegamento(event.target.value)}
            required
            spellCheck={false}
            value={collegamento}
          />
          <Button block disabled={occupato || erroreCassaforte !== null} type="submit">
            {occupato ? t("ingresso_app.collego") : t("ingresso_app.collega")}
          </Button>
        </form>
      </div>
    </main>
  );
}
