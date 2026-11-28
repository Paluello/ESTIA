/**
 * I gruppi, fra tre case (M8 Fase 1, [ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §2 e §3).
 *
 * Tre case, tre database veri, e in mezzo le regole invece del filo: la stessa
 * scelta di `segnaposti.test.ts`. Il trasporto ha le sue prove in
 * `federation.test.ts`; qui si verifica **chi sa che cosa, e chi può fare che
 * cosa** — e quello che attraversa passa dallo stesso controllo di forma che
 * il filo applica (`leggiComposizione`), così una composizione che il filo
 * scarterebbe qui non passa per comodità.
 *
 * Anna abita ad Aia e crea il gruppo: Aia è la casa che ordina. Bruno abita a
 * Borgo, Carla a Colle.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { MAX_FOGLIE_GRUPPO } from "@estia/contracts";
import { withTempDataDir } from "@estia/testing";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../db/database.js";
import { DomainError } from "../errors.js";
import { leggiComposizione } from "../federation/protocol.js";
import { SqliteUserRepository } from "../identity/repository.js";

import { SqliteMessaggiRepository } from "./repository.js";
import {
  MessaggiService,
  type ChiPuoScrivere,
  type Composizione,
  type ReteFraCase,
} from "./service.js";

const ORA = "2026-11-27T10:00:00.000Z";

interface Casa {
  chiave: string;
  database: DatabaseSync;
  repo: SqliteMessaggiRepository;
  messaggi: MessaggiService;
  /** Le case che rispondono, come le vede questa. Togliere una casa è spegnerla. */
  accese: Map<string, Casa>;
  /** L'ultimo contatto con ogni altra casa, come lo terrebbe il battito (ADR 0041). */
  contatti: Map<string, string>;
  abita: (username: string) => string;
  orologio: { adesso: string };
  /** Chi può scrivere a chi (ADR 0030). Di norma tutti; le prove della regola la stringono. */
  porta: ChiPuoScrivere;
}

/** Come sul filo: JSON, e poi il controllo di forma di chi riceve. */
function sulFilo(composizione: Composizione): Composizione | undefined {
  return leggiComposizione(JSON.parse(JSON.stringify(composizione)) as unknown);
}

function casa(dataDir: string, chiave: string, conRete = true): Casa {
  const database = openDatabase(dataDir);
  const users = new SqliteUserRepository(database);
  const repo = new SqliteMessaggiRepository(database);
  const orologio = { adesso: ORA };
  const accese = new Map<string, Casa>();
  const contatti = new Map<string, string>();

  const porta: ChiPuoScrivere = { puoAprire: () => true };

  const messaggi = new MessaggiService({
    chiPuoScrivere: { puoAprire: (...argomenti) => porta.puoAprire(...argomenti) },
    now: () => orologio.adesso,
    repository: repo,
    users,
  });

  const spenta = { esito: "irraggiungibile" } as const;
  const rete: ReteFraCase = {
    annunciaComposizione: (altra, conversazioneId, composizione) => {
      const arrivata = sulFilo(composizione);
      if (arrivata !== undefined) {
        accese.get(altra)?.messaggi.riceviComposizione(conversazioneId, chiave, arrivata);
      }
      return Promise.resolve();
    },
    cambiaMembri: (altra, conversazioneId, { da, ...cambio }) => {
      const lei = accese.get(altra);
      if (lei === undefined) {
        return Promise.resolve(spenta);
      }

      const esito = lei.messaggi.cambiaMembriRemoto({
        cambio,
        conversazioneId,
        da,
        remoteKey: chiave,
      });
      if (esito === "rifiutato") {
        return Promise.resolve({ esito: "rifiutato" });
      }
      if ("negato" in esito) {
        return Promise.resolve({ esito: "negato", motivo: esito.negato });
      }

      const arrivata = sulFilo(esito.composizione);
      return Promise.resolve(
        arrivata === undefined
          ? { esito: "rifiutato" }
          : { composizione: arrivata, esito: "fatto" },
      );
    },
    casa: chiave,
    coda: (altra, conversazioneId, dopo) => {
      const coda = accese
        .get(altra)
        ?.messaggi.handshakeRemoti(conversazioneId, chiave, dopo === undefined ? {} : { dopo });
      if (!accese.has(altra)) {
        return Promise.resolve(spenta);
      }
      return Promise.resolve(
        coda === undefined
          ? { esito: "rifiutato" }
          : { esito: "coda", handshake: coda.handshake.map(({ seq: _seq, ...voce }) => voce) },
      );
    },
    composizione: (altra, conversazioneId) => {
      const lei = accese.get(altra);
      if (lei === undefined) {
        return Promise.resolve(spenta);
      }

      const esito = lei.messaggi.composizionePerCasa(conversazioneId, chiave);
      const arrivata = esito === "rifiutato" ? undefined : sulFilo(esito);
      return Promise.resolve(
        arrivata === undefined
          ? { esito: "rifiutato" }
          : { composizione: arrivata, esito: "composizione" },
      );
    },
    deposita: (altra, conversazioneId, busta) => {
      const lei = accese.get(altra);
      if (lei === undefined) {
        return Promise.resolve(spenta);
      }

      const esito = lei.messaggi.depositaHandshakeRemoto({
        ...busta,
        conversazioneId,
        remoteKey: chiave,
      });
      return Promise.resolve(
        esito === undefined
          ? { esito: "rifiutato" }
          : esito === "indietro"
            ? { esito: "indietro" }
            : { esito: "depositato" },
      );
    },
    depositaStato: () => Promise.resolve(spenta),
    leggiStato: (altra, conversazioneId, tipo) => {
      const lei = accese.get(altra);
      if (lei === undefined) {
        return Promise.resolve(spenta);
      }

      const stato = lei.messaggi.statoRemoto(conversazioneId, chiave, tipo);
      return Promise.resolve(
        stato === "rifiutato"
          ? { esito: "rifiutato" }
          : stato === undefined
            ? { esito: "assente" }
            : { ...stato, esito: "stato" },
      );
    },
    risponde: (altra) => {
      const cE = accese.has(altra);
      if (cE) {
        contatti.set(altra, orologio.adesso);
      }
      return Promise.resolve(cE);
    },
    segnapostiDa: (altra, conversazioneId, dopo) => {
      const lei = accese.get(altra);
      if (lei === undefined) {
        return Promise.resolve(spenta);
      }

      const finestra = lei.messaggi.segnapostiPerCasa(conversazioneId, chiave, dopo);
      return Promise.resolve(
        finestra === "rifiutato" ? { esito: "rifiutato" } : { esito: "finestra", ...finestra },
      );
    },
    spingiSegnaposti: (altra, spinta) => {
      accese.get(altra)?.messaggi.riceviSegnapostiSpinti({ ...spinta, remoteKey: chiave });
      return Promise.resolve();
    },
    ultimoContatto: (altra) => contatti.get(altra),
    visitaArchivio: (altra, conversazioneId, ids) => {
      const lei = accese.get(altra);
      if (lei === undefined) {
        return Promise.resolve(spenta);
      }

      const esito = lei.messaggi.vociPerCasa(conversazioneId, chiave, ids);
      return Promise.resolve(
        esito === "rifiutato" ? { esito: "rifiutato" } : { esito: "voci", ...esito },
      );
    },
  };

  if (conRete) {
    messaggi.useRete(rete);
  }

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
    contatti,
    database,
    messaggi,
    orologio,
    porta,
    repo,
  };
}

