import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { CategoriaSegnalazione } from "../federation/protocol.js";

/**
 * Le segnalazioni dei membri di qui, la replica di questa istanza e i verdetti
 * del suo admin ([ADR 0047], [ADR 0049]).
 *
 * Niente di quello che sta qui è una copia: le segnalazioni le hanno scritte
 * persone di questa casa, la replica l'ha scritta questa casa, e i verdetti
 * sono decisioni di questa casa. Le segnalazioni **altrui** non hanno una
 * tabella, e non ne avranno: si visitano.
 */

export interface SegnalazioneRecord {
  id: string;
  autoreId: string;
  /** Username dell'autore, per chi modera: ne risponde (ADR 0047 Decisione 6). */
  autore: string;
  istanza: string;
  categoria: CategoriaSegnalazione;
  motivo: string;
  creataIl: string;
}

export interface ReplicaRecord {
  testo: string;
  aggiornataIl: string;
}

export interface VerdettoRecord {
  istanza: string;
  ignora: boolean;
  nota: string;
  /** Username di chi ha deciso, se esiste ancora. */
  autore: string | null;
  decisoIl: string;
}

export interface SegnalazioniRepository {
  salva(input: {
    autoreId: string;
    istanza: string;
    categoria: CategoriaSegnalazione;
    motivo: string;
    at: string;
  }): SegnalazioneRecord;
  trova(id: string): SegnalazioneRecord | undefined;
  diAutore(autoreId: string): SegnalazioneRecord[];
  tutte(): SegnalazioneRecord[];
  /** Le più recenti per categoria, al massimo `perCategoria` ciascuna. */
  suIstanza(istanza: string, perCategoria: number): SegnalazioneRecord[];
  rimuovi(id: string): boolean;

  replica(): ReplicaRecord | undefined;
  salvaReplica(input: { testo: string; autoreId: string; at: string }): ReplicaRecord;
  rimuoviReplica(): boolean;

  verdetto(istanza: string): VerdettoRecord | undefined;
  verdetti(): VerdettoRecord[];
  salvaVerdetto(input: {
    istanza: string;
    ignora: boolean;
    nota: string;
    autoreId: string;
    at: string;
  }): VerdettoRecord;
  rimuoviVerdetto(istanza: string): boolean;
}

type SegnalazioneRow = {
  id: string;
  autore_id: string;
  autore: string;
  istanza: string;
  categoria: string;
  motivo: string;
  creata_il: string;
};

type VerdettoRow = {
  istanza: string;
  ignora: number;
  nota: string;
  autore: string | null;
  deciso_il: string;
};

const SELECT_SEGNALAZIONE = `SELECT s.id, s.autore_id, u.username AS autore, s.istanza, s.categoria,
         s.motivo, s.creata_il
    FROM segnalazioni s JOIN users u ON u.id = s.autore_id`;

const SELECT_VERDETTO = `SELECT v.istanza, v.ignora, v.nota, u.username AS autore, v.deciso_il
    FROM verdetti_istanze v LEFT JOIN users u ON u.id = v.autore_id`;

function toSegnalazione(row: SegnalazioneRow): SegnalazioneRecord {
  return {
    autore: row.autore,
    autoreId: row.autore_id,
    categoria: row.categoria as CategoriaSegnalazione,
    creataIl: row.creata_il,
    id: row.id,
    istanza: row.istanza,
    motivo: row.motivo,
  };
}

function toVerdetto(row: VerdettoRow): VerdettoRecord {
  return {
    autore: row.autore,
    decisoIl: row.deciso_il,
    ignora: row.ignora === 1,
    istanza: row.istanza,
    nota: row.nota,
  };
}

