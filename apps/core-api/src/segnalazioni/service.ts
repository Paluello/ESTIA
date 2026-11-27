import type { UserRole } from "@estia/contracts";

import { DomainError } from "../errors.js";
import {
  CATEGORIE_SEGNALAZIONE,
  MAX_MOTIVI_PER_CATEGORIA,
  MAX_MOTIVO_LENGTH,
  MAX_REPLICA_LENGTH,
  type CategoriaSegnalazione,
  type SegnalazioneSulFilo,
} from "../federation/protocol.js";

import type {
  ReplicaRecord,
  SegnalazioneRecord,
  SegnalazioniRepository,
  VerdettoRecord,
} from "./repository.js";

/**
 * Le segnalazioni si visitano, i verdetti restano locali ([ADR 0047], forma in
 * [ADR 0049]).
 *
 * Questo servizio tiene due metà che non si toccano mai:
 *
 * - **ciò che scrivono i membri di qui**, che si salva qui, si ritira quando
 *   si vuole e risponde alle istanze collegate che chiedono;
 * - **ciò che dicono le altre case**, che si chiede al momento, si tiene in
 *   memoria per poco, e non tocca mai il disco.
 */

/** Quanto resta in memoria un avviso ricomposto, per non richiederlo a ogni apertura. */
export const DURATA_AVVISO_MS = 5 * 60_000;

/** Una chiave di istanza: 32 byte ed25519 in esadecimale. */
const CHIAVE = /^[0-9a-f]{64}$/;

/** Ciò che serve dalla rete, e niente di più: una porta, perché i test la fingono. */
export interface ReteSegnalazioni {
  /** Le istanze collegate, con il nome che dichiarano di sé. */
  collegate(): Array<{ publicKey: string; declaredName: string }>;
  /** La chiave di questa istanza, se la rete è accesa. */
  chiaveDiQuesta(): string | undefined;
  segnalazioniPresso(
    target: string,
    istanza: string,
  ): Promise<{ esito: "risposta"; segnalazioni: SegnalazioneSulFilo[] } | { esito: "muta" }>;
  replicaPresso(
    target: string,
  ): Promise<
    { esito: "replica"; testo: string; mese: string } | { esito: "nessuna" } | { esito: "muta" }
  >;
}

export interface Provenienza {
  /** Il nome che l'istanza da cui arriva **dichiara di sé** (ADR 0020 §5). */
  tramite: string;
  motivi: Array<{ motivo: string; mese: string }>;
}

export type StatoReplica =
  | { stato: "disponibile"; testo: string; mese: string }
  | { stato: "assente" }
  | { stato: "non_disponibile" };

export interface Avviso {
  istanza: string;
  /** L'admin di qui ha deciso di non chiedere: si dice, non si tace. */
  ignorate: boolean;
  /** Quante istanze collegate sono state interpellate. */
  interpellate: number;
  /** Quante non hanno risposto: un avviso incompleto si dichiara incompleto. */
  senzaRisposta: number;
  /** Per categoria, **mai mescolate**: un elenco di istanze, non un numero di persone. */
  nonAutentica: Provenienza[];
  nonGradita: Provenienza[];
  replica: StatoReplica;
}

export interface Chiamante {
  id: string;
  role: UserRole;
}

function modera(chi: Chiamante): boolean {
  return chi.role === "instance_admin" || chi.role === "instance_moderator";
}

function mese(iso: string): string {
  return iso.slice(0, 7);
}

export function chiaveValida(valore: string): string {
  const chiave = valore.trim().toLowerCase();

  if (!CHIAVE.test(chiave)) {
    throw new DomainError("chiave_non_valida", 400);
  }

  return chiave;
}

export class SegnalazioniService {
  readonly #repository: SegnalazioniRepository;
  readonly #rete: ReteSegnalazioni;
  readonly #now: () => Date;
  readonly #durata: number;
  /** In memoria e basta ([ADR 0047] Decisione 4): il risultato non si archivia. */
  readonly #avvisi = new Map<string, { scade: number; avviso: Avviso }>();

  public constructor(options: {
    repository: SegnalazioniRepository;
    rete: ReteSegnalazioni;
    now?: () => Date;
    durataAvvisoMs?: number;
  }) {
    this.#repository = options.repository;
    this.#rete = options.rete;
    this.#now = options.now ?? (() => new Date());
    this.#durata = options.durataAvvisoMs ?? DURATA_AVVISO_MS;
  }

