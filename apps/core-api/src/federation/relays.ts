/**
 * La mappa dei relay di una Casa ([ADR 0045](../../../../docs/adr/0045-la-rete-dei-relay-della-comunita.md) §2).
 *
 * Una Casa usa i relay che il suo amministratore ha adottato, e **n0 per
 * ultimo, mai tolto**. Il laboratorio dei relay ha trovato il 2026-11-27 che
 * questa frase non si traduce mettendo n0 in coda alla mappa: iroh sceglie il
 * relay principale **per latenza**, non per ordine, e n0 è quasi sempre il più
 * vicino. Quindi:
 *
 * - finché almeno un relay adottato risponde, la mappa contiene **solo** gli
 *   adottati — tutti, anche quelli che tacciono, perché iroh non sceglierà mai
 *   un relay che non risponde e tenerli evita di riscrivere la mappa a ogni
 *   singhiozzo;
 * - quando nessuno risponde, n0 entra nella mappa accanto a loro;
 * - quando uno torna, n0 ne esce.
 *
 * «Mai tolto» vuol dire questo: n0 è sempre lì dietro, pronto, non che sia
 * sempre nella mappa. Senza relay adottati la mappa è quella di n0, cioè la
 * Casa di oggi.
 *
 * Chi chiama raggiunge comunque il relay dell'altro anche se non è nella
 * propria mappa (verifica 1): la mappa decide dove **questa** Casa si fa
 * trovare, non chi può raggiungere.
 */

import type { SettingsRepository } from "../backup/settings.js";
import { DomainError } from "../errors.js";

/** Un relay adottato, con ciò che l'amministratore ha visto quando l'ha adottato. */
export interface AdoptedRelay {
  /** Forma canonica: `https://host[:porta]/`. */
  url: string;
  /** Chi lo gestisce, come è stato detto all'amministratore (§«Che cosa vede chi»). */
  gestore: string;
  adottatoIl: string;
}

const KEY = "network.relays";

/** Quanti relay una Casa può adottare: pochi, sparsi e indipendenti (§1). */
export const MAX_ADOPTED_RELAYS = 8;

/**
 * La forma canonica di un indirizzo di relay, o `undefined` se non lo è.
 *
 * Solo `https`: un relay senza certificato è un relay che chiunque sulla
 * strada può impersonare per far cadere i pacchetti, e iroh lo accetterebbe.
 * Niente credenziali, percorso, query o frammento: un relay è un'origine.
 */
export function canonicalRelayUrl(input: string): string | undefined {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  if (url.hostname === "") return undefined;

  return `${url.protocol}//${url.host}/`;
}

function isAdoptedRelay(value: unknown): value is AdoptedRelay {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.url === "string" &&
    canonicalRelayUrl(candidate.url) === candidate.url &&
    typeof candidate.gestore === "string" &&
    typeof candidate.adottatoIl === "string"
  );
}

/** I relay adottati. Una riga illeggibile si salta invece di spegnere la rete. */
export function readAdoptedRelays(repository: SettingsRepository): AdoptedRelay[] {
  const stored = repository.read(KEY);
  if (stored === undefined) return [];

  try {
    const parsed: unknown = JSON.parse(stored);

    return Array.isArray(parsed) ? parsed.filter(isAdoptedRelay).slice(0, MAX_ADOPTED_RELAYS) : [];
  } catch {
    return [];
  }
}

export function writeAdoptedRelays(
  repository: SettingsRepository,
  relays: readonly AdoptedRelay[],
  updatedAt: string,
): void {
  if (relays.length === 0) {
    repository.clear(KEY);

    return;
  }

  repository.write(KEY, JSON.stringify(relays), updatedAt);
}

/**
 * Adotta un relay (§3): con un gesto, mai in automatico, e con il nome di chi
 * lo gestisce, che è quello che l'amministratore deve sapere quando adotta.
 */
export function adoptRelay(
  repository: SettingsRepository,
  input: { url: string; gestore: string },
  now: Date,
): AdoptedRelay[] {
  const url = canonicalRelayUrl(input.url);
  if (url === undefined) throw new DomainError("relay_indirizzo_non_valido", 400);

  const gestore = input.gestore.trim();
  if (gestore === "") throw new DomainError("relay_gestore_mancante", 400);

  const relays = readAdoptedRelays(repository);
  if (relays.some((relay) => relay.url === url)) throw new DomainError("relay_gia_adottato", 409);
  if (relays.length >= MAX_ADOPTED_RELAYS) {
    throw new DomainError("troppi_relay", 409, { massimo: MAX_ADOPTED_RELAYS });
  }

  const next = [...relays, { url, gestore, adottatoIl: now.toISOString() }];
  writeAdoptedRelays(repository, next, now.toISOString());

  return next;
}