/** Le spinte partono senza essere attese: qui si lascia che arrivino. */
const quieta = (): Promise<void> => new Promise((fatto) => setImmediate(fatto));

async function treCase(use: (aia: Casa, borgo: Casa, colle: Casa) => Promise<void>): Promise<void> {
  await withTempDataDir(async (primo) => {
    await withTempDataDir(async (secondo) => {
      await withTempDataDir(async (terzo) => {
        const case_ = [
          casa(primo, "a1".repeat(32)),
          casa(secondo, "b0".repeat(32)),
          casa(terzo, "c0".repeat(32)),
        ] as const;

        for (const una of case_) {
          for (const altra of case_) {
            if (una !== altra) {
              una.accese.set(altra.chiave, altra);
            }
          }
        }

        try {
          await use(...case_);
        } finally {
          for (const una of case_) {
            una.database.close();
          }
        }
      });
    });
  });
}

interface Scena {
  conv: string;
  anna: string;
  bruno: string;
  carla: string;
}

/** Anna, ad Aia, crea «Cena di quartiere» con Bruno di Borgo e Carla di Colle. */
async function gruppo(aia: Casa, borgo: Casa, colle: Casa): Promise<Scena> {
  const anna = aia.abita("anna");
  const bruno = borgo.abita("bruno");
  const carla = colle.abita("carla");

  const { conversazione } = aia.messaggi.creaGruppo(anna, {
    membri: [
      { casa: borgo.chiave, username: "bruno" },
      { casa: colle.chiave, username: "carla" },
    ],
    nome: "Cena di quartiere",
  });
  await quieta();

  return { anna, bruno, carla, conv: conversazione.id };
}

/** Il codice del rifiuto, o `undefined` se la chiamata passa. */
async function rifiuto(chiamata: () => unknown): Promise<string | undefined> {
  try {
    await chiamata();
    return undefined;
  } catch (causa) {
    if (causa instanceof DomainError) {
      return causa.code;
    }
    throw causa;
  }
}

const dopoUnMinuto = (c: Casa): void => {
  c.orologio.adesso = new Date(Date.parse(c.orologio.adesso) + 61_000).toISOString();
};

describe("un gruppo esiste", () => {
  it("nasce con un nome e un creatore, e la casa di chi crea lo ordina", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, conv } = await gruppo(aia, borgo, colle);

      const vista = await aia.messaggi.getConversazione(anna, conv);
      expect(vista).toMatchObject({ nome: "Cena di quartiere", ordinataQui: true, tipo: "gruppo" });
      expect(vista.membri.map((m) => m.username).sort()).toEqual(["anna", "bruno", "carla"]);
      expect(vista.ruoli).toEqual({
        [anna]: "creatore",
        [`remote:${borgo.chiave}:bruno`]: "membro",
        [`remote:${colle.chiave}:carla`]: "membro",
      });
      expect(aia.messaggi.listConversazioni(anna)[0]).toMatchObject({
        nome: "Cena di quartiere",
        tipo: "gruppo",
      });
    });
  });

  it("la terza casa risulta partecipante alla seconda: la composizione la dice chi ordina", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { bruno, carla, conv } = await gruppo(aia, borgo, colle);

      // Era il difetto: l'annuncio portava i destinatari di una casa sola, e
      // Borgo conosceva Bruno e Anna — non Carla.
      expect(borgo.repo.casaCheOrdina(conv)).toBe(aia.chiave);
      expect(borgo.repo.haMembroDiCasa(conv, colle.chiave)).toBe(true);
      expect(colle.repo.haMembroDiCasa(conv, borgo.chiave)).toBe(true);

      const daBorgo = await borgo.messaggi.getConversazione(bruno, conv);
      expect(daBorgo).toMatchObject({ nome: "Cena di quartiere", ordinataQui: false });
      expect(daBorgo.membri.map((m) => m.username).sort()).toEqual(["anna", "bruno", "carla"]);
      expect(daBorgo.ruoli?.[`remote:${aia.chiave}:anna`]).toBe("creatore");

      // Quindi Colle serve a Borgo quello che Carla scrive, e viceversa.
      colle.messaggi.depositaArchivio(carla, conv, [
        { busta: "VOCE_DI_CARLA", chiaveN: 1, createdAt: ORA, id: "m-carla" },
      ]);
      await quieta();
      const pagina = await borgo.messaggi.cronologia(bruno, conv);
      expect(pagina.righe).toMatchObject([
        { id: "m-carla", mittente: `carla@${colle.chiave}`, stato: "disponibile" },
      ]);
    });
  });

  it("sotto tre persone non è un gruppo, e chi crea non conta due volte", async () => {
    await treCase(async (aia, borgo) => {
      const anna = aia.abita("anna");
      aia.abita("dario");

      expect(
        await rifiuto(() =>
          aia.messaggi.creaGruppo(anna, {
            membri: [{ username: "dario" }, { username: "anna" }, { username: "dario" }],
            nome: "In due",
          }),
        ),
      ).toBe("gruppo_troppo_piccolo");
      expect(
        await rifiuto(() =>
          aia.messaggi.creaGruppo(anna, {
            membri: [{ username: "dario" }, { username: "nessuno" }],
            nome: "Con uno che non c'è",
          }),
        ),
      ).toBe("user_not_found");
      expect(
        await rifiuto(() =>
          aia.messaggi.creaGruppo(anna, {
            membri: [{ username: "dario" }, { casa: borgo.chiave, username: "bruno" }],
            nome: "   ",
          }),
        ),
      ).toBe("invalid_request");
    });
  });

  it("senza rete un gruppo di casa nasce, e uno con qualcuno di fuori no", async () => {
    await withTempDataDir(async (dataDir) => {
      const sola = casa(dataDir, "chiave-sola", false);
      try {
        const anna = sola.abita("anna");
        sola.abita("bruno");
        sola.abita("carla");

        const { conversazione } = sola.messaggi.creaGruppo(anna, {
          membri: [{ username: "bruno" }, { username: "carla" }],
          nome: "Di casa",
        });
        expect(conversazione).toMatchObject({ ordinataQui: true, tipo: "gruppo" });

        expect(
          await rifiuto(() =>
            sola.messaggi.creaGruppo(anna, {
              membri: [{ username: "bruno" }, { casa: "un-altra-casa", username: "dario" }],
              nome: "Con uno di fuori",
            }),
          ),
        ).toBe("rete_non_attiva");
      } finally {
        sola.database.close();
      }
    });
  });

  it("il tetto è cinquanta: il cinquantunesimo non entra", async () => {
    await treCase(async (aia) => {
      const anna = aia.abita("anna");
      const altri = Array.from({ length: MAX_FOGLIE_GRUPPO - 1 }, (_, i) => `membro${String(i)}`);
      altri.forEach((nome) => aia.abita(nome));
      aia.abita("di-troppo");

      const { conversazione } = aia.messaggi.creaGruppo(anna, {
        membri: altri.map((username) => ({ username })),
        nome: "Pieno",
      });
      expect(conversazione.membri).toHaveLength(MAX_FOGLIE_GRUPPO);

      expect(
        await rifiuto(() =>
          aia.messaggi.aggiungiMembro(anna, conversazione.id, { username: "di-troppo" }),
        ),
      ).toBe("gruppo_pieno");
    });
  });
});

