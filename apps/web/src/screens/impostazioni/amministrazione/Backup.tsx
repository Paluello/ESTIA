import type {
  AdminDiagnostics,
  BackupArchiveView,
  BackupReport,
  BackupSettingsView,
} from "@estia/contracts";
import type { Chiave } from "@estia/lingue";
import { useCallback, useEffect, useState } from "react";

import { api } from "../../../api.js";
import { spiega } from "../../../errori.js";
import { t, tc, tf, useT } from "../../../lingua.js";
import { useSignedIn } from "../../../state.js";
import { Alert, Badge, Button, Live, TextField } from "../../../ui/index.js";
import { Sezione } from "../Sezione.js";
import { quandoMedio as quando } from "../../../tempo.js";

/**
 * Backup dal pannello, senza terminale (ADR 0016).
 *
 * Tre sezioni, un lavoro ciascuna: se stanno funzionando, ogni quanto,
 * gli archivi da portarsi via. Il ripristino non sta qui di proposito.
 */

/** Rosso solo dove chi amministra crede di essere protetto e non lo è. */
const ALLARMANTI = new Set(["missing", "stale"]);

const SALUTE: Readonly<Record<BackupReport["health"], Chiave>> = {
  healthy: "backup.salute.healthy",
  missing: "backup.salute.missing",
  not_configured: "backup.salute.not_configured",
  stale: "backup.salute.stale",
  waiting: "backup.salute.waiting",
};

type Lavoro = "genera" | "salva" | "esegui" | `scarica:${string}`;

/** Che cosa sta succedendo, detto a chi non vede l'etichetta del pulsante. */
function durante(lavoro: Lavoro): string {
  switch (lavoro) {
    case "genera":
      return t("backup.genero_coppia");
    case "salva":
      return t("backup.salvo_impostazioni");
    case "esegui":
      return t("backup.scrivo_ora");
    default:
      return t("backup.preparo_download");
  }
}

function dimensione(byte: number): string {
  return byte < 1024 * 1024
    ? t("backup.kb", { n: Math.round(byte / 1024) })
    : t("backup.mb", { n: Math.round((byte / (1024 * 1024)) * 10) / 10 });
}

function eAggiornamento(name: string): boolean {
  return name.startsWith("estia-aggiornamento-");
}

function tonoSalute(health: BackupReport["health"]): "on" | "error" | "neutral" {
  if (health === "healthy" || health === "waiting") {
    return "on";
  }

  if (ALLARMANTI.has(health)) {
    return "error";
  }

  return "neutral";
}

