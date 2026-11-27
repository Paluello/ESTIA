/**
 * Il segnaposto, fra due case ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §4.1,
 * [ADR 0043](../../../../docs/adr/0043-custodia-lato-mittente.md) §3).
 *
 * Due case, due database veri, e in mezzo le regole invece del filo: la stessa
 * scelta di `feed/rete.test.ts`. Il trasporto ha le sue prove in
 * `federation.test.ts`; qui si verifica **che cosa resta dove**, e deve valere
 * in modo deterministico, non a seconda di com'è andato un handshake.
 *
 * Matteo abita a Borgo, Marco ad Aia. Matteo scrive: la voce resta a Borgo, e
 * ad Aia arriva soltanto il segno che esiste.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { withTempDataDir } from "@estia/testing";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../db/database.js";
import { SqliteUserRepository } from "../identity/repository.js";

import { SqliteMessaggiRepository } from "./repository.js";
import { MessaggiService, QUOTE, type ChiPuoScrivere, type ReteFraCase } from "./service.js";

const ORA = "2026-09-23T10:00:00.000Z";

interface Casa {
  chiave: string;
  database: DatabaseSync;
  repo: SqliteMessaggiRepository;
  messaggi: MessaggiService;
  /** Le case che rispondono, come le vede questa. Togliere una casa è spegnerla. */
  accese: Map<string, Casa>;
  abita: (username: string) => string;
  /** Quante domande ha ricevuto questa casa, per sapere se si è chiesto davvero. */
  domande: { segnaposti: number };
  orologio: { adesso: string };
  /**
   * Chi può aprire una conversazione con chi (ADR 0030). Di norma tutti: qui
   * si prova che cosa resta dove, e la regola ha le sue prove più sotto.
   */
  porta: ChiPuoScrivere;
}

function casa(dataDir: string, chiave: string): Casa {
  const database = openDatabase(dataDir);
  const users = new SqliteUserRepository(database);
  const repo = new SqliteMessaggiRepository(database);
  const orologio = { adesso: ORA };
  const accese = new Map<string, Casa>();
  const domande = { segnaposti: 0 };

  const porta: ChiPuoScrivere = { puoAprire: () => true };

  const messaggi = new MessaggiService({
    chiPuoScrivere: { puoAprire: (...argomenti) => porta.puoAprire(...argomenti) },
    now: () => orologio.adesso,
    repository: repo,
    users,
  });

  // La rete, in processo: ogni domanda arriva all'altra casa come se venisse
  // dal filo, con la chiave di chi chiede al posto della connessione.
  const rete: ReteFraCase = {
    // I gruppi hanno le loro prove in `gruppi.test.ts`: qui nessuno li usa.
    annunciaComposizione: () => Promise.resolve(),
    cambiaMembri: () => Promise.resolve({ esito: "irraggiungibile" }),
    casa: chiave,
    coda: () => Promise.resolve({ esito: "irraggiungibile" }),
    composizione: () => Promise.resolve({ esito: "irraggiungibile" }),
    deposita: () => Promise.resolve({ esito: "irraggiungibile" }),
    depositaStato: () => Promise.resolve({ esito: "irraggiungibile" }),
    leggiStato: () => Promise.resolve({ esito: "irraggiungibile" }),
    segnapostiDa: (altra, conversazioneId, dopo) => {
      const lei = accese.get(altra);
      if (lei === undefined) {
        return Promise.resolve({ esito: "irraggiungibile" });
      }

      lei.domande.segnaposti += 1;
      const finestra = lei.messaggi.segnapostiPerCasa(conversazioneId, chiave, dopo);

      return Promise.resolve(
        finestra === "rifiutato" ? { esito: "rifiutato" } : { esito: "finestra", ...finestra },
      );
    },
    spingiSegnaposti: (altra, spinta) => {
      accese.get(altra)?.messaggi.riceviSegnapostiSpinti({ ...spinta, remoteKey: chiave });
      return Promise.resolve();
    },
    visitaArchivio: (altra, conversazioneId, ids) => {
      const lei = accese.get(altra);
      if (lei === undefined) {
        return Promise.resolve({ esito: "irraggiungibile" });
      }

      const esito = lei.messaggi.vociPerCasa(conversazioneId, chiave, ids);
      return Promise.resolve(
        esito === "rifiutato" ? { esito: "rifiutato" } : { esito: "voci", ...esito },
      );
    },
  };
  messaggi.useRete(rete);

  return {
    abita: (username) => {
      const id = randomBytes(8).toString("hex");
      users.create({
        createdAt: ORA,
        deletedAt: null,
        displayName: username,
        id,
        passwordHash: "$argon2id$finto",
        role: "member",
        username,
      });
      return id;
    },
    accese,
    chiave,
    database,
    domande,
    messaggi,
    orologio,
    porta,
    repo,
  };
}

