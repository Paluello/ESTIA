import type { AuthorView, ConversazioneView } from "@estia/contracts";
import { useEffect, useState } from "react";

import { t, tn, useT } from "../../lingua.js";
import { Alert, Avatar, Badge, Button, Icon, Sheet } from "../../ui/index.js";
import { CercaPersone, type Persona } from "./CercaPersone.js";
import { gestiSu, gestisce, nomeDi, ruoloDi } from "./logica.js";

/** Che cosa la schermata sa fare per il pannello. Ogni gesto dice com'è andato da sé. */
export interface GestiDelGruppo {
  aggiungi: (persona: Persona) => Promise<void>;
  togli: (autore: AuthorView) => Promise<void>;
  cambiaRuolo: (autore: AuthorView, ruolo: "amministratore" | "membro") => Promise<void>;
  /** Fa entrare nel gruppo cifrato chi è fra i membri ma non ha ancora una foglia. */
  faiEntrare: (autore: AuthorView) => Promise<void>;
  esci: () => Promise<void>;
}

type Vista =
  | { kind: "elenco" }
  | { kind: "persona"; id: string }
  | { kind: "cerca" }
  | { kind: "conferma-aggiungi"; persona: Persona }
  | { kind: "conferma-togli"; id: string }
  | { kind: "conferma-esci" };

/**
 * Le persone di un gruppo, e ciò che si può fare con loro.
 *
 * Una vista, un lavoro (euristica 8): l'elenco, una persona, la ricerca, e una
 * conferma per ciascuno dei tre gesti che cambiano chi legge. Le conferme non
 * sono un «sei sicuro?»: dicono **che cosa succede a chi legge**, che è la
 * cosa che un gruppo cifrato deve dire e che nessuno indovina.
 *
 * - **Aggiungere** è un momento dichiarato: chi entra legge anche quello che è
 *   stato scritto prima, e chi c'è lo vede scritto nella conversazione.
 * - **Togliere** dice la verità: chi viene tolto non riceverà più i messaggi
 *   nuovi. Non dice che «non potrà più leggere», perché quello che ha già
 *   letto l'ha letto, e nessuna crittografia glielo toglie.
 */
