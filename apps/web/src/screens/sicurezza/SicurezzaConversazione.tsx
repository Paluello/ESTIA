import type { AuthorView, ConversazioneView } from "@estia/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAvvisi, type StatoAvvisi } from "../../avvisi.js";
import { t, useT } from "../../lingua.js";
import { cassettoIndexedDb } from "../../mls/adattatori.js";
import { scriviIdentita } from "../../mls/gruppo.js";
import { contestoChat } from "../../mls/motore.js";
import { cambiati, verificati } from "../../mls/sicurezza.js";
import { useSignedIn } from "../../state.js";
import { Alert, Badge, Button, ListRow, Sheet } from "../../ui/index.js";
import { quandoSiApre } from "./apri.js";
import { membroDi } from "./membri.js";
import { PannelloSicurezza, type Ambiente } from "./PannelloSicurezza.js";

type Conversazione = Pick<ConversazioneView, "id" | "tipo" | "membri">;

export interface SicurezzaVistaProps {
  conversazione: Conversazione;
  /** L'id con cui la conversazione nomina chi guarda: tutti gli altri sono «gli altri». */
  ioId: string;
  ambiente: () => Promise<Ambiente>;
  avvisi: Pick<StatoAvvisi, "errore" | "successo">;
}

const nomeDi = (autore: AuthorView): string =>
  autore.displayName === "" ? autore.username : autore.displayName;

/**
 * Il numero di sicurezza dentro una conversazione: l'avviso e il pannello
 * ([ADR 0050](../../../../../docs/adr/0050-il-numero-di-sicurezza.md)).
 *
 * Fa due cose, e sono le due che la conversazione deve alla persona:
 *
 * 1. **Avvisa** quando le chiavi di qualcuno che era verificato non sono più
 *    quelle. Sta in cima alla conversazione e non in un menu, perché è la
 *    risposta 2 del proprietario ad [ADR 0042](../../../../../docs/adr/0042-come-mls-attraversa.md):
 *    «molto evidente» — e **non blocca**: si continua a scrivere.
 * 2. **Apre il confronto**, da una persona sola nei messaggi privati e da
 *    ciascun membro in un gruppo. Il numero è della coppia, quindi in un gruppo
 *    non ce n'è uno «del gruppo»: c'è l'elenco, e dietro ogni riga lo stesso
 *    pannello dei messaggi privati.
 *
 * Il controllo si fa quando la conversazione si apre, quando la scheda torna
 * in primo piano e dopo ogni «verificato»: non a ogni rilettura della chat,
 * perché ogni controllo è una domanda alla casa di ciascun verificato.
 */