export function Backup(): React.ReactElement {
  useT();
  const { token } = useSignedIn();
  const [diagnostica, setDiagnostica] = useState<AdminDiagnostics | undefined>();
  const [settings, setSettings] = useState<BackupSettingsView | undefined>();
  const [archives, setArchives] = useState<BackupArchiveView[]>([]);
  const [publicKey, setPublicKey] = useState("");
  const [intervalHours, setIntervalHours] = useState(24);
  const [keep, setKeep] = useState(7);
  const [privateKey, setPrivateKey] = useState<string | undefined>();
  const [modificaChiave, setModificaChiave] = useState(false);
  const [password, setPassword] = useState("");
  const [lavoro, setLavoro] = useState<Lavoro | undefined>();
  const [esito, setEsito] = useState<string | undefined>();
  const [errore, setErrore] = useState<string | undefined>();

  const carica = useCallback(async () => {
    const [diag, current, list] = await Promise.all([
      api.diagnostics(token),
      api.backupSettings(token),
      api.backupArchives(token),
    ]);

    setDiagnostica(diag);
    setSettings(current);
    setArchives(list.archives);
    setPublicKey(current.publicKey ?? "");
    setIntervalHours(current.intervalHours);
    setKeep(current.keep);
    setModificaChiave(false);
  }, [token]);

  useEffect(() => {
    void carica();
  }, [carica]);

  const busy = lavoro !== undefined;
  const report = diagnostica?.backups;

  const esegui = async (id: Lavoro, detto: string, work: () => Promise<void>): Promise<void> => {
    setLavoro(id);
    setErrore(undefined);
    setEsito(undefined);

    try {
      await work();
      setEsito(detto);
    } catch (caught) {
      setErrore(spiega(caught, t("backup.errore")));
    } finally {
      setLavoro(undefined);
    }
  };

  const genera = (): Promise<void> =>
    esegui("genera", t("backup.coppia_generata"), async () => {
      const pair = await api.createBackupKeys(token);

      setPrivateKey(pair.privateKey);
      setPublicKey(pair.publicKey);
      setModificaChiave(true);
    });

  const salva = (): Promise<void> =>
    esegui("salva", t("backup.salvato"), async () => {
      const saved = await api.saveBackupSettings(token, {
        intervalHours,
        keep,
        publicKey,
        ...(password === "" ? {} : { password }),
      });

      setSettings(saved);
      setPrivateKey(undefined);
      setModificaChiave(false);
      setPassword("");
      await carica();
    });

  const eseguiOra = (): Promise<void> =>
    esegui("esegui", t("backup.scritto"), async () => {
      await api.runBackup(token);
      await carica();
    });

  const scarica = (name: string): Promise<void> =>
    esegui(`scarica:${name}`, t("backup.download_avviato"), async () => {
      const blob = await api.downloadBackup(token, name);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    });

  if (settings === undefined || report === undefined) {
    return (
      <Sezione titolo={t("sezioni.backup")}>
        <p className="muted">{t("comune.carico")}</p>
      </Sezione>
    );
  }

  const configurati = settings.configured;
  const modificabili = settings.editable;
  // Prima volta, oppure chi ha scelto «Cambia…»: la chiave è in vista.
  const chiaveInVista = !configurati || modificaChiave;

  return (
    <Sezione titolo={t("sezioni.backup")}>
      {/*
        `Live` c'è sempre e porta lavoro ed esito; l'errore lo annuncia il
        `role="alert"` del suo tono. Un `aria-live` sull'`Alert` non
        funzionerebbe — vedi `Feedback.tsx`.
      */}
      <Live>{lavoro !== undefined ? durante(lavoro) : (esito ?? "")}</Live>

      {(errore !== undefined || esito !== undefined) && (
        <Alert tone={errore === undefined ? "ok" : "error"}>{errore ?? esito}</Alert>
      )}

      {/* 1. Come stanno andando — una riga, niente nomi di file. */}
      <div className="card card--flush">
        <div className="row">
          <span className="row__body">
            <span className="row__title">{t("backup.stato")}</span>
            <span className="row__note">{tf(report.detailFrasi, report.detail)}</span>
          </span>
          <span className="row__end">
            <Badge tone={tonoSalute(report.health)}>{t(SALUTE[report.health])}</Badge>
          </span>
        </div>

        {report.memoryWarning !== undefined && (
          <Alert>{tf(report.memoryWarningFrasi, report.memoryWarning)}</Alert>
        )}

        {ALLARMANTI.has(report.health) && (
          <Alert tone="error">
            {tc("backup.non_funzionano", {
              forte: <strong>{t("backup.non_funzionano.forte")}</strong>,
            })}
          </Alert>
        )}
      </div>

      {/* 2. Frequenza e chiave — un lavoro: farli partire o regolarli. */}
      <div className="card">
        <h2>{configurati ? t("backup.frequenza") : t("backup.attiva")}</h2>

        {!configurati && <p className="muted">{t("backup.serve_coppia")}</p>}

        {!modificabili && <Alert>{t("backup.da_ambiente")}</Alert>}

        {configurati && (
          <p className="muted">
            {t("backup.riassunto", { ore: settings.intervalHours, archivi: settings.keep })}
          </p>
        )}

        <div className="cluster">
          <label className="campo-breve">
            {t("backup.ogni")}
            <input
              aria-label={t("backup.ore_etichetta")}
              className="input"
              disabled={!modificabili || busy}
              max={720}
              min={1}
              onChange={(event) => setIntervalHours(Number(event.target.value))}
              type="number"
              value={intervalHours}
            />
            {t("backup.ore")}
          </label>
          <label className="campo-breve">
            {t("backup.tieni")}
            <input
              aria-label={t("backup.quanti")}
              className="input"
              disabled={!modificabili || busy}
              max={365}
              min={1}
              onChange={(event) => setKeep(Number(event.target.value))}
              type="number"
              value={keep}
            />
          </label>
        </div>

        {privateKey !== undefined && (
          <Alert tone="ok">
            <p>
              {tc("backup.chiave_privata", {
                privata: <strong>{t("backup.chiave_privata.privata")}</strong>,
                fuori: <strong>{t("backup.chiave_privata.fuori")}</strong>,
              })}
            </p>
            <code className="secret">{privateKey}</code>
          </Alert>
        )}

        {configurati && !chiaveInVista && (
          <div className="cluster cluster--between">
            <span className="row__body">
              <span className="row__title">{t("backup.chiave_cifratura")}</span>
              <span className="row__note">{t("backup.chiave_impostata")}</span>
            </span>
            <Button
              disabled={busy || !modificabili}
              onClick={() => setModificaChiave(true)}
              variant="secondary"
            >
              {t("backup.cambia")}
            </Button>
          </div>
        )}

        {chiaveInVista && (
          <>
            {configurati && <Alert>{t("backup.chiave_nuova")}</Alert>}
            <TextField
              disabled={!modificabili || busy}
              hint={t("backup.pubblica.aiuto")}
              label={t("backup.pubblica")}
              onChange={(event) => setPublicKey(event.target.value)}
              placeholder={t("backup.pubblica.esempio")}
              value={publicKey}
            />
            {configurati && (
              <TextField
                autoComplete="current-password"
                disabled={!modificabili || busy}
                hint={t("backup.conferma_password.aiuto")}
                label={t("backup.conferma_password")}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
            )}
            <div className="cluster">
              {configurati ? (
                <Button
                  aria-busy={lavoro === "genera" || undefined}
                  disabled={busy || !modificabili}
                  onClick={() => void genera()}
                  variant="secondary"
                >
                  {lavoro === "genera" ? t("backup.genero") : t("backup.genera")}
                </Button>
              ) : (
                <Button
                  aria-busy={lavoro === "genera" || undefined}
                  disabled={busy || !modificabili}
                  onClick={() => void genera()}
                >
                  {lavoro === "genera" ? t("backup.genero") : t("backup.genera")}
                </Button>
              )}
              {configurati && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setModificaChiave(false);
                    setPrivateKey(undefined);
                    setPassword("");
                    setPublicKey(settings.publicKey ?? "");
                  }}
                  variant="secondary"
                >
                  {t("comune.annulla")}
                </Button>
              )}
            </div>
          </>
        )}

        <div className="cluster">
          <Button
            aria-busy={lavoro === "salva" || undefined}
            disabled={busy || !modificabili}
            onClick={() => void salva()}
          >
            {lavoro === "salva" ? t("comune.salvo") : t("comune.salva")}
          </Button>
          {configurati && (
            <Button
              aria-busy={lavoro === "esegui" || undefined}
              disabled={busy}
              onClick={() => void eseguiOra()}
              variant="secondary"
            >
              {lavoro === "esegui" ? t("backup.scrivo") : t("backup.fai_ora")}
            </Button>
          )}
        </div>

        {settings.directoryIsBesideData && configurati && (
          <Alert>
            {tc("backup.stesso_disco", {
              disco: <strong>{t("backup.stesso_disco.disco")}</strong>,
            })}
          </Alert>
        )}
      </div>

      {/* 3. La lista — data in evidenza, tipo come badge, niente nomi di file. */}
      <div className="card card--flush">
        <h2 className="gruppo">{t("backup.archivi")}</h2>
        <p className="muted empty-inline">{t("backup.scaricane")}</p>

        {archives.length === 0 && <p className="empty-inline">{t("backup.nessuno")}</p>}

        {archives.map((archive) => {
          const scaricando = lavoro === `scarica:${archive.name}`;
          const aggiornamento = eAggiornamento(archive.name);

          return (
            <div className="row" key={archive.name}>
              <span className="row__body">
                <span className="row__title">
                  {quando(archive.modifiedAt)}{" "}
                  <Badge>
                    {aggiornamento ? t("backup.tipo.aggiornamento") : t("backup.tipo.periodico")}
                  </Badge>
                </span>
                <span className="row__note">{dimensione(archive.byteSize)}</span>
              </span>
              <span className="row__end">
                <Button
                  aria-busy={scaricando || undefined}
                  disabled={busy}
                  icon="download"
                  onClick={() => void scarica(archive.name)}
                  variant="secondary"
                >
                  {scaricando ? t("backup.scarico") : t("backup.scarica")}
                </Button>
              </span>
            </div>
          );
        })}

        <p className="muted empty-inline">
          {tc("backup.ripristino", {
            forte: <strong>{t("backup.ripristino.forte")}</strong>,
          })}
        </p>
      </div>
    </Sezione>
  );
}
