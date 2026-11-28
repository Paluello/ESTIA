/**
 * Un filo fra istanze **in processo**, per le prove: sostituisce iroh, e
 * nient'altro.
 *
 * Esiste per una ragione trovata il 2026-11-27. Le prove di una chat fra due
 * case sostituivano i metodi con cui una casa chiede (`fetchHandshake`,
 * `spingiSegnapostiA`…) con chiamate dirette al servizio dell'altra: così
 * saltavano `FederationService` da tutte e due le parti — la serializzazione,
 * `parseRequest`, i limiti di frequenza, il controllo del rapporto, e
 * soprattutto **il collegamento dei servizi in `buildApp`**. Quel collegamento
 * mancava, e nessuna prova poteva accorgersene.
 *
 * Qui si sostituisce soltanto ciò che iroh fa: portare byte da una chiave a
 * un'altra e dire, a chi li riceve, **da quale chiave arrivano**. Una domanda
 * fatta con `connect` arriva a `serve` del servizio che l'altra istanza ha
 * registrato per quell'ALPN, come byte, con la chiave di chi chiama al posto
 * di quella che QUIC avrebbe autenticato.
 *
 * Non è una simulazione di rete: non ci sono ritardi, perdite, relay. Per
 * quelli c'è `federation.test.ts`, con endpoint iroh veri.
 */
import {
  InstanceEndpoint,
  type AlpnService,
  type EndpointMode,
  type IrohConnection,
  type IrohStream,
} from "./endpoint.js";

/** Le istanze che stanno sullo stesso filo, per chiave. Togliere una chiave è spegnerla. */
export class FiloFinto {
  readonly #accese = new Map<string, EndpointFinto>();
  readonly #spente = new Set<string>();
  /**
   * Ogni domanda passata dal filo: chi, a chi, il `tipo` che c'era scritto, e
   * la risposta com'è tornata — per poter dire che due rifiuti sono **lo
   * stesso** rifiuto.
   */
  public readonly domande: { da: string; a: string; tipo: string; risposta?: unknown }[] = [];

  /** Da passare a `buildApp` come `createEndpoint`. */
  public readonly endpoint = (chiavi: {
    secretKey: Uint8Array;
    publicKey: string;
  }): InstanceEndpoint => {
    const finto = new EndpointFinto(chiavi.secretKey, chiavi.publicKey, this);
    this.#accese.set(chiavi.publicKey, finto);
    return finto;
  };

  public spegni(chiave: string): void {
    this.#spente.add(chiave);
  }

  public accendi(chiave: string): void {
    this.#spente.delete(chiave);
  }

  /** @internal */
  public trova(chiave: string): EndpointFinto | undefined {
    return this.#spente.has(chiave) ? undefined : this.#accese.get(chiave);
  }

  /** @internal */
  public spenta(chiave: string): boolean {
    return this.#spente.has(chiave);
  }
}

const decoder = new TextDecoder();

class EndpointFinto extends InstanceEndpoint {
  readonly #chiave: string;
  readonly #filo: FiloFinto;
  readonly #servizi: AlpnService[] = [];
  #modo: EndpointMode | undefined;

  public constructor(secretKey: Uint8Array, chiave: string, filo: FiloFinto) {
    super(secretKey);
    this.#chiave = chiave;
    this.#filo = filo;
  }

  public override register(service: AlpnService): void {
    this.#servizi.push(service);
  }

  public override get mode(): EndpointMode | undefined {
    return this.#modo;
  }

  public override get endpointId(): string | undefined {
    return this.#chiave;
  }

  public override get ticket(): string | undefined {
    return this.#chiave;
  }

  public override get unavailableReason(): string | undefined {
    return undefined;
  }

  public override get isOpen(): boolean {
    return true;
  }

  public override get reachableByKey(): boolean {
    return true;
  }

  public override open(mode: EndpointMode): Promise<void> {
    this.#modo = mode;
    return Promise.resolve();
  }

  public override close(): Promise<void> {
    return Promise.resolve();
  }

  public override looksLikeKey(value: string): boolean {
    return /^[0-9a-f]{64}$/u.test(value.trim());
  }

  public override keyOf(target: string): string | undefined {
    return this.looksLikeKey(target) ? target.trim() : undefined;
  }