async function dueCase(use: (aia: Casa, borgo: Casa) => Promise<void>): Promise<void> {
  await withTempDataDir(async (primo) => {
    await withTempDataDir(async (secondo) => {
      const aia = casa(primo, "chiave-di-aia");
      const borgo = casa(secondo, "chiave-di-borgo");
      aia.accese.set(borgo.chiave, borgo);
      borgo.accese.set(aia.chiave, aia);

      try {
        await use(aia, borgo);
      } finally {
        aia.database.close();
        borgo.database.close();
      }
    });
  });
}

/**
 * La scena di partenza: una conversazione nata a Borgo, fra Matteo e Marco, e
 * annunciata ad Aia. Ritorna gli id che servono.
 */
async function conversazione(
  aia: Casa,
  borgo: Casa,
): Promise<{ conv: string; matteo: string; marco: string }> {
  const matteo = borgo.abita("matteo");
  const marco = aia.abita("marco");
  const conv = randomBytes(8).toString("hex");

  borgo.repo.createConversazione({
    createdAt: ORA,
    id: conv,
    membri: [matteo, `remote:${aia.chiave}:marco`],
    tipo: "diretta",
  });
  await borgo.messaggi.annunciaConversazione(matteo, conv);

  return { conv, marco, matteo };
}

/** Matteo scrive: la voce (opaca) resta a Borgo. */
function scrive(borgo: Casa, matteo: string, conv: string, id: string, quando = ORA): void {
  borgo.messaggi.depositaArchivio(matteo, conv, [
    { busta: `VOCE_CIFRATA_${id}`, chiaveN: 0, createdAt: quando, id },
  ]);
}

/** Tutto quello che il database di una casa contiene, come testo: per cercarci dentro. */
function tuttoIlDatabase(c: Casa): string {
  const tabelle = c.database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as { name: string }[];

  return tabelle
    .map(({ name }) => JSON.stringify(c.database.prepare(`SELECT * FROM "${name}"`).all()))
    .join("\n");
}

describe("l'annuncio: la casa di chi è invitato sa che la conversazione esiste", () => {
  it("la crea, con la casa che ordina scritta e i due membri", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco } = await conversazione(aia, borgo);

      expect(aia.repo.casaCheOrdina(conv)).toBe(borgo.chiave);
      expect(aia.repo.isMember(conv, marco)).toBe(true);
      expect(aia.repo.haMembroDiCasa(conv, borgo.chiave)).toBe(true);
    });
  });

  it("chi non è stato invitato non ne sa niente, e un nome sconosciuto non crea niente", async () => {
    await dueCase(async (aia, borgo) => {
      const conv = "conv-per-nessuno";

      expect(
        aia.messaggi.riceviSegnapostiSpinti({
          conversazioneId: conv,
          da: "matteo",
          destinatari: ["qualcuno-che-non-abita-qui"],
          remoteKey: borgo.chiave,
          voci: [],
        }),
      ).toBe(false);
      expect(aia.repo.casaCheOrdina(conv)).toBeUndefined();
    });
  });
});

/**
 * Le quattro cose che la revisione di sicurezza del 2026-11-27 ha trovato
 * dietro l'annuncio, prima che la chat fra case venisse collegata davvero:
 * chiunque faceva nascere qui una conversazione, la risposta diceva quali nomi
 * esistono, un annuncio valeva il budget di una casa collegata, e i Welcome
 * non avevano tetto.
 */
