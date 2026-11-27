import { loadConfig, type AppConfig } from "@estia/config";
import { withTempDataDir } from "@estia/testing";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { openDatabase } from "../db/database.js";
import type { SegnalazioneSulFilo } from "../federation/protocol.js";

import { SqliteSegnalazioniRepository } from "./repository.js";
import { SegnalazioniService, type ReteSegnalazioni } from "./service.js";

/**
 * Le segnalazioni si visitano, non circolano ([ADR 0047], forma in [ADR 0049]).
 *
 * Le proprietà che contano sono poche e vanno fissate qui: chi segnala non
 * esce mai di casa, si contano le istanze e non le persone, le categorie non
 * si mescolano, un avviso incompleto si dichiara tale, e niente di ciò che
 * dicono le altre case finisce sul disco.
 */

const X = "a".repeat(64);
const QUESTA = "f".repeat(64);
const SAMPIERDARENA = "1".repeat(64);
const VANCHIGLIA = "2".repeat(64);
const SPENTA = "3".repeat(64);

function reteFinta(
  risposte: Record<string, SegnalazioneSulFilo[] | "muta">,
  collegate: Array<{ publicKey: string; declaredName: string }>,
  replica: { testo: string; mese: string } | "nessuna" | "muta" = "nessuna",
): ReteSegnalazioni & { domande: number } {
  const rete = {
    chiaveDiQuesta: () => QUESTA,
    collegate: () => collegate,
    domande: 0,
    replicaPresso: async () =>
      replica === "nessuna"
        ? { esito: "nessuna" as const }
        : replica === "muta"
          ? { esito: "muta" as const }
          : { esito: "replica" as const, ...replica },
    segnalazioniPresso: async (target: string) => {
      rete.domande += 1;
      const risposta = risposte[target];

      return risposta === undefined || risposta === "muta"
        ? { esito: "muta" as const }
        : { esito: "risposta" as const, segnalazioni: risposta };
    },
  };

  return rete;
}

