/**
 * The instance's one and only socket on the network between instances.
 *
 * **One key, one endpoint.** The temptation is to let each feature bind its
 * own: the probe of [ADR 0018] one, the protocol of [ADR 0021] another. It
 * would be wrong in a way that only shows up in somebody's house — both would
 * bind the *same* key, because the key is derived from the instance identity
 * and is the instance's address, and discovery would then hold two records
 * claiming the same identity at two different sockets. A remote instance
 * resolving that key could land on the socket that does not speak the ALPN it
 * wanted.
 *
 * So the endpoint is bound once, with every ALPN the instance serves, and
 * incoming connections are routed by the ALPN that QUIC negotiated. The probe
 * keeps its own ALPN and stays a measurement; the protocol gets `estia/1`.
 *
 * Everything here is written so that a missing or broken native module can
 * only ever become a sentence in the diagnostics — never a boot failure.
 */

/** Loaded lazily, so an architecture without a binary costs a message, not the instance. */
async function loadIroh(): Promise<{ module?: IrohModule; reason?: string }> {
  try {
    return { module: (await import("@number0/iroh")) as unknown as IrohModule };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface IrohModule {
  Endpoint: {
    builder: () => {
      applyMinimal: () => void;
      applyN0: () => void;
      relayMode: (mode: unknown) => void;
      alpns: (alpns: number[][]) => void;
      secretKey: (bytes: number[]) => void;
      /** `ip:porta`; senza, la porta la sceglie il sistema a ogni avvio. */
      bindAddr?: (addr: string) => void;
      bind: () => Promise<IrohEndpoint>;
    };
  };
  EndpointTicket: {
    fromAddr: (addr: unknown) => { toString: () => string };
    fromString: (value: string) => { endpointAddr: () => { id: () => { toString: () => string } } };
  };
  EndpointId: {
    fromString: (value: string) => unknown;
  };
  EndpointAddr: new (id: unknown) => unknown;
  RelayMode: {
    defaultMode: () => { relayMap: () => { urls: () => string[] } };
    customFromUrls: (urls: string[]) => unknown;
  };
}

export interface IrohEndpoint {
  id: () => { toString: () => string };
  addr: () => { relayUrl?: () => string | null };
  boundSockets?: () => string[];
  insertRelay?: (config: { url: string }) => Promise<void>;
  removeRelay?: (url: string) => Promise<boolean>;
  acceptNext: () => Promise<IrohIncoming | null>;
  connect: (addr: unknown, alpn: number[]) => Promise<IrohConnection>;
  close: () => Promise<void>;
}

export interface IrohIncoming {
  accept: () => Promise<IrohAccepting>;
}

export interface IrohAccepting {
  /** Which ALPN QUIC settled on, which is how a connection finds its handler. */
  alpn: () => Promise<number[]>;
  connect: () => Promise<IrohConnection>;
}

export interface IrohConnection {
  acceptBi: () => Promise<IrohStream>;
  openBi: () => Promise<IrohStream>;
  /**
   * The authenticated public key of the other end.
   *
   * ADR 0021 §1: this is the only thing that ever decides a permission. It comes
   * from the QUIC handshake, so it cannot be claimed — unlike any field inside
   * a message, which the caller writes.
   */
  remoteId: () => { toString: () => string };
  paths: () => { isSelected: boolean; isRelay: boolean; rttMs: number }[];
  close: (errorCode: bigint, reason: number[]) => void;
}

export interface IrohStream {
  send: { writeAll: (data: number[]) => Promise<void>; finish: () => Promise<void> };
  recv: { readToEnd: (limit: number) => Promise<number[]> };
}

export type EndpointMode = "local" | "internet";

/** Serves one ALPN. Returning ends the connection; throwing is caught and dropped. */
export interface AlpnService {
  /** The wire name, e.g. `estia/1`. */
  readonly alpn: string;
  serve(connection: IrohConnection): Promise<void>;
}

const encoder = new TextEncoder();

export function alpnBytes(alpn: string): number[] {
  return Array.from(encoder.encode(alpn));
}

function sameAlpn(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export class InstanceEndpoint {
  readonly #secretKey: number[];
  readonly #services: AlpnService[] = [];

  #iroh: IrohModule | undefined;
  #endpoint: IrohEndpoint | undefined;
  #endpointId: string | undefined;
  #ticket: string | undefined;
  #reason: string | undefined;
  #mode: EndpointMode | undefined;
  #accepting = false;
  /** La mappa dei relay chiesta da `setRelayMap`; `undefined` = quella di n0. */
  #wantedRelays: string[] | undefined;
  /** La mappa che l'endpoint aperto ha davvero. */
  #currentRelays: string[] = [];
  readonly #onOpen: (() => void)[] = [];
  /** La porta UDP fissa di `ESTIA_UDP_PORT`, se c'è (ADR 0045 §6). */
  readonly #udpPort: number | undefined;
  /** Perché la porta fissa non è stata presa all'ultima apertura, se non lo è stata. */
  #udpPortRefused: string | undefined;

  public constructor(secretKey: Uint8Array, options: { udpPort?: number | undefined } = {}) {
    if (secretKey.length !== 32) {
      throw new Error("The network identity must be a 32-byte ed25519 secret key.");
    }

    this.#secretKey = Array.from(secretKey);
    this.#udpPort = options.udpPort;
  }

  /**
   * La porta UDP fissa e se l'endpoint aperto la sta usando.
   *
   * `rifiutata` dice perché no: una porta occupata non spegne la rete — la
   * Casa si apre su una porta a caso e lo dice, perché chi ha aperto quella
   * porta sul router deve sapere che adesso non porta da nessuna parte.
   */
  public get udpPort(): { porta: number; inUso: boolean; rifiutata?: string } | undefined {
    if (this.#udpPort === undefined) return undefined;

    return {
      porta: this.#udpPort,
      inUso: this.#endpoint !== undefined && this.#udpPortRefused === undefined,
      ...(this.#udpPortRefused === undefined ? {} : { rifiutata: this.#udpPortRefused }),
    };
  }

  /**
   * Adds a service before the socket exists.
   *
   * The ALPN list is fixed at bind time — that is what lets QUIC negotiate
   * versions for us (ADR 0021 §2) — so registering after opening would silently
   * produce a service nobody can reach. It refuses instead.
   */
  public register(service: AlpnService): void {
    if (this.#endpoint !== undefined) {
      throw new Error("Services must be registered before the endpoint is opened.");
    }

    this.#services.push(service);
  }

  public get mode(): EndpointMode | undefined {
    return this.#mode;
  }

  public get endpointId(): string | undefined {
    return this.#endpointId;
  }

  /** The key plus where it can be found now. Only needed where nothing resolves keys. */
  public get ticket(): string | undefined {
    return this.#ticket;
  }

  public get unavailableReason(): string | undefined {
    return this.#reason;
  }

  public get isOpen(): boolean {
    return this.#endpoint !== undefined;
  }

  /** True only where discovery runs, which is what makes a bare key enough. */
  public get reachableByKey(): boolean {
    return this.#mode === "internet";
  }

  /**
   * The relays of n0, as the binding knows them — `undefined` where no relay is
   * used at all (`local`, or no binding). See `relays.ts` for why n0 is not
   * simply the last entry of the map.
   */
  public n0RelayUrls(): string[] | undefined {
    if (this.#iroh === undefined || this.#mode !== "internet") return undefined;

    return this.#iroh.RelayMode.defaultMode().relayMap().urls();
  }

  /** Gli indirizzi locali a cui il socket è legato, `[]` se non è aperto. */
  public boundSockets(): string[] {
    try {
      return this.#endpoint?.boundSockets?.() ?? [];
    } catch {
      return [];
    }
  }

  /** The relay this instance is reachable through right now, if any. */
  public get homeRelay(): string | undefined {
    try {
      return this.#endpoint?.addr().relayUrl?.() ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Called every time the socket opens, so the relay map can be (re)applied. */
  public onOpen(listener: () => void): void {
    this.#onOpen.push(listener);
  }

  /**
   * Replaces the relay map (ADR 0045 §2), on the open socket and for the next
   * one. Only the difference is applied, with `insertRelay`/`removeRelay`: the
   * socket stays up, and so do the connections that do not use a removed relay.
   */
  public async setRelayMap(urls: readonly string[]): Promise<void> {
    this.#wantedRelays = [...urls];

    const endpoint = this.#endpoint;
    if (endpoint === undefined || this.#mode !== "internet") return;
    if (endpoint.insertRelay === undefined || endpoint.removeRelay === undefined) {
      throw new Error("Questo binding non sa cambiare i relay a istanza accesa.");
    }

    for (const url of urls) {
      if (!this.#currentRelays.includes(url)) await endpoint.insertRelay({ url });
    }

    for (const url of this.#currentRelays) {
      if (!urls.includes(url)) await endpoint.removeRelay(url);
    }

    this.#currentRelays = [...urls];
  }

  /** Binds the socket. Never throws: a failure becomes `unavailableReason`. */
  public async open(mode: EndpointMode): Promise<void> {
    if (this.#mode === mode && this.#endpoint !== undefined) {
      return;
    }

    await this.close();
    this.#mode = mode;
    this.#reason = undefined;

    const { module, reason } = await loadIroh();

    if (module === undefined) {
      this.#reason = reason;
      return;
    }

    const bind = async (fixedPort: number | undefined): Promise<IrohEndpoint> => {
      const builder = module.Endpoint.builder();

      // `local` touches nothing outside this machine's network and publishes
      // nothing; `internet` accepts the public servers of n0 — relays as the
      // declared fallback, discovery as what makes a bare key resolvable
      // (ADR 0018 §«L'infrastruttura del trasporto»).
      if (mode === "internet") {
        builder.applyN0();

        // The relays this instance adopted (ADR 0045 §2), when it adopted any.
        // Discovery stays n0's: the preset is replayed first, then only the
        // relay part is replaced.
        const n0 = module.RelayMode.defaultMode().relayMap().urls();
        this.#currentRelays = this.#wantedRelays ?? n0;
        if (this.#wantedRelays !== undefined) {
          builder.relayMode(module.RelayMode.customFromUrls(this.#wantedRelays));
        }
      } else {
        builder.applyMinimal();
      }

      builder.alpns(this.#services.map((service) => alpnBytes(service.alpn)));

      // After the preset, which replays a whole configuration and would
      // otherwise be free to put a generated key back.
      builder.secretKey(this.#secretKey);

      // La porta fissa (ADR 0045 §6), dopo il preset che altrimenti la
      // rimetterebbe a caso. Solo IPv4: è la porta che si apre sul router.
      if (fixedPort !== undefined) {
        if (builder.bindAddr === undefined) {
          throw new Error("Questo binding non sa fissare la porta UDP.");
        }
        builder.bindAddr(`0.0.0.0:${fixedPort}`);
      }

      return builder.bind();
    };

    try {
      this.#udpPortRefused = undefined;
      let endpoint: IrohEndpoint;

      try {
        endpoint = await bind(this.#udpPort);
      } catch (error) {
        if (this.#udpPort === undefined) throw error;
        // Occupata, o non permessa: la rete si apre lo stesso, su una porta a caso.
        this.#udpPortRefused = error instanceof Error ? error.message : String(error);
        endpoint = await bind(undefined);
      }

      this.#iroh = module;
      this.#endpoint = endpoint;
      this.#endpointId = endpoint.id().toString();
      this.#ticket = module.EndpointTicket.fromAddr(endpoint.addr()).toString();
      this.#accepting = true;

      void this.#acceptLoop(endpoint);

      for (const listener of this.#onOpen) {
        try {
          listener();
        } catch {
          // A listener is a convenience; the socket is open either way.
        }
      }
    } catch (error) {
      this.#reason = error instanceof Error ? error.message : String(error);
    }
  }

  async #acceptLoop(endpoint: IrohEndpoint): Promise<void> {
    while (this.#accepting) {
      try {
        const incoming = await endpoint.acceptNext();

        if (incoming === null) {
          return;
        }

        // Routed before the connection is completed, so a connection for an
        // ALPN nobody serves never becomes this instance's problem.
        const accepting = await incoming.accept();
        const negotiated = await accepting.alpn();
        const service = this.#services.find((candidate) =>
          sameAlpn(alpnBytes(candidate.alpn), negotiated),
        );

        if (service === undefined) {
          continue;
        }

        void this.#serve(service, accepting);
      } catch {
        // One failed handshake is not a reason to stop listening: the other
        // side may simply have gone away.
      }
    }
  }

  async #serve(service: AlpnService, accepting: IrohAccepting): Promise<void> {
    try {
      await service.serve(await accepting.connect());
    } catch {
      // A service that throws loses its connection, never the accept loop.
    }
  }

  /**
   * Opens a connection to another instance.
   *
   * `target` is its **public key** — the thing ADR 0018 asks people to
   * exchange. A ticket is also accepted, for `local`, where nothing publishes
   * where a key lives and the addresses have to travel with it.
   */
  public async connect(target: string, alpn: string): Promise<IrohConnection> {
    const endpoint = this.#endpoint;
    const iroh = this.#iroh;

    if (endpoint === undefined || iroh === undefined) {
      throw new Error("La rete fra istanze non è attiva su questa istanza.");
    }

    return endpoint.connect(this.#resolve(iroh, target.trim()), alpnBytes(alpn));
  }

  /**
   * Whether a string is a bare public key, as opposed to a ticket.
   *
   * The caller needs to know because the two carry different amounts of truth:
   * a key *is* the identity, while a ticket is a key plus addresses that were
   * true once. See `FederationService.requestConnection`.
   */
  public looksLikeKey(value: string): boolean {
    if (this.#iroh === undefined) {
      return false;
    }

    try {
      this.#iroh.EndpointId.fromString(value.trim());

      return true;
    } catch {
      return false;
    }
  }

  /**
   * The public key a target names, whether it was written as a key or wrapped
   * in a ticket. `undefined` when it is neither.
   *
   * A ticket carries its key, so «who is this» is answerable before dialling —
   * which is what lets a caller refuse an instance, or itself, without opening
   * a connection to find out.
   */
  public keyOf(target: string): string | undefined {
    const iroh = this.#iroh;
    const value = target.trim();

    if (iroh === undefined) {
      return undefined;
    }

    if (this.looksLikeKey(value)) {
      return value;
    }

    try {
      return iroh.EndpointTicket.fromString(value).endpointAddr().id().toString();
    } catch {
      return undefined;
    }
  }

  #resolve(iroh: IrohModule, target: string): unknown {
    try {
      const id = iroh.EndpointId.fromString(target);

      if (this.#mode !== "internet") {
        throw new Error(
          "Questa è una chiave pubblica, ma la rete è su «local», dove non esiste alcuna scoperta: nessuno può dire dove abiti quella chiave. Passa a «internet», oppure usa il codice lungo dell'altra istanza, che porta con sé anche gli indirizzi.",
        );
      }

      return new iroh.EndpointAddr(id);
    } catch (error) {
      // A key that failed for the reason above must not be retried as a ticket:
      // that would swap a precise explanation for «non è un codice valido».
      if (error instanceof Error && error.message.startsWith("Questa è una chiave")) {
        throw error;
      }
    }

    try {
      return iroh.EndpointTicket.fromString(target).endpointAddr();
    } catch {
      throw new Error(
        "Non è né una chiave pubblica né un codice di un'altra istanza. La chiave è la riga corta che l'altra istanza mostra nel proprio pannello.",
      );
    }
  }

  public async close(): Promise<void> {
    this.#accepting = false;

    if (this.#endpoint !== undefined) {
      await this.#endpoint.close();
      this.#endpoint = undefined;
    }

    this.#endpointId = undefined;
    this.#ticket = undefined;
  }
}