describe("chi può aggiungere e togliere", () => {
  it("un membro semplice no, nemmeno da un'altra casa; un amministratore nominato sì", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, bruno, conv } = await gruppo(aia, borgo, colle);
      colle.abita("dario");
      const dario = { casa: colle.chiave, username: "dario" };

      expect(await rifiuto(() => borgo.messaggi.aggiungiMembro(bruno, conv, dario))).toBe(
        "solo_amministratori",
      );
      expect(aia.repo.contaMembri(conv)).toBe(3);

      await aia.messaggi.cambiaRuolo(anna, conv, `remote:${borgo.chiave}:bruno`, "amministratore");
      await quieta();

      const vista = await borgo.messaggi.aggiungiMembro(bruno, conv, dario);
      await quieta();
      expect(vista.conversazione.membri.map((m) => m.username).sort()).toEqual([
        "anna",
        "bruno",
        "carla",
        "dario",
      ]);

      // Lo sanno tutte e tre: chi ordina, chi ha chiesto, e la casa di chi entra.
      for (const una of [aia, borgo, colle]) {
        expect(una.repo.contaMembri(conv)).toBe(4);
      }
      expect(await rifiuto(() => borgo.messaggi.aggiungiMembro(bruno, conv, dario))).toBe(
        "gia_nel_gruppo",
      );
    });
  });

  it("gli amministratori li nomina il creatore, e il creatore non si toglie", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, bruno, conv } = await gruppo(aia, borgo, colle);
      await aia.messaggi.cambiaRuolo(anna, conv, `remote:${borgo.chiave}:bruno`, "amministratore");
      await quieta();

      expect(
        await rifiuto(() =>
          borgo.messaggi.cambiaRuolo(bruno, conv, `remote:${colle.chiave}:carla`, "amministratore"),
        ),
      ).toBe("solo_il_creatore");
      expect(
        await rifiuto(() => borgo.messaggi.togliMembro(bruno, conv, `remote:${aia.chiave}:anna`)),
      ).toBe("creatore_non_si_toglie");
      expect(
        await rifiuto(() => aia.messaggi.togliMembro(anna, conv, "remote:altrove:nessuno")),
      ).toBe("non_nel_gruppo");
    });
  });

  it("una casa parla per i suoi e per nessun altro", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { conv } = await gruppo(aia, borgo, colle);

      // Colle dice che a chiedere è Anna: ma Anna non è di Colle.
      expect(
        aia.messaggi.cambiaMembriRemoto({
          cambio: { azione: "togli", chi: `bruno@${borgo.chiave}` },
          conversazioneId: conv,
          da: "anna",
          remoteKey: colle.chiave,
        }),
      ).toBe("rifiutato");
      // E una casa che non partecipa non chiede niente, nemmeno a nome di un nome vero.
      expect(
        aia.messaggi.cambiaMembriRemoto({
          cambio: { azione: "esci" },
          conversazioneId: conv,
          da: "bruno",
          remoteKey: "una-casa-estranea",
        }),
      ).toBe("rifiutato");
      expect(aia.messaggi.composizionePerCasa(conv, "una-casa-estranea")).toBe("rifiutato");
      expect(aia.repo.contaMembri(conv)).toBe(3);
    });
  });

  it("in una conversazione fra due non c'è nessuno da aggiungere, e un gruppo non si elimina", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, conv } = await gruppo(aia, borgo, colle);
      const dario = aia.abita("dario");
      const diretta = aia.messaggi.getOrCreateDirect(anna, {
        recipientUserId: dario,
      }).conversazione;

      expect(
        await rifiuto(() => aia.messaggi.aggiungiMembro(anna, diretta.id, { username: "dario" })),
      ).toBe("non_un_gruppo");
      expect(await rifiuto(() => aia.messaggi.deleteConversazione(anna, conv))).toBe(
        "gruppo_non_si_elimina",
      );
    });
  });
});