export function MembriGruppo({
  aperto,
  conversazione,
  ioId,
  assenti,
  casa,
  gesti,
  iniziale,
  onChiudi,
}: {
  aperto: boolean;
  conversazione: ConversazioneView;
  ioId: string;
  /** Gli id di chi è fra i membri ma non è ancora entrato nel gruppo cifrato. */
  assenti: ReadonlySet<string>;
  /** La chiave di questa casa, quando si sa: serve a non riproporre chi c'è già. */
  casa: string | undefined;
  gesti: GestiDelGruppo;
  /** Da dove si parte: l'elenco, o la conferma dell'uscita se si arriva dal menu. */
  iniziale?: "elenco" | "conferma-esci";
  onChiudi: () => void;
}): React.ReactElement {
  useT();
  const [vista, setVista] = useState<Vista>({ kind: "elenco" });
  /** Che cosa si sta facendo, detto a parole: spegne i controlli e si legge. */
  const [lavoro, setLavoro] = useState<string | undefined>();

  useEffect(() => {
    if (aperto) {
      setVista({ kind: iniziale ?? "elenco" });
    }
  }, [aperto, iniziale]);

  const io = gestisce(conversazione, ioId);
  const elenco: Vista = { kind: "elenco" };

  /** Un gesto: si dice che cosa si fa, lo si fa, e si torna all'elenco. */
  const fai = async (etichetta: string, gesto: () => Promise<void>): Promise<void> => {
    setLavoro(etichetta);
    try {
      await gesto();
      setVista(elenco);
    } finally {
      setLavoro(undefined);
    }
  };

  const persona =
    vista.kind === "persona" || vista.kind === "conferma-togli"
      ? conversazione.membri.find((m) => m.id === vista.id)
      : undefined;

  const giaDentro = new Set(
    conversazione.membri.map((m) => {
      const altrove = m.id.startsWith("remote:") ? m.id.split(":")[1] : undefined;
      return `${altrove === undefined || altrove === casa ? "" : altrove}:${m.username}`;
    }),
  );

  const indietro = (
    <div className="cluster">
      <Button
        disabled={lavoro !== undefined}
        icon="arrow-left"
        onClick={() => setVista(elenco)}
        variant="quiet"
      >
        {t("comune.indietro")}
      </Button>
    </div>
  );

  const stato = (
    <p aria-live="polite" className="muted chiavi__testo">
      {lavoro ?? ""}
    </p>
  );

  return (
    <Sheet
      onClose={onChiudi}
      open={aperto}
      title={tn("gruppi.membri.titolo", conversazione.membri.length)}
      variant="centrato"
    >
      {aperto && (
        <div className="feed-pad stack">
          {vista.kind === "elenco" && (
            <>
              {assenti.size > 0 && (
                <Alert tone="neutral">
                  <p className="chiavi__testo">
                    {io ? t("gruppi.assenti.gestisci") : t("gruppi.assenti.aspetta")}
                  </p>
                </Alert>
              )}
              <ul className="card card--flush gruppi-elenco">
                {conversazione.membri.map((autore) => {
                  const ruolo = ruoloDi(conversazione, autore.id);
                  const gestiPossibili = gestiSu(conversazione, ioId, autore.id);
                  const apribile =
                    gestiPossibili.togliere ||
                    gestiPossibili.nominare ||
                    gestiPossibili.revocare ||
                    (io && assenti.has(autore.id));
                  const corpo = (
                    <>
                      <span className="row__body">
                        <span className="cluster" style={{ flexWrap: "nowrap", gap: "var(--s-3)" }}>
                          <Avatar
                            displayName={nomeDi(autore)}
                            size="sm"
                            username={autore.username}
                          />
                          <span
                            className="stack stack--tight"
                            style={{ alignItems: "flex-start", gap: 0, minWidth: 0 }}
                          >
                            <span className="row__title truncate">
                              {autore.id === ioId
                                ? t("gruppi.membri.tu", { nome: nomeDi(autore) })
                                : nomeDi(autore)}
                            </span>
                            <span className="row__note truncate">
                              {assenti.has(autore.id)
                                ? t("gruppi.membri.non_entrato")
                                : `@${autore.username}`}
                            </span>
                          </span>
                        </span>
                      </span>
                      <span className="row__end">
                        {ruolo !== "membro" && (
                          <Badge tone="on">{t(`gruppi.ruolo.${ruolo}`)}</Badge>
                        )}
                        {apribile && <Icon name="chevron-right" size={18} />}
                      </span>
                    </>
                  );

                  return (
                    <li key={autore.id}>
                      {apribile ? (
                        <button
                          className="row"
                          onClick={() => setVista({ id: autore.id, kind: "persona" })}
                          type="button"
                        >
                          {corpo}
                        </button>
                      ) : (
                        <div className="row gruppi-elenco__riga">{corpo}</div>
                      )}
                    </li>
                  );
                })}
              </ul>

              <div className="stack stack--tight">
                {io && (
                  <Button
                    icon="plus"
                    onClick={() => setVista({ kind: "cerca" })}
                    variant="secondary"
                  >
                    {t("gruppi.aggiungi.voce")}
                  </Button>
                )}
                <Button
                  icon="logout"
                  onClick={() => setVista({ kind: "conferma-esci" })}
                  variant="quiet"
                >
                  {t("gruppi.esci.voce")}
                </Button>
              </div>
            </>
          )}

          {vista.kind === "persona" && persona !== undefined && (
            <>
              {indietro}
              <div className="cluster" style={{ flexWrap: "nowrap", gap: "var(--s-3)" }}>
                <Avatar displayName={nomeDi(persona)} size="md" username={persona.username} />
                <div className="stack stack--tight" style={{ gap: 0, minWidth: 0 }}>
                  <strong className="truncate">{nomeDi(persona)}</strong>
                  <span className="muted truncate">@{persona.username}</span>
                </div>
              </div>

              {assenti.has(persona.id) && (
                <Alert tone="neutral">
                  <p className="chiavi__testo">
                    {t("gruppi.entra.spiegazione", { nome: nomeDi(persona) })}
                  </p>
                </Alert>
              )}

              <div className="stack stack--tight">
                {io && assenti.has(persona.id) && (
                  <Button
                    disabled={lavoro !== undefined}
                    onClick={() =>
                      void fai(t("gruppi.entra.lavoro", { nome: nomeDi(persona) }), () =>
                        gesti.faiEntrare(persona),
                      )
                    }
                    variant="primary"
                  >
                    {t("gruppi.entra.voce")}
                  </Button>
                )}
                {gestiSu(conversazione, ioId, persona.id).nominare && (
                  <Button
                    disabled={lavoro !== undefined}
                    onClick={() =>
                      void fai(t("comune.un_momento"), () =>
                        gesti.cambiaRuolo(persona, "amministratore"),
                      )
                    }
                    variant="secondary"
                  >
                    {t("gruppi.ruolo.nomina")}
                  </Button>
                )}
                {gestiSu(conversazione, ioId, persona.id).revocare && (
                  <Button
                    disabled={lavoro !== undefined}
                    onClick={() =>
                      void fai(t("comune.un_momento"), () => gesti.cambiaRuolo(persona, "membro"))
                    }
                    variant="secondary"
                  >
                    {t("gruppi.ruolo.revoca")}
                  </Button>
                )}
                {gestiSu(conversazione, ioId, persona.id).togliere && (
                  <Button
                    disabled={lavoro !== undefined}
                    onClick={() => setVista({ id: persona.id, kind: "conferma-togli" })}
                    variant="danger"
                  >
                    {t("gruppi.togli.voce")}
                  </Button>
                )}
              </div>
              <p className="muted chiavi__testo">{t("gruppi.ruolo.spiegazione")}</p>
              {stato}
            </>
          )}

          {vista.kind === "cerca" && (
            <>
              {indietro}
              <p className="muted chiavi__testo">{t("gruppi.aggiungi.spiegazione")}</p>
              <CercaPersone
                escludi={giaDentro}
                etichetta={t("gruppi.aggiungi.cerca")}
                onScegli={(scelta) => setVista({ kind: "conferma-aggiungi", persona: scelta })}
              />
            </>
          )}

          {vista.kind === "conferma-aggiungi" && (
            <>
              <h3 className="gruppo">
                {t("gruppi.aggiungi.titolo", { nome: vista.persona.displayName })}
              </h3>
              <p className="chiavi__testo">
                {t("gruppi.aggiungi.testo", { nome: vista.persona.displayName })}
              </p>
              {stato}
              <div className="cluster cluster--end">
                <Button
                  disabled={lavoro !== undefined}
                  onClick={() => setVista({ kind: "cerca" })}
                  variant="secondary"
                >
                  {t("comune.annulla")}
                </Button>
                <Button
                  disabled={lavoro !== undefined}
                  onClick={() =>
                    void fai(t("gruppi.aggiungi.lavoro", { nome: vista.persona.displayName }), () =>
                      gesti.aggiungi(vista.persona),
                    )
                  }
                  variant="primary"
                >
                  {lavoro === undefined ? t("gruppi.aggiungi.conferma") : t("comune.un_momento")}
                </Button>
              </div>
            </>
          )}

          {vista.kind === "conferma-togli" && persona !== undefined && (
            <>
              <h3 className="gruppo">{t("gruppi.togli.titolo", { nome: nomeDi(persona) })}</h3>
              <p className="chiavi__testo">{t("gruppi.togli.testo", { nome: nomeDi(persona) })}</p>
              {stato}
              <div className="cluster cluster--end">
                <Button
                  disabled={lavoro !== undefined}
                  onClick={() => setVista({ id: persona.id, kind: "persona" })}
                  variant="secondary"
                >
                  {t("comune.annulla")}
                </Button>
                <Button
                  disabled={lavoro !== undefined}
                  onClick={() =>
                    void fai(t("gruppi.togli.lavoro", { nome: nomeDi(persona) }), () =>
                      gesti.togli(persona),
                    )
                  }
                  variant="danger"
                >
                  {lavoro === undefined ? t("gruppi.togli.conferma") : t("comune.un_momento")}
                </Button>
              </div>
            </>
          )}

          {vista.kind === "conferma-esci" && (
            <>
              <h3 className="gruppo">{t("gruppi.esci.titolo")}</h3>
              <p className="chiavi__testo">{t("gruppi.esci.testo")}</p>
              {stato}
              <div className="cluster cluster--end">
                <Button
                  disabled={lavoro !== undefined}
                  onClick={() => setVista(elenco)}
                  variant="secondary"
                >
                  {t("comune.annulla")}
                </Button>
                <Button
                  disabled={lavoro !== undefined}
                  onClick={() => void fai(t("gruppi.esci.lavoro"), () => gesti.esci())}
                  variant="danger"
                >
                  {lavoro === undefined ? t("gruppi.esci.conferma") : t("comune.un_momento")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