  // --- Ciò che scrivono i membri di qui ------------------------------------

  public segnala(
    autore: Chiamante,
    input: { istanza: string; categoria: string; motivo: string },
  ): SegnalazioneRecord {
    const istanza = chiaveValida(input.istanza);

    if (istanza === this.#rete.chiaveDiQuesta()) {
      throw new DomainError("segnalare_questa_istanza", 400);
    }

    if (!(CATEGORIE_SEGNALAZIONE as readonly string[]).includes(input.categoria)) {
      throw new DomainError("categoria_non_valida", 400);
    }

    const motivo = input.motivo.trim();

    if (motivo.length === 0 || motivo.length > MAX_MOTIVO_LENGTH) {
      throw new DomainError("motivo_non_valido", 400, { max: MAX_MOTIVO_LENGTH });
    }

    return this.#repository.salva({
      at: this.#now().toISOString(),
      autoreId: autore.id,
      categoria: input.categoria as CategoriaSegnalazione,
      istanza,
      motivo,
    });
  }

  public mie(autore: Chiamante): SegnalazioneRecord[] {
    return this.#repository.diAutore(autore.id);
  }

  /** Tutte quelle scritte qui, con chi le ha scritte: per chi ne risponde. */
  public tutte(chi: Chiamante): SegnalazioneRecord[] {
    if (!modera(chi)) {
      throw new DomainError("solo_moderazione", 403);
    }

    return this.#repository.tutte();
  }

  /**
   * Il ritiro, che vale subito per tutti perché nessuno ne tiene copia. Lo fa
   * chi l'ha scritta, oppure chi modera: il motivo è contenuto di questa casa.
   */
  public ritira(chi: Chiamante, id: string): void {
    const segnalazione = this.#repository.trova(id);

    // Stessa risposta per «non c'è» e «non è tua»: una segnalazione altrui
    // non deve potersi scoprire indovinandone l'identificativo.
    if (segnalazione === undefined || (segnalazione.autoreId !== chi.id && !modera(chi))) {
      throw new DomainError("segnalazione_inesistente", 404);
    }

    this.#repository.rimuovi(id);
  }

  // --- Ciò che si risponde alle collegate ----------------------------------

  /** Categoria, motivo e mese. **Mai chi l'ha scritta** (ADR 0047 Decisione 6). */
  public perLaRete(istanza: string): SegnalazioneSulFilo[] {
    return this.#repository
      .suIstanza(istanza.trim().toLowerCase(), MAX_MOTIVI_PER_CATEGORIA)
      .map((segnalazione) => ({
        categoria: segnalazione.categoria,
        mese: mese(segnalazione.creataIl),
        motivo: segnalazione.motivo,
      }));
  }

  public replicaPerLaRete(): { testo: string; mese: string } | undefined {
    const replica = this.#repository.replica();

    return replica === undefined
      ? undefined
      : { mese: mese(replica.aggiornataIl), testo: replica.testo };
  }

  // --- La replica di questa istanza ----------------------------------------

  public replica(): ReplicaRecord | undefined {
    return this.#repository.replica();
  }

  public scriviReplica(autore: Chiamante, testo: string): ReplicaRecord {
    const pulito = testo.trim();

    if (pulito.length === 0 || pulito.length > MAX_REPLICA_LENGTH) {
      throw new DomainError("replica_non_valida", 400, { max: MAX_REPLICA_LENGTH });
    }

    return this.#repository.salvaReplica({
      at: this.#now().toISOString(),
      autoreId: autore.id,
      testo: pulito,
    });
  }

  public togliReplica(): void {
    this.#repository.rimuoviReplica();
  }

  // --- Il verdetto locale --------------------------------------------------

  public verdetti(): VerdettoRecord[] {
    return this.#repository.verdetti();
  }

  public verdetto(istanza: string): VerdettoRecord | undefined {
    return this.#repository.verdetto(chiaveValida(istanza));
  }

  /**
   * La nota è dell'admin: arriva come l'ha scritta, e niente qui la
   * precompila con le segnalazioni altrui (ADR 0047 Decisione 5).
   */
  public decidi(
    autore: Chiamante,
    input: { istanza: string; ignora: boolean; nota: string },
  ): VerdettoRecord {
    const istanza = chiaveValida(input.istanza);
    const nota = input.nota.trim();

    if (nota.length > MAX_REPLICA_LENGTH) {
      throw new DomainError("nota_troppo_lunga", 400, { max: MAX_REPLICA_LENGTH });
    }

    this.#avvisi.delete(istanza);

    return this.#repository.salvaVerdetto({
      at: this.#now().toISOString(),
      autoreId: autore.id,
      ignora: input.ignora,
      istanza,
      nota,
    });
  }

  public revoca(istanza: string): void {
    const chiave = chiaveValida(istanza);

    this.#avvisi.delete(chiave);
    this.#repository.rimuoviVerdetto(chiave);
  }

  // --- Ciò che dicono le altre case ----------------------------------------

  /**
   * Chiede alle istanze collegate, a un salto, e ricompone l'avviso
   * ([ADR 0047] Decisioni 3 e 4).
   *
   * Si contano le istanze, non le persone: ogni casa che ha risposto con
   * almeno una segnalazione di una categoria è **una** provenienza per quella
   * categoria, qualunque numero di motivi porti. Chi guarda l'avviso con
   * `perAmministrazione` lo vede anche quando l'admin ha deciso di ignorarlo:
   * è lei che deve poter cambiare idea.
   */
  public async avviso(istanza: string, perAmministrazione = false): Promise<Avviso> {
    const chiave = chiaveValida(istanza);
    const ignora = this.#repository.verdetto(chiave)?.ignora === true;

    if (ignora && !perAmministrazione) {
      return {
        ignorate: true,
        interpellate: 0,
        istanza: chiave,
        nonAutentica: [],
        nonGradita: [],
        replica: { stato: "non_disponibile" },
        senzaRisposta: 0,
      };
    }

    const adesso = this.#now().getTime();
    const inMemoria = this.#avvisi.get(chiave);

    if (inMemoria !== undefined && inMemoria.scade > adesso) {
      return { ...inMemoria.avviso, ignorate: ignora };
    }

    const avviso = await this.#ricomponi(chiave);

    this.#avvisi.set(chiave, { avviso, scade: adesso + this.#durata });

    return { ...avviso, ignorate: ignora };
  }

  async #ricomponi(chiave: string): Promise<Avviso> {
    const collegate = this.#rete.collegate();
    // L'istanza segnalata non si interpella su sé stessa: risponde con la
    // replica, che è un'altra domanda.
    const interpellate = collegate.filter((remota) => remota.publicKey !== chiave);
    const segnalata = collegate.find((remota) => remota.publicKey === chiave);

    const [risposte, replica] = await Promise.all([
      Promise.all(
        interpellate.map(async (remota) => ({
          esito: await this.#rete.segnalazioniPresso(remota.publicKey, chiave).catch(() => ({
            esito: "muta" as const,
          })),
          tramite: remota.declaredName,
        })),
      ),
      segnalata === undefined
        ? Promise.resolve<StatoReplica>({ stato: "non_disponibile" })
        : this.#replicaDi(segnalata.publicKey),
    ]);

    const nonAutentica: Provenienza[] = [];
    const nonGradita: Provenienza[] = [];
    let senzaRisposta = 0;

    for (const { esito, tramite } of risposte) {
      if (esito.esito === "muta") {
        senzaRisposta += 1;
        continue;
      }

      for (const [categoria, elenco] of [
        ["non_autentica", nonAutentica],
        ["non_gradita", nonGradita],
      ] as const) {
        // Il tetto si riapplica qui: una casa che ne manda di più non
        // diventa per questo più forte ([ADR 0049] Decisione 3).
        const motivi = esito.segnalazioni
          .filter((segnalazione) => segnalazione.categoria === categoria)
          .slice(0, MAX_MOTIVI_PER_CATEGORIA)
          .map(({ mese: quando, motivo }) => ({ mese: quando, motivo }));

        if (motivi.length > 0) {
          elenco.push({ motivi, tramite });
        }
      }
    }

    return {
      ignorate: false,
      interpellate: interpellate.length,
      istanza: chiave,
      nonAutentica,
      nonGradita,
      replica,
      senzaRisposta,
    };
  }

  async #replicaDi(publicKey: string): Promise<StatoReplica> {
    const esito = await this.#rete
      .replicaPresso(publicKey)
      .catch(() => ({ esito: "muta" as const }));

    if (esito.esito === "replica") {
      return { mese: esito.mese, stato: "disponibile", testo: esito.testo };
    }

    return esito.esito === "nessuna" ? { stato: "assente" } : { stato: "non_disponibile" };
  }
}