describe("la rimozione", () => {
  it("chi è tolto non riceve più niente, e l'istanza glielo dice", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, bruno, carla, conv } = await gruppo(aia, borgo, colle);
      colle.messaggi.depositaArchivio(carla, conv, [
        { busta: "VOCE_DI_CARLA", chiaveN: 1, createdAt: ORA, id: "m-carla" },
      ]);
      await quieta();

      await aia.messaggi.togliMembro(anna, conv, `remote:${colle.chiave}:carla`);
      await quieta();

      // La casa che ordina ricorda chi, quando e da chi.
      expect(aia.repo.rimosso(conv, `remote:${colle.chiave}:carla`)).toEqual({
        da: anna,
        rimossoIl: ORA,
        userId: `remote:${colle.chiave}:carla`,
      });

      // Criterio 3: la sua casa rifiuta di servirle la conversazione, per ogni porta.
      for (const chiamata of [
        () => colle.messaggi.cronologia(carla, conv),
        () => colle.messaggi.getConversazione(carla, conv),
        () => colle.messaggi.listHandshake(carla, conv),
        () => colle.messaggi.getMazzoArchivio(carla, conv),
        () => colle.messaggi.getGroupInfo(carla, conv),
        () => colle.messaggi.listArchivio(carla, conv),
        () =>
          colle.messaggi.depositaArchivio(carla, conv, [
            { busta: "DOPO", chiaveN: 1, createdAt: ORA, id: "m-dopo" },
          ]),
      ]) {
        expect(await rifiuto(chiamata)).toBe("rimosso_dal_gruppo");
      }
      expect(colle.messaggi.listConversazioni(carla)).toEqual([]);

      // E le altre case non servono più niente a Colle, che dentro non ha più nessuno.
      expect(aia.messaggi.handshakeRemoti(conv, colle.chiave)).toBeUndefined();
      expect(aia.messaggi.statoRemoto(conv, colle.chiave, "mazzo")).toBe("rifiutato");
      expect(aia.messaggi.segnapostiPerCasa(conv, colle.chiave, 0)).toBe("rifiutato");
      expect(borgo.messaggi.vociPerCasa(conv, colle.chiave, ["m-1"])).toBe("rifiutato");

      // Rimuovere non è cancellare: quello che Carla aveva scritto resta dov'era,
      // e chi è rimasto lo legge ancora.
      const pagina = await borgo.messaggi.cronologia(bruno, conv);
      expect(pagina.righe).toMatchObject([{ id: "m-carla", stato: "disponibile" }]);

      // E ogni casa dice ai suoi chi è stato tolto, con il suo indirizzo: è
      // ciò che serve a un client per togliere la foglia di chi non c'è più.
      expect((await aia.messaggi.getConversazione(anna, conv)).rimossi).toEqual([
        `carla@${colle.chiave}`,
      ]);
      expect((await borgo.messaggi.getConversazione(bruno, conv)).rimossi).toEqual([
        `carla@${colle.chiave}`,
      ]);
    });
  });

  it("chi è tolto mentre la sua casa non ascoltava lo scopre alla prima lettura", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, carla, conv } = await gruppo(aia, borgo, colle);
      expect(await rifiuto(() => colle.messaggi.cronologia(carla, conv))).toBeUndefined();

      // Colle si spegne, e l'annuncio della rimozione non le arriva.
      aia.accese.delete(colle.chiave);
      await aia.messaggi.togliMembro(anna, conv, `remote:${colle.chiave}:carla`);
      await quieta();
      expect(colle.repo.isMember(conv, carla)).toBe(true);

      aia.accese.set(colle.chiave, colle);
      dopoUnMinuto(colle);

      expect(await rifiuto(() => colle.messaggi.cronologia(carla, conv))).toBe(
        "rimosso_dal_gruppo",
      );
      expect(colle.repo.isMember(conv, carla)).toBe(false);
    });
  });

  it("riammettere toglie il segno della rimozione, in tutte le case", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, carla, conv } = await gruppo(aia, borgo, colle);
      const suo = `remote:${colle.chiave}:carla`;

      await aia.messaggi.togliMembro(anna, conv, suo);
      await quieta();
      expect(colle.repo.rimosso(conv, carla)).toBeDefined();

      await aia.messaggi.aggiungiMembro(anna, conv, { casa: colle.chiave, username: "carla" });
      await quieta();

      expect(aia.repo.rimosso(conv, suo)).toBeUndefined();
      expect(colle.repo.rimosso(conv, carla)).toBeUndefined();
      expect(await rifiuto(() => colle.messaggi.cronologia(carla, conv))).toBeUndefined();
      expect(borgo.repo.haMembroDiCasa(conv, colle.chiave)).toBe(true);
    });
  });
});

describe("uscire", () => {
  it("è un'operazione di chi esce: non serve nessun ruolo, e attraversa", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { bruno, conv } = await gruppo(aia, borgo, colle);
      const suo = `remote:${borgo.chiave}:bruno`;

      await borgo.messaggi.esci(bruno, conv);
      await quieta();

      // `da` è lui: nessuno lo ha tolto.
      expect(aia.repo.rimosso(conv, suo)).toMatchObject({ da: suo });
      expect(borgo.repo.rimosso(conv, bruno)).toMatchObject({ da: bruno });
      expect(colle.repo.haMembroDiCasa(conv, borgo.chiave)).toBe(false);
      expect(await rifiuto(() => borgo.messaggi.cronologia(bruno, conv))).toBe(
        "rimosso_dal_gruppo",
      );
    });
  });

  it("se la casa che ordina non risponde non si esce, e lo si dice", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { bruno, conv } = await gruppo(aia, borgo, colle);

      borgo.accese.delete(aia.chiave);

      expect(await rifiuto(() => borgo.messaggi.esci(bruno, conv))).toBe(
        "casa_che_ordina_non_raggiungibile",
      );
      expect(borgo.repo.isMember(conv, bruno)).toBe(true);
      expect(aia.repo.contaMembri(conv)).toBe(3);
    });
  });

  it("se esce il creatore, il gruppo non resta senza nessuno che lo amministri", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, conv } = await gruppo(aia, borgo, colle);

      await aia.messaggi.esci(anna, conv);
      await quieta();

      // Bruno era entrato per primo: tocca a lui, e da Borgo può già aggiungere.
      expect(aia.repo.ruoloDi(conv, `remote:${borgo.chiave}:bruno`)).toBe("amministratore");
      expect(aia.repo.ruoloDi(conv, `remote:${colle.chiave}:carla`)).toBe("membro");
      expect(borgo.repo.haMembroDiCasa(conv, aia.chiave)).toBe(false);
    });
  });
});