export class SqliteSegnalazioniRepository implements SegnalazioniRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public salva(input: {
    autoreId: string;
    istanza: string;
    categoria: CategoriaSegnalazione;
    motivo: string;
    at: string;
  }): SegnalazioneRecord {
    // Una sola per persona, categoria e istanza: la nuova sostituisce, e la
    // data diventa quella nuova perché il motivo è nuovo.
    this.database
      .prepare(
        `INSERT INTO segnalazioni (id, autore_id, istanza, categoria, motivo, creata_il)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (autore_id, istanza, categoria)
         DO UPDATE SET motivo = excluded.motivo, creata_il = excluded.creata_il`,
      )
      .run(randomUUID(), input.autoreId, input.istanza, input.categoria, input.motivo, input.at);

    const row = this.database
      .prepare(`${SELECT_SEGNALAZIONE} WHERE s.autore_id = ? AND s.istanza = ? AND s.categoria = ?`)
      .get(input.autoreId, input.istanza, input.categoria) as SegnalazioneRow | undefined;

    if (row === undefined) {
      throw new Error("La segnalazione è sparita mentre veniva scritta.");
    }

    return toSegnalazione(row);
  }

  public trova(id: string): SegnalazioneRecord | undefined {
    const row = this.database.prepare(`${SELECT_SEGNALAZIONE} WHERE s.id = ?`).get(id) as
      SegnalazioneRow | undefined;

    return row === undefined ? undefined : toSegnalazione(row);
  }

  public diAutore(autoreId: string): SegnalazioneRecord[] {
    return (
      this.database
        .prepare(`${SELECT_SEGNALAZIONE} WHERE s.autore_id = ? ORDER BY s.creata_il DESC, s.id`)
        .all(autoreId) as SegnalazioneRow[]
    ).map(toSegnalazione);
  }

  public tutte(): SegnalazioneRecord[] {
    return (
      this.database
        .prepare(`${SELECT_SEGNALAZIONE} ORDER BY s.creata_il DESC, s.id`)
        .all() as SegnalazioneRow[]
    ).map(toSegnalazione);
  }

  public suIstanza(istanza: string, perCategoria: number): SegnalazioneRecord[] {
    const statement = this.database.prepare(
      `${SELECT_SEGNALAZIONE}
        WHERE s.istanza = ? AND s.categoria = ? AND u.deleted_at IS NULL
        ORDER BY s.creata_il DESC, s.id
        LIMIT ?`,
    );

    return (["non_autentica", "non_gradita"] as const).flatMap((categoria) =>
      (statement.all(istanza, categoria, perCategoria) as SegnalazioneRow[]).map(toSegnalazione),
    );
  }

  public rimuovi(id: string): boolean {
    return (
      Number(this.database.prepare("DELETE FROM segnalazioni WHERE id = ?").run(id).changes) > 0
    );
  }

  public replica(): ReplicaRecord | undefined {
    const row = this.database
      .prepare("SELECT testo, aggiornata_il FROM replica_segnalazioni")
      .get() as { testo: string; aggiornata_il: string } | undefined;

    return row === undefined ? undefined : { aggiornataIl: row.aggiornata_il, testo: row.testo };
  }

  public salvaReplica(input: { testo: string; autoreId: string; at: string }): ReplicaRecord {
    this.database
      .prepare(
        `INSERT INTO replica_segnalazioni (singleton, testo, autore_id, aggiornata_il)
         VALUES (1, ?, ?, ?)
         ON CONFLICT (singleton)
         DO UPDATE SET testo = excluded.testo, autore_id = excluded.autore_id,
                       aggiornata_il = excluded.aggiornata_il`,
      )
      .run(input.testo, input.autoreId, input.at);

    return { aggiornataIl: input.at, testo: input.testo };
  }

  public rimuoviReplica(): boolean {
    return Number(this.database.prepare("DELETE FROM replica_segnalazioni").run().changes) > 0;
  }

  public verdetto(istanza: string): VerdettoRecord | undefined {
    const row = this.database.prepare(`${SELECT_VERDETTO} WHERE v.istanza = ?`).get(istanza) as
      VerdettoRow | undefined;

    return row === undefined ? undefined : toVerdetto(row);
  }

  public verdetti(): VerdettoRecord[] {
    return (
      this.database.prepare(`${SELECT_VERDETTO} ORDER BY v.deciso_il DESC`).all() as VerdettoRow[]
    ).map(toVerdetto);
  }

  public salvaVerdetto(input: {
    istanza: string;
    ignora: boolean;
    nota: string;
    autoreId: string;
    at: string;
  }): VerdettoRecord {
    this.database
      .prepare(
        `INSERT INTO verdetti_istanze (istanza, ignora, nota, autore_id, deciso_il)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (istanza)
         DO UPDATE SET ignora = excluded.ignora, nota = excluded.nota,
                       autore_id = excluded.autore_id, deciso_il = excluded.deciso_il`,
      )
      .run(input.istanza, input.ignora ? 1 : 0, input.nota, input.autoreId, input.at);

    const saved = this.verdetto(input.istanza);

    if (saved === undefined) {
      throw new Error("Il verdetto è sparito mentre veniva scritto.");
    }

    return saved;
  }

  public rimuoviVerdetto(istanza: string): boolean {
    return (
      Number(
        this.database.prepare("DELETE FROM verdetti_istanze WHERE istanza = ?").run(istanza)
          .changes,
      ) > 0
    );
  }
}
