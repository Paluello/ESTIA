import type { DatabaseSync } from "node:sqlite";

export interface DeviceKeyRecord {
  id: string;
  sessionId: string;
  userId: string;
  publicKey: string;
  algorithm: string;
  createdAt: string;
  revokedAt: string | null;
  /**
   * Quando qualcuno ha detto di si' ([ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)).
   * `null` vuol dire che aspetta: non compare nel registro delle chiavi di
   * firma e nessuno puo' scrivergli.
   */
  approvatoIl: string | null;
}

export interface KeyPackageRecord {
  id: string;
  deviceId: string;
  userId: string;
  keyPackage: string;
  createdAt: string;
  consumedAt: string | null;
}

export interface KeyBackupRecord {
  userId: string;
  encryptedBlob: string;
  algorithm: string;
  salt: string;
  iterations: number;
  updatedAt: string;
}

export interface DeviceKeysRepository {
  registerDeviceKey(record: {
    id: string;
    sessionId: string;
    userId: string;
    publicKey: string;
    algorithm: string;
    createdAt: string;
    /** `null` per un dispositivo che deve aspettare un si'. */
    approvatoIl: string | null;
  }): DeviceKeyRecord;
  getDeviceKeyBySessionId(sessionId: string): DeviceKeyRecord | undefined;
  getDeviceKeysByUserId(userId: string): DeviceKeyRecord[];
  /**
   * Come sopra, ma **anche** senza le chiavi la cui sessione e' stata revocata.
   *
   * ADR 0028 §1 promette che «la revoca di una sessione revoca immediatamente la
   * chiave del dispositivo», e nel codice non succede: `revokeDeviceKey` esiste e
   * non la chiama nessuno, e le sessioni si revocano marcando `revoked_at` invece
   * di cancellare la riga, quindi nemmeno il `ON DELETE CASCADE` scatta. Questa
   * query legge la verita' invece di fidarsi di una chiamata che non c'e'.
   */
  getActiveDeviceKeysByUserId(userId: string, adesso?: string): DeviceKeyRecord[];
  /**
   * Se questa persona ha **mai** avuto un dispositivo approvato.
   *
   * «Mai», non «adesso»: se contasse solo chi ha una sessione aperta, chi ha
   * la password potrebbe uscire o revocare tutti i dispositivi della vittima e
   * rientrare come «primo dispositivo», che si approva da solo. Il primo
   * dispositivo è il primo davvero, una volta sola.
   */
  hasApprovedDeviceKey(userId: string): boolean;
  /**
   * Se questa chiave pubblica e' gia' stata approvata per questa persona.
   *
   * E' la via di riserva di [ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md):
   * chi rimette le proprie chiavi con la frase segreta ripresenta **la stessa**
   * chiave, e riprodurla richiede la chiave privata. Ha gia' dimostrato di
   * essere lui, quindi non deve chiedere il permesso a nessuno.
   */
  isPublicKeyApproved(userId: string, publicKey: string): boolean;
  /** Toglie dal registro le chiavi della sessione revocata da qualcun altro. */
  revokeDeviceKeysOfSession(sessionId: string, revokedAt: string): void;
  getDeviceKeyById(id: string): DeviceKeyRecord | undefined;
  revokeDeviceKey(id: string, revokedAt: string): void;
  approvaDeviceKey(id: string, approvatoIl: string): void;
  addKeyPackages(
    records: Array<{
      id: string;
      deviceId: string;
      userId: string;
      keyPackage: string;
      createdAt: string;
    }>,
  ): void;
  claimKeyPackageForUser(
    userId: string,
    consumedAt: string,
    /** Solo i dispositivi di questo algoritmo, e solo uno che abbia un KeyPackage. */
    algoritmo: string,
  ): { device: DeviceKeyRecord; keyPackage: KeyPackageRecord } | undefined;
  saveKeyBackup(record: {
    userId: string;
    encryptedBlob: string;
    algorithm: string;
    salt: string;
    iterations: number;
    updatedAt: string;
  }): void;
  getKeyBackup(userId: string): KeyBackupRecord | undefined;
}

export class SqliteDeviceKeysRepository implements DeviceKeysRepository {
  constructor(private readonly db: DatabaseSync) {}

