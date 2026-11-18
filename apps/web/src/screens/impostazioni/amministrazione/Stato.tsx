import type {
  AdminDiagnostics,
  SchemaUpgradeView,
  UpdateCheckResult,
  UpdateCommand,
} from "@estia/contracts";
import type { Chiave } from "@estia/lingue";
import { useEffect, useState } from "react";

import { api } from "../../../api.js";
import { t, tc, tf, useT } from "../../../lingua.js";
import { useSignedIn } from "../../../state.js";
import { Alert, Badge, Button } from "../../../ui/index.js";
import { Sezione } from "../Sezione.js";
import { quandoMedio as quando } from "../../../tempo.js";

const A_RIPOSO: Readonly<Record<AdminDiagnostics["atRest"]["detected"], Chiave>> = {
  active: "stato.a_riposo.active",
  inactive: "stato.a_riposo.inactive",
  unknown: "stato.a_riposo.unknown",
};

const DICHIARATA: Readonly<Record<AdminDiagnostics["atRest"]["declared"], Chiave>> = {
  automatic: "stato.dichiarata.automatic",
  none: "stato.dichiarata.none",
  passphrase: "stato.dichiarata.passphrase",
  unspecified: "stato.dichiarata.unspecified",
};

const AGGIORNAMENTO: Readonly<Record<string, Chiave>> = {
  created: "stato.aggiornamento.created",
  failed: "stato.aggiornamento.failed",
  not_configured: "stato.aggiornamento.not_configured",
};

const ORIGINI: Readonly<Record<string, Chiave>> = {
  local: "stato.origine.local",
  loopback: "stato.origine.loopback",
  overlay: "stato.origine.overlay",
  public: "stato.origine.public",
};

const DUREVOLEZZA: Readonly<Record<AdminDiagnostics["dataDurability"], Chiave>> = {
  anonymous: "stato.durevolezza.anonymous",
  ephemeral: "stato.durevolezza.ephemeral",
  persistent: "stato.durevolezza.persistent",
  unknown: "stato.durevolezza.unknown",
};

/** Una voce di una tabella fatta di chiavi, o il valore così com'è se manca. */
function voce(tabella: Readonly<Record<string, Chiave>>, valore: string): string {
  const chiave = tabella[valore];
  return chiave === undefined ? valore : t(chiave);
}

function corta(sha: string): string {
  return sha.slice(0, 7);
}

/** Un comando da terminale con un bottone che lo copia negli appunti. */
function ComandoCopiabile({ comando }: { comando: string }): React.ReactElement {
  useT();
  const [copiato, setCopiato] = useState(false);

  const copia = async (): Promise<void> => {
    try {
      // Come in InviteLink: niente Clipboard API in contesti non sicuri
      // (HTTP semplice sulla rete di casa), da cui il fallback selezionabile.
      await navigator.clipboard.writeText(comando);
      setCopiato(true);
    } catch {
      const campo = document.getElementById(`comando-${comando}`);

      if (campo instanceof HTMLInputElement) {
        campo.select();
      }
    }
  };

  return (
    <div className="cluster">
      <input className="input grow secret" id={`comando-${comando}`} readOnly value={comando} />
      <Button onClick={() => void copia()}>
        {copiato ? t("comune.copiato_breve") : t("comune.copia")}
      </Button>
    </div>
  );
}

/**
 * Un passo dell'aggiornamento: che cosa fa, il comando, e l'avvertenza.
 *
 * La nota non è decorazione. I due modi in cui un aggiornamento sembra riuscito
 * e non lo è — `docker pull` senza ricreare il container, e il `cd` nella
 * cartella sbagliata — si evitano solo leggendola.
 */
function Passo({ passo }: { passo: UpdateCommand }): React.ReactElement {
  useT();
  return (
    <div className="row">
      <span className="row__body">
        <span className="row__title">
          {tf(passo.titleFrase === undefined ? undefined : [passo.titleFrase], passo.title)}
        </span>
        <ComandoCopiabile comando={passo.command} />
        {passo.note !== undefined && (
          <span className="row__note">{tf(passo.noteFrasi, passo.note)}</span>
        )}
      </span>
    </div>
  );
}

/**
 * Il testo registrato al momento dell'aggiornamento resta vero sul fatto
 * (punto di ritorno sì/no). La raccomandazione no: dopo ADR 0016 i backup si
 * impostano dal pannello, e un'istanza che li ha già non va mandata alle
 * variabili d'ambiente. Se oggi sono configurati, lo diciamo senza fingere che
 * *quel* aggiornamento ne abbia avuto uno.
 */
function dettaglioAggiornamento(
  upgrade: SchemaUpgradeView,
  backupsOraConfigurati: boolean,
): string {
  if (upgrade.backupStatus === "not_configured" && backupsOraConfigurati) {
    return t("stato.senza_backup_ora_si");
  }

  return tf(upgrade.detailFrasi, upgrade.detail);
}

