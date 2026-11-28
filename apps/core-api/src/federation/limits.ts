/**
 * How much work this instance is willing to do for another one (ADR 0020 §2).
 *
 * The rule that shapes this file is arithmetic, not caution: **a single global
 * ceiling turns one noisy instance into everybody else's problem.** If one
 * saturates the budget, the legitimate requests of twenty connected instances
 * are refused along with its own. So the budget is counted per key.
 *
 * And nothing here touches the disk. Counters for instances we have no
 * relationship with live in memory, with a ceiling and an expiry, and a restart
 * forgets them — because the alternative is a persistent record of everyone who
 * ever knocked, which ADR 0020 §3 refuses to build.
 */

export interface Budget {
  /** How many requests are allowed inside one window. */
  requests: number;
  /** How long the window lasts, in milliseconds. */
  windowMs: number;
}

export interface BudgetOptions {
  /**
   * An unknown instance may do exactly one thing — introduce itself — so its
   * budget only has to cover that, and being stingy here costs nobody anything.
   */
  unknown?: Budget;
  /**
   * A connected instance is one somebody said yes to, and that yes is also a
   * statement about how much work we are willing to do for them.
   */
  connected?: Budget;
  /**
   * Le richieste che portano **contenuti**, che hanno un budget loro e più
   * stretto ([ADR 0023] §3).
   *
   * La ragione è aritmetica come tutto il resto di questo file: una pagina di
   * bacheca arriva a 256 kB, e centoventi al minuto — il tetto di un'istanza
   * collegata — varrebbero **30 MB al minuto in uscita** da un NAS che sta in
   * casa di qualcuno, cioè un modo di occupargli la linea restando dentro le
   * regole. Trenta al minuto sono più di quante ne servano a leggere un feed
   * e un ordine di grandezza meno di quante ne servano a fare danno.
   */
  content?: Budget;
  /**
   * Budget dedicato per la consegna di messaggi privati E2E.
   * Separato dalle letture per proteggere lo spazio disco.
   */
  delivery?: Budget;
  /**
   * How many unknown keys are tracked at once. The map itself must not become
   * the way to exhaust this instance's memory.
   */
  maxTrackedUnknown?: number;
  now?: () => number;
}

const DEFAULTS = {
  connected: { requests: 120, windowMs: 60_000 },
  content: { requests: 30, windowMs: 60_000 },
  delivery: { requests: 60, windowMs: 60_000 },
  maxTrackedUnknown: 1024,
  unknown: { requests: 5, windowMs: 60_000 },
} as const;

/** Below this many entries a map is not worth walking. */
const SWEEP_AT = 256;

interface Window {
  startedAt: number;
  count: number;
  connected: boolean;
}

export type BudgetLevel = "sconosciuta" | "collegata";

export class RemoteBudgets {
  readonly #windows = new Map<string, Window>();
  readonly #contentWindows = new Map<string, Window>();
  readonly #deliveryWindows = new Map<string, Window>();
  readonly #unknown: Budget;
  readonly #connected: Budget;
  readonly #content: Budget;
  readonly #delivery: Budget;
  readonly #maxTrackedUnknown: number;
  readonly #now: () => number;

  public constructor(options: BudgetOptions = {}) {
    this.#unknown = options.unknown ?? DEFAULTS.unknown;
    this.#connected = options.connected ?? DEFAULTS.connected;
    this.#content = options.content ?? DEFAULTS.content;
    this.#delivery = options.delivery ?? DEFAULTS.delivery;
    this.#maxTrackedUnknown = options.maxTrackedUnknown ?? DEFAULTS.maxTrackedUnknown;
    this.#now = options.now ?? Date.now;
  }