export function SicurezzaVista({
  conversazione,
  ioId,
  ambiente,
  avvisi,
}: SicurezzaVistaProps): React.ReactElement {
  useT();
  const [aperto, setAperto] = useState(false);
  const [sceltoId, setSceltoId] = useState<string | undefined>();
  const [cambiatiId, setCambiatiId] = useState<readonly string[]>([]);
  const [verificatiId, setVerificatiId] = useState<readonly string[]>([]);
  const giro = useRef(0);

  // L'elenco delle conversazioni si rilegge ogni pochi secondi e a ogni giro i
  // membri sono oggetti nuovi: qui contano chi sono, non quali oggetti sono.
  const firma = conversazione.membri.map((m) => `${m.id}\n${m.username}`).join("\n\n");
  const altri = useMemo(
    () => conversazione.membri.filter((m) => m.id !== ioId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `firma` dice gli stessi membri
    [firma, ioId],
  );
  const diretta = conversazione.tipo === "diretta";

  const controlla = useCallback(async (): Promise<void> => {
    const questo = ++giro.current;
    try {
      const { dip, io } = await ambiente();
      const segnati = await verificati(dip.cassetto);
      const membri = altri.map((autore) => ({ autore, membro: membroDi(autore, io.casa) }));
      const fuori = new Set(
        (
          await cambiati(
            dip,
            membri.map((m) => m.membro),
          )
        ).map(scriviIdentita),
      );

      if (giro.current !== questo) {
        return;
      }
      setVerificatiId(
        membri.filter((m) => segnati.has(scriviIdentita(m.membro))).map((m) => m.autore.id),
      );
      setCambiatiId(
        membri.filter((m) => fuori.has(scriviIdentita(m.membro))).map((m) => m.autore.id),
      );
    } catch {
      // Senza ambiente non c'è niente da confrontare: nessun avviso è meglio di
      // un avviso inventato. Il pannello, se lo si apre, dice che cosa non va.
    }
  }, [ambiente, altri]);

  useEffect(() => {
    // Un'altra conversazione è un'altra gente: l'avviso e il pannello di prima
    // non la riguardano.
    setAperto(false);
    setCambiatiId([]);
    setVerificatiId([]);
    void controlla();

    const alRitorno = (): void => {
      if (document.visibilityState === "visible") {
        void controlla();
      }
    };
    document.addEventListener("visibilitychange", alRitorno);
    return () => {
      giro.current += 1;
      document.removeEventListener("visibilitychange", alRitorno);
    };
  }, [controlla, conversazione.id]);

  const apri = useCallback(
    (id?: string): void => {
      setSceltoId(id ?? (diretta ? altri[0]?.id : undefined));
      setAperto(true);
    },
    [altri, diretta],
  );

  useEffect(() => quandoSiApre(() => apri()), [apri]);

  const scelto = altri.find((m) => m.id === sceltoId);
  const fuori = altri.filter((m) => cambiatiId.includes(m.id));

  return (
    <>
      {fuori.length > 0 && (
        <div className="chat-detail-alert">
          <Alert tone="error">
            <p className="chiavi__testo">
              {t("sicurezza.avviso", { nomi: fuori.map(nomeDi).join(", ") })}
            </p>
            <div className="cluster avviso-sicurezza__azioni">
              <Button
                onClick={() => apri(fuori.length === 1 ? fuori[0]?.id : undefined)}
                variant="secondary"
              >
                {t("sicurezza.avviso.confronta")}
              </Button>
            </div>
          </Alert>
        </div>
      )}

      <Sheet
        onClose={() => setAperto(false)}
        open={aperto}
        title={t("sicurezza.titolo")}
        variant="centrato"
      >
        {aperto && (
          <div className="feed-pad stack sicurezza-pannello">
            {scelto === undefined ? (
              <>
                <p className="muted chiavi__testo">{t("sicurezza.elenco")}</p>
                <div className="card card--flush">
                  {altri.map((autore) => (
                    <ListRow
                      end={
                        cambiatiId.includes(autore.id) ? (
                          <Badge tone="error">{t("sicurezza.stato.cambiato")}</Badge>
                        ) : verificatiId.includes(autore.id) ? (
                          <Badge tone="ok">{t("sicurezza.stato.verificato")}</Badge>
                        ) : undefined
                      }
                      icon="shield"
                      key={autore.id}
                      note={`@${autore.username}`}
                      onClick={() => setSceltoId(autore.id)}
                      title={nomeDi(autore)}
                    />
                  ))}
                </div>
              </>
            ) : (
              <>
                {!diretta && (
                  <div className="cluster">
                    <Button
                      icon="arrow-left"
                      onClick={() => setSceltoId(undefined)}
                      variant="quiet"
                    >
                      {t("comune.indietro")}
                    </Button>
                  </div>
                )}
                <PannelloSicurezza
                  altro={scelto}
                  ambiente={ambiente}
                  avvisi={avvisi}
                  onCambio={() => void controlla()}
                />
              </>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}

/**
 * Lo stesso, con il mondo vero attaccato: la sessione, IndexedDB e il registro
 * delle chiavi di firma che la chat usa già.
 *
 * Si monta una volta sola nella conversazione aperta; la voce di menu lo apre
 * con [`apriNumeroDiSicurezza`](./apri.ts).
 */
export function SicurezzaConversazione({
  conversazione,
}: {
  conversazione: Conversazione;
}): React.ReactElement {
  const { token, user } = useSignedIn();
  const { errore, successo } = useAvvisi();

  const ambiente = useCallback(async (): Promise<Ambiente> => {
    const { casa, ctx } = await contestoChat(token, user.username);
    return {
      dip: {
        cassetto: cassettoIndexedDb,
        chiaviDiFirmaDi: (membro) => ctx.istanza.chiaviDiFirmaDi(membro),
      },
      io: { casa, username: user.username },
    };
  }, [token, user.username]);

  const avvisi = useMemo(() => ({ errore, successo }), [errore, successo]);

  return (
    <SicurezzaVista
      ambiente={ambiente}
      avvisi={avvisi}
      conversazione={conversazione}
      ioId={user.id}
    />
  );
}