describe("la composizione la dice una casa sola", () => {
  it("quella di una casa che non ordina non si applica", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { conv } = await gruppo(aia, borgo, colle);

      const falsa: Composizione = {
        membri: [{ chi: `bruno@${borgo.chiave}`, dal: ORA, ruolo: "creatore" }],
        nome: "Preso",
        rimossi: [],
        tipo: "gruppo",
        versione: 99,
      };

      expect(colle.messaggi.riceviComposizione(conv, borgo.chiave, falsa)).toBe(false);
      expect(colle.repo.contaMembri(conv)).toBe(3);
      expect(colle.repo.nomeDi(conv)).toBe("Cena di quartiere");
      // Nemmeno la casa che ordina se la fa riscrivere da un'altra.
      expect(aia.messaggi.riceviComposizione(conv, borgo.chiave, falsa)).toBe(false);
      expect(aia.repo.contaMembri(conv)).toBe(3);
    });
  });

  it("una versione vecchia arrivata tardi non rimette dentro chi è stato tolto", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, conv } = await gruppo(aia, borgo, colle);
      const prima = aia.messaggi.composizionePerCasa(conv, borgo.chiave) as Composizione;

      await aia.messaggi.togliMembro(anna, conv, `remote:${colle.chiave}:carla`);
      await quieta();
      expect(borgo.repo.contaMembri(conv)).toBe(2);

      expect(borgo.messaggi.riceviComposizione(conv, aia.chiave, prima)).toBe(true);
      expect(borgo.repo.contaMembri(conv)).toBe(2);
    });
  });

  it("non nasce da chi non ha messo dentro nessuno di qui, né da una spinta di chi non ordina", async () => {
    await treCase(async (aia, borgo, colle) => {
      aia.abita("anna");
      const composizione: Composizione = {
        membri: [
          { chi: `bruno@${borgo.chiave}`, dal: ORA, ruolo: "creatore" },
          { chi: `nessuno@${colle.chiave}`, dal: ORA, ruolo: "membro" },
        ],
        nome: "Senza di voi",
        rimossi: [],
        tipo: "gruppo",
        versione: 1,
      };

      expect(colle.messaggi.riceviComposizione("conv-x", borgo.chiave, composizione)).toBe(false);
      expect(colle.repo.casaCheOrdina("conv-x")).toBeUndefined();

      // Con tre case il messaggio di una casa che partecipa può arrivare prima
      // dell'annuncio di chi ordina: non deve far nascere la conversazione con
      // la casa sbagliata scritta sopra.
      colle.abita("carla");
      expect(
        colle.messaggi.riceviSegnapostiSpinti({
          conversazioneId: "conv-y",
          da: "bruno",
          destinatari: ["carla"],
          ordina: false,
          remoteKey: borgo.chiave,
          voci: [],
        }),
      ).toBe(false);
      expect(colle.repo.casaCheOrdina("conv-y")).toBeUndefined();
    });
  });
});

/**
 * La stessa porta dell'annuncio (ADR 0030 §1, `segnaposti.test.ts`), per chi
 * entra in un gruppo: una casa non mette qualcuno di qui in un gruppo se non
 * potrebbe aprirgli una conversazione.
 */
describe("entrare in un gruppo è farsi scrivere (ADR 0030)", () => {
  it("un gruppo non nasce qui per chi quella casa non può raggiungere, e la risposta è quella di un nome che non c'è", async () => {
    await treCase(async (aia, borgo, colle) => {
      borgo.porta.puoAprire = () => false;
      const { conv } = await gruppo(aia, borgo, colle);

      // A Colle è nato, a Borgo no: Bruno non ne sa niente.
      expect(colle.repo.casaCheOrdina(conv)).toBe(aia.chiave);
      expect(borgo.repo.casaCheOrdina(conv)).toBeUndefined();

      const composizione = (nome: string): Composizione => ({
        membri: [
          { chi: `anna@${aia.chiave}`, dal: ORA, ruolo: "creatore" },
          { chi: `${nome}@${borgo.chiave}`, dal: ORA, ruolo: "membro" },
        ],
        nome: "Un altro",
        rimossi: [],
        tipo: "gruppo",
        versione: 1,
      });
      const perBruno = borgo.messaggi.riceviComposizione("c-1", aia.chiave, composizione("bruno"));
      const perNessuno = borgo.messaggi.riceviComposizione(
        "c-2",
        aia.chiave,
        composizione("nessuno"),
      );
      expect(perBruno).toBe(false);
      expect(perNessuno).toBe(perBruno);
    });
  });

  it("la regola si chiede con i nomi che la casa che ordina dichiara suoi, e con nessun altro", async () => {
    await treCase(async (aia, borgo, colle) => {
      const chieste: { casa: string; da: string; a: string }[] = [];
      borgo.porta.puoAprire = (casaDiChi, da, destinatario) => {
        chieste.push({ a: destinatario.username, casa: casaDiChi, da });
        return true;
      };
      await gruppo(aia, borgo, colle);

      // Carla è nel gruppo, ma è di Colle: Aia non risponde di lei, e un
      // follow di Bruno verso Carla non apre la porta ad Aia.
      expect(chieste).toEqual([{ a: "bruno", casa: aia.chiave, da: "anna" }]);
    });
  });

  it("chi viene aggiunto dopo e non si può raggiungere non entra nello specchio; chi c'era resta", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, bruno, conv } = await gruppo(aia, borgo, colle);
      const dino = borgo.abita("dino");

      borgo.porta.puoAprire = () => false;
      await aia.messaggi.aggiungiMembro(anna, conv, { casa: borgo.chiave, username: "dino" });
      await quieta();

      // Per Aia Dino è dentro: è un invito a cui nessuno risponde.
      expect(aia.repo.isMember(conv, `remote:${borgo.chiave}:dino`)).toBe(true);
      // A Borgo no — e Bruno, che c'era già, non è stato toccato.
      expect(borgo.repo.isMember(conv, dino)).toBe(false);
      expect(borgo.repo.isMember(conv, bruno)).toBe(true);
      expect(borgo.messaggi.listConversazioni(dino)).toEqual([]);

      // Se poi la porta si apre, entra alla prima composizione che arriva.
      borgo.porta.puoAprire = () => true;
      dopoUnMinuto(borgo);
      await borgo.messaggi.getConversazione(bruno, conv);
      expect(borgo.repo.isMember(conv, dino)).toBe(true);
    });
  });

  it("una casa non fa aggiungere qualcuno di qui che non può raggiungere, e non impara se esiste", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, bruno, conv } = await gruppo(aia, borgo, colle);
      await aia.messaggi.cambiaRuolo(anna, conv, `remote:${borgo.chiave}:bruno`, "amministratore");
      await quieta();
      aia.abita("emma");

      // Bruno amministra, e da Borgo chiede di aggiungere Emma, di Aia.
      aia.porta.puoAprire = () => false;
      const perEmma = await rifiuto(() =>
        borgo.messaggi.aggiungiMembro(bruno, conv, { casa: aia.chiave, username: "emma" }),
      );
      const perNessuno = await rifiuto(() =>
        borgo.messaggi.aggiungiMembro(bruno, conv, { casa: aia.chiave, username: "nessuno" }),
      );
      expect(perEmma).toBe("user_not_found");
      expect(perNessuno).toBe(perEmma);

      aia.porta.puoAprire = (casaDiChi, da) => casaDiChi === borgo.chiave && da === "bruno";
      expect(
        await rifiuto(() =>
          borgo.messaggi.aggiungiMembro(bruno, conv, { casa: aia.chiave, username: "emma" }),
        ),
      ).toBeUndefined();
    });
  });

  it("un nome o una casa scritti male non entrano in una composizione", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, conv } = await gruppo(aia, borgo, colle);

      for (const chi of [
        { casa: borgo.chiave, username: "Non Un Nome" },
        { casa: "non-una-chiave", username: "dino" },
        { casa: borgo.chiave.toUpperCase(), username: "dino" },
      ]) {
        expect(await rifiuto(() => aia.messaggi.aggiungiMembro(anna, conv, chi))).toBe(
          "invalid_request",
        );
      }
    });
  });
});

