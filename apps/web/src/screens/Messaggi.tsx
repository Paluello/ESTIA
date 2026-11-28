import type { AuthorView, ConversazioneView } from "@estia/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "../api.js";
import { base64InBytes } from "../mls/adattatori.js";
import {
  annuncia,
  apriConversazione,
  faiEntrare,
  faiUscire,
  leggi,
  manda,
  type Evento,
  type Invitato,
  type Riga,
} from "../mls/conversazione.js";
import {
  epochDi,
  leggiKeyPackage,
  scriviIdentita,
  TroppeFoglie,
  type Confronto,
} from "../mls/gruppo.js";
import { contestoChat, ripristina, type ContestoChat } from "../mls/motore.js";
import { ChiaveDiUnAltro, riprendiCongelata, type Sessione } from "../mls/sessione.js";
import { useSignedIn } from "../state.js";
import { useAvvisi } from "../avvisi.js";
import { t, tc, tn, useT } from "../lingua.js";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  EmptyState,
  Icon,
  IconButton,
  MenuAzioni,
  Sheet,
  SplitLayout,
  TextField,
} from "../ui/index.js";
import { PersonLink } from "../components/PersonLink.js";
import { impedimentoDi, siPuoScrivere, spiegazioneDi } from "./chat-impedimento.js";
import type { Persona } from "./gruppi/CercaPersone.js";
import {
  assentiFra,
  comeInput,
  composizioneDi,
  creaQui,
  eUnGruppo,
  idAtteso,
  nomeDaIndirizzo,
  nomeDi,
  nomeNellEvento,
} from "./gruppi/logica.js";
import { MembriGruppo, type GestiDelGruppo } from "./gruppi/MembriGruppo.js";
import { NuovoGruppo } from "./gruppi/NuovoGruppo.js";
import { AvvisoTrasloco } from "./gruppi/Trasloco.js";
import { membroDi } from "./sicurezza/membri.js";
import { apriNumeroDiSicurezza } from "./sicurezza/apri.js";
import { SicurezzaConversazione } from "./sicurezza/SicurezzaConversazione.js";
import { giornoDi, ora, quandoPreciso } from "../tempo.js";

interface DecryptedMessage {
  id: string;
  senderUserId: string;
  text: string;
  replyTo?: string | undefined;
  createdAt: string;
  /** C'è, ma questo dispositivo non ha la chiave per aprirla. */
  unreadable?: boolean;
  /**
   * La casa che la custodisce non risponde: restano chi e quando, e il
   * contenuto torna quando torna lei ([ADR 0043](../../../../docs/adr/0043-custodia-lato-mittente.md) §3).
   */
  nonDisponibile?: boolean;
  pending?: boolean;
  /** Non è una frase: è qualcosa che è successo al gruppo, e si disegna come tale. */
  evento?: Evento | undefined;
  /**
   * Chi e quando li dichiara soltanto l'istanza: una voce di prima che
   * venissero sigillati con il testo ([ADR 0052](../../../../docs/adr/0052-l-archivio-dei-gruppi.md) §1).
   */
  nonAttestata?: boolean;
}

/** Ogni quanto si rilegge una chat aperta. Ogni giro chiede qualcosa alle case degli autori. */
const RILETTURA_MS = 10_000;

/** Ogni quanto si rilegge l'elenco delle conversazioni: sta tutto in casa. */
const ELENCO_MS = 5_000;

/** Una riga della cronologia, come la disegna la schermata. */
function versoSchermata(
  riga: Riga,
  casa: string,
  io: { id: string; username: string },
  membri: readonly { id: string; username: string }[],
): DecryptedMessage {
  const base = {
    createdAt: riga.createdAt,
    id: riga.id,
    senderUserId: chiHaScritto(riga.mittente, casa, io, membri),
  };

  if (riga.stato === "non-disponibile") {
    return { ...base, nonDisponibile: true, text: "" };
  }

  if (riga.stato === "non-si-apre" || riga.testo === undefined) {
    return { ...base, text: "", unreadable: true };
  }

  return {
    ...base,
    evento: riga.evento,
    nonAttestata: riga.attestata === false,
    replyTo: riga.risponde,
    text: riga.testo,
  };
}

/**
 * Da `username@casa` all'id con cui la conversazione nomina quel membro: il
 * proprio, uno di questa casa, o `remote:casa:username`.
 */
function chiHaScritto(
  mittente: string | null,
  casa: string,
  io: { id: string; username: string },
  membri: readonly { id: string; username: string }[],
): string {
  if (mittente === null) {
    return "";
  }

  const taglio = mittente.lastIndexOf("@");
  const username = mittente.slice(0, taglio);
  const suaCasa = mittente.slice(taglio + 1);

  if (suaCasa === casa) {
    return username === io.username
      ? io.id
      : (membri.find((m) => !m.id.startsWith("remote:") && m.username === username)?.id ??
          mittente);
  }

  return `remote:${suaCasa}:${username}`;
}