describe("l'annuncio non è un permesso (ADR 0030, ADR 0020 §1)", () => {
  const annuncia = (
    a: Casa,
    da: Casa,
    conv: string,
    destinatari: string[],
    chi = "matteo",
  ): boolean =>
    a.messaggi.riceviSegnapostiSpinti({
      conversazioneId: conv,
      da: chi,
      destinatari,
      remoteKey: da.chiave,
      voci: [],
    });

  it("senza una regola che dica di sì, nessun annuncio fa nascere niente", async () => {
    await withTempDataDir(async (dataDir) => {
      const database = openDatabase(dataDir);
      try {
        const users = new SqliteUserRepository(database);
        const repo = new SqliteMessaggiRepository(database);
        // Nessun `chiPuoScrivere`: è il servizio com'è prima che la rete lo colleghi.
        const messaggi = new MessaggiService({ now: () => ORA, repository: repo, users });
        users.create({
          createdAt: ORA,
          deletedAt: null,
          displayName: "marco",
          id: "id-di-marco",
          passwordHash: "$argon2id$finto",
          role: "member",
          username: "marco",
        });

        expect(
          messaggi.riceviSegnapostiSpinti({
            conversazioneId: "conv",
            da: "matteo",
            destinatari: ["marco"],
            remoteKey: "una-casa",
            voci: [],
          }),
        ).toBe(false);
        expect(repo.casaCheOrdina("conv")).toBeUndefined();
      } finally {
        database.close();
      }
    });
  });

  it("chi non può scrivere a Marco non apre niente, e sente la stessa risposta di un nome che non c'è", async () => {
    await dueCase(async (aia, borgo) => {
      const marco = aia.abita("marco");
      aia.porta.puoAprire = () => false;

      const rifiutato = annuncia(aia, borgo, "conv-1", ["marco"]);
      const inesistente = annuncia(aia, borgo, "conv-2", ["nessuno-con-questo-nome"]);

      // La stessa risposta: da qui un'altra casa non impara chi abita qua.
      expect(rifiutato).toBe(false);
      expect(inesistente).toBe(rifiutato);
      expect(aia.repo.casaCheOrdina("conv-1")).toBeUndefined();
      expect(aia.messaggi.listConversazioni(marco)).toEqual([]);
    });
  });

  it("la regola si chiede per ogni destinatario, con la casa della connessione e il nome dichiarato", async () => {
    await dueCase(async (aia, borgo) => {
      const marco = aia.abita("marco");
      const lucia = aia.abita("lucia");
      const chieste: unknown[] = [];
      aia.porta.puoAprire = (casaDiChi, da, destinatario) => {
        chieste.push({ casaDiChi, da, destinatario: destinatario.username });
        return destinatario.id === marco;
      };

      // Lucia non si può raggiungere: con lei dentro, niente nasce — nemmeno
      // per Marco, che da solo si potrebbe.
      expect(annuncia(aia, borgo, "conv-a-tre", ["marco", "lucia"])).toBe(false);
      expect(aia.repo.casaCheOrdina("conv-a-tre")).toBeUndefined();
      expect(aia.messaggi.listConversazioni(lucia)).toEqual([]);

      expect(annuncia(aia, borgo, "conv-a-due", ["marco"])).toBe(true);
      expect(aia.repo.casaCheOrdina("conv-a-due")).toBe(borgo.chiave);
      expect(chieste).toContainEqual({
        casaDiChi: borgo.chiave,
        da: "matteo",
        destinatario: "marco",
      });
      expect(chieste).toContainEqual({
        casaDiChi: borgo.chiave,
        da: "matteo",
        destinatario: "lucia",
      });
    });
  });

  it("un nome di chi scrive che non è un nome non crea un membro", async () => {
    await dueCase(async (aia, borgo) => {
      aia.abita("marco");

      for (const da of ["", "Matteo Con Spazi", "a", "matteo:altro", "x".repeat(200)]) {
        expect({ da, esito: annuncia(aia, borgo, `conv-${da.length}`, ["marco"], da) }).toEqual({
          da,
          esito: false,
        });
      }
    });
  });

  it("una casa non fa nascere più conversazioni di quante ne tiene la quota, né per una persona né in tutto", async () => {
    await dueCase(async (aia, borgo) => {
      aia.abita("marco");

      for (let n = 0; n < QUOTE.annunciPerPersona; n += 1) {
        expect(annuncia(aia, borgo, `per-marco-${n}`, ["marco"])).toBe(true);
      }
      expect(annuncia(aia, borgo, "per-marco-una-di-troppo", ["marco"])).toBe(false);
      expect(aia.repo.casaCheOrdina("per-marco-una-di-troppo")).toBeUndefined();

      // Un'altra casa ha la sua quota: quella di Borgo non la tocca.
      const terza = { ...borgo, chiave: "chiave-di-corte" };
      expect(annuncia(aia, terza, "da-corte", ["marco"])).toBe(true);

      // E in tutto: tante persone diverse, ma la casa che annuncia è una.
      let nate = QUOTE.annunciPerPersona;
      for (let persona = 0; nate < QUOTE.annunciPerCasa; persona += 1) {
        aia.abita(`persona-${persona}`);
        for (let n = 0; n < QUOTE.annunciPerPersona && nate < QUOTE.annunciPerCasa; n += 1) {
          expect(annuncia(aia, borgo, `p${persona}-${n}`, [`persona-${persona}`])).toBe(true);
          nate += 1;
        }
      }
      aia.abita("ultima");
      expect(annuncia(aia, borgo, "oltre-la-quota", ["ultima"])).toBe(false);

      // La finestra è di un giorno: passato quello, si ricomincia.
      aia.orologio.adesso = "2026-09-24T10:00:01.000Z";
      expect(annuncia(aia, borgo, "il-giorno-dopo", ["ultima"])).toBe(true);
    });
  });

  it("un annuncio ripetuto non consuma la quota e non cambia la conversazione", async () => {
    await dueCase(async (aia, borgo) => {
      const marco = aia.abita("marco");

      for (let n = 0; n < QUOTE.annunciPerPersona * 3; n += 1) {
        expect(annuncia(aia, borgo, "sempre-la-stessa", ["marco"])).toBe(true);
      }
      expect(aia.messaggi.listConversazioni(marco)).toHaveLength(1);
    });
  });

  it("una conversazione soltanto annunciata non vale il budget di una casa collegata", async () => {
    await dueCase(async (aia, borgo) => {
      const marco = aia.abita("marco");

      expect(annuncia(aia, borgo, "annunciata", ["marco"])).toBe(true);
      // Borgo l'ha annunciata e basta: ad Aia nessuno ha fatto niente.
      expect(aia.messaggi.casaPartecipa(borgo.chiave)).toBe(false);

      // Marco ci scrive: adesso è una conversazione che qualcuno di qui usa.
      scrive(aia, marco, "annunciata", "m-di-marco");
      expect(aia.messaggi.casaPartecipa(borgo.chiave)).toBe(true);
    });
  });

  it("una conversazione aperta da qualcuno di qui vale subito", async () => {
    await dueCase(async (aia, borgo) => {
      const marco = aia.abita("marco");

      expect(aia.messaggi.casaPartecipa(borgo.chiave)).toBe(false);
      aia.messaggi.getOrCreateDirect(marco, {
        recipientUsername: "matteo",
        remoteInstanceKey: borgo.chiave,
      });
      expect(aia.messaggi.casaPartecipa(borgo.chiave)).toBe(true);
    });
  });
});