describe("un Welcome attraversa per indirizzo", () => {
  it("depositato da un'altra casa arriva a chi entra, di casa o di una terza casa", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, bruno, carla, conv } = await gruppo(aia, borgo, colle);
      const emma = aia.abita("emma");
      await aia.messaggi.aggiungiMembro(anna, conv, { username: "emma" });
      await quieta();

      // Un Welcome porta l'epoch del commit che l'ha prodotto: prima il commit.
      await aia.messaggi.depositaHandshake(anna, conv, { busta: "C1", epoch: 1, tipo: "commit" });

      // Bruno, da Borgo, nomina le persone come le nomina Borgo.
      await borgo.messaggi.depositaHandshake(bruno, conv, {
        busta: "WELCOME_PER_EMMA",
        destinatario: `remote:${aia.chiave}:emma`,
        epoch: 1,
        tipo: "welcome",
      });
      await borgo.messaggi.depositaHandshake(bruno, conv, {
        busta: "WELCOME_PER_CARLA",
        destinatario: `remote:${colle.chiave}:carla`,
        epoch: 1,
        tipo: "welcome",
      });

      const perEmma = await aia.messaggi.listHandshake(emma, conv);
      expect(perEmma.handshake.map((h) => h.busta)).toEqual(["C1", "WELCOME_PER_EMMA"]);
      const perCarla = await colle.messaggi.listHandshake(carla, conv);
      expect(perCarla.handshake.map((h) => h.busta)).toEqual(["C1", "WELCOME_PER_CARLA"]);
      // E nessuno dei due arriva ad Anna, che è già dentro: lei vede il commit.
      expect((await aia.messaggi.listHandshake(anna, conv)).handshake.map((h) => h.busta)).toEqual([
        "C1",
      ]);
    });
  });

  it("un Welcome per chi non è nella composizione non si mette in fila", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, bruno, conv } = await gruppo(aia, borgo, colle);
      await aia.messaggi.depositaHandshake(anna, conv, { busta: "C1", epoch: 1, tipo: "commit" });

      // La casa di Bruno lo ferma già: per lei quel nome non è nel gruppo.
      expect(
        await rifiuto(() =>
          borgo.messaggi.depositaHandshake(bruno, conv, {
            busta: "WELCOME_PER_UN_ESTRANEO",
            destinatario: `remote:${colle.chiave}:nessuno`,
            epoch: 1,
            tipo: "welcome",
          }),
        ),
      ).toBe("invalid_request");

      // E se una casa lo mandasse lo stesso, chi ordina non lo mette in fila:
      // né per un indirizzo che non è nel gruppo, né per uno che non esiste.
      for (const destinatario of [`nessuno@${colle.chiave}`, `nessuno@${aia.chiave}`]) {
        expect(
          aia.messaggi.depositaHandshakeRemoto({
            busta: "WELCOME_PER_UN_ESTRANEO",
            conversazioneId: conv,
            createdAt: ORA,
            destinatario,
            epoch: 1,
            id: "w",
            remoteKey: borgo.chiave,
            tipo: "welcome",
          }),
        ).toBeUndefined();
      }
    });
  });
});

/* ---------- il trasloco (ADR 0042 §3) ---------- */

const GIORNO = 24 * 60 * 60 * 1000;

/** Aia si spegne: da adesso nessuno la raggiunge, e l'ultimo contatto è di adesso. */
function spegniAia(aia: Casa, altre: readonly Casa[]): void {
  for (const c of altre) {
    c.contatti.set(aia.chiave, c.orologio.adesso);
    c.accese.delete(aia.chiave);
  }
}

function passano(giorni: number, case_: readonly Casa[]): void {
  for (const c of case_) {
    c.orologio.adesso = new Date(Date.parse(c.orologio.adesso) + giorni * GIORNO).toISOString();
  }
}

const unaVoce = (id: string, createdAt: string) => [{ busta: "QQ==", chiaveN: 1, createdAt, id }];