/** Toglie un relay adottato. Tolti tutti, la Casa torna alla mappa di n0. */
export function removeRelay(
  repository: SettingsRepository,
  input: string,
  now: Date,
): AdoptedRelay[] {
  const url = canonicalRelayUrl(input) ?? input;
  const relays = readAdoptedRelays(repository);
  const next = relays.filter((relay) => relay.url !== url);

  if (next.length === relays.length) throw new DomainError("relay_non_adottato", 404);
  writeAdoptedRelays(repository, next, now.toISOString());

  return next;
}

/**
 * Gli URL che la mappa deve contenere adesso.
 *
 * `healthy` sono gli adottati che all'ultimo controllo hanno risposto; `n0`
 * sono i relay di n0, come li dà il binding.
 */
export function plannedRelayMap(options: {
  adopted: readonly string[];
  healthy: ReadonlySet<string>;
  n0: readonly string[];
}): string[] {
  const { adopted, healthy, n0 } = options;

  if (adopted.length === 0) return [...n0];

  const anyHealthy = adopted.some((url) => healthy.has(url));

  return anyHealthy ? [...adopted] : [...new Set([...adopted, ...n0])];
}

/**
 * Un relay che una Casa collegata dice di usare ([ADR 0045](../../../../docs/adr/0045-la-rete-dei-relay-della-comunita.md) §3).
 *
 * Arriva con la risposta a `presentazione`, cioè con il battito, e si tiene
 * **solo in memoria**: è un suggerimento, non un fatto da conservare, e dopo un
 * riavvio torna da solo al primo giro. Non si adotta mai da qui: il pannello lo
 * mostra e l'amministratore, se vuole, lo adotta con un gesto.
 */
export interface RelaySuggestion {
  url: string;
  gestore: string;
  /** Il nome che la Casa amica dà a sé stessa: dichiarato, mai verificato (ADR 0020 §5). */
  casa: string;
}

/** Quanto può essere lungo il nome di chi gestisce un relay suggerito. */
export const MAX_GESTORE_LENGTH = 120;

/**
 * Il relay suggerito da un'altra Casa, letto dal filo, o `undefined` se non è
 * un suggerimento accettabile. Chi suggerisce è un'altra istanza: niente di
 * quello che manda si prende così com'è.
 */
export function parseRelaySuggestion(value: unknown): { url: string; gestore: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.url !== "string" || typeof candidate.gestore !== "string") return undefined;
  if (candidate.url.length > 512) return undefined;

  const url = canonicalRelayUrl(candidate.url);
  const gestore = candidate.gestore.trim();
  if (url === undefined || gestore === "" || gestore.length > MAX_GESTORE_LENGTH) return undefined;

  return { url, gestore };
}

/** Che cosa il controllo dei relay sa di sé, per il pannello. */
export interface RelayStatus {
  url: string;
  gestore: string;
  /** `undefined` finché non è stato controllato. */
  risponde?: boolean;
  controllatoIl?: string;
}

/** La parte dell'endpoint che il controllo usa: si sostituisce nelle prove. */
export interface RelayMapTarget {
  /** Gli URL dei relay di n0, o `undefined` se il binding non c'è. */
  n0RelayUrls(): string[] | undefined;
  setRelayMap(urls: readonly string[]): Promise<void>;
  /** Il relay attraverso cui la Casa si fa trovare adesso. */
  readonly homeRelay?: string | undefined;
}

export type RelayPing = (url: string, signal: AbortSignal) => Promise<boolean>;

/**
 * Chiede a un relay se c'è: `GET /ping`, che `iroh-relay` serve con un 200.
 *
 * Non dice niente di chi chiede oltre all'indirizzo della Casa, che il relay
 * vedrà comunque appena la Casa lo usa.
 */
export const pingRelay: RelayPing = async (url, signal) => {
  try {
    const response = await fetch(new URL("ping", url), {
      method: "GET",
      redirect: "error",
      signal,
    });

    return response.status === 200;
  } catch {
    return false;
  }
};

/**
 * Tiene d'occhio i relay adottati e la mappa dell'endpoint (§2).
 *
 * Stesso ritmo del battito di [ADR 0041](../../../../docs/adr/0041-le-istanze-si-tengono-d-occhio.md),
 * cinque minuti, con un tetto di tempo a ogni domanda: senza, «risponde» non è
 * uno stato.
 */
export class RelayWatch {
  readonly #settings: SettingsRepository;
  readonly #target: RelayMapTarget;
  readonly #ping: RelayPing;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #collegata: (publicKey: string) => boolean;
  readonly #status = new Map<string, { risponde: boolean; controllatoIl: string }>();
  /** I suggerimenti delle Case collegate, per chiave pubblica di chi suggerisce. */
  readonly #suggeriti = new Map<string, RelaySuggestion>();
  #applied: string[] | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  public static readonly INTERVAL_MS = 5 * 60 * 1000;

  public constructor(options: {
    settings: SettingsRepository;
    target: RelayMapTarget;
    ping?: RelayPing;
    now?: () => Date;
    timeoutMs?: number;
    /**
     * Se una Casa è ancora collegata. Un suggerimento di chi è stata bloccata o
     * tolta smette di comparire subito, non al riavvio.
     */
    collegata?: (publicKey: string) => boolean;
  }) {
    this.#settings = options.settings;
    this.#target = options.target;
    this.#ping = options.ping ?? pingRelay;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#collegata = options.collegata ?? (() => true);
  }