describe("i Welcome hanno un tetto (ADR 0042 §3)", () => {
  /** Una conversazione che ordina Borgo, con Matteo di là e Marco di qua, e un commit in fila. */
  async function conUnCommit(aia: Casa, borgo: Casa): Promise<{ conv: string; matteo: string }> {
    const { conv, matteo } = await conversazione(aia, borgo);
    await borgo.messaggi.depositaHandshake(matteo, conv, { busta: "C1", epoch: 1, tipo: "commit" });
    return { conv, matteo };
  }

  const welcomeDa = (
    ordina: Casa,
    da: Casa,
    conv: string,
    destinatario: string,
    epoch = 1,
  ): unknown =>
    ordina.messaggi.depositaHandshakeRemoto({
      busta: "W",
      conversazioneId: conv,
      createdAt: "1999-01-01T00:00:00.000Z",
      destinatario,
      epoch,
      id: "sempre-lo-stesso-id",
      remoteKey: da.chiave,
      tipo: "welcome",
    });

  it("un Welcome è per un membro: per chiunque altro non entra in fila", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, matteo } = await conUnCommit(aia, borgo);

      expect(welcomeDa(borgo, aia, conv, "uno-che-non-c-entra")).toBeUndefined();
      await expect(
        borgo.messaggi.depositaHandshake(matteo, conv, {
          busta: "W",
          destinatario: "uno-che-non-c-entra",
          epoch: 1,
          tipo: "welcome",
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });

      expect(welcomeDa(borgo, aia, conv, `remote:${aia.chiave}:marco`)).toEqual({
        id: expect.any(String),
      });
    });
  });

  it("l'id e l'orario li mette chi ordina: quelli dell'altra casa non contano", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv } = await conUnCommit(aia, borgo);
      const marco = `remote:${aia.chiave}:marco`;

      // Lo stesso id due volte: prima faceva fallire la scrittura.
      const primo = welcomeDa(borgo, aia, conv, marco) as { id: string };
      const secondo = welcomeDa(borgo, aia, conv, marco) as { id: string };
      expect(primo.id).not.toBe(secondo.id);
      expect(primo.id).not.toBe("sempre-lo-stesso-id");

      const coda = borgo.messaggi.handshakeRemoti(conv, aia.chiave);
      expect(coda?.handshake.filter((h) => h.tipo === "welcome").map((h) => h.createdAt)).toEqual([
        ORA,
        ORA,
      ]);
    });
  });

  it("un Welcome porta un'epoch che la fila ha già: non una inventata", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv } = await conUnCommit(aia, borgo);
      const marco = `remote:${aia.chiave}:marco`;

      expect(welcomeDa(borgo, aia, conv, marco, 2)).toBe("indietro");
      expect(welcomeDa(borgo, aia, conv, marco, 2 ** 53 - 1)).toBe("indietro");
      expect(welcomeDa(borgo, aia, conv, marco, 0)).toBe("indietro");
    });
  });

  it("per lo stesso destinatario non ne entrano più della quota, da nessuna delle due porte", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, matteo } = await conUnCommit(aia, borgo);
      const marco = `remote:${aia.chiave}:marco`;

      for (let n = 0; n < QUOTE.welcomePerDestinatario; n += 1) {
        expect(welcomeDa(borgo, aia, conv, marco)).toEqual({ id: expect.any(String) });
      }

      // Lo stesso rifiuto di sempre, senza dire perché (§2).
      expect(welcomeDa(borgo, aia, conv, marco)).toBeUndefined();
      // E un membro di casa non ha una quota a parte.
      await expect(
        borgo.messaggi.depositaHandshake(matteo, conv, {
          busta: "W",
          destinatario: marco,
          epoch: 1,
          tipo: "welcome",
        }),
      ).rejects.toMatchObject({ code: "troppe_richieste" });

      // Un altro destinatario ha il suo conto.
      expect(welcomeDa(borgo, aia, conv, matteo)).toEqual({ id: expect.any(String) });

      // I commit non c'entrano: il gruppo va avanti.
      expect(
        borgo.messaggi.depositaHandshakeRemoto({
          busta: "C2",
          conversazioneId: conv,
          createdAt: ORA,
          epoch: 2,
          id: "c2",
          remoteKey: aia.chiave,
          tipo: "commit",
        }),
      ).toEqual({ id: expect.any(String) });

      // E il giorno dopo la finestra si è svuotata.
      borgo.orologio.adesso = "2026-09-24T10:00:01.000Z";
      expect(welcomeDa(borgo, aia, conv, marco, 2)).toEqual({ id: expect.any(String) });
    });
  });

  it("una conversazione ha un tetto suo, qualunque siano i destinatari", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv } = await conUnCommit(aia, borgo);

      // Tanti membri di Aia, scritti nel database: i gruppi non hanno ancora una rotta.
      const membri = Array.from(
        { length: QUOTE.welcomePerConversazione / QUOTE.welcomePerDestinatario + 1 },
        (_, n) => `remote:${aia.chiave}:membro-${n}`,
      );
      const aggiungi = borgo.database.prepare(
        `INSERT INTO conversazione_membri (conversazione_id, user_id, joined_at) VALUES (?, ?, ?)`,
      );
      membri.forEach((m) => aggiungi.run(conv, m, ORA));

      let entrati = 0;
      for (const membro of membri) {
        for (let n = 0; n < QUOTE.welcomePerDestinatario; n += 1) {
          if (welcomeDa(borgo, aia, conv, membro) !== undefined) {
            entrati += 1;
          }
        }
      }

      expect(entrati).toBe(QUOTE.welcomePerConversazione);
    });
  });

  it("una casa ha un tetto suo, in tutte le sue conversazioni insieme", async () => {
    await dueCase(async (aia, borgo) => {
      const matteo = borgo.abita("matteo");
      const aggiungi = borgo.database.prepare(
        `INSERT INTO conversazione_membri (conversazione_id, user_id, joined_at) VALUES (?, ?, ?)`,
      );

      let entrati = 0;
      let rifiutati = 0;
      const conversazioni = QUOTE.welcomePerCasa / QUOTE.welcomePerConversazione + 1;
      for (let c = 0; c < conversazioni; c += 1) {
        const conv = `conv-${c}`;
        borgo.repo.createConversazione({
          createdAt: ORA,
          id: conv,
          membri: [matteo],
          tipo: "gruppo",
        });
        await borgo.messaggi.depositaHandshake(matteo, conv, {
          busta: "C1",
          epoch: 1,
          tipo: "commit",
        });

        for (let m = 0; m < QUOTE.welcomePerConversazione / QUOTE.welcomePerDestinatario; m += 1) {
          const membro = `remote:${aia.chiave}:membro-${m}`;
          aggiungi.run(conv, membro, ORA);
          for (let n = 0; n < QUOTE.welcomePerDestinatario; n += 1) {
            if (welcomeDa(borgo, aia, conv, membro) === undefined) {
              rifiutati += 1;
            } else {
              entrati += 1;
            }
          }
        }
      }

      expect(entrati).toBe(QUOTE.welcomePerCasa);
      expect(rifiutati).toBe(QUOTE.welcomePerConversazione);
    });
  });
});