  registerDeviceKey(record: {
    id: string;
    sessionId: string;
    userId: string;
    publicKey: string;
    algorithm: string;
    createdAt: string;
    approvatoIl: string | null;
  }): DeviceKeyRecord {
    // If a key for this session already exists, update it or insert fresh.
    //
    // `approvato_il` **non** compare nell'UPDATE, ed e' voluto: un dispositivo
    // gia' approvato non riperde il si' riregistrandosi, e uno in attesa non se
    // lo prende da solo ripetendo la chiamata.
    this.db
      .prepare(
        `INSERT INTO device_keys (id, session_id, user_id, public_key, algorithm, created_at, revoked_at, approvato_il)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (id) DO UPDATE SET
           approvato_il = CASE
             WHEN device_keys.public_key = excluded.public_key THEN device_keys.approvato_il
             ELSE excluded.approvato_il
           END,
           public_key = excluded.public_key,
           algorithm = excluded.algorithm,
           created_at = excluded.created_at,
           revoked_at = NULL`,
      )
      .run(
        record.id,
        record.sessionId,
        record.userId,
        record.publicKey,
        record.algorithm,
        record.createdAt,
        record.approvatoIl,
      );

    // Si rilegge invece di dedurre: dopo un conflitto `approvato_il` e' quello
    // che c'era, non quello che si e' passato.
    return this.getDeviceKeyById(record.id)!;
  }