function SwipeableBubble({
  message,
  isMe,
  onReply,
  onInfo,
  replyMessage,
  replyAuthor,
  peerVistoFinoA,
  autore,
}: {
  message: DecryptedMessage;
  isMe: boolean;
  /** Chi ha scritto, da mostrare sopra la riga: serve in un gruppo, dove non è ovvio. */
  autore?: string | undefined;
  onReply: (id: string) => void;
  onInfo: (message: DecryptedMessage) => void;
  replyMessage?: DecryptedMessage | undefined;
  replyAuthor?: string | undefined;
  peerVistoFinoA?: string | null;
}) {
  useT();
  const [swipeOffset, setSwipeOffset] = useState(0);
  const touchStart = useRef<number | null>(null);
  /** Una riga senza testo non si risponde e non si guarda nel dettaglio: non c'è niente. */
  const senzaTesto = message.unreadable === true || message.nonDisponibile === true;

  const handleTouchStart = (e: React.TouchEvent) => {
    if (senzaTesto) return;
    touchStart.current = e.touches[0]?.clientX ?? null;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (senzaTesto || touchStart.current === null) return;
    const clientX = e.touches[0]?.clientX;
    if (clientX === undefined) return;
    const deltaX = clientX - touchStart.current;

    // Both directions allowed up to [-60, 60]
    setSwipeOffset(Math.max(-60, Math.min(60, deltaX)));
  };

  const handleTouchEnd = () => {
    if (!senzaTesto) {
      if (isMe) {
        // Messaggi inviati:
        // Swipe da sinistra verso destra (deltaX > 40) -> Info
        // Swipe da destra verso sinistra (deltaX < -40) -> Rispondi
        if (swipeOffset > 40) {
          onInfo(message);
        } else if (swipeOffset < -40) {
          onReply(message.id);
        }
      } else {
        // Messaggi ricevuti:
        // Swipe da destra verso sinistra (deltaX < -40) -> Info
        // Swipe da sinistra verso destra (deltaX > 40) -> Rispondi
        if (swipeOffset < -40) {
          onInfo(message);
        } else if (swipeOffset > 40) {
          onReply(message.id);
        }
      }
    }
    setSwipeOffset(0);
    touchStart.current = null;
  };

  return (
    <div className={`chat-row ${isMe ? "chat-row--me" : "chat-row--them"}`}>
      {isMe && !senzaTesto && (
        <div className="chat-row__actions">
          <IconButton icon="info" label={t("messaggi.info")} onClick={() => onInfo(message)} />
          <IconButton
            icon="reply"
            label={t("commento.rispondi")}
            onClick={() => onReply(message.id)}
          />
        </div>
      )}
      <div
        className={`chat-bubble ${isMe ? "chat-bubble--me" : "chat-bubble--them"} ${
          senzaTesto ? "chat-bubble--unreadable" : ""
        }`}
        style={{
          transform: `translateX(${swipeOffset}px)`,
          transition: touchStart.current === null ? "transform 0.2s ease" : "none",
          touchAction: "pan-y",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {replyMessage && !senzaTesto && (
          <div className="chat-bubble__reply">
            {replyAuthor && <span className="chat-bubble__reply-author">{replyAuthor}</span>}
            <p className="chat-bubble__reply-text truncate">{replyMessage.text}</p>
          </div>
        )}
        {message.nonDisponibile ? (
          <div className="chat-unreadable stack stack--tight">
            <div className="cluster chat-unreadable__head">
              <Icon name="clock" size={16} />
              <strong>{t("messaggi.non_disponibile.titolo")}</strong>
            </div>
            <p className="chat-unreadable__desc muted">{t("messaggi.non_disponibile.testo")}</p>
            <time className="chat-time">{ora(message.createdAt)}</time>
          </div>
        ) : message.unreadable ? (
          <div className="chat-unreadable stack stack--tight">
            <div className="cluster chat-unreadable__head">
              <Icon name="key" size={16} />
              <strong>{t("messaggi.non_si_apre.titolo")}</strong>
            </div>
            <p className="chat-unreadable__desc muted">{t("messaggi.non_si_apre.testo")}</p>
          </div>
        ) : (
          <div className="chat-bubble__body">
            {autore !== undefined && <span className="chat-bubble__reply-author">{autore}</span>}
            <p className="chat-bubble__text">{message.text}</p>
            {message.nonAttestata === true && (
              <span className="chat-bubble__nota muted">{t("messaggi.non_attestato")}</span>
            )}
            <div className="chat-bubble__meta">
              <time className="chat-time">{ora(message.createdAt)}</time>
              {isMe &&
                (() => {
                  const isRead =
                    !message.pending && peerVistoFinoA && message.createdAt <= peerVistoFinoA;
                  const isPending = message.pending;

                  const statusClass = isPending
                    ? "chat-status--pending"
                    : isRead
                      ? "chat-status--read"
                      : "chat-status--sent";

                  const title = isPending
                    ? t("messaggi.stato.in_invio")
                    : isRead
                      ? t("messaggi.stato.letto")
                      : t("messaggi.stato.inviato");

                  return (
                    <span className={`chat-status ${statusClass}`} title={title}>
                      {isPending ? (
                        <Icon name="clock" size={13} />
                      ) : isRead ? (
                        <Icon name="eye" size={15} />
                      ) : (
                        <Icon name="check" size={15} />
                      )}
                    </span>
                  );
                })()}
            </div>
          </div>
        )}
      </div>
      {!isMe && !senzaTesto && (
        <div className="chat-row__actions">
          <IconButton
            icon="reply"
            label={t("commento.rispondi")}
            onClick={() => onReply(message.id)}
          />
          <IconButton icon="info" label={t("messaggi.info")} onClick={() => onInfo(message)} />
        </div>
      )}
    </div>
  );
}

const ATTESA_MS = 120;
const MINIMO = 2;

export function Messaggi(): React.ReactElement {
  const { token, user } = useSignedIn();
  useT();
  const { errore: mostraErrore, successo: mostraSuccesso } = useAvvisi();

  const isCryptoAvailable = typeof window !== "undefined" && Boolean(window.crypto?.subtle);

  const [conversazioni, setConversazioni] = useState<ConversazioneView[]>([]);
  const [caricamento, setCaricamento] = useState(true);
  const [selezionataId, setSelezionataId] = useState<string | undefined>();
  const [messaggi, setMessaggi] = useState<DecryptedMessage[]>([]);
  const [inInvio, setInInvio] = useState(false);
  const [testo, setTesto] = useState("");
  const [replyToId, setReplyToId] = useState<string | undefined>();
  const [peerVistoFinoA, setPeerVistoFinoA] = useState<string | null>(null);
  /** Che cosa è tornato provando ad aprire la conversazione: dice perché non si scrive. */
  const [erroreChiave, setErroreChiave] = useState<unknown>();
  /** La conversazione la ordina un'altra casa, e l'invito per noi non è arrivato. */
  const [inAttesa, setInAttesa] = useState(false);
  /** Questo dispositivo è nel gruppo, ma la chiave per leggerlo non gliel'ha ancora riconsegnata nessuno. */
  const [senzaCronologia, setSenzaCronologia] = useState(false);
  /**
   * La conversazione si sta aprendo su questo dispositivo: si crea il gruppo, si
   * entra da un invito o si rientra. Finché dura, il campo è spento e lo dice —
   * un campo acceso che poi rifiuta il messaggio è lo stato «sembra pronto e non
   * lo è» dell'euristica 5.
   */
  const [inApertura, setInApertura] = useState(false);
  /** L'albero cifrato accanto alle persone della conversazione: chi è di troppo, chi manca. */
  const [confronto, setConfronto] = useState<Confronto | undefined>();
  /** Questo dispositivo ha applicato il commit che lo toglie dal gruppo. */
  const [tolto, setTolto] = useState(false);
  /** La chiave di questa casa, da quando la si sa: serve a dire chi abita qui. */
  const [casaMia, setCasaMia] = useState<string | undefined>();
  const [nuovoGruppoAperto, setNuovoGruppoAperto] = useState(false);
  const [membriAperti, setMembriAperti] = useState<"elenco" | "conferma-esci" | undefined>();
  /** La sessione MLS della conversazione aperta. Vive in memoria, e si riapre cambiando chat. */
  const sessioneRef = useRef<Sessione | undefined>(undefined);
  /**
   * Una cosa alla volta sulla sessione. La rilettura periodica, l'invio e i
   * gesti del gruppo partono tutti dallo stesso stato MLS e lo portano avanti:
   * due insieme costruirebbero due commit sulla stessa epoch, e chi perde
   * resterebbe con uno stato che nessun altro conosce.
   */
  const codaRef = useRef<Promise<unknown>>(Promise.resolve());
  const inSerie = useCallback(<T,>(lavoro: () => Promise<T>): Promise<T> => {
    const prossimo = codaRef.current.then(lavoro, lavoro);
    codaRef.current = prossimo.catch(() => undefined);
    return prossimo;
  }, []);
  /**
   * L'ultima conversazione aperta, com'era: chi viene tolto da un gruppo non
   * la trova più nell'elenco, e la schermata deve poter dire **di quale**
   * gruppo non fa più parte invece di svuotarsi.
   */
  const ricordataRef = useRef<ConversazioneView | undefined>(undefined);
  /** Le conversazioni dell'ultimo caricamento, per leggerle senza rifare gli effetti a ogni render. */
  const conversazioniRef = useRef<ConversazioneView[]>([]);

  interface RisultatoRicercaMessaggi {
    username: string;
    displayName: string;
    instanceKey?: string | undefined;
    tramite?: string | undefined;
    isRemote: boolean;
  }

  // Search state
  const [termine, setTermine] = useState("");
  const [cercando, setCercando] = useState(false);
  const [risultati, setRisultati] = useState<RisultatoRicercaMessaggi[] | undefined>();

  // Ripristino chiavi di sicurezza E2E
  const [sheetRipristinoAperto, setSheetRipristinoAperto] = useState(false);
  const [passphraseRipristino, setPassphraseRipristino] = useState("");
  const [ripristinoInCorso, setRipristinoInCorso] = useState(false);

  // Info dettagli messaggio
  const [messaggioInfo, setMessaggioInfo] = useState<DecryptedMessage | undefined>();

  const fineMessaggiRef = useRef<HTMLDivElement>(null);
  /**
   * Quale conversazione si sta guardando **adesso**. I giri di lettura stanno
   * in fila: quello di una chat da cui si è già usciti non deve scrivere i suoi
   * messaggi, o il suo impedimento, sopra quella che si è aperta dopo.
   */
  const guardataRef = useRef<string | undefined>(undefined);
  guardataRef.current = selezionataId;
  const nellElenco = conversazioni.find((c) => c.id === selezionataId);
  if (nellElenco !== undefined) {
    ricordataRef.current = nellElenco;
  }
  const selezionata =
    nellElenco ?? (ricordataRef.current?.id === selezionataId ? ricordataRef.current : undefined);
  const gruppo = eUnGruppo(selezionata);
  const altroMembro = gruppo ? undefined : selezionata?.membri.find((m) => m.id !== user.id);

  /** Il nome di chi ha scritto una riga, per chi la guarda. */
  const nomeDiChi = useCallback(
    (id: string, ripiego: string): string => {
      const autore = selezionata?.membri.find((m) => m.id === id);
      return autore === undefined ? ripiego : nomeDi(autore);
    },
    [selezionata],
  );

  const caricaConversazioni = useCallback(async (): Promise<void> => {
    try {
      const resp = await api.conversazioni(token);
      conversazioniRef.current = resp.conversazioni;
      setConversazioni(resp.conversazioni);
    } catch {
      // Ignora, proverà al prossimo ciclo
    } finally {
      setCaricamento(false);
    }
  }, [token]);

  /**
   * Le chiavi d'ingresso di una persona, una per ciascun suo dispositivo,
   * chieste alla sua casa. Monouso. Si entra con tutti: telefono e PC sono due
   * foglie della stessa persona (ADR 0040).
   */
  const chiaviDi = useCallback(
    async (altro: AuthorView, casa: string) => {
      const presi = await api.keyPackagesMls(token, membroDi(altro, casa).casa, altro.username);
      const keyPackages = presi.keyPackages
        .map((preso) => leggiKeyPackage(base64InBytes(preso.keyPackage)))
        .filter((kp): kp is NonNullable<typeof kp> => kp !== undefined);
      if (keyPackages.length === 0) {
        throw new Error(t("messaggi.chiave_illeggibile", { nome: nomeDi(altro) }));
      }

      return keyPackages;
    },
    [token],
  );

  /**
   * La chiave d'ingresso di chi si invita, quando si crea il gruppo.
   *
   * Si chiama soltanto se la conversazione la ordina questa casa (ADR 0042 §3),
   * e l'istanza instrada la domanda: dalla propria casa, o da quella di chi si
   * invita. `idDiChiEntra` è l'id con cui **questa** conversazione nomina quel
   * membro, perché è con quello che la casa che ordina consegna il Welcome.
   */
  const invitoPer = useCallback(
    (conv: ConversazioneView, casa: string) => async (): Promise<Invitato[]> => {
      const altri = conv.membri.filter((m) => m.id !== user.id);
      if (altri.length === 0) {
        throw new Error(t("messaggi.nessuno_da_invitare"));
      }

      // In un gruppo entra chi ha un dispositivo pronto, e gli altri restano
      // «non ancora dentro»: li fa entrare dopo chi amministra. Se non entra
      // nessuno, la ragione del primo è la ragione che si dice.
      const invitati: Invitato[] = [];
      let primaCausa: unknown;
      for (const altro of altri) {
        try {
          for (const keyPackage of await chiaviDi(altro, casa)) {
            invitati.push({ idDiChiEntra: altro.id, keyPackage });
          }
        } catch (causa) {
          primaCausa ??= causa;
        }
      }

      if (invitati.length === 0) {
        throw primaCausa;
      }

      return invitati;
    },
    [chiaviDi, user.id],
  );

  /**
   * Apre (la prima volta) e rilegge la conversazione.
   *
   * La cronologia arriva dall'istanza ricomposta dalle custodie, e si decifra
   * qui, in memoria: niente di quello che si legge viene scritto su questo
   * browser ([ADR 0043](../../../../docs/adr/0043-custodia-lato-mittente.md) §5).
   */
  const caricaMessaggi = useCallback(
    (id: string): Promise<void> =>
      inSerie(async () => {
        const nota =
          conversazioniRef.current.find((c) => c.id === id) ??
          (ricordataRef.current?.id === id ? ricordataRef.current : undefined);
        if (nota === undefined || guardataRef.current !== id) {
          return;
        }

        try {
          const { casa, ctx } = await contestoChat(token, user.username);
          setCasaMia(casa);

          // Di un gruppo si chiede ogni volta chi c'è: è la domanda che fa
          // rileggere la composizione alla casa che ordina, e quella a cui
          // l'istanza risponde «non sei più in questo gruppo» a chi è stato tolto.
          const conv = eUnGruppo(nota)
            ? (await api.getConversazione(token, id)).conversazione
            : nota;
          if (ricordataRef.current?.id === id) {
            ricordataRef.current = conv;
          }

          let sessione =
            // Una sessione da cui si risulta tolti non si riusa: si riapre a
            // ogni giro, perché è lì che si trova l'invito di chi ci ha fatti
            // rientrare.
            sessioneRef.current?.conversazioneId === id && sessioneRef.current.tolto !== true
              ? sessioneRef.current
              : undefined;
          if (sessione === undefined) {
            const apertura = await apriConversazione(
              ctx,
              {
                congelata: conv.congelata === true,
                creaQui: creaQui(conv, user.id),
                id,
                ordinataQui: conv.ordinataQui,
              },
              invitoPer(conv, casa),
            );

            if (guardataRef.current !== id) {
              return;
            }

            if (apertura.kind === "tolto") {
              setTolto(true);
              setInAttesa(false);
              setErroreChiave(undefined);
              setMessaggi([]);
              return;
            }

            if (apertura.kind === "in-attesa") {
              setInAttesa(true);
              setSenzaCronologia(false);
              setErroreChiave(undefined);
              setMessaggi([]);
              return;
            }

            sessione = apertura.sessione;
          }

          // L'albero si mette accanto alle persone a ogni giro. In un gruppo è
          // anche il momento in cui la foglia di chi è uscito viene tolta.
          // Di un gruppo congelato si legge e basta: la coda stava nella casa
          // persa, e l'albero non si tocca più (ADR 0042 §3, «Il trasloco»).
          const lettura = await leggi(ctx, sessione, undefined, composizioneDi(conv, casa), {
            congelata: conv.congelata === true,
          });
          if (guardataRef.current !== id) {
            return;
          }
          sessioneRef.current = lettura.sessione;
          setConfronto(lettura.confronto);
          setTolto(lettura.sessione.tolto === true);

          const righe = lettura.righe.map((r) =>
            versoSchermata(r, casa, { id: user.id, username: user.username }, conv.membri),
          );
          setMessaggi(righe);
          setInAttesa(false);
          setSenzaCronologia(lettura.sessione.catena === undefined);
          setErroreChiave(undefined);

          // Fin dove l'altra persona ha letto, e fin dove abbiamo letto noi: sono
          // cursori di questa casa. Il primo arriva con la conversazione, che
          // l'elenco rilegge da solo; di chi abita altrove qui non c'è.
          setPeerVistoFinoA(conv.peerVistoFinoA ?? null);
          const ultimoRicevuto = [...righe]
            .reverse()
            .find((m) => m.senderUserId !== user.id && !m.nonDisponibile);
          if (ultimoRicevuto) {
            void api.segnaConversazioneLetta(token, id, ultimoRicevuto.createdAt).catch(() => {});
          }
        } catch (err) {
          if (guardataRef.current !== id) {
            return;
          }
          // Non è rumore da console: è la ragione per cui questa chat non si può
          // usare adesso, e va detta a chi ci sta dentro.
          setErroreChiave(err);
          // Chi non è più nel gruppo non tiene sullo schermo quello che
          // l'istanza ha smesso di servirgli: la spiegazione dice perché.
          if (err instanceof ApiError && err.code === "rimosso_dal_gruppo") {
            setMessaggi([]);
            sessioneRef.current = undefined;
          }
        } finally {
          setInApertura(false);
        }
      }),
    [inSerie, invitoPer, token, user.id, user.username],
  );

  const eseguiRipristinoChiavi = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (passphraseRipristino.trim().length === 0) return;
    setRipristinoInCorso(true);
    try {
      await ripristina(token, user.username, passphraseRipristino);
      mostraSuccesso(t("messaggi.chiave_rimessa"));
      setPassphraseRipristino("");
      setSheetRipristinoAperto(false);
      sessioneRef.current = undefined;
      if (selezionataId) {
        await caricaMessaggi(selezionataId);
      }
    } catch (err: unknown) {
      mostraErrore(err, t("messaggi.frase_non_apre"));
    } finally {
      setRipristinoInCorso(false);
    }
  };

  // Menu opzioni conversazione
  const [eliminazioneInCorso, setEliminazioneInCorso] = useState(false);

  const eseguiEliminazioneConversazione = async (): Promise<void> => {
    if (!selezionataId) return;
    setEliminazioneInCorso(true);
    try {
      await api.deleteConversazione(token, selezionataId);
      mostraSuccesso(t("messaggi.eliminata"));
      setSelezionataId(undefined);
      setMessaggi([]);
      await caricaConversazioni();
    } catch (err: unknown) {
      mostraErrore(err, t("messaggi.errore_elimina"));
    } finally {
      setEliminazioneInCorso(false);
    }
  };

  useEffect(() => {
    void caricaConversazioni();

    // L'elenco sta tutto in casa, e si rilegge spesso. La chat aperta no: ogni
    // giro chiede qualcosa alle case degli autori, e una domanda ogni tre
    // secondi farebbe scattare il loro limite di frequenza.
    const elenco = setInterval(() => {
      if (document.visibilityState === "visible") {
        void caricaConversazioni();
      }
    }, ELENCO_MS);

    const chat = setInterval(() => {
      if (document.visibilityState === "visible" && selezionataId) {
        void caricaMessaggi(selezionataId);
      }
    }, RILETTURA_MS);

    const onVisChange = (): void => {
      if (document.visibilityState === "visible") {
        void caricaConversazioni();
        if (selezionataId) {
          void caricaMessaggi(selezionataId);
        }
      }
    };

    document.addEventListener("visibilitychange", onVisChange);
    return () => {
      clearInterval(elenco);
      clearInterval(chat);
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, [caricaConversazioni, caricaMessaggi, selezionataId]);

  useEffect(() => {
    // Cambiando chat la sessione di prima non vale più: si riapre quella nuova.
    sessioneRef.current = undefined;
    setInApertura(selezionataId !== undefined);
    setMessaggi([]);
    setInAttesa(false);
    setSenzaCronologia(false);
    setConfronto(undefined);
    setTolto(false);
    setMembriAperti(undefined);

    if (selezionataId) {
      setPeerVistoFinoA(null);
      setErroreChiave(undefined);
      void caricaMessaggi(selezionataId);
    }
  }, [caricaMessaggi, selezionataId]);

  /**
   * Aprendo una chat si arriva **già in fondo**, senza scorrimento: l'animazione
   * che scende dall'alto fa vedere per un attimo messaggi vecchi che non si
   * stavano cercando. Da lì in poi i messaggi nuovi arrivano con la transizione,
   * perché lì il movimento è l'informazione (euristica 1).
   */
  const ultimaScrollata = useRef<string | undefined>(undefined);
  useEffect(() => {
    const apertura = ultimaScrollata.current !== selezionataId;
    ultimaScrollata.current = selezionataId;
    fineMessaggiRef.current?.scrollIntoView({ behavior: apertura ? "auto" : "smooth" });
  }, [messaggi, selezionataId]);

  // Search logic
  useEffect(() => {
    const cercabile = termine.trim();
    if (cercabile.length < MINIMO) {
      setRisultati(undefined);
      setCercando(false);
      return;
    }

    const annulla = new AbortController();
    const attesa = setTimeout(() => {
      setCercando(true);

      // Risultati locali immediati
      api
        .searchProfiles(token, cercabile, "istanza", annulla.signal)
        .then((res) => {
          const localiList: RisultatoRicercaMessaggi[] = res.locali.map((l) => ({
            username: l.username,
            displayName: l.displayName,
            isRemote: false,
          }));
          setRisultati((prev) => {
            const remoti = prev?.filter((p) => p.isRemote) ?? [];
            return [...localiList, ...remoti];
          });
        })
        .catch(() => undefined);

      // Risultati remoti di rete in parallelo. Da qui si prendono **solo** le
      // persone di altre case: i `locali` di questo ambito sono soltanto chi è
      // presente in rete, e sostituire con loro quelli della ricerca in casa
      // faceva sparire chi abita qui ma non si mostra fuori — cioè proprio
      // qualcuno a cui si può scrivere.
      api
        .searchProfiles(token, cercabile, "rete", annulla.signal)
        .then((res) => {
          const remoti: RisultatoRicercaMessaggi[] = res.remoti.map((r) => ({
            username: r.username,
            displayName: r.displayName,
            instanceKey: r.instanceKey,
            tramite: r.tramite,
            isRemote: true,
          }));
          setRisultati((prev) => [...(prev?.filter((p) => !p.isRemote) ?? []), ...remoti]);
        })
        .catch(() => undefined)
        .finally(() => setCercando(false));
    }, ATTESA_MS);

    return () => {
      clearTimeout(attesa);
      annulla.abort();
    };
  }, [termine, token]);

  const invia = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!selezionataId || testo.trim().length === 0 || inInvio) return;

    const testoDaInviare = testo.trim();
    const repId = replyToId;
    // L'id del messaggio lo sceglie chi scrive, **a caso**: diventa l'id del
    // segnaposto nelle altre case, e un id derivato dal testo sarebbe
    // un'impronta del contenuto scritta in casa d'altri (ADR 0042 §4.1).
    const idMessaggio = crypto.randomUUID();
    const quando = new Date().toISOString();
    const optimisticMsg: DecryptedMessage = {
      createdAt: quando,
      id: idMessaggio,
      pending: true,
      replyTo: repId,
      senderUserId: user.id,
      text: testoDaInviare,
    };

    setMessaggi((prev) => [...prev, optimisticMsg]);
    setTesto("");
    setReplyToId(undefined);
    setInInvio(true);

    try {
      const sessione = sessioneRef.current;
      if (sessione === undefined || sessione.conversazioneId !== selezionataId) {
        throw new Error(t("messaggi.non_ancora_aperta"));
      }

      const { casa, ctx } = await contestoChat(token, user.username);
      const conv = ricordataRef.current;
      await inSerie(() =>
        manda(
          ctx,
          sessioneRef.current ?? sessione,
          { testo: testoDaInviare, ...(repId === undefined ? {} : { risponde: repId }) },
          idMessaggio,
          quando,
          // Chi dovrebbe esserci: se nell'albero c'è qualcun altro, la riga non parte.
          conv?.id === selezionataId
            ? composizioneDi(conv, casa).membri.map((m) => m.membro)
            : undefined,
        ),
      );
      await caricaMessaggi(selezionataId);
      await caricaConversazioni();
    } catch (err: unknown) {
      setMessaggi((prev) => prev.filter((m) => m.id !== idMessaggio));
      // Il testo torna nel campo: chi ha scritto non deve riscriverlo (euristica 3).
      setTesto(testoDaInviare);
      setReplyToId(repId);
      mostraErrore(err, t("messaggi.errore_invio"));
    } finally {
      setInInvio(false);
    }
  };

  const avviaChat = async (trovato: RisultatoRicercaMessaggi): Promise<void> => {
    setTermine("");
    try {
      const convRes = await api.createConversazione(token, {
        recipientUsername: trovato.username,
        ...(trovato.instanceKey ? { remoteInstanceKey: trovato.instanceKey } : {}),
      });

      await caricaConversazioni();
      setSelezionataId(convRes.conversazione.id);
    } catch (err: unknown) {
      mostraErrore(err, t("messaggi.errore_avvio"));
    }
  };

  /* ------------------------------ i gruppi (M8) ------------------------------ */

  /**
   * Scrive nella conversazione che cosa è successo al gruppo. Se non riesce il
   * gesto è fatto lo stesso: è un racconto, non il gesto.
   */
  const racconta = async (ambiente: ContestoChat, evento: Evento): Promise<void> => {
    const sessione = sessioneRef.current;
    if (sessione === undefined) {
      return;
    }

    await annuncia(
      ambiente.ctx,
      sessione,
      evento,
      crypto.randomUUID(),
      new Date().toISOString(),
    ).catch(() => undefined);
  };

  /** Fa entrare nel gruppo cifrato una persona che è già fra i membri. */
  const entraNelGruppo = async (ambiente: ContestoChat, autore: AuthorView): Promise<void> => {
    const sessione = sessioneRef.current;
    if (sessione === undefined) {
      throw new Error(t("gruppi.non_pronto"));
    }

    const membro = membroDi(autore, ambiente.casa);
    const keyPackages = await chiaviDi(autore, ambiente.casa);
    sessioneRef.current = await faiEntrare(
      ambiente.ctx,
      sessione,
      { id: autore.id, membro },
      keyPackages,
    );
    await racconta(ambiente, { chi: scriviIdentita(membro), tipo: "ingresso" });
  };

  /** Che cosa dire quando una persona non è riuscita a entrare nel gruppo cifrato. */
  const percheNonEntra = (causa: unknown, nome: string): void => {
    if (causa instanceof ApiError && causa.code === "no_device_available") {
      mostraErrore(undefined, t("gruppi.entra.senza_dispositivo", { nome }));
    } else if (causa instanceof ChiaveDiUnAltro) {
      mostraErrore(undefined, t("gruppi.entra.chiave_di_un_altro", { nome }));
    } else if (causa instanceof TroppeFoglie) {
      mostraErrore(undefined, t("errori.gruppo_pieno"));
    } else {
      mostraErrore(causa, t("gruppi.entra.errore", { nome }));
    }
  };

  const dopoUnGesto = async (): Promise<void> => {
    await caricaConversazioni();
    if (selezionataId) {
      await caricaMessaggi(selezionataId);
    }
  };

  /**
   * Il trasloco: la casa che ordina è persa, e da qui nasce il gruppo che
   * continua questo. L'epoch è l'ultima che questo dispositivo ha visto — zero
   * se del gruppo di prima non ha lo stato. Il gruppo cifrato nuovo lo crea
   * l'apertura, come per ogni gruppo: chi ha traslocato ne è il creatore.
   */
  const trasloca = async (): Promise<void> => {
    if (!selezionataId) return;
    const id = selezionataId;
    try {
      // Dallo stato che il browser ha tenuto, senza chiedere niente a nessuno:
      // la casa a cui chiedere è quella che non risponde.
      const { ctx } = await contestoChat(token, user.username);
      const locale = await riprendiCongelata(ctx, id);
      const epoch = locale === undefined ? 0 : Number(epochDi(locale.stato));
      const { conversazione } = await api.traslocaGruppo(token, id, { epoch });
      await caricaConversazioni();
      setSelezionataId(conversazione.id);
      mostraSuccesso(t("gruppi.trasloco.fatto"));
    } catch (causa) {
      mostraErrore(causa, t("gruppi.trasloco.errore"));
      await caricaConversazioni();
    }
  };

  const gestiDelGruppo: GestiDelGruppo = {
    aggiungi: async (persona: Persona) => {
      if (!selezionataId) return;
      const id = selezionataId;
      try {
        const ambiente = await contestoChat(token, user.username);
        const { conversazione } = await api.aggiungiAlGruppo(
          token,
          id,
          comeInput(persona, ambiente.casa),
        );
        ricordataRef.current = conversazione;

        const autore = conversazione.membri.find(
          (m) => m.id === idAtteso(persona, conversazione.membri, ambiente.casa),
        );
        if (autore !== undefined) {
          try {
            await inSerie(() => entraNelGruppo(ambiente, autore));
            mostraSuccesso(t("gruppi.aggiungi.fatto", { nome: persona.displayName }));
          } catch (causa) {
            // È fra le persone del gruppo, ma non nel gruppo cifrato: si dice
            // qual è delle due cose, perché la seconda si può riprovare.
            percheNonEntra(causa, persona.displayName);
          }
        }
      } catch (causa) {
        mostraErrore(causa, t("gruppi.aggiungi.errore"));
      } finally {
        await dopoUnGesto();
      }
    },
    cambiaRuolo: async (autore, ruolo) => {
      if (!selezionataId) return;
      try {
        const { conversazione } = await api.cambiaRuoloNelGruppo(
          token,
          selezionataId,
          autore.id,
          ruolo,
        );
        ricordataRef.current = conversazione;
        mostraSuccesso(
          t(ruolo === "amministratore" ? "gruppi.ruolo.nominato" : "gruppi.ruolo.revocato", {
            nome: nomeDi(autore),
          }),
        );
      } catch (causa) {
        mostraErrore(causa, t("gruppi.ruolo.errore"));
      } finally {
        await caricaConversazioni();
      }
    },
    esci: async () => {
      if (!selezionataId) return;
      const id = selezionataId;
      try {
        const ambiente = await contestoChat(token, user.username);
        // Prima lo si scrive, finché si può ancora scrivere: dopo l'uscita
        // l'istanza non accetta più niente da chi è uscito.
        await inSerie(() =>
          racconta(ambiente, {
            chi: scriviIdentita({ casa: ambiente.casa, username: user.username }),
            tipo: "uscita",
          }),
        );
        await api.esciDalGruppo(token, id);
        mostraSuccesso(t("gruppi.esci.fatto"));
        setMembriAperti(undefined);
        setSelezionataId(undefined);
        setMessaggi([]);
        await caricaConversazioni();
      } catch (causa) {
        mostraErrore(causa, t("gruppi.esci.errore"));
      }
    },
    faiEntrare: async (autore) => {
      try {
        const ambiente = await contestoChat(token, user.username);
        await inSerie(() => entraNelGruppo(ambiente, autore));
        mostraSuccesso(t("gruppi.entra.fatto", { nome: nomeDi(autore) }));
      } catch (causa) {
        percheNonEntra(causa, nomeDi(autore));
      } finally {
        await dopoUnGesto();
      }
    },
    togli: async (autore) => {
      if (!selezionataId) return;
      const id = selezionataId;
      const nome = nomeDi(autore);
      try {
        const ambiente = await contestoChat(token, user.username);
        const { conversazione } = await api.togliDalGruppo(token, id, autore.id);
        ricordataRef.current = conversazione;

        const membro = membroDi(autore, ambiente.casa);
        try {
          await inSerie(async () => {
            const sessione = sessioneRef.current;
            if (sessione === undefined) {
              throw new Error(t("gruppi.non_pronto"));
            }

            // Tutte le sue foglie in un commit, e la catena d'archivio guadagna
            // la chiave che non avrà: è questo che «non riceverà più» vuol dire.
            sessioneRef.current = await faiUscire(ambiente.ctx, sessione, membro);
            await racconta(ambiente, { chi: scriviIdentita(membro), tipo: "rimozione" });
          });
          mostraSuccesso(t("gruppi.togli.fatto", { nome }));
        } catch {
          // Non è più fra le persone, ma la sua foglia c'è ancora: la toglie
          // il prossimo giro di chiunque. Finché c'è, legge — e va detto.
          mostraErrore(undefined, t("gruppi.togli.a_meta", { nome }));
        }
      } catch (causa) {
        mostraErrore(causa, t("gruppi.togli.errore"));
      } finally {
        await dopoUnGesto();
      }
    },
  };

  const assenti = useMemo(
    () =>
      selezionata === undefined || casaMia === undefined || !gruppo
        ? new Set<string>()
        : assentiFra(selezionata, casaMia, confronto),
    [casaMia, confronto, gruppo, selezionata],
  );

  /** Chi ha un dispositivo nel gruppo cifrato senza essere fra le persone, per nome. */
  const estranei = (confronto?.estranei ?? []).map((m) =>
    m.username === "" ? t("messaggi.utente") : `@${m.username}`,
  );

  const creatore = selezionata?.membri.find((m) => selezionata.ruoli?.[m.id] === "creatore");
  const titoloChat = gruppo
    ? selezionata?.nome || t("gruppi.senza_nome")
    : (altroMembro?.displayName ?? altroMembro?.username);

  const abbastanza = termine.trim().length >= MINIMO;

  const inChat = selezionataId !== undefined;

  /** Perché questa chat non si può usare, se non si può usare. */
  const impedimento = impedimentoDi({
    congelata: selezionata?.congelata === true,
    crittografiaDisponibile: isCryptoAvailable,
    erroreChiave,
    estranei,
    gruppo,
    inAttesa,
    nomeDestinatario: gruppo
      ? inAttesa && creatore !== undefined
        ? nomeDi(creatore)
        : t("gruppi.qualcuno")
      : (altroMembro?.displayName ?? altroMembro?.username ?? t("messaggi.questa_persona")),
    senzaCronologia,
    tolto,
  });
  const spiegazione = spiegazioneDi(impedimento);
  const puoScrivere = siPuoScrivere(impedimento) && !inApertura;

  return (
    <>
      <SplitLayout
        detail={
          <div className="chat-view">
            <header className="screen-head split-layout__detail-head chat-header">
              <div className="chat-header__left">
                <IconButton
                  className="split-layout__back"
                  icon="arrow-left"
                  label={t("messaggi.torna_elenco")}
                  onClick={() => setSelezionataId(undefined)}
                />
                {gruppo && selezionata !== undefined ? (
                  <button
                    aria-label={t("gruppi.membri.apri", { nome: titoloChat ?? "" })}
                    className="chat-header-link chat-header-link--gruppo"
                    disabled={tolto || impedimento.kind === "tolto-dal-gruppo"}
                    onClick={() => setMembriAperti("elenco")}
                    type="button"
                  >
                    <Avatar displayName={titoloChat ?? ""} size="sm" username={selezionata.id} />
                    <span className="chat-header__name">
                      <strong>{titoloChat}</strong>
                      <span className="muted">
                        {tn("gruppi.persone", selezionata.membri.length)}
                      </span>
                    </span>
                  </button>
                ) : (
                  (() => {
                    const remoteKey = altroMembro?.id.startsWith("remote:")
                      ? altroMembro.id.split(":")[1]
                      : undefined;
                    return (
                      <PersonLink
                        className="chat-header-link"
                        instanceKey={remoteKey}
                        username={altroMembro?.username ?? "utente"}
                      >
                        <Avatar
                          displayName={
                            altroMembro?.displayName ??
                            altroMembro?.username ??
                            t("messaggi.utente")
                          }
                          size="sm"
                          username={altroMembro?.username ?? "utente"}
                        />
                        <span className="chat-header__name">
                          <strong>{altroMembro?.displayName ?? altroMembro?.username}</strong>
                          <span className="muted">
                            (@{altroMembro?.username}
                            {remoteKey ? t("messaggi.remota") : ""})
                          </span>
                        </span>
                      </PersonLink>
                    );
                  })()
                )}
              </div>
              <div className="chat-header__right">
                <Badge tone="on">{t("messaggi.cifrata")}</Badge>
                <MenuAzioni
                  etichetta={t("messaggi.opzioni")}
                  occupato={eliminazioneInCorso}
                  titolo={t("messaggi.opzioni")}
                  voci={[
                    ...(gruppo && impedimento.kind !== "tolto-dal-gruppo"
                      ? [
                          {
                            icon: "users" as const,
                            id: "membri",
                            note: t("gruppi.membri.nota"),
                            onClick: () => setMembriAperti("elenco"),
                            title: t("gruppi.membri.voce"),
                          },
                        ]
                      : []),
                    ...(altroMembro
                      ? [
                          {
                            icon: "user" as const,
                            id: "profilo",
                            note: `@${altroMembro.username}`,
                            title: t("messaggi.vedi_profilo"),
                            to: `/@${altroMembro.username}`,
                          },
                        ]
                      : []),
                    {
                      icon: "shield" as const,
                      id: "sicurezza",
                      note: t("sicurezza.voce.nota"),
                      onClick: apriNumeroDiSicurezza,
                      title: t("sicurezza.titolo"),
                    },
                    {
                      icon: "key" as const,
                      id: "chiavi",
                      note: t("messaggi.chiavi.nota"),
                      title: t("messaggi.chiavi.titolo"),
                      to: "/impostazioni/chat",
                    },
                    {
                      icon: "download" as const,
                      id: "ripristina",
                      note: t("messaggi.ripristina.nota"),
                      onClick: () => setSheetRipristinoAperto(true),
                      title: t("ripristino.rimetti"),
                    },
                    // Un gruppo non si elimina: se ne esce, e gli altri restano.
                    ...(gruppo
                      ? impedimento.kind === "tolto-dal-gruppo" ||
                        impedimento.kind === "gruppo-congelato"
                        ? []
                        : [
                            {
                              icon: "logout" as const,
                              id: "esci",
                              note: t("gruppi.esci.nota"),
                              onClick: () => setMembriAperti("conferma-esci"),
                              title: t("gruppi.esci.voce"),
                              tono: "danger" as const,
                            },
                          ]
                      : [
                          {
                            conferma: {
                              etichetta: t("messaggi.elimina.conferma"),
                              testo: t("messaggi.elimina.testo"),
                              titolo: t("messaggi.elimina.titolo"),
                            },
                            icon: "close" as const,
                            id: "elimina",
                            note: t("messaggi.elimina.nota"),
                            onClick: () => void eseguiEliminazioneConversazione(),
                            title: t("messaggi.elimina.voce"),
                            tono: "danger" as const,
                          },
                        ]),
                  ]}
                />
              </div>
            </header>

            {selezionata && <SicurezzaConversazione conversazione={selezionata} />}

            {gruppo && selezionata !== undefined && (
              <AvvisoTrasloco
                casa={casaMia}
                conversazione={selezionata}
                mie={new Set(conversazioni.map((c) => c.id))}
                onApri={setSelezionataId}
                onTrasloca={trasloca}
              />
            )}

            {gruppo && assenti.size > 0 && impedimento.kind === "nessuno" && (
              <div className="chat-detail-alert">
                <Alert tone="neutral">
                  <p className="chiavi__testo">{tn("gruppi.assenti.avviso", assenti.size)}</p>
                  <div className="cluster avviso-sicurezza__azioni">
                    <Button onClick={() => setMembriAperti("elenco")} variant="secondary">
                      {t("gruppi.assenti.vedi")}
                    </Button>
                  </div>
                </Alert>
              </div>
            )}

            {messaggi.some((m) => m.nonDisponibile) && (
              <div className="chat-detail-alert">
                <Alert tone="neutral">
                  <p className="chiavi__testo">{t("messaggi.custoditi_altrove")}</p>
                </Alert>
              </div>
            )}

            <div className="chat-messages">
              {inApertura && (
                <p
                  aria-live="polite"
                  className="muted center"
                  style={{ marginBlockStart: "var(--s-6)" }}
                >
                  {t("messaggi.apro")}
                </p>
              )}
              {!inApertura && messaggi.length === 0 && spiegazione === undefined && (
                <p className="muted center" style={{ marginBlockStart: "var(--s-6)" }}>
                  {t("messaggi.nessun_messaggio")}
                </p>
              )}
              {messaggi.map((m) => {
                const isMe = m.senderUserId === user.id;
                if (m.evento !== undefined && selezionata !== undefined) {
                  // Qualcosa che è successo al gruppo: una riga al centro, non
                  // una nuvoletta — non è una frase di nessuno.
                  const nome =
                    casaMia === undefined
                      ? m.evento.chi
                      : nomeNellEvento(m.evento, selezionata, casaMia);
                  const chi = isMe
                    ? t("messaggi.tu")
                    : nomeDiChi(m.senderUserId, t("messaggi.interlocutore"));
                  return (
                    <p className="chat-evento muted" key={m.id}>
                      {m.evento.tipo === "uscita"
                        ? t("gruppi.evento.uscita", { nome })
                        : t(`gruppi.evento.${m.evento.tipo}`, { chi, nome })}
                    </p>
                  );
                }

                const repMsg = m.replyTo ? messaggi.find((x) => x.id === m.replyTo) : undefined;
                const repAuthor = repMsg
                  ? repMsg.senderUserId === user.id
                    ? t("messaggi.tu")
                    : nomeDiChi(repMsg.senderUserId, t("messaggi.interlocutore"))
                  : undefined;
                return (
                  <SwipeableBubble
                    key={m.id}
                    autore={
                      gruppo && !isMe && !m.nonDisponibile && !m.unreadable
                        ? nomeDiChi(m.senderUserId, t("messaggi.interlocutore"))
                        : undefined
                    }
                    isMe={isMe}
                    message={m}
                    onInfo={setMessaggioInfo}
                    onReply={setReplyToId}
                    peerVistoFinoA={peerVistoFinoA}
                    replyAuthor={repAuthor}
                    replyMessage={repMsg}
                  />
                );
              })}
              {spiegazione !== undefined && (
                <div className="chat-impedimento">
                  <EmptyState icon="key" title={spiegazione.titolo}>
                    <p className="muted">{spiegazione.testo}</p>
                    <p className="muted">{spiegazione.cosaFare}</p>
                  </EmptyState>
                </div>
              )}
              <div ref={fineMessaggiRef} />
            </div>

            <div className="chat-composer-container">
              {replyToId && (
                <div className="chat-composer__reply-bar">
                  <div className="chat-composer__reply-bar-content">
                    <span className="chat-composer__reply-bar-title">
                      {(() => {
                        const targetMsg = messaggi.find((m) => m.id === replyToId);
                        if (!targetMsg) return "";
                        return t("messaggi.risposta_a", {
                          nome:
                            targetMsg.senderUserId === user.id
                              ? t("messaggi.te_stesso")
                              : nomeDiChi(
                                  targetMsg.senderUserId,
                                  t("messaggi.interlocutore_minuscolo"),
                                ),
                        });
                      })()}
                    </span>
                    <p className="chat-composer__reply-bar-text">
                      {messaggi.find((m) => m.id === replyToId)?.text}
                    </p>
                  </div>
                  <IconButton
                    icon="close"
                    label={t("messaggi.annulla_risposta")}
                    onClick={() => setReplyToId(undefined)}
                  />
                </div>
              )}

              <form className="chat-composer" onSubmit={(e) => void invia(e)}>
                <input
                  aria-label={t("messaggi.scrivi")}
                  className="input"
                  disabled={!puoScrivere || inInvio}
                  onChange={(e) => setTesto(e.target.value)}
                  placeholder={
                    inApertura
                      ? t("messaggi.si_sta_aprendo")
                      : (spiegazione?.segnaposto ?? t("messaggi.scrivi_segnaposto"))
                  }
                  value={testo}
                />
                <Button
                  disabled={!puoScrivere || inInvio || testo.trim().length === 0}
                  type="submit"
                  variant="primary"
                >
                  {inInvio ? "..." : t("comune.invia")}
                </Button>
              </form>
            </div>
          </div>
        }
        detailClassName={inChat ? "chat-view" : ""}
        detailEmpty={<p className="muted split-layout__detail-empty">{t("messaggi.scegli")}</p>}
        nav={
          <>
            <header className="screen-head">
              <h1 className="screen-head__title grow">{t("messaggi.titolo")}</h1>
              <Button
                disabled={!isCryptoAvailable}
                icon="users"
                onClick={() => setNuovoGruppoAperto(true)}
                variant="secondary"
              >
                {t("gruppi.nuovo.voce")}
              </Button>
            </header>

            {!isCryptoAvailable && (
              <div className="chat-nav-alert">
                <Alert tone="neutral">
                  {tc("messaggi.insicura", {
                    nessuno: <strong>{t("messaggi.insicura.nessuno")}</strong>,
                  })}
                </Alert>
              </div>
            )}

            <search className="split-layout__search">
              <label className="only-screen-reader" htmlFor="cerca-messaggi">
                {t("messaggi.cerca.etichetta")}
              </label>
              <div className="cluster" style={{ flexWrap: "nowrap", gap: "var(--s-2)" }}>
                <Icon name="search" size={18} />
                <input
                  autoComplete="off"
                  className="input grow"
                  id="cerca-messaggi"
                  onChange={(event) => setTermine(event.target.value)}
                  placeholder={t("messaggi.cerca.segnaposto")}
                  type="search"
                  value={termine}
                />
              </div>
            </search>

            <div className="stack">
              {abbastanza ? (
                <>
                  {cercando && risultati === undefined && (
                    <p className="muted feed-pad">{t("cerca.cerco")}</p>
                  )}
                  {risultati !== undefined && risultati.length > 0 && (
                    <div className="list-block">
                      <h2 className="gruppo">{t("messaggi.risultati")}</h2>
                      {risultati.map((trovato) => (
                        <button
                          className="row"
                          key={
                            trovato.isRemote
                              ? `${trovato.instanceKey}:${trovato.username}`
                              : trovato.username
                          }
                          onClick={() => void avviaChat(trovato)}
                          type="button"
                        >
                          <span className="row__body">
                            <span
                              className="cluster"
                              style={{ gap: "var(--s-3)", flexWrap: "nowrap" }}
                            >
                              <Avatar
                                displayName={trovato.displayName}
                                size="md"
                                username={trovato.username}
                              />
                              <span
                                className="stack stack--tight"
                                style={{ gap: 0, minWidth: 0, alignItems: "flex-start" }}
                              >
                                <span className="row__title truncate">
                                  {trovato.displayName}
                                  {trovato.isRemote && (
                                    <span
                                      className="badge badge--subtle"
                                      style={{
                                        marginInlineStart: "var(--s-2)",
                                        fontSize: "var(--t-xs)",
                                      }}
                                    >
                                      {trovato.tramite || t("messaggi.rete")}
                                    </span>
                                  )}
                                </span>
                                <span className="row__note truncate">
                                  @{trovato.username}
                                  {trovato.isRemote && trovato.tramite && ` · ${trovato.tramite}`}
                                </span>
                              </span>
                            </span>
                          </span>
                          <span className="row__end">
                            <Icon name="send" size={20} />
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {risultati !== undefined && risultati.length === 0 && (
                    <p className="muted feed-pad">{t("messaggi.nessuno_trovato")}</p>
                  )}
                </>
              ) : (
                <>
                  {caricamento && <p className="empty-inline">{t("messaggi.caricamento")}</p>}
                  {!caricamento && conversazioni.length === 0 && (
                    <EmptyState icon="send" title={t("messaggi.vuoto.titolo")}>
                      <p className="muted">{t("messaggi.vuoto.testo")}</p>
                    </EmptyState>
                  )}
                  {conversazioni.length > 0 && (
                    <div className="list-block">
                      {conversazioni.map((c) => {
                        const altro = c.membri.find((m) => m.id !== user.id) ?? c.membri[0];
                        const unGruppo = eUnGruppo(c);
                        const nome = unGruppo
                          ? c.nome || t("gruppi.senza_nome")
                          : (altro?.displayName ?? altro?.username ?? t("messaggi.utente"));
                        // Il colore dell'avatar di un gruppo viene dal suo id: non cambia col nome.
                        const userHandle = unGruppo ? c.id : (altro?.username ?? "anon");
                        const isActive = c.id === selezionataId;
                        return (
                          <button
                            aria-current={isActive ? "page" : undefined}
                            className={`row ${isActive ? "row--active" : ""}`}
                            key={c.id}
                            onClick={() => setSelezionataId(c.id)}
                            type="button"
                          >
                            <span className="row__body">
                              <span
                                className="cluster"
                                style={{ gap: "var(--s-3)", flexWrap: "nowrap" }}
                              >
                                <Avatar displayName={nome} size="md" username={userHandle} />
                                <span
                                  className="stack stack--tight"
                                  style={{ gap: 0, minWidth: 0, alignItems: "flex-start" }}
                                >
                                  <span className="row__title truncate">{nome}</span>
                                  <span className="row__note truncate">
                                    {/* Un gruppo traslocato e chi lo continua hanno lo
                                        stesso nome: nell'elenco li distingue chi ha
                                        traslocato, e quando (ADR 0042 §3). */}
                                    {!unGruppo
                                      ? `@${userHandle}`
                                      : c.congelata === true
                                        ? t("gruppi.trasloco.elenco_congelato")
                                        : c.continua !== undefined
                                          ? t("gruppi.trasloco.elenco_successore", {
                                              chi: nomeDaIndirizzo(c.continua.da, c, casaMia ?? ""),
                                              il: giornoDi(c.continua.il),
                                            })
                                          : tn("gruppi.persone", c.membri.length)}{" "}
                                    ·{" "}
                                    {c.ultimoMessaggio
                                      ? ora(c.ultimoMessaggio.createdAt)
                                      : ora(c.createdAt)}
                                  </span>
                                </span>
                              </span>
                            </span>
                            <span className="row__end">
                              {c.nonLetti > 0 && <Badge tone="on">{c.nonLetti}</Badge>}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        }
        navLabel={t("messaggi.elenco")}
        showNav={!inChat}
      />
      <NuovoGruppo
        aperto={nuovoGruppoAperto}
        casa={async () => (await contestoChat(token, user.username)).casa}
        onChiudi={() => setNuovoGruppoAperto(false)}
        onCreato={(conversazione) => {
          setNuovoGruppoAperto(false);
          void caricaConversazioni().then(() => setSelezionataId(conversazione.id));
        }}
      />
      {gruppo && selezionata !== undefined && (
        <MembriGruppo
          aperto={membriAperti !== undefined}
          assenti={assenti}
          casa={casaMia}
          conversazione={selezionata}
          gesti={gestiDelGruppo}
          iniziale={membriAperti ?? "elenco"}
          ioId={user.id}
          onChiudi={() => setMembriAperti(undefined)}
        />
      )}
      <Sheet
        open={sheetRipristinoAperto}
        onClose={() => {
          setSheetRipristinoAperto(false);
        }}
        title={t("messaggi.ripristino.titolo")}
        variant="centrato"
      >
        <div className="feed-pad stack" style={{ paddingBlock: "var(--s-4)" }}>
          <p className="muted chiavi__testo">{t("messaggi.ripristino.testo")}</p>

          <form onSubmit={(e) => void eseguiRipristinoChiavi(e)} className="stack">
            <TextField
              autoFocus
              label={t("ripristino.frase")}
              onChange={(e) => setPassphraseRipristino(e.target.value)}
              required
              type="password"
              value={passphraseRipristino}
            />
            <div className="cluster cluster--end" style={{ marginBlockStart: "var(--s-2)" }}>
              <Button
                disabled={ripristinoInCorso}
                onClick={() => setSheetRipristinoAperto(false)}
                type="button"
                variant="secondary"
              >
                {t("comune.annulla")}
              </Button>
              <Button
                disabled={ripristinoInCorso || passphraseRipristino.trim().length === 0}
                type="submit"
                variant="primary"
              >
                {ripristinoInCorso ? t("comune.un_momento") : t("messaggi.ripristino.rimetti")}
              </Button>
            </div>
          </form>
        </div>
      </Sheet>

      {/* Dettagli messaggio */}
      <Sheet
        onClose={() => setMessaggioInfo(undefined)}
        open={Boolean(messaggioInfo)}
        title={t("messaggi.dettagli")}
        variant="centrato"
      >
        {messaggioInfo && (
          <div className="feed-pad stack" style={{ paddingBlock: "var(--s-4)" }}>
            <div
              className={`chat-bubble ${
                messaggioInfo.senderUserId === user.id ? "chat-bubble--me" : "chat-bubble--them"
              }`}
              style={{ margin: "0 auto", width: "100%" }}
            >
              <p className="chat-bubble__text">{messaggioInfo.text}</p>
            </div>

            <div
              className="stack stack--tight"
              style={{
                borderBlockStart: "1px solid var(--border)",
                paddingBlockStart: "var(--s-3)",
                marginBlockStart: "var(--s-2)",
              }}
            >
              <div
                className="cluster"
                style={{ justifyContent: "space-between", fontSize: "var(--t-sm)" }}
              >
                <span className="muted">{t("messaggi.mittente")}</span>
                <strong>
                  {messaggioInfo.senderUserId === user.id
                    ? t("messaggi.tu_handle", { utente: user.username })
                    : (() => {
                        const autore = selezionata?.membri.find(
                          (m) => m.id === messaggioInfo.senderUserId,
                        );
                        return `${autore === undefined ? t("messaggi.utente") : nomeDi(autore)} (@${autore?.username ?? ""})`;
                      })()}
                </strong>
              </div>

              {!messaggioInfo.pending && (
                <div
                  className="cluster"
                  style={{ justifyContent: "space-between", fontSize: "var(--t-sm)" }}
                >
                  <span className="muted">{t("messaggi.provenienza")}</span>
                  <span>
                    {messaggioInfo.nonAttestata === true
                      ? t("messaggi.provenienza.non_attestata")
                      : t("messaggi.provenienza.attestata")}
                  </span>
                </div>
              )}

              <div
                className="cluster"
                style={{ justifyContent: "space-between", fontSize: "var(--t-sm)" }}
              >
                <span className="muted">{t("messaggi.orario")}</span>
                <span>{quandoPreciso(messaggioInfo.createdAt)}</span>
              </div>

              <div
                className="cluster"
                style={{ justifyContent: "space-between", fontSize: "var(--t-sm)" }}
              >
                <span className="muted">{t("messaggi.stato_consegna")}</span>
                <span className="cluster" style={{ gap: "var(--s-1)", alignItems: "center" }}>
                  {messaggioInfo.pending ? (
                    <>
                      <Icon name="clock" size={15} /> {t("messaggi.stato.in_invio")}
                    </>
                  ) : peerVistoFinoA && messaggioInfo.createdAt <= peerVistoFinoA ? (
                    <>
                      <Icon name="eye" size={15} /> {t("messaggi.stato.letto")}
                    </>
                  ) : (
                    <>
                      <Icon name="check" size={15} /> {t("messaggi.stato.inviato")}
                    </>
                  )}
                </span>
              </div>

              <div
                className="cluster"
                style={{ justifyContent: "space-between", fontSize: "var(--t-sm)" }}
              >
                <span className="muted">{t("messaggi.crittografia")}</span>
                <span className="cluster" style={{ gap: "var(--s-1)", alignItems: "center" }}>
                  <Icon name="key" size={15} /> {t("messaggi.end_to_end")}
                </span>
              </div>
            </div>

            <div className="cluster cluster--end" style={{ marginBlockStart: "var(--s-2)" }}>
              <Button onClick={() => setMessaggioInfo(undefined)} type="button" variant="secondary">
                {t("comune.chiudi")}
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </>
  );
}