describe("il segnaposto arriva, il contenuto no", () => {
  it("Matteo scrive: ad Aia c'è il segno, e nessun byte della voce", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);

      scrive(borgo, matteo, conv, "m-1");
      // La spinta è asincrona e senza attesa: si lascia girare il ciclo.
      await new Promise((r) => setTimeout(r, 0));

      const segni = aia.messaggi.segnaposti(marco, conv);
      expect(segni).toEqual([
        expect.objectContaining({
          casaCustode: borgo.chiave,
          id: "m-1",
          inviatoIl: ORA,
          mittente: `matteo@${borgo.chiave}`,
          seq: 1,
        }),
      ]);

      // È la verifica 6 di §4.1 e la 1 di ADR 0043: nel database di Aia non c'è
      // la voce, nemmeno cifrata.
      expect(tuttoIlDatabase(aia)).not.toContain("VOCE_CIFRATA_m-1");
      expect(tuttoIlDatabase(borgo)).toContain("VOCE_CIFRATA_m-1");
    });
  });

  it("la spinta persa si recupera chiedendo, e in ordine", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);

      // Aia è spenta mentre Matteo scrive tre messaggi: le spinte si perdono.
      borgo.accese.delete(aia.chiave);
      scrive(borgo, matteo, conv, "m-1", "2026-09-23T10:01:00.000Z");
      scrive(borgo, matteo, conv, "m-2", "2026-09-23T10:02:00.000Z");
      scrive(borgo, matteo, conv, "m-3", "2026-09-23T10:03:00.000Z");
      await new Promise((r) => setTimeout(r, 0));
      expect(aia.messaggi.segnaposti(marco, conv)).toEqual([]);

      // Aia si riaccende e chiede: tutti e tre, e in ordine (verifica 4).
      borgo.accese.set(aia.chiave, aia);
      await aia.messaggi.sincronizzaSegnaposti(conv);

      expect(aia.messaggi.segnaposti(marco, conv).map((s) => s.id)).toEqual(["m-1", "m-2", "m-3"]);
    });
  });

  it("ritentare la stessa consegna dieci volte lascia un segnaposto solo", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");
      await new Promise((r) => setTimeout(r, 0));

      for (let i = 0; i < 10; i++) {
        await aia.messaggi.sincronizzaSegnaposti(conv);
      }

      expect(aia.messaggi.segnaposti(marco, conv)).toHaveLength(1);
    });
  });

  it("un id che torna con un altro mittente si rifiuta, e con lui il lotto", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");
      await new Promise((r) => setTimeout(r, 0));

      expect(
        aia.messaggi.riceviSegnapostiSpinti({
          conversazioneId: conv,
          da: "matteo",
          destinatari: ["marco"],
          remoteKey: borgo.chiave,
          voci: [
            { id: "m-9", inviatoIl: ORA, mittente: `matteo@${borgo.chiave}`, seq: 9 },
            { id: "m-1", inviatoIl: ORA, mittente: `luca@${borgo.chiave}`, seq: 1 },
          ],
        }),
      ).toBe(false);
      expect(aia.messaggi.segnaposti(marco, conv).map((s) => s.id)).toEqual(["m-1"]);
    });
  });

  it("una casa non deposita segnaposto a nome di un'altra", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco } = await conversazione(aia, borgo);

      expect(
        aia.messaggi.riceviSegnapostiSpinti({
          conversazioneId: conv,
          da: "matteo",
          destinatari: ["marco"],
          remoteKey: borgo.chiave,
          voci: [{ id: "x", inviatoIl: ORA, mittente: "carla@una-terza-casa", seq: 1 }],
        }),
      ).toBe(false);
      expect(aia.messaggi.segnaposti(marco, conv)).toEqual([]);
    });
  });
});