  hasApprovedDeviceKey(userId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM device_keys WHERE user_id = ? AND approvato_il IS NOT NULL LIMIT 1`)
      .get(userId);
    return row !== undefined;
  }

  /**
   * Approvata almeno una volta, e **mai** tolta da qualcuno: un dispositivo
   * revocato dal proprietario non rientra ripresentando la propria chiave.
   */
  isPublicKeyApproved(userId: string, publicKey: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM device_keys
         WHERE user_id = ? AND public_key = ? AND approvato_il IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM device_keys r
             WHERE r.user_id = device_keys.user_id AND r.public_key = device_keys.public_key
               AND r.approvato_il IS NOT NULL AND r.revoked_at IS NOT NULL
           )`,
      )
      .get(userId, publicKey);
    return row !== undefined;
  }

  revokeDeviceKeysOfSession(sessionId: string, revokedAt: string): void {
    this.db
      .prepare(`UPDATE device_keys SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL`)
      .run(revokedAt, sessionId);
  }

  getDeviceKeyBySessionId(sessionId: string): DeviceKeyRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, session_id, user_id, public_key, algorithm, created_at, revoked_at, approvato_il
         FROM device_keys
         WHERE session_id = ? AND revoked_at IS NULL`,
      )
      .get(sessionId) as
      | {
          id: string;
          session_id: string;
          user_id: string;
          public_key: string;
          algorithm: string;
          created_at: string;
          revoked_at: string | null;
          approvato_il: string | null;
        }
      | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      sessionId: row.session_id,
      userId: row.user_id,
      publicKey: row.public_key,
      algorithm: row.algorithm,
      createdAt: row.created_at,
      approvatoIl: row.approvato_il,
      revokedAt: row.revoked_at,
    };
  }

  getDeviceKeysByUserId(userId: string): DeviceKeyRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, user_id, public_key, algorithm, created_at, revoked_at, approvato_il
         FROM device_keys
         WHERE user_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC`,
      )
      .all(userId) as Array<{
      id: string;
      session_id: string;
      user_id: string;
      public_key: string;
      algorithm: string;
      created_at: string;
      revoked_at: string | null;
      approvato_il: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      userId: row.user_id,
      publicKey: row.public_key,
      algorithm: row.algorithm,
      createdAt: row.created_at,
      approvatoIl: row.approvato_il,
      revokedAt: row.revoked_at,
    }));
  }

  getActiveDeviceKeysByUserId(
    userId: string,
    adesso: string = new Date().toISOString(),
  ): DeviceKeyRecord[] {
    const rows = this.db
      .prepare(
        `SELECT k.id, k.session_id, k.user_id, k.public_key, k.algorithm, k.created_at, k.revoked_at
         FROM device_keys k
         JOIN sessions s ON s.id = k.session_id
         WHERE k.user_id = ? AND k.revoked_at IS NULL AND s.revoked_at IS NULL
           AND s.expires_at > ?
           AND k.approvato_il IS NOT NULL
         ORDER BY k.created_at DESC`,
      )
      .all(userId, adesso) as Array<{
      id: string;
      session_id: string;
      user_id: string;
      public_key: string;
      algorithm: string;
      created_at: string;
      revoked_at: string | null;
      approvato_il: string | null;
    }>;

    return rows.map((row) => ({
      algorithm: row.algorithm,
      createdAt: row.created_at,
      id: row.id,
      publicKey: row.public_key,
      approvatoIl: row.approvato_il,
      revokedAt: row.revoked_at,
      sessionId: row.session_id,
      userId: row.user_id,
    }));
  }

  getDeviceKeyById(id: string): DeviceKeyRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, session_id, user_id, public_key, algorithm, created_at, revoked_at, approvato_il
         FROM device_keys
         WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          session_id: string;
          user_id: string;
          public_key: string;
          algorithm: string;
          created_at: string;
          revoked_at: string | null;
          approvato_il: string | null;
        }
      | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      sessionId: row.session_id,
      userId: row.user_id,
      publicKey: row.public_key,
      algorithm: row.algorithm,
      createdAt: row.created_at,
      approvatoIl: row.approvato_il,
      revokedAt: row.revoked_at,
    };
  }

  revokeDeviceKey(id: string, revokedAt: string): void {
    this.db
      .prepare(
        `UPDATE device_keys
         SET revoked_at = ?
         WHERE id = ?`,
      )
      .run(revokedAt, id);
  }

  approvaDeviceKey(id: string, approvatoIl: string): void {
    // `IS NULL` e' la guardia: un dispositivo gia' approvato non cambia data, e
    // due si' arrivati insieme non fanno due approvazioni diverse.
    this.db
      .prepare(
        `UPDATE device_keys
         SET approvato_il = ?
         WHERE id = ? AND approvato_il IS NULL`,
      )
      .run(approvatoIl, id);
  }

  addKeyPackages(
    records: Array<{
      id: string;
      deviceId: string;
      userId: string;
      keyPackage: string;
      createdAt: string;
    }>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO key_packages (id, device_id, user_id, key_package, created_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );

    for (const rec of records) {
      stmt.run(rec.id, rec.deviceId, rec.userId, rec.keyPackage, rec.createdAt);
    }
  }

  /**
   * Il prelievo: fra i dispositivi utilizzabili **di quell'algoritmo** —
   * approvati, non revocati, con la sessione ancora viva — il più recente che
   * abbia ancora un KeyPackage. Il più recente in assoluto non basta: un
   * dispositivo senza scorta non fa entrare nessuno.
   */
  claimKeyPackageForUser(
    userId: string,
    consumedAt: string,
    algoritmo: string,
  ): { device: DeviceKeyRecord; keyPackage: KeyPackageRecord } | undefined {
    const trova = this.db.prepare(
      `SELECT id, device_id, user_id, key_package, created_at FROM key_packages
         WHERE device_id = ? AND consumed_at IS NULL
         ORDER BY created_at ASC LIMIT 1`,
    );

    for (const device of this.getActiveDeviceKeysByUserId(userId, consumedAt)) {
      if (device.algorithm !== algoritmo) {
        continue;
      }

      const row = trova.get(device.id) as
        | {
            id: string;
            device_id: string;
            user_id: string;
            key_package: string;
            created_at: string;
          }
        | undefined;
      if (row === undefined) {
        continue;
      }

      this.db
        .prepare(`UPDATE key_packages SET consumed_at = ? WHERE id = ?`)
        .run(consumedAt, row.id);

      return {
        device,
        keyPackage: {
          consumedAt,
          createdAt: row.created_at,
          deviceId: row.device_id,
          id: row.id,
          keyPackage: row.key_package,
          userId: row.user_id,
        },
      };
    }

    return undefined;
  }

  saveKeyBackup(record: {
    userId: string;
    encryptedBlob: string;
    algorithm: string;
    salt: string;
    iterations: number;
    updatedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO key_backups (user_id, encrypted_blob, algorithm, salt, iterations, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           encrypted_blob = excluded.encrypted_blob,
           algorithm = excluded.algorithm,
           salt = excluded.salt,
           iterations = excluded.iterations,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.userId,
        record.encryptedBlob,
        record.algorithm,
        record.salt,
        record.iterations,
        record.updatedAt,
      );
  }

  getKeyBackup(userId: string): KeyBackupRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id, encrypted_blob, algorithm, salt, iterations, updated_at
         FROM key_backups
         WHERE user_id = ?`,
      )
      .get(userId) as
      | {
          user_id: string;
          encrypted_blob: string;
          algorithm: string;
          salt: string;
          iterations: number;
          updated_at: string;
        }
      | undefined;

    if (!row) return undefined;

    return {
      userId: row.user_id,
      encryptedBlob: row.encrypted_blob,
      algorithm: row.algorithm,
      salt: row.salt,
      iterations: row.iterations,
      updatedAt: row.updated_at,
    };
  }
}