  public override connect(target: string, alpn: string): Promise<IrohConnection> {
    const chiave = target.trim();
    const lei = this.#filo.trova(chiave);
    const servizio = lei?.servizio(alpn);

    if (this.#filo.spenta(this.#chiave) || lei === undefined || servizio === undefined) {
      return Promise.reject(new Error("Nessuno risponde a questa chiave."));
    }

    const chiede = this.#chiave;
    const filo = this.#filo;
    const inAttesa: ((stream: IrohStream) => void)[] = [];
    const arrivati: IrohStream[] = [];
    let chiusa: (() => void) | undefined;
    const fine = new Promise<never>((_, reject) => {
      chiusa = () => reject(new Error("chiusa"));
    });
    fine.catch(() => undefined);

    const percorsi = (): ReturnType<IrohConnection["paths"]> => [
      { isRelay: false, isSelected: true, rttMs: 0 },
    ];
    const chiudi = (): void => chiusa?.();

    const diLa: IrohConnection = {
      acceptBi: () => {
        const pronto = arrivati.shift();
        if (pronto !== undefined) {
          return Promise.resolve(pronto);
        }

        return Promise.race([
          new Promise<IrohStream>((resolve) => {
            inAttesa.push(resolve);
          }),
          fine,
        ]);
      },
      close: chiudi,
      openBi: () => Promise.reject(new Error("Il filo finto apre i flussi da una parte sola.")),
      paths: percorsi,
      // La sola cosa che decide un permesso (ADR 0021 §1): qui è la chiave di
      // chi ha chiamato `connect`, che nessun campo del messaggio può cambiare.
      remoteId: () => ({ toString: () => chiede }),
    };

    void servizio.serve(diLa).catch(() => undefined);

    const diQua: IrohConnection = {
      acceptBi: () => Promise.reject(new Error("Il filo finto apre i flussi da una parte sola.")),
      close: chiudi,
      openBi: () => {
        const domanda = tubo();
        const risposta = tubo();

        const voce: FiloFinto["domande"][number] = { a: chiave, da: chiede, tipo: "?" };
        const perChiRisponde: IrohStream = {
          recv: domanda.recv,
          send: {
            finish: async () => {
              voce.risposta = letto(risposta.scritti());
              await risposta.send.finish();
            },
            writeAll: risposta.send.writeAll,
          },
        };
        const perChiChiede: IrohStream = {
          recv: risposta.recv,
          send: {
            finish: async () => {
              await domanda.send.finish();
              voce.tipo = tipoDi(domanda.scritti());
              filo.domande.push(voce);

              const aspetta = inAttesa.shift();
              if (aspetta === undefined) {
                arrivati.push(perChiRisponde);
              } else {
                aspetta(perChiRisponde);
              }
            },
            writeAll: domanda.send.writeAll,
          },
        };

        return Promise.resolve(perChiChiede);
      },
      paths: percorsi,
      remoteId: () => ({ toString: () => chiave }),
    };

    return Promise.resolve(diQua);
  }

  /** @internal */
  public servizio(alpn: string): AlpnService | undefined {
    return this.#servizi.find((s) => s.alpn === alpn);
  }
}

/** Una metà di flusso: si scrive, si chiude, e chi legge ha tutto o un errore di tetto. */
function tubo(): { send: IrohStream["send"]; recv: IrohStream["recv"]; scritti: () => number[] } {
  const bytes: number[] = [];
  let finito: (() => void) | undefined;
  const chiuso = new Promise<void>((resolve) => {
    finito = resolve;
  });

  return {
    recv: {
      readToEnd: async (limit) => {
        await chiuso;
        if (bytes.length > limit) {
          throw new Error("Oltre il tetto di lettura.");
        }
        return bytes;
      },
    },
    scritti: () => bytes,
    send: {
      finish: () => {
        finito?.();
        return Promise.resolve();
      },
      writeAll: (data) => {
        // Non `push(...data)`: una busta grande supera il numero di argomenti.
        for (const byte of data) {
          bytes.push(byte);
        }
        return Promise.resolve();
      },
    },
  };
}

function letto(bytes: number[]): unknown {
  try {
    return JSON.parse(decoder.decode(Uint8Array.from(bytes))) as unknown;
  } catch {
    return undefined;
  }
}

function tipoDi(bytes: number[]): string {
  const messaggio = letto(bytes) as { tipo?: unknown } | undefined;
  return typeof messaggio?.tipo === "string" ? messaggio.tipo : "?";
}