describe("un ritirato non torna (ADR 0042 §4.1)", () => {
  /** Matteo ritira: la voce sparisce da Borgo, e il posto resta vuoto. */
  function ritira(borgo: Casa, conv: string, id: string): void {
    borgo.database
      .prepare(`DELETE FROM archivio_voci WHERE conversazione_id = ? AND id = ?`)
      .run(conv, id);
  }

  it("la finestra dichiarata cancella il segnaposto di un messaggio ritirato", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");
      scrive(borgo, matteo, conv, "m-2");
      await aia.messaggi.sincronizzaSegnaposti(conv);

      ritira(borgo, conv, "m-1");
      // La riconciliazione da zero arriva entro i cinque minuti.
      aia.orologio.adesso = "2026-09-23T10:06:00.000Z";
      await aia.messaggi.sincronizzaSegnaposti(conv);

      expect(aia.messaggi.segnaposti(marco, conv).map((s) => s.id)).toEqual(["m-2"]);
    });
  });

  it("un recupero da zero non lo resuscita, e nemmeno una spinta vecchia (verifica 9)", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");
      scrive(borgo, matteo, conv, "m-2");
      await aia.messaggi.sincronizzaSegnaposti(conv);

      ritira(borgo, conv, "m-1");
      aia.orologio.adesso = "2026-09-23T10:06:00.000Z";
      await aia.messaggi.sincronizzaSegnaposti(conv);

      // Una spinta vecchia che porta ancora m-1: sotto il cursore, si ignora.
      aia.messaggi.riceviSegnapostiSpinti({
        conversazioneId: conv,
        da: "matteo",
        destinatari: ["marco"],
        remoteKey: borgo.chiave,
        voci: [{ id: "m-1", inviatoIl: ORA, mittente: `matteo@${borgo.chiave}`, seq: 1 }],
      });
      expect(aia.messaggi.segnaposti(marco, conv).map((s) => s.id)).toEqual(["m-2"]);

      // E una ricostruzione da zero dà lo stesso risultato.
      aia.orologio.adesso = "2026-09-23T10:12:00.000Z";
      await aia.messaggi.sincronizzaSegnaposti(conv);
      expect(aia.messaggi.segnaposti(marco, conv).map((s) => s.id)).toEqual(["m-2"]);
    });
  });

  it("un backup di Aia di prima del ritiro, ripristinato, si riconcilia (verifica 10)", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");
      scrive(borgo, matteo, conv, "m-2");
      await aia.messaggi.sincronizzaSegnaposti(conv);

      ritira(borgo, conv, "m-1");

      // Il ripristino: il segnaposto di m-1 è ancora lì, e il cursore pure.
      expect(aia.messaggi.segnaposti(marco, conv).map((s) => s.id)).toEqual(["m-1", "m-2"]);

      aia.orologio.adesso = "2026-09-23T10:06:00.000Z";
      await aia.messaggi.sincronizzaSegnaposti(conv);

      expect(aia.messaggi.segnaposti(marco, conv).map((s) => s.id)).toEqual(["m-2"]);
    });
  });

  it("il numero di un messaggio ritirato non si riusa", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");
      scrive(borgo, matteo, conv, "m-2");

      // Si ritira l'ultimo: un MAX(seq)+1 gli darebbe lo stesso numero.
      ritira(borgo, conv, "m-2");
      scrive(borgo, matteo, conv, "m-3");

      const finestra = borgo.messaggi.segnapostiPerCasa(conv, aia.chiave, 0);
      expect(finestra === "rifiutato" ? [] : finestra.voci.map((v) => [v.id, v.seq])).toEqual([
        ["m-1", 1],
        ["m-3", 3],
      ]);
    });
  });
});