  public start(): void {
    if (this.#timer !== undefined) return;
    void this.check();
    this.#timer = setInterval(() => void this.check(), RelayWatch.INTERVAL_MS);
    this.#timer.unref?.();
  }

  public stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Lo stato di ogni relay adottato, nell'ordine in cui sono stati adottati. */
  public status(): RelayStatus[] {
    return readAdoptedRelays(this.#settings).map(({ url, gestore }) => ({
      url,
      gestore,
      ...this.#status.get(url),
    }));
  }

  /**
   * Il relay che questa Casa fa sapere alle Case collegate, se ne usa uno
   * adottato: quello attraverso cui si fa trovare adesso, con il nome di chi
   * lo gestisce. Su n0 non suggerisce niente: n0 ce l'hanno già tutte.
   */
  public daSuggerire(): { url: string; gestore: string } | undefined {
    const home = this.#target.homeRelay;
    if (home === undefined) return undefined;
    const url = canonicalRelayUrl(home);
    const adottato = readAdoptedRelays(this.#settings).find((relay) => relay.url === url);

    return adottato === undefined ? undefined : { url: adottato.url, gestore: adottato.gestore };
  }

  /**
   * Ciò che una Casa collegata ha detto del suo relay all'ultima presentazione.
   * `relay` assente vuol dire che non ne suggerisce più uno.
   */
  public suggerito(input: {
    publicKey: string;
    casa: string;
    relay?: { url: string; gestore: string } | undefined;
  }): void {
    if (input.relay === undefined) {
      this.#suggeriti.delete(input.publicKey);

      return;
    }

    this.#suggeriti.set(input.publicKey, { ...input.relay, casa: input.casa });
  }

  /** Che cosa mostra il pannello (`CommunityRelaysView`). */
  public view(): {
    attivi: boolean;
    relays: (AdoptedRelay & { risponde?: boolean; controllatoIl?: string })[];
    suggeriti: RelaySuggestion[];
    inUso?: string;
    ripiegoSuN0: boolean;
    massimo: number;
  } {
    const n0 = this.#target.n0RelayUrls();
    const relays = readAdoptedRelays(this.#settings).map((relay) => ({
      ...relay,
      ...this.#status.get(relay.url),
    }));
    const inUso = n0 === undefined ? undefined : this.#target.homeRelay;
    const adottati = new Set(relays.map((relay) => relay.url));
    const suggeriti = [...this.#suggeriti]
      .filter(([key, suggestion]) => this.#collegata(key) && !adottati.has(suggestion.url))
      .map(([, suggestion]) => suggestion)
      .sort((a, b) => a.casa.localeCompare(b.casa) || a.url.localeCompare(b.url));

    return {
      attivi: n0 !== undefined,
      relays,
      suggeriti,
      ...(inUso === undefined ? {} : { inUso }),
      ripiegoSuN0:
        n0 !== undefined &&
        relays.length > 0 &&
        (this.#applied ?? []).some((url) => n0.includes(url)),
      massimo: MAX_ADOPTED_RELAYS,
    };
  }

  /** La mappa che l'ultimo controllo ha dato all'endpoint, se gliene ha data una. */
  public get appliedMap(): readonly string[] | undefined {
    return this.#applied;
  }

  /**
   * Controlla gli adottati e, se serve, cambia la mappa. Due controlli insieme
   * diventano uno: quello che parte aspetta quello in corso.
   */
  public async check(): Promise<void> {
    while (this.#running !== undefined) await this.#running;
    this.#running = this.#check();

    try {
      await this.#running;
    } finally {
      this.#running = undefined;
    }
  }

  async #check(): Promise<void> {
    const n0 = this.#target.n0RelayUrls();
    if (n0 === undefined) return;

    const adopted = readAdoptedRelays(this.#settings).map((relay) => relay.url);
    for (const url of this.#status.keys()) {
      if (!adopted.includes(url)) this.#status.delete(url);
    }

    const healthy = new Set<string>();
    await Promise.all(
      adopted.map(async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
        let risponde = false;

        try {
          risponde = await this.#ping(url, controller.signal);
        } finally {
          clearTimeout(timer);
        }

        this.#status.set(url, { risponde, controllatoIl: this.#now().toISOString() });
        if (risponde) healthy.add(url);
      }),
    );

    const planned = plannedRelayMap({ adopted, healthy, n0 });
    const same =
      this.#applied !== undefined &&
      this.#applied.length === planned.length &&
      this.#applied.every((url, index) => url === planned[index]);

    if (same) return;

    try {
      await this.#target.setRelayMap(planned);
      this.#applied = planned;
    } catch {
      // Un endpoint chiuso o che rifiuta un relay: si riprova al giro dopo.
      this.#applied = undefined;
    }
  }
}