/**
 * Quello che l'istanza sa di sé, e che altrimenti resterebbe nei log.
 *
 * Il criterio è sempre lo stesso: **rosso solo dove chi amministra crede di
 * essere protetto e non lo è.** Backup non configurati è una constatazione;
 * backup configurati che non producono archivi è un allarme.
 */
export function Stato(): React.ReactElement {
  useT();
  const { token } = useSignedIn();
  const [d, setD] = useState<AdminDiagnostics | undefined>();
  const [verifica, setVerifica] = useState<UpdateCheckResult | undefined>();
  const [verificando, setVerificando] = useState(false);
  const [erroreVerifica, setErroreVerifica] = useState<string | undefined>();

  useEffect(() => {
    void api.diagnostics(token).then(setD);
  }, [token]);

  async function verificaAggiornamenti(): Promise<void> {
    setVerificando(true);
    setErroreVerifica(undefined);

    try {
      setVerifica(await api.checkUpdates(token));
    } catch (error) {
      setVerifica(undefined);
      setErroreVerifica(error instanceof Error ? error.message : t("stato.verifica_fallita"));
    } finally {
      setVerificando(false);
    }
  }

  if (d === undefined) {
    return (
      <Sezione titolo={t("sezioni.stato")}>
        <p className="muted">{t("comune.carico")}</p>
      </Sezione>
    );
  }

  return (
    <Sezione titolo={t("sezioni.stato")}>
      {/* Prima di ogni altra cosa: un'istanza che perde tutto al prossimo
          aggiornamento non ha altri problemi che contino. */}
      {d.dataDurability === "anonymous" && (
        <Alert tone="error">
          {tc("stato.anonimo", {
            titolo: <strong>{t("stato.anonimo.titolo")}</strong>,
            compose: <code>docker compose</code>,
            insostituibile: <strong>{t("stato.insostituibile")}</strong>,
          })}
        </Alert>
      )}

      {d.dataDurability === "ephemeral" && (
        <Alert tone="error">
          {tc("stato.effimero", {
            titolo: <strong>{t("stato.effimero.titolo")}</strong>,
            insostituibile: <strong>{t("stato.insostituibile")}</strong>,
          })}
        </Alert>
      )}

      {/* L'assunzione su cui poggia tutto il modello delle minacce è che questa
          istanza non sia raggiungibile da Internet. Se smette di essere vera,
          smette di esserlo in silenzio (SECURITY_BASELINE §5). */}
      {d.connections.some((visto) => visto.origin === "public") && (
        <Alert tone="error">
          {tc("stato.pubblico", {
            titolo: <strong>{t("stato.pubblico.titolo")}</strong>,
          })}
        </Alert>
      )}

      {/* Una protezione dichiarata che l'istanza non vede è la cosa più
          pericolosa da mostrare in silenzio (ADR 0007). */}
      {!d.atRest.consistent && (
        <Alert tone="error">
          {tc("stato.incoerente", {
            non_protetti: <strong>{t("stato.non_protetti")}</strong>,
          })}
        </Alert>
      )}

      <div className="card card--flush">
        <div className="row">
          <span className="row__body">
            <span className="row__title">{t("stato.dove_dati")}</span>
            <span className="row__note">{tf(d.dataDurabilityFrasi, d.dataDurabilityDetail)}</span>
          </span>
          <span className="row__end">
            <Badge tone={d.dataDurability === "persistent" ? "on" : "neutral"}>
              {t(DUREVOLEZZA[d.dataDurability])}
            </Badge>
          </span>
        </div>

        <div className="row">
          <span className="row__body">
            <span className="row__title">{t("stato.persone")}</span>
          </span>
          <span className="row__end">
            <strong>{d.memberCount}</strong>
          </span>
        </div>

        <div className="row">
          <span className="row__body">
            <span className="row__title">{t("stato.cifratura")}</span>
            <span className="row__note">{tf(d.atRest.detailFrasi, d.atRest.detail)}</span>
            {d.atRest.declared !== "unspecified" && (
              <span className="row__note">
                {t("stato.dichiarata", { come: t(DICHIARATA[d.atRest.declared]) })}
              </span>
            )}
          </span>
          <span className="row__end">
            <Badge tone={d.atRest.consistent && d.atRest.detected === "active" ? "on" : "neutral"}>
              {t(A_RIPOSO[d.atRest.detected])}
            </Badge>
          </span>
        </div>

        <div className="row">
          <span className="row__body">
            <span className="row__title">{t("stato.connessioni")}</span>
            <span className="row__note">
              {d.connections.length === 0
                ? t("stato.niente_da_dire")
                : d.connections
                    .map((visto) => `${voce(ORIGINI, visto.origin)}: ${String(visto.count)}`)
                    .join(" · ")}
            </span>
            <span className="row__note">{t("stato.conta_tipi")}</span>
          </span>
        </div>

        {/* Solo quando manca: una directory con i permessi giusti è la norma, e
            dirlo ogni volta la trasformerebbe in rumore. */}
        {!d.dataDirectorySecure && (
          <div className="row">
            <span className="row__body">
              <span className="row__title">{t("stato.permessi")}</span>
              <span className="row__note">{t("stato.permessi.testo")}</span>
            </span>
            <span className="row__end">
              <Badge>{t("stato.troppo_aperti")}</Badge>
            </span>
          </div>
        )}

        {/* Le migrazioni vanno solo in avanti: un aggiornamento applicato senza
            backup resta senza punto di ritorno per sempre (ADR 0014).
            Rosso solo su «failed»: chi non aveva configurato i backup lo sa;
            chi li aveva e sono falliti crede di essere protetto e non lo è. */}
        {d.lastUpgrade !== undefined && (
          <div className="row">
            <span className="row__body">
              <span className="row__title">{t("stato.ultimo_schema")}</span>
              <span className="row__note">
                {t("stato.versione", {
                  da: d.lastUpgrade.fromVersion,
                  a: d.lastUpgrade.toVersion,
                  quando: quando(d.lastUpgrade.appliedAt),
                })}
              </span>
              <span className="row__note">
                {dettaglioAggiornamento(d.lastUpgrade, d.backups.health !== "not_configured")}
              </span>
            </span>
            <span className="row__end">
              <Badge
                tone={
                  d.lastUpgrade.backupStatus === "created"
                    ? "on"
                    : d.lastUpgrade.backupStatus === "failed"
                      ? "error"
                      : "neutral"
                }
              >
                {voce(AGGIORNAMENTO, d.lastUpgrade.backupStatus)}
              </Badge>
            </span>
          </div>
        )}
      </div>

      {/* Controlla il registry e scrive i comandi di questa installazione.
          Aggiornare resta un gesto sul Docker della macchina: l'istanza non ha
          il socket di Docker, e non deve averlo. */}
      <div className="card">
        <h2>{t("stato.aggiornamenti")}</h2>
        <p className="muted">
          {tc("stato.aggiornamenti.intro", { comando: <code>estia aggiorna</code> })}
        </p>

        <div className="row">
          <span className="row__body">
            <Button disabled={verificando} onClick={() => void verificaAggiornamenti()}>
              {verificando ? t("stato.verifico") : t("stato.verifica")}
            </Button>
          </span>
          {verifica !== undefined && (
            <span className="row__end">
              <Badge
                tone={
                  verifica.status === "available"
                    ? "error"
                    : verifica.status === "up_to_date"
                      ? "on"
                      : "neutral"
                }
              >
                {verifica.status === "available"
                  ? t("stato.disponibile")
                  : verifica.status === "up_to_date"
                    ? t("stato.aggiornato")
                    : t("stato.non_verificabile")}
              </Badge>
            </span>
          )}
        </div>

        {erroreVerifica !== undefined && <Alert tone="error">{erroreVerifica}</Alert>}

        {verifica !== undefined && (
          <>
            <p className="muted">{tf(verifica.detailFrasi, verifica.detail)}</p>
            {verifica.currentRevision !== undefined && (
              <p className="muted">
                {tc("stato.revisione", {
                  revisione: <code>{corta(verifica.currentRevision)}</code>,
                })}
                {verifica.latestRevision !== undefined && (
                  <>
                    {" "}
                    {tc("stato.registry", {
                      revisione: <code>{corta(verifica.latestRevision)}</code>,
                    })}
                  </>
                )}
              </p>
            )}
          </>
        )}

        {/* Quando un aggiornamento è disponibile o non verificabile, mostra il comando estia in primo piano: */}
        {verifica !== undefined &&
          verifica.status !== "up_to_date" &&
          verifica.commands.length > 0 && (
            <>
              {verifica.commands[0]?.command === "estia aggiorna" ? (
                <>
                  <div className="card card--flush">
                    <div className="row">
                      <span className="row__body">
                        <span className="row__title">{t("stato.comando")}</span>
                        <ComandoCopiabile comando="estia aggiorna" />
                        <span className="row__note">{t("stato.comando.nota")}</span>
                      </span>
                    </div>
                  </div>

                  {verifica.commands.length > 1 && (
                    <details style={{ marginTop: "var(--s-3)" }}>
                      <summary
                        style={{
                          cursor: "pointer",
                          color: "var(--text-soft)",
                          fontSize: "var(--t-md)",
                          padding: "var(--s-1) 0",
                        }}
                      >
                        {t("stato.passi_manuali")}
                      </summary>
                      <div className="card card--flush" style={{ marginTop: "var(--s-2)" }}>
                        {verifica.commands.slice(1).map((passo) => (
                          <Passo key={passo.command} passo={passo} />
                        ))}
                      </div>
                    </details>
                  )}
                </>
              ) : (
                <div className="card card--flush">
                  {verifica.commands.map((passo) => (
                    <Passo key={passo.command} passo={passo} />
                  ))}
                </div>
              )}
            </>
          )}
      </div>
    </Sezione>
  );
}