describe("il trasloco: la casa che ordina è persa", () => {
  it("prima della soglia il gesto non c'è: un silenzio breve non è una scomparsa", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { bruno, conv } = await gruppo(aia, borgo, colle);
      spegniAia(aia, [borgo, colle]);
      passano(29, [borgo, colle]);

      const vista = await borgo.messaggi.getConversazione(bruno, conv);
      expect(vista.casaPersaDal).toBeUndefined();
      expect(vista.puoTraslocare).toBe(false);
      expect(await rifiuto(() => borgo.messaggi.trasloca(bruno, conv, { epoch: 1 }))).toBe(
        "casa_non_persa",
      );
      expect(borgo.messaggi.listConversazioni(bruno)).toHaveLength(1);
    });
  });

  it("oltre la soglia un amministratore trasloca: nasce un successore dichiarato, e il vecchio si congela", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, bruno, carla, conv } = await gruppo(aia, borgo, colle);
      await aia.messaggi.cambiaRuolo(anna, conv, `remote:${borgo.chiave}:bruno`, "amministratore");
      await quieta();

      spegniAia(aia, [borgo, colle]);
      const spentaIl = borgo.orologio.adesso;
      passano(31, [borgo, colle]);

      // Il gesto è di chi amministra: Carla vede che la casa è persa, e non può.
      const perCarla = await colle.messaggi.getConversazione(carla, conv);
      expect(perCarla).toMatchObject({ casaPersaDal: spentaIl, puoTraslocare: false });
      expect(await rifiuto(() => colle.messaggi.trasloca(carla, conv, { epoch: 4 }))).toBe(
        "trasloco_solo_amministratori",
      );

      const perBruno = await borgo.messaggi.getConversazione(bruno, conv);
      expect(perBruno).toMatchObject({
        casaPersaDal: spentaIl,
        congelata: false,
        puoTraslocare: true,
      });

      const { conversazione: nuovo } = await borgo.messaggi.trasloca(bruno, conv, { epoch: 4 });
      await quieta();

      // Un gruppo nuovo, ordinato dalla casa di chi ha traslocato, che dice
      // che cosa continua, chi è stato e quando. Anna, che ha la casa spenta,
      // non c'è.
      expect(nuovo.id).not.toBe(conv);
      expect(nuovo).toMatchObject({
        continua: {
          casaPersaDal: spentaIl,
          conversazioneId: conv,
          da: `bruno@${borgo.chiave}`,
          epoch: 4,
          il: borgo.orologio.adesso,
          nome: "Cena di quartiere",
        },
        nome: "Cena di quartiere",
        ordinataQui: true,
        ruoli: { [bruno]: "creatore", [`remote:${colle.chiave}:carla`]: "membro" },
        tipo: "gruppo",
      });
      expect(nuovo.membri.map((m) => m.username).sort()).toEqual(["bruno", "carla"]);

      // Il vecchio resta, marcato, con il legame al successore — in tutte e
      // due le case vive. E non accetta più scritture né cambi.
      for (const [c, chi] of [
        [borgo, bruno],
        [colle, carla],
      ] as const) {
        const vecchio = await c.messaggi.getConversazione(chi, conv);
        expect(vecchio).toMatchObject({
          congelata: true,
          successori: [{ da: `bruno@${borgo.chiave}`, id: nuovo.id, il: borgo.orologio.adesso }],
        });
        expect(vecchio.membri.map((m) => m.username).sort()).toEqual(["anna", "bruno", "carla"]);
        expect(
          await rifiuto(() =>
            c.messaggi.depositaArchivio(chi, conv, unaVoce("tardi", c.orologio.adesso)),
          ),
        ).toBe("gruppo_congelato");
        expect(await rifiuto(() => c.messaggi.esci(chi, conv))).toBe("gruppo_congelato");
        expect(
          await rifiuto(() =>
            c.messaggi.depositaHandshake(chi, conv, { busta: "C", epoch: 5, tipo: "commit" }),
          ),
        ).toBe("gruppo_congelato");
        // La cronologia si legge ancora: la casa persa è soltanto una che non risponde.
        expect((await c.messaggi.cronologia(chi, conv)).righe).toEqual([]);
      }

      // La casa di Carla ha il successore, con la stessa dichiarazione.
      const daColle = await colle.messaggi.getConversazione(carla, nuovo.id);
      expect(daColle).toMatchObject({ continua: nuovo.continua, ordinataQui: false });
      // E nel successore si scrive.
      expect(
        colle.messaggi.depositaArchivio(carla, nuovo.id, unaVoce("m1", colle.orologio.adesso)),
      ).toEqual({ scritte: 1 });
    });
  });

  it("se nessun amministratore ha una casa viva trasloca un membro, e l'atto porta il suo nome", async () => {
    await treCase(async (aia, borgo, colle) => {
      // Amministra soltanto Anna, e la sua casa è quella persa.
      const { carla, conv } = await gruppo(aia, borgo, colle);
      spegniAia(aia, [borgo, colle]);
      passano(31, [borgo, colle]);

      expect((await colle.messaggi.getConversazione(carla, conv)).puoTraslocare).toBe(true);
      const { conversazione } = await colle.messaggi.trasloca(carla, conv, { epoch: 1 });
      expect(conversazione.continua?.da).toBe(`carla@${colle.chiave}`);
      expect(conversazione.ruoli?.[carla]).toBe("creatore");
    });
  });

  it("una casa che quel giorno risponde non è persa, qualunque cosa dica il registro", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { bruno, conv } = await gruppo(aia, borgo, colle);
      // Il registro di Borgo è fermo a un mese fa, ma Aia è accesa.
      borgo.contatti.set(aia.chiave, borgo.orologio.adesso);
      passano(31, [borgo, colle]);

      expect(await rifiuto(() => borgo.messaggi.trasloca(bruno, conv, { epoch: 1 }))).toBe(
        "casa_non_persa",
      );
      // Bussare è stato un contatto: il gesto non c'è più.
      expect((await borgo.messaggi.getConversazione(bruno, conv)).casaPersaDal).toBeUndefined();
      expect(borgo.messaggi.listConversazioni(bruno)).toHaveLength(1);
    });
  });

  it("chi quel giorno non ha una casa raggiungibile non entra nel successore", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { bruno, conv } = await gruppo(aia, borgo, colle);
      spegniAia(aia, [borgo, colle]);
      passano(31, [borgo, colle]);
      borgo.accese.delete(colle.chiave);

      // Con Bruno non resterebbe nessuno: non nasce un gruppo di una persona.
      expect(await rifiuto(() => borgo.messaggi.trasloca(bruno, conv, { epoch: 1 }))).toBe(
        "trasloco_senza_nessuno",
      );
      expect(borgo.messaggi.listConversazioni(bruno)).toHaveLength(1);
      expect((await borgo.messaggi.getConversazione(bruno, conv)).congelata).toBe(false);

      // Con qualcuno di qui sì, e Carla — casa spenta — resta fuori: la si
      // aggiunge a mano quando torna.
      const dino = borgo.abita("dino");
      borgo.repo.aggiungiMembro(conv, dino, "membro", borgo.orologio.adesso);
      const { conversazione: nuovo } = await borgo.messaggi.trasloca(bruno, conv, { epoch: 1 });
      expect(nuovo.membri.map((m) => m.username).sort()).toEqual(["bruno", "dino"]);

      borgo.accese.set(colle.chiave, colle);
      const { conversazione: conCarla } = await borgo.messaggi.aggiungiMembro(bruno, nuovo.id, {
        casa: colle.chiave,
        username: "carla",
      });
      expect(conCarla.membri.map((m) => m.username).sort()).toEqual(["bruno", "carla", "dino"]);
    });
  });

  it("due traslochi insieme danno due successori visibili, e nessuno dei due è impedito", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { anna, bruno, carla, conv } = await gruppo(aia, borgo, colle);
      for (const c of [borgo, colle]) {
        const nome = c === borgo ? "bruno" : "carla";
        await aia.messaggi.cambiaRuolo(anna, conv, `remote:${c.chiave}:${nome}`, "amministratore");
      }
      await quieta();
      spegniAia(aia, [borgo, colle]);
      passano(31, [borgo, colle]);
      colle.orologio.adesso = new Date(Date.parse(colle.orologio.adesso) + 60_000).toISOString();

      const [diBruno, diCarla] = await Promise.all([
        borgo.messaggi.trasloca(bruno, conv, { epoch: 2 }),
        colle.messaggi.trasloca(carla, conv, { epoch: 2 }),
      ]);
      await quieta();

      const attesi = [
        { da: `bruno@${borgo.chiave}`, id: diBruno.conversazione.id, il: borgo.orologio.adesso },
        { da: `carla@${colle.chiave}`, id: diCarla.conversazione.id, il: colle.orologio.adesso },
      ];
      for (const [c, chi] of [
        [borgo, bruno],
        [colle, carla],
      ] as const) {
        expect((await c.messaggi.getConversazione(chi, conv)).successori).toEqual(attesi);
        // Tre righe nell'elenco: il vecchio e i due successori.
        expect(
          c.messaggi
            .listConversazioni(chi)
            .map((x) => x.id)
            .sort(),
        ).toEqual([conv, ...attesi.map((a) => a.id)].sort());
      }
    });
  });

  it("una casa che vede ancora chi ordina sa del successore, ma non spegne la scrittura sulla parola di un'altra", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { bruno, carla, conv } = await gruppo(aia, borgo, colle);
      // Aia è irraggiungibile da Borgo; Colle la sente ancora.
      spegniAia(aia, [borgo]);
      passano(31, [borgo, colle]);
      colle.contatti.set(aia.chiave, colle.orologio.adesso);

      const { conversazione: nuovo } = await borgo.messaggi.trasloca(bruno, conv, { epoch: 1 });
      await quieta();

      const perCarla = await colle.messaggi.getConversazione(carla, conv);
      expect(perCarla).toMatchObject({ congelata: false, successori: [{ id: nuovo.id }] });
      expect(
        colle.messaggi.depositaArchivio(carla, conv, unaVoce("ancora", colle.orologio.adesso)),
      ).toEqual({ scritte: 1 });

      // Quando anche per Colle il silenzio supera la soglia, si congela anche lì.
      spegniAia(aia, [colle]);
      passano(31, [colle]);
      expect((await colle.messaggi.getConversazione(carla, conv)).congelata).toBe(true);
    });
  });

  it("una dichiarazione che non torna non marca niente", async () => {
    await treCase(async (aia, borgo, colle) => {
      const { carla, conv } = await gruppo(aia, borgo, colle);
      colle.abita("dora");
      spegniAia(aia, [borgo, colle]);
      passano(31, [borgo, colle]);

      const dichiara = (id: string, da: string, casaPersa: string): boolean =>
        colle.messaggi.riceviComposizione(id, borgo.chiave, {
          continua: {
            casaPersa,
            casaPersaDal: ORA,
            conversazione: conv,
            da,
            epoch: 1,
            il: colle.orologio.adesso,
            nome: "Cena di quartiere",
          },
          membri: [
            { chi: `bruno@${borgo.chiave}`, dal: ORA, ruolo: "creatore" },
            { chi: `carla@${colle.chiave}`, dal: ORA, ruolo: "membro" },
          ],
          nome: "Cena di quartiere",
          rimossi: [],
          tipo: "gruppo",
          versione: 1,
        });

      // Borgo firma un trasloco con il nome di una persona di Colle: non si scrive.
      expect(dichiara("finto-1", `carla@${colle.chiave}`, aia.chiave)).toBe(true);
      expect(colle.repo.traslocoDi("finto-1")).toBeUndefined();
      // Qualcuno di Borgo che nel gruppo non c'era, o una casa persa che non
      // è quella che lo ordinava: la dichiarazione resta sul successore, e il
      // gruppo di prima non ne sa niente.
      expect(dichiara("finto-2", `nessuno@${borgo.chiave}`, aia.chiave)).toBe(true);
      expect(dichiara("finto-3", `bruno@${borgo.chiave}`, "d0".repeat(32))).toBe(true);
      expect(colle.repo.traslocoDi("finto-2")).toBeDefined();

      const vecchio = await colle.messaggi.getConversazione(carla, conv);
      expect(vecchio.successori).toBeUndefined();
      expect(vecchio.congelata).toBe(false);
    });
  });
});