describe("una casa spenta non è un messaggio ritirato", () => {
  it("con Borgo spenta i segnaposto di Matteo restano, e Borgo è detta irraggiungibile", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");
      await aia.messaggi.sincronizzaSegnaposti(conv);

      aia.accese.delete(borgo.chiave);
      aia.orologio.adesso = "2026-09-23T11:00:00.000Z";
      const esito = await aia.messaggi.sincronizzaSegnaposti(conv);

      expect(esito.irraggiungibili).toEqual([borgo.chiave]);
      expect(aia.messaggi.segnaposti(marco, conv).map((s) => s.id)).toEqual(["m-1"]);
    });
  });
});

describe("chi non partecipa non chiede", () => {
  it("una casa senza membri nella conversazione riceve un rifiuto", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");

      expect(borgo.messaggi.segnapostiPerCasa(conv, "una-casa-estranea", 0)).toBe("rifiutato");
      expect(borgo.messaggi.segnapostiPerCasa("conv-che-non-esiste", aia.chiave, 0)).toBe(
        "rifiutato",
      );
    });
  });
});

describe("la cronologia si visita (ADR 0043 §2)", () => {
  it("Marco legge la parola di Matteo, e ad Aia non ne resta niente", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");

      const pagina = await aia.messaggi.cronologia(marco, conv);

      expect(pagina.righe).toEqual([
        {
          casa: borgo.chiave,
          createdAt: ORA,
          id: "m-1",
          mittente: `matteo@${borgo.chiave}`,
          stato: "disponibile",
          voce: { busta: "VOCE_CIFRATA_m-1", chiaveN: 0 },
        },
      ]);
      // La voce è passata dalla risposta, e non è stata scritta: la verifica 1
      // di ADR 0043, **dopo** una lettura.
      expect(tuttoIlDatabase(aia)).not.toContain("VOCE_CIFRATA_m-1");
    });
  });

  it("le parole delle due case si ricompongono in ordine di tempo", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1", "2026-09-23T10:01:00.000Z");
      aia.messaggi.depositaArchivio(marco, conv, [
        { busta: "VOCE_DI_MARCO", chiaveN: 0, createdAt: "2026-09-23T10:02:00.000Z", id: "a-1" },
      ]);
      scrive(borgo, matteo, conv, "m-2", "2026-09-23T10:03:00.000Z");

      const pagina = await aia.messaggi.cronologia(marco, conv);

      expect(pagina.righe.map((r) => [r.id, r.mittente])).toEqual([
        ["m-1", `matteo@${borgo.chiave}`],
        ["a-1", `marco@${aia.chiave}`],
        ["m-2", `matteo@${borgo.chiave}`],
      ]);
      // E la voce di Marco sta ad Aia soltanto: Borgo ne ha il segno.
      expect(tuttoIlDatabase(borgo)).not.toContain("VOCE_DI_MARCO");
    });
  });

  it("con Borgo spenta restano mittente e orario; riaccesa, il contenuto torna", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");
      await aia.messaggi.sincronizzaSegnaposti(conv);

      aia.accese.delete(borgo.chiave);
      const spenta = await aia.messaggi.cronologia(marco, conv);

      expect(spenta.nonRispondono).toEqual([borgo.chiave]);
      expect(spenta.righe).toEqual([
        {
          casa: borgo.chiave,
          createdAt: ORA,
          id: "m-1",
          mittente: `matteo@${borgo.chiave}`,
          stato: "non-disponibile",
        },
      ]);

      // È la prova centrale di ADR 0043, verifica 3: nessuna copia di ripiego,
      // e quando Borgo torna il contenuto torna dalla visita.
      aia.accese.set(borgo.chiave, borgo);
      const riaccesa = await aia.messaggi.cronologia(marco, conv);
      expect(riaccesa.righe[0]?.stato).toBe("disponibile");
      expect(riaccesa.nonRispondono).toEqual([]);
    });
  });

  it("Matteo ritira: alla lettura successiva di Marco il messaggio non c'è più", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");
      scrive(borgo, matteo, conv, "m-2");
      expect((await aia.messaggi.cronologia(marco, conv)).righe).toHaveLength(2);

      borgo.messaggi.ritiraVoce(matteo, conv, "m-1");

      // Subito, senza aspettare la riconciliazione: la visita dice che non c'è.
      const dopo = await aia.messaggi.cronologia(marco, conv);
      expect(dopo.righe.map((r) => r.id)).toEqual(["m-2"]);
      expect(aia.messaggi.segnaposti(marco, conv).map((s) => s.id)).toEqual(["m-2"]);
    });
  });

  it("si ritira soltanto la propria parola", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");

      // Marco non abita a Borgo e non ha scritto m-1: niente da ritirare.
      expect(() => aia.messaggi.ritiraVoce(marco, conv, "m-1")).toThrow();
      expect(borgo.messaggi.vociPerCasa(conv, aia.chiave, ["m-1"])).toMatchObject({
        assenti: [],
      });
    });
  });

  it("una pagina alla volta, dalla più recente", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      for (let i = 1; i <= 5; i++) {
        scrive(borgo, matteo, conv, `m-${i}`, `2026-09-23T10:0${i}:00.000Z`);
      }

      const ultima = await aia.messaggi.cronologia(marco, conv, { limite: 2 });
      expect(ultima.righe.map((r) => r.id)).toEqual(["m-4", "m-5"]);

      const precedente = await aia.messaggi.cronologia(marco, conv, {
        limite: 2,
        prima: ultima.prima,
      });
      expect(precedente.righe.map((r) => r.id)).toEqual(["m-2", "m-3"]);
    });
  });

  it("chi non partecipa non visita", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");

      expect(borgo.messaggi.vociPerCasa(conv, "una-casa-estranea", ["m-1"])).toBe("rifiutato");
    });
  });
});

