import { useEffect, useId, useState } from "react";

import { api } from "../../api.js";
import { t, useT } from "../../lingua.js";
import { useSignedIn } from "../../state.js";
import { Avatar, Icon } from "../../ui/index.js";

/** Una persona trovata: di questa casa, o di un'altra con la sua chiave. */
export interface Persona {
  username: string;
  displayName: string;
  /** La chiave della sua casa. Assente = questa casa. */
  instanceKey?: string | undefined;
  /** Da dove la conosciamo, se abita altrove. */
  tramite?: string | undefined;
}

export const chiaveDi = (persona: Pick<Persona, "username" | "instanceKey">): string =>
  `${persona.instanceKey ?? ""}:${persona.username}`;

const ATTESA_MS = 120;
const MINIMO = 2;

/**
 * Cerca una persona da mettere in un gruppo: in questa casa e nella rete.
 *
 * È la stessa ricerca con cui `Messaggi` fa partire una conversazione, con la
 * stessa regola: dalla rete si prendono solo le persone di altre case, perché
 * i «locali» di quell'ambito sono soltanto chi si mostra fuori, e sostituirli
 * a quelli della ricerca in casa nasconderebbe proprio chi abita qui.
 */
export function CercaPersone({
  escludi,
  etichetta,
  onScegli,
}: {
  /** Chi non va proposto: è già scelto, o è già nel gruppo. Per `chiaveDi`. */
  escludi: ReadonlySet<string>;
  etichetta: string;
  onScegli: (persona: Persona) => void;
}): React.ReactElement {
  useT();
  const { token, user } = useSignedIn();
  const id = useId();
  const [termine, setTermine] = useState("");
  const [cercando, setCercando] = useState(false);
  const [trovati, setTrovati] = useState<Persona[] | undefined>();

  useEffect(() => {
    const cercabile = termine.trim();
    if (cercabile.length < MINIMO) {
      setTrovati(undefined);
      setCercando(false);
      return;
    }

    const annulla = new AbortController();
    const attesa = setTimeout(() => {
      setCercando(true);

      const inCasa = api
        .searchProfiles(token, cercabile, "istanza", annulla.signal)
        .then((res) =>
          res.locali.map((l): Persona => ({ displayName: l.displayName, username: l.username })),
        )
        .catch((): Persona[] => []);
      const inRete = api
        .searchProfiles(token, cercabile, "rete", annulla.signal)
        .then((res) =>
          res.remoti.map((r): Persona => ({
            displayName: r.displayName,
            instanceKey: r.instanceKey,
            tramite: r.tramite,
            username: r.username,
          })),
        )
        .catch((): Persona[] => []);

      void Promise.all([inCasa, inRete]).then(([locali, remoti]) => {
        if (!annulla.signal.aborted) {
          setTrovati([...locali, ...remoti]);
          setCercando(false);
        }
      });
    }, ATTESA_MS);

    return () => {
      clearTimeout(attesa);
      annulla.abort();
    };
  }, [termine, token]);

  const proponibili = trovati?.filter(
    (p) =>
      !escludi.has(chiaveDi(p)) && !(p.instanceKey === undefined && p.username === user.username),
  );

  return (
    <div className="stack stack--tight">
      <label className="field__label" htmlFor={id}>
        {etichetta}
      </label>
      <div className="cluster" style={{ flexWrap: "nowrap", gap: "var(--s-2)" }}>
        <Icon name="search" size={18} />
        <input
          autoComplete="off"
          className="input grow"
          id={id}
          onChange={(event) => setTermine(event.target.value)}
          placeholder={t("messaggi.cerca.segnaposto")}
          type="search"
          value={termine}
        />
      </div>
      <div aria-live="polite">
        {cercando && proponibili === undefined && <p className="muted">{t("cerca.cerco")}</p>}
        {proponibili !== undefined && proponibili.length === 0 && !cercando && (
          <p className="muted">{t("gruppi.cerca.nessuno")}</p>
        )}
      </div>
      {proponibili !== undefined && proponibili.length > 0 && (
        <div className="card card--flush">
          {proponibili.map((persona) => (
            <button
              className="row"
              key={chiaveDi(persona)}
              onClick={() => {
                onScegli(persona);
                setTermine("");
              }}
              type="button"
            >
              <span className="row__body">
                <span className="cluster" style={{ flexWrap: "nowrap", gap: "var(--s-3)" }}>
                  <Avatar displayName={persona.displayName} size="sm" username={persona.username} />
                  <span
                    className="stack stack--tight"
                    style={{ alignItems: "flex-start", gap: 0, minWidth: 0 }}
                  >
                    <span className="row__title truncate">{persona.displayName}</span>
                    <span className="row__note truncate">
                      @{persona.username}
                      {persona.instanceKey !== undefined &&
                        ` · ${persona.tramite ?? t("messaggi.rete")}`}
                    </span>
                  </span>
                </span>
              </span>
              <span className="row__end">
                <Icon name="plus" size={20} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
