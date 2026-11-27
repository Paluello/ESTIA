import { MAX_NOME_GRUPPO, type ConversazioneView } from "@estia/contracts";
import { useEffect, useState } from "react";

import { api } from "../../api.js";
import { useAvvisi } from "../../avvisi.js";
import { t, tn, useT } from "../../lingua.js";
import { useSignedIn } from "../../state.js";
import { Avatar, Button, IconButton, Sheet, TextField } from "../../ui/index.js";
import { CercaPersone, chiaveDi, type Persona } from "./CercaPersone.js";
import { comeInput, mancaPerCreare } from "./logica.js";

/**
 * Creare un gruppo: un nome, e almeno due altre persone.
 *
 * Il pulsante resta spento finché manca qualcosa, e **dice che cosa manca**
 * (euristiche 5 e 1): un «Crea» acceso che poi risponde «un gruppo ha almeno
 * tre persone» è lo stato che sembra pronto e non lo è.
 */
export function NuovoGruppo({
  aperto,
  casa,
  onChiudi,
  onCreato,
}: {
  aperto: boolean;
  /** La chiave di questa casa: serve a dire chi abita qui e chi altrove. */
  casa: () => Promise<string>;
  onChiudi: () => void;
  onCreato: (conversazione: ConversazioneView) => void;
}): React.ReactElement {
  useT();
  const { token } = useSignedIn();
  const { errore: mostraErrore } = useAvvisi();
  const [nome, setNome] = useState("");
  const [scelti, setScelti] = useState<Persona[]>([]);
  const [creando, setCreando] = useState(false);

  useEffect(() => {
    if (!aperto) {
      setNome("");
      setScelti([]);
    }
  }, [aperto]);

  const manca = mancaPerCreare(nome, scelti.length);

  const crea = async (evento: React.FormEvent): Promise<void> => {
    evento.preventDefault();
    if (manca !== undefined || creando) {
      return;
    }

    setCreando(true);
    try {
      const qui = await casa();
      const { conversazione } = await api.creaGruppo(token, {
        membri: scelti.map((p) => comeInput(p, qui)),
        nome: nome.trim(),
      });
      onCreato(conversazione);
    } catch (causa) {
      mostraErrore(causa, t("gruppi.nuovo.errore"));
    } finally {
      setCreando(false);
    }
  };

  return (
    <Sheet onClose={onChiudi} open={aperto} title={t("gruppi.nuovo.titolo")} variant="centrato">
      {aperto && (
        <form className="feed-pad stack" onSubmit={(e) => void crea(e)}>
          <p className="muted chiavi__testo">{t("gruppi.nuovo.spiegazione")}</p>

          <TextField
            autoFocus
            label={t("gruppi.nuovo.nome")}
            maxLength={MAX_NOME_GRUPPO}
            onChange={(e) => setNome(e.target.value)}
            value={nome}
          />

          {scelti.length > 0 && (
            <div className="stack stack--tight">
              <h3 className="gruppo">{tn("gruppi.nuovo.scelti", scelti.length)}</h3>
              <ul className="card card--flush gruppi-elenco">
                {scelti.map((persona) => (
                  <li className="row gruppi-elenco__riga" key={chiaveDi(persona)}>
                    <span className="row__body">
                      <span className="cluster" style={{ flexWrap: "nowrap", gap: "var(--s-3)" }}>
                        <Avatar
                          displayName={persona.displayName}
                          size="sm"
                          username={persona.username}
                        />
                        <span className="row__title truncate">{persona.displayName}</span>
                      </span>
                    </span>
                    <span className="row__end">
                      <IconButton
                        icon="close"
                        label={t("gruppi.nuovo.togli", { nome: persona.displayName })}
                        onClick={() =>
                          setScelti((prima) =>
                            prima.filter((p) => chiaveDi(p) !== chiaveDi(persona)),
                          )
                        }
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <CercaPersone
            escludi={new Set(scelti.map(chiaveDi))}
            etichetta={t("gruppi.nuovo.cerca")}
            onScegli={(persona) => setScelti((prima) => [...prima, persona])}
          />

          <p aria-live="polite" className="muted chiavi__testo">
            {creando
              ? t("gruppi.nuovo.creo")
              : manca === "nome"
                ? t("gruppi.nuovo.manca_nome")
                : manca === "persone"
                  ? t("gruppi.nuovo.manca_persone")
                  : manca === "troppe"
                    ? t("gruppi.nuovo.troppe")
                    : t("gruppi.nuovo.pronto", { n: scelti.length + 1 })}
          </p>

          <div className="cluster cluster--end">
            <Button disabled={creando} onClick={onChiudi} type="button" variant="secondary">
              {t("comune.annulla")}
            </Button>
            <Button disabled={manca !== undefined || creando} type="submit" variant="primary">
              {creando ? t("gruppi.nuovo.creo") : t("gruppi.nuovo.crea")}
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