describe("il Welcome per un'altra casa porta l'annuncio con sé", () => {
  it("Matteo invita Marco: la casa di Marco sa che la conversazione esiste, e chi la ordina", async () => {
    await dueCase(async (aia, borgo) => {
      const matteo = borgo.abita("matteo");
      const marco = aia.abita("marco");
      const conv = "conv-dal-welcome";
      borgo.repo.createConversazione({
        createdAt: ORA,
        id: conv,
        membri: [matteo, `remote:${aia.chiave}:marco`],
        tipo: "diretta",
      });

      await borgo.messaggi.depositaHandshake(matteo, conv, {
        busta: "COMMIT",
        epoch: 1,
        tipo: "commit",
      });
      await borgo.messaggi.depositaHandshake(matteo, conv, {
        busta: "WELCOME",
        destinatario: `remote:${aia.chiave}:marco`,
        epoch: 1,
        tipo: "welcome",
      });
      await new Promise((r) => setTimeout(r, 0));

      // Senza l'annuncio Marco non vedrebbe la conversazione, e non saprebbe
      // dove cercare il suo Welcome.
      expect(aia.repo.isMember(conv, marco)).toBe(true);
      expect(aia.repo.casaCheOrdina(conv)).toBe(borgo.chiave);
      expect(aia.messaggi.listConversazioni(marco).map((c) => [c.id, c.ordinataQui])).toEqual([
        [conv, false],
      ]);
      expect(borgo.messaggi.listConversazioni(matteo).map((c) => c.ordinataQui)).toEqual([true]);
    });
  });
});

describe("il respiro fra due domande", () => {
  it("più letture ravvicinate non moltiplicano le domande all'altra casa", async () => {
    // Una chat aperta in due schede, o due persone della stessa casa sulla
    // stessa conversazione: senza respiro, ognuna chiederebbe per conto suo, e
    // il limite di frequenza dell'altra casa scatterebbe in meno di un minuto.
    await dueCase(async (aia, borgo) => {
      const { conv, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1");

      await aia.messaggi.sincronizzaSegnaposti(conv);
      const dopoLaPrima = borgo.domande.segnaposti;

      aia.orologio.adesso = "2026-09-23T10:00:05.000Z";
      await aia.messaggi.sincronizzaSegnaposti(conv);
      await aia.messaggi.sincronizzaSegnaposti(conv);
      expect(borgo.domande.segnaposti).toBe(dopoLaPrima);

      // Passati dieci secondi, si torna a chiedere.
      aia.orologio.adesso = "2026-09-23T10:00:11.000Z";
      await aia.messaggi.sincronizzaSegnaposti(conv);
      expect(borgo.domande.segnaposti).toBeGreaterThan(dopoLaPrima);
    });
  });
});

describe("l'elenco delle conversazioni vede le chat MLS", () => {
  it("ultimo messaggio e non letti vengono dalle voci e dai segnaposto", async () => {
    // Senza, una chat MLS sembrerebbe sempre vuota e senza novità: le sue
    // parole non stanno in `messaggi`, stanno nell'archivio di chi scrive.
    await dueCase(async (aia, borgo) => {
      const { conv, marco, matteo } = await conversazione(aia, borgo);
      scrive(borgo, matteo, conv, "m-1", "2026-09-23T10:01:00.000Z");
      scrive(borgo, matteo, conv, "m-2", "2026-09-23T10:02:00.000Z");
      await aia.messaggi.sincronizzaSegnaposti(conv);

      const perMarco = aia.messaggi.listConversazioni(marco)[0];
      expect(perMarco?.ultimoMessaggio).toEqual({
        createdAt: "2026-09-23T10:02:00.000Z",
        id: "m-2",
        senderUserId: `remote:${borgo.chiave}:matteo`,
      });
      expect(perMarco?.nonLetti).toBe(2);

      // Per Matteo le sue parole non sono «non lette».
      const perMatteo = borgo.messaggi.listConversazioni(matteo)[0];
      expect(perMatteo?.ultimoMessaggio?.id).toBe("m-2");
      expect(perMatteo?.nonLetti).toBe(0);
    });
  });
});