async function conServizio(
  rete: ReteSegnalazioni,
  use: (servizio: SegnalazioniService, utenti: { anna: string; marco: string }) => Promise<void>,
  now?: () => Date,
): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const database = openDatabase(dataDir);

    try {
      const crea = database.prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, created_at)
         VALUES (?, ?, ?, 'x', 'member', '2026-01-01T00:00:00.000Z')`,
      );
      crea.run("u-anna", "anna", "Anna");
      crea.run("u-marco", "marco", "Marco");
      for (const n of [1, 2, 3]) {
        crea.run(`u-${String(n)}`, `persona${String(n)}`, `Persona ${String(n)}`);
      }

      await use(
        new SegnalazioniService({
          repository: new SqliteSegnalazioniRepository(database),
          rete,
          ...(now === undefined ? {} : { now }),
        }),
        { anna: "u-anna", marco: "u-marco" },
      );
    } finally {
      database.close();
    }
  });
}

const membro = (id: string) => ({ id, role: "member" as const });

describe("chi segnala", () => {
  it("salva a casa propria, una per categoria, e ritira quando vuole", async () => {
    await conServizio(reteFinta({}, []), async (servizio, { anna }) => {
      servizio.segnala(membro(anna), { categoria: "non_autentica", istanza: X, motivo: "bot" });
      // Una seconda della stessa categoria sostituisce, non moltiplica.
      const seconda = servizio.segnala(membro(anna), {
        categoria: "non_autentica",
        istanza: X.toUpperCase(),
        motivo: "  account finti  ",
      });
      servizio.segnala(membro(anna), { categoria: "non_gradita", istanza: X, motivo: "insulti" });

      expect(servizio.mie(membro(anna)).map((s) => [s.categoria, s.motivo])).toEqual(
        expect.arrayContaining([
          ["non_autentica", "account finti"],
          ["non_gradita", "insulti"],
        ]),
      );
      expect(servizio.mie(membro(anna))).toHaveLength(2);

      servizio.ritira(membro(anna), seconda.id);

      expect(servizio.perLaRete(X).map((s) => s.categoria)).toEqual(["non_gradita"]);
    });
  });

  it("non ritira quella di un altro, e non dice che esiste", async () => {
    await conServizio(reteFinta({}, []), async (servizio, { anna, marco }) => {
      const sua = servizio.segnala(membro(anna), {
        categoria: "non_gradita",
        istanza: X,
        motivo: "insulti",
      });

      expect(() => servizio.ritira(membro(marco), sua.id)).toThrow(
        expect.objectContaining({ code: "segnalazione_inesistente" }),
      );
      expect(() => servizio.ritira(membro(marco), "non-esiste")).toThrow(
        expect.objectContaining({ code: "segnalazione_inesistente" }),
      );

      // Chi modera sì: il motivo è contenuto di questa casa, e ne risponde.
      servizio.ritira({ id: marco, role: "instance_moderator" }, sua.id);

      expect(servizio.perLaRete(X)).toEqual([]);
    });
  });

  it("rifiuta una chiave storta, la propria istanza e un motivo vuoto", async () => {
    await conServizio(reteFinta({}, []), async (servizio, { anna }) => {
      const prova =
        (istanza: string, motivo = "x", categoria = "non_gradita") =>
        () =>
          servizio.segnala(membro(anna), { categoria, istanza, motivo });

      expect(prova("non-una-chiave")).toThrow(
        expect.objectContaining({ code: "chiave_non_valida" }),
      );
      expect(prova(QUESTA)).toThrow(expect.objectContaining({ code: "segnalare_questa_istanza" }));
      expect(prova(X, "   ")).toThrow(expect.objectContaining({ code: "motivo_non_valido" }));
      expect(prova(X, "y".repeat(401))).toThrow(
        expect.objectContaining({ code: "motivo_non_valido" }),
      );
      expect(prova(X, "x", "generata_con_ai")).toThrow(
        expect.objectContaining({ code: "categoria_non_valida" }),
      );
    });
  });
});

describe("ciò che si risponde alle collegate", () => {
  it("non dice mai chi ha scritto, e la data è il mese", async () => {
    await conServizio(
      reteFinta({}, []),
      async (servizio, { anna }) => {
        servizio.segnala(membro(anna), { categoria: "non_autentica", istanza: X, motivo: "bot" });

        expect(servizio.perLaRete(X)).toEqual([
          { categoria: "non_autentica", mese: "2026-11", motivo: "bot" },
        ]);
      },
      () => new Date("2026-11-27T15:42:00.000Z"),
    );
  });

  it("tre motivi per categoria al massimo, i più recenti", async () => {
    let minuto = 0;

    await conServizio(
      reteFinta({}, []),
      async (servizio) => {
        // Cinque persone, una segnalazione ciascuna, un minuto dopo l'altra.
        for (const [id, motivo] of [
          ["u-anna", "primo"],
          ["u-marco", "secondo"],
          ["u-1", "terzo"],
          ["u-2", "quarto"],
          ["u-3", "quinto"],
        ] as const) {
          servizio.segnala(membro(id), { categoria: "non_gradita", istanza: X, motivo });
        }

        servizio.segnala(membro("u-anna"), {
          categoria: "non_autentica",
          istanza: X,
          motivo: "bot",
        });

        expect(servizio.perLaRete(X).map((s) => s.motivo)).toEqual([
          "bot",
          "quinto",
          "quarto",
          "terzo",
        ]);
      },
      () => new Date(Date.UTC(2026, 10, 27, 10, minuto++)),
    );
  });
});

describe("l'avviso", () => {
  it("conta le istanze, non le persone, e non mescola le categorie", async () => {
    const rete = reteFinta(
      {
        [SAMPIERDARENA]: [
          { categoria: "non_autentica", mese: "2026-10", motivo: "bot" },
          { categoria: "non_autentica", mese: "2026-10", motivo: "bot" },
          { categoria: "non_autentica", mese: "2026-09", motivo: "bot" },
          // Una quarta, oltre il tetto: chi risponde non diventa più forte.
          { categoria: "non_autentica", mese: "2026-08", motivo: "bot" },
        ],
        [VANCHIGLIA]: [{ categoria: "non_gradita", mese: "2026-11", motivo: "insulti" }],
      },
      [
        { declaredName: "Sampierdarena", publicKey: SAMPIERDARENA },
        { declaredName: "Vanchiglia", publicKey: VANCHIGLIA },
        { declaredName: "Spenta", publicKey: SPENTA },
      ],
    );

    await conServizio(rete, async (servizio) => {
      const avviso = await servizio.avviso(X);

      expect(avviso.interpellate).toBe(3);
      expect(avviso.senzaRisposta).toBe(1);
      expect(avviso.nonAutentica).toEqual([
        { motivi: expect.any(Array), tramite: "Sampierdarena" },
      ]);
      expect(avviso.nonAutentica[0]?.motivi).toHaveLength(3);
      expect(avviso.nonGradita).toEqual([
        { motivi: [{ mese: "2026-11", motivo: "insulti" }], tramite: "Vanchiglia" },
      ]);
      // X non è collegata a questa casa: la replica non si può visitare.
      expect(avviso.replica).toEqual({ stato: "non_disponibile" });
    });
  });

  it("visita la replica solo dove l'istanza segnalata è collegata, e non le chiede di sé", async () => {
    const rete = reteFinta(
      { [X]: [{ categoria: "non_gradita", mese: "2026-11", motivo: "di sé" }] },
      [{ declaredName: "X", publicKey: X }],
      { mese: "2026-11", testo: "Siamo un collettivo vero." },
    );

    await conServizio(rete, async (servizio) => {
      const avviso = await servizio.avviso(X);

      expect(rete.domande).toBe(0);
      expect(avviso.interpellate).toBe(0);
      expect(avviso.replica).toEqual({
        mese: "2026-11",
        stato: "disponibile",
        testo: "Siamo un collettivo vero.",
      });
    });
  });

  it("si tiene in memoria per poco, e poi richiede", async () => {
    let adesso = Date.UTC(2026, 10, 27);
    const rete = reteFinta({}, [{ declaredName: "Sampierdarena", publicKey: SAMPIERDARENA }]);

    await conServizio(
      rete,
      async (servizio) => {
        await servizio.avviso(X);
        await servizio.avviso(X);
        expect(rete.domande).toBe(1);

        adesso += 6 * 60_000;
        await servizio.avviso(X);
        expect(rete.domande).toBe(2);
      },
      () => new Date(adesso),
    );
  });

  it("ignorata dall'admin non si chiede per i membri, e lo si dice", async () => {
    const rete = reteFinta({}, [{ declaredName: "Sampierdarena", publicKey: SAMPIERDARENA }]);

    await conServizio(rete, async (servizio, { anna }) => {
      servizio.decidi({ id: anna, role: "instance_admin" }, { ignora: true, istanza: X, nota: "" });

      const perMembri = await servizio.avviso(X);

      expect(perMembri.ignorate).toBe(true);
      expect(rete.domande).toBe(0);

      // L'admin lo vede lo stesso: è lei che deve poter cambiare idea.
      const perAdmin = await servizio.avviso(X, true);

      expect(perAdmin.ignorate).toBe(true);
      expect(rete.domande).toBe(1);
    });
  });
});

// --- Le rotte ---------------------------------------------------------------

const SETUP_TOKEN = "token-di-prova";
const ADMIN = { password: "una-password-lunga", username: "palu" };

function configFor(dataDir: string): AppConfig {
  return loadConfig({
    ESTIA_DATA_DIR: dataDir,
    ESTIA_HOST: "127.0.0.1",
    ESTIA_LOG_LEVEL: "silent",
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function conCasa(
  use: (casa: {
    app: FastifyInstance;
    admin: string;
    anna: string;
    marco: string;
  }) => Promise<void>,
): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const app = await buildApp(configFor(dataDir), { setupToken: SETUP_TOKEN });

    try {
      await app.inject({
        method: "POST",
        payload: {
          adminPassword: ADMIN.password,
          adminUsername: ADMIN.username,
          name: "Via Roma",
          setupToken: SETUP_TOKEN,
        },
        url: "/api/v1/instance/setup",
      });

      const entra = async (username: string, password: string): Promise<string> =>
        (
          await app.inject({
            method: "POST",
            payload: { password, username },
            url: "/api/v1/auth/login",
          })
        ).json().token;

      for (const username of ["anna", "marco"]) {
        await app.identityService.createUser({
          password: "password-lunga-ok",
          role: "member",
          username,
        });
      }

      await use({
        admin: await entra(ADMIN.username, ADMIN.password),
        anna: await entra("anna", "password-lunga-ok"),
        app,
        marco: await entra("marco", "password-lunga-ok"),
      });
    } finally {
      await app.close();
    }
  });
}

describe("le rotte delle segnalazioni", () => {
  it("chi segnala vede le proprie, gli altri membri niente, chi modera tutto", async () => {
    await conCasa(async ({ admin, anna, app, marco }) => {
      const creata = await app.inject({
        headers: bearer(anna),
        method: "POST",
        payload: { categoria: "non_autentica", istanza: X, motivo: "bot" },
        url: "/api/v1/segnalazioni",
      });

      expect(creata.statusCode).toBe(201);
      expect(creata.json()).not.toHaveProperty("autore");

      const diMarco = await app.inject({
        headers: bearer(marco),
        url: "/api/v1/segnalazioni/mie",
      });

      expect(diMarco.json().segnalazioni).toEqual([]);

      const marcoTutte = await app.inject({ headers: bearer(marco), url: "/api/v1/segnalazioni" });

      expect(marcoTutte.statusCode).toBe(403);

      const tutte = await app.inject({ headers: bearer(admin), url: "/api/v1/segnalazioni" });

      expect(tutte.json().segnalazioni).toEqual([
        expect.objectContaining({ autore: "anna", categoria: "non_autentica", istanza: X }),
      ]);

      const ritiro = await app.inject({
        headers: bearer(anna),
        method: "DELETE",
        url: `/api/v1/segnalazioni/${String(creata.json().id)}`,
      });

      expect(ritiro.statusCode).toBe(204);
    });
  });

  it("l'avviso senza collegate è vuoto e lo dice", async () => {
    await conCasa(async ({ anna, app }) => {
      const avviso = await app.inject({
        headers: bearer(anna),
        url: `/api/v1/istanze/${X}/avviso`,
      });

      expect(avviso.statusCode).toBe(200);
      expect(avviso.json()).toEqual({
        ignorate: false,
        interpellate: 0,
        istanza: X,
        nonAutentica: [],
        nonGradita: [],
        replica: { stato: "non_disponibile" },
        senzaRisposta: 0,
      });
    });
  });

  it("verdetto e replica sono dell'admin", async () => {
    await conCasa(async ({ admin, anna, app }) => {
      const daMembro = await app.inject({
        headers: bearer(anna),
        method: "PUT",
        payload: { ignora: true, nota: "" },
        url: `/api/v1/verdetti/${X}`,
      });

      expect(daMembro.statusCode).toBe(403);

      const deciso = await app.inject({
        headers: bearer(admin),
        method: "PUT",
        payload: { ignora: true, nota: "Le conosco, sono a posto." },
        url: `/api/v1/verdetti/${X}`,
      });

      expect(deciso.json()).toMatchObject({ autore: "palu", ignora: true, istanza: X });

      const avvisoAdmin = await app.inject({
        headers: bearer(admin),
        url: `/api/v1/istanze/${X}/avviso`,
      });

      expect(avvisoAdmin.json().verdetto).toMatchObject({ nota: "Le conosco, sono a posto." });

      const avvisoMembro = await app.inject({
        headers: bearer(anna),
        url: `/api/v1/istanze/${X}/avviso`,
      });

      expect(avvisoMembro.json()).toMatchObject({ ignorate: true });
      expect(avvisoMembro.json()).not.toHaveProperty("verdetto");

      const replica = await app.inject({
        headers: bearer(admin),
        method: "PUT",
        payload: { testo: "Siamo un collettivo vero." },
        url: "/api/v1/segnalazioni/replica",
      });

      expect(replica.json().replica).toMatchObject({ testo: "Siamo un collettivo vero." });
    });
  });
});