  /** True when the request may proceed. Never throws, never blocks. */
  public allow(publicKey: string, level: BudgetLevel): boolean {
    const connected = level === "collegata";
    const budget = connected ? this.#connected : this.#unknown;
    const now = this.#now();
    const existing = this.#windows.get(publicKey);

    if (existing === undefined || now - existing.startedAt >= budget.windowMs) {
      if (!connected && !this.#roomForAnotherUnknown(now)) {
        // Full, and this one is a stranger: refuse rather than evict somebody
        // who is inside their budget. Failing closed here costs an unknown
        // instance a retry; failing open would make the ceiling decorative.
        return false;
      }

      this.#windows.set(publicKey, { connected, count: 1, startedAt: now });

      return true;
    }

    if (existing.count >= budget.requests) {
      return false;
    }

    existing.count += 1;
    existing.connected = connected;

    return true;
  }

  /**
   * True quando una richiesta che porta contenuti può procedere.
   *
   * Si conta **oltre** al budget generale e non al posto suo: una bacheca è
   * comunque una richiesta, e l'unica cosa che questo tetto aggiunge è che
   * costa di più. Il conto sta in una mappa sua, altrimenti le due finestre si
   * consumerebbero a vicenda e nessuno dei due tetti direbbe la verità.
   *
   * Nessuna riga nuova per chi non ha già un rapporto: qui si arriva solo con
   * una prova valida, che esiste soltanto se qualcuno di qua ha detto di sì.
   */
  public allowContent(publicKey: string): boolean {
    const now = this.#now();
    const existing = this.#contentWindows.get(publicKey);

    if (existing === undefined || now - existing.startedAt >= this.#content.windowMs) {
      if (existing === undefined && !this.#roomIn(this.#contentWindows, this.#content, now)) {
        return false;
      }

      this.#contentWindows.set(publicKey, { connected: true, count: 1, startedAt: now });

      return true;
    }

    if (existing.count >= this.#content.requests) {
      return false;
    }

    existing.count += 1;

    return true;
  }

  public allowDelivery(publicKey: string): boolean {
    const now = this.#now();
    const existing = this.#deliveryWindows.get(publicKey);

    if (existing === undefined || now - existing.startedAt >= this.#delivery.windowMs) {
      if (existing === undefined && !this.#roomIn(this.#deliveryWindows, this.#delivery, now)) {
        return false;
      }

      this.#deliveryWindows.set(publicKey, { connected: true, count: 1, startedAt: now });
      return true;
    }

    if (existing.count >= this.#delivery.requests) {
      return false;
    }

    existing.count += 1;
    return true;
  }

  /**
   * Room for a new key in the content or delivery map.
   *
   * These maps used to only grow (internal review, 2026-11-27): a key is
   * nothing but a fresh handshake, so a stranger minting keys could fill
   * memory one entry at a time. Expired windows are swept when the map is
   * large enough for it to matter, and past the ceiling a new key waits for
   * the next window, the same fail-closed rule as for unknown instances.
   */
  #roomIn(map: Map<string, Window>, budget: Budget, now: number): boolean {
    if (map.size < SWEEP_AT) {
      return true;
    }

    for (const [key, window] of map) {
      if (now - window.startedAt >= budget.windowMs) {
        map.delete(key);
      }
    }

    return map.size < Math.max(SWEEP_AT, this.#maxTrackedUnknown * 4);
  }

  #roomForAnotherUnknown(now: number): boolean {
    let tracked = 0;

    for (const [key, window] of this.#windows) {
      // Expired windows are swept here rather than on a timer: the only moment
      // this map's size matters is the moment something is being added to it.
      // A connected window is swept too once it has expired, or the entries of
      // every instance ever connected would stay for the life of the process.
      if (window.connected) {
        if (now - window.startedAt >= this.#connected.windowMs) {
          this.#windows.delete(key);
        }

        continue;
      }

      if (now - window.startedAt >= this.#unknown.windowMs) {
        this.#windows.delete(key);
        continue;
      }

      tracked += 1;
    }

    return tracked < this.#maxTrackedUnknown;
  }

  /** Lets a revoked relationship stop counting as a generous one immediately. */
  public forget(publicKey: string): void {
    this.#windows.delete(publicKey);
    this.#contentWindows.delete(publicKey);
    this.#deliveryWindows.delete(publicKey);
  }
}
