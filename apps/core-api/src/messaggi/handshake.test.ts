/**
 * Il canale di handshake MLS ([ADR 0038](../../../../docs/adr/0038-mls-si-adotta-e-si-comincia-dal-web.md) punto 4).
 *
 * I messaggi applicativi vanno per la loro strada; commit e Welcome sono
 * un'altra cosa. Un **commit** deve raggiungere tutti i membri; un **Welcome**
 * soltanto chi viene aggiunto — e chi viene aggiunto non è ancora nel gruppo
 * crittografico, quindi non potrebbe decifrare niente che passi dal canale dei
 * membri. È questa asimmetria che i test qui sotto difendono.
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type AppConfig } from "@estia/config";
import { withTempDataDir } from "@estia/testing";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";

const SETUP_TOKEN = "setup-token-handshake-test";
const ADMIN = { password: "password-valida-admin", username: "admin" };

function configFor(dataDir: string): AppConfig {
  return loadConfig({
    ESTIA_DATA_DIR: dataDir,
    ESTIA_HOST: "127.0.0.1",
    ESTIA_LOG_LEVEL: "silent",
  });
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

interface Rig {
  app: FastifyInstance;
  annaToken: string;
  brunoToken: string;
  brunoId: string;
  carlaToken: string;
  conversazioneId: string;
  dataDir: string;
}

async function withRig(use: (rig: Rig) => Promise<void>): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const app = await buildApp(configFor(dataDir), { setupToken: SETUP_TOKEN });

    try {
      await app.inject({
        method: "POST",
        payload: {
          adminPassword: ADMIN.password,
          adminUsername: ADMIN.username,
          name: "Casa Handshake",
          setupToken: SETUP_TOKEN,
        },
        url: "/api/v1/instance/setup",
      });

      const membro = async (username: string): Promise<{ token: string; id: string }> => {
        const password = `password-lunga-${username}`;
        const utente = await app.identityService.createUser({ password, role: "member", username });
        const login = await app.identityService.login({ password, username });
        await app.inject({
          headers: bearer(login.token),
          method: "POST",
          payload: { algorithm: "ECDSA-P256", publicKey: `pk_${username}` },
          url: "/api/v1/dispositivi/chiave",
        });
        return { id: utente.id, token: login.token };
      };

      const anna = await membro("anna");
      const bruno = await membro("bruno");
      const carla = await membro("carla");

      const conv = await app.inject({
        headers: bearer(anna.token),
        method: "POST",
        payload: { recipientUserId: bruno.id },
        url: "/api/v1/conversazioni",
      });

      await use({
        annaToken: anna.token,
        app,
        brunoId: bruno.id,
        brunoToken: bruno.token,
        carlaToken: carla.token,
        conversazioneId: conv.json().conversazione.id as string,
        dataDir,
      });
    } finally {
      await app.close();
    }
  });
}

const deposita = async (
  app: FastifyInstance,
  token: string,
  id: string,
  body: Record<string, unknown>,
) =>
  app.inject({
    headers: bearer(token),
    method: "POST",
    payload: body,
    url: `/api/v1/conversazioni/${id}/handshake`,
  });

const commit = (epoch: number, busta = `C${epoch}`): Record<string, unknown> => ({
  busta,
  epoch,
  tipo: "commit",
});

/** Porta la fila da `da` fino a `epoch`: i commit entrano uno alla volta, in ordine. */
const avanza = async (
  app: FastifyInstance,
  token: string,
  id: string,
  epoch: number,
  da = 1,
): Promise<void> => {
  for (let e = da; e <= epoch; e += 1) {
    expect((await deposita(app, token, id, commit(e))).statusCode).toBe(200);
  }
};

const leggi = async (app: FastifyInstance, token: string, id: string, query = "") =>
  app.inject({
    headers: bearer(token),
    method: "GET",
    url: `/api/v1/conversazioni/${id}/handshake${query}`,
  });

describe("il canale di handshake", () => {
  it("un commit raggiunge tutti i membri", async () => {
    await withRig(async ({ app, annaToken, brunoToken, conversazioneId }) => {
      const res = await deposita(app, annaToken, conversazioneId, {
        busta: "COMMIT_OPACO",
        epoch: 1,
        tipo: "commit",
      });
      expect(res.statusCode).toBe(200);

      for (const [chi, token] of [
        ["Anna", annaToken],
        ["Bruno", brunoToken],
      ] as const) {
        const pagina = (await leggi(app, token, conversazioneId)).json();
        expect({ chi, n: pagina.handshake.length }).toEqual({ chi, n: 1 });
        expect(pagina.handshake[0].busta).toBe("COMMIT_OPACO");
        expect(pagina.handshake[0].tipo).toBe("commit");
        expect(pagina.handshake[0].epoch).toBe(1);
      }
    });
  });

  it("un Welcome lo vede solo chi entra, non gli altri membri", async () => {
    await withRig(async ({ app, annaToken, brunoToken, brunoId, conversazioneId }) => {
      await avanza(app, annaToken, conversazioneId, 1);
      await deposita(app, annaToken, conversazioneId, {
        busta: "WELCOME_PER_BRUNO",
        destinatario: brunoId,
        epoch: 1,
        tipo: "welcome",
      });

      const perBruno = (await leggi(app, brunoToken, conversazioneId)).json();
      expect(perBruno.handshake.map((h: { busta: string }) => h.busta)).toEqual([
        "C1",
        "WELCOME_PER_BRUNO",
      ]);

      // Anna lo ha depositato, ma non è per lei: vede il commit e basta.
      const perAnna = (await leggi(app, annaToken, conversazioneId)).json();
      expect(perAnna.handshake.map((h: { busta: string }) => h.busta)).toEqual(["C1"]);
    });
  });

  it("un Welcome senza destinatario è rifiutato: sarebbe un invito a nessuno", async () => {
    await withRig(async ({ app, annaToken, conversazioneId }) => {
      const res = await deposita(app, annaToken, conversazioneId, {
        busta: "WELCOME",
        epoch: 1,
        tipo: "welcome",
      });

      expect(res.statusCode).toBe(400);
      expect((await leggi(app, annaToken, conversazioneId)).json().handshake).toHaveLength(0);
    });
  });

  it("un commit con destinatario è rifiutato: sarebbe un gruppo spaccato in silenzio", async () => {
    await withRig(async ({ app, annaToken, brunoId, conversazioneId }) => {
      const res = await deposita(app, annaToken, conversazioneId, {
        busta: "COMMIT",
        destinatario: brunoId,
        epoch: 1,
        tipo: "commit",
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // Tre commit depositati di fila cadono nello stesso millisecondo. Un cursore
  // fatto di tempo li perderebbe; uno fatto di tempo + id li restituirebbe in
  // ordine di UUID, cioe' a caso. MLS applica i commit in sequenza, quindi
  // l'ordine dev'essere quello di ARRIVO — ed e' quello che questo test difende.
  it("si legge in ordine di arrivo, e si riparte da dove si era rimasti", async () => {
    await withRig(async ({ app, annaToken, brunoToken, conversazioneId }) => {
      for (const n of [1, 2, 3]) {
        await deposita(app, annaToken, conversazioneId, {
          busta: `COMMIT_${String(n)}`,
          epoch: n,
          tipo: "commit",
        });
      }

      const prima = (await leggi(app, brunoToken, conversazioneId, "?limit=2")).json();
      expect(prima.handshake.map((h: { epoch: number }) => h.epoch)).toEqual([1, 2]);
      expect(prima.prossimo).toBeDefined();

      const dopo = (
        await leggi(
          app,
          brunoToken,
          conversazioneId,
          `?dopo=${encodeURIComponent(prima.prossimo as string)}`,
        )
      ).json();
      expect(dopo.handshake.map((h: { epoch: number }) => h.epoch)).toEqual([3]);
      expect(dopo.prossimo).toBeUndefined();
    });
  });

  it("chi non è della conversazione non legge e non deposita", async () => {
    await withRig(async ({ app, annaToken, carlaToken, conversazioneId }) => {
      await deposita(app, annaToken, conversazioneId, {
        busta: "COMMIT",
        epoch: 1,
        tipo: "commit",
      });

      expect((await leggi(app, carlaToken, conversazioneId)).statusCode).toBe(403);
      expect(
        (
          await deposita(app, carlaToken, conversazioneId, {
            busta: "MIO",
            epoch: 9,
            tipo: "commit",
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  it("senza sessione non si arriva al canale", async () => {
    await withRig(async ({ app, conversazioneId }) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/conversazioni/${conversazioneId}/handshake`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  it("un handshake oltre il tetto è rifiutato prima di toccare il disco", async () => {
    await withRig(async ({ app, annaToken, conversazioneId }) => {
      const res = await deposita(app, annaToken, conversazioneId, {
        busta: "A".repeat(256 * 1024 + 1),
        epoch: 1,
        tipo: "commit",
      });

      expect(res.statusCode).toBe(400);
      expect((await leggi(app, annaToken, conversazioneId)).json().handshake).toHaveLength(0);
    });
  });

  it("un tipo che non esiste non entra", async () => {
    await withRig(async ({ app, annaToken, conversazioneId }) => {
      const res = await deposita(app, annaToken, conversazioneId, {
        busta: "X",
        epoch: 1,
        tipo: "proposta-inventata",
      });

      expect(res.statusCode).toBe(400);
    });
  });
});

/**
 * La casa che mette in fila ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §2 e §3),
 * provata su un database vero.
 *
 * Due regole, e nessuna delle due si può verificare con un doppio: chi ordina è
 * scritto sulla riga della conversazione, e chi può depositare si decide
 * guardando i membri.
 */
describe("chi ordina, e chi può depositare nella sua coda", () => {
  it("una conversazione nata qui la ordina questa casa, e la coda è locale", async () => {
    await withRig(async ({ app, annaToken, conversazioneId }) => {
      const res = await deposita(app, annaToken, conversazioneId, {
        busta: "COMMIT_LOCALE",
        epoch: 1,
        tipo: "commit",
      });

      expect(res.statusCode).toBe(200);
      expect((await leggi(app, annaToken, conversazioneId)).json().handshake).toHaveLength(1);
    });
  });

  it("una casa che ha un membro dentro deposita; una che non ce l'ha, no", async () => {
    await withRig(async ({ app, conversazioneId }) => {
      const messaggi = app.messaggiService;

      // La conversazione del rig ha due membri locali: nessuna casa remota
      // dentro, quindi nessuna casa remota può depositare (§2).
      expect(
        messaggi.depositaHandshakeRemoto({
          busta: "COMMIT_OPACO",
          conversazioneId,
          createdAt: new Date().toISOString(),
          epoch: 1,
          id: "hs-remoto-1",
          remoteKey: "casa-che-non-partecipa",
          tipo: "commit",
        }),
      ).toBeUndefined();

      // Una conversazione che non esiste dà la stessa risposta: chi chiede non
      // impara da qui che cosa c'è su questa istanza.
      expect(
        messaggi.depositaHandshakeRemoto({
          busta: "COMMIT_OPACO",
          conversazioneId: "conv-che-non-esiste",
          createdAt: new Date().toISOString(),
          epoch: 1,
          id: "hs-remoto-2",
          remoteKey: "casa-che-non-partecipa",
          tipo: "commit",
        }),
      ).toBeUndefined();
    });
  });

  it("la coda di una casa porta i commit e soltanto i Welcome dei suoi", async () => {
    await withRig(async ({ app, annaToken, conversazioneId, dataDir }) => {
      const messaggi = app.messaggiService;

      // Una conversazione con dentro qualcuno di due case diverse.
      const conv = await app.inject({
        headers: bearer(annaToken),
        method: "POST",
        payload: { recipientUserId: "remote:casa-uno:bruno" },
        url: "/api/v1/conversazioni",
      });
      const id = (conv.json().conversazione?.id as string | undefined) ?? conversazioneId;

      // Carla, di un'altra casa ancora, è nella stessa conversazione: scritta
      // nel database, perché su `main` i gruppi non hanno ancora una rotta.
      const db = new DatabaseSync(path.join(dataDir, "estia.db"));
      db.prepare(
        `INSERT INTO conversazione_membri (conversazione_id, user_id, joined_at) VALUES (?, ?, ?)`,
      ).run(id, "remote:casa-due:carla", new Date().toISOString());
      db.close();

      await deposita(app, annaToken, id, { busta: "COMMIT", epoch: 1, tipo: "commit" });
      for (const [busta, destinatario] of [
        ["WELCOME_PER_UNO", "remote:casa-uno:bruno"],
        ["WELCOME_PER_DUE", "remote:casa-due:carla"],
      ] as const) {
        const res = await deposita(app, annaToken, id, {
          busta,
          destinatario,
          epoch: 1,
          tipo: "welcome",
        });
        expect(res.statusCode).toBe(200);
      }

      const perUno = messaggi.handshakeRemoti(id, "casa-uno");

      expect(perUno?.handshake.map((v) => v.busta)).toEqual(["COMMIT", "WELCOME_PER_UNO"]);
    });
  });

  it("se la conversazione è ordinata da un'altra casa, qui non si scrive niente", async () => {
    await withRig(async ({ app, annaToken }) => {
      // Una conversazione nata altrove: arriva con l'annuncio, e con esso la
      // casa che ordina (ADR 0042 §3).
      app.messaggiService.useChiPuoScrivere({ puoAprire: () => true });
      const consegna = app.messaggiService.riceviSegnapostiSpinti({
        conversazioneId: "conv-nata-altrove",
        da: "matteo",
        destinatari: ["anna"],
        remoteKey: "casa-dove-e-nata",
        voci: [],
      });

      expect(consegna).toBe(true);

      // Questa casa non la ordina: non serve la coda di nessun altro, e il
      // deposito remoto si rifiuta invece di aprire una seconda fila.
      expect(
        app.messaggiService.depositaHandshakeRemoto({
          busta: "COMMIT_OPACO",
          conversazioneId: "conv-nata-altrove",
          createdAt: new Date().toISOString(),
          epoch: 1,
          id: "hs-3",
          remoteKey: "casa-dove-e-nata",
          tipo: "commit",
        }),
      ).toBeUndefined();

      // E un membro di qui, che chiede la coda, si sente dire che la casa che
      // ordina non risponde — non un elenco vuoto, che vorrebbe dire «non è
      // successo niente».
      const letta = await leggi(app, annaToken, "conv-nata-altrove");

      expect(letta.statusCode).toBe(503);
      expect(letta.json().error?.code ?? letta.json().code).toBe(
        "casa_che_ordina_non_raggiungibile",
      );
    });
  });
});

/**
 * `GroupInfo` e mazzo presso chi ordina, su un database vero (ADR 0042 §4 e
 * decisione 5 delle risposte del proprietario).
 */
describe("lo stato da cui si rientra sta dove si ordina", () => {
  it("una casa con un membro dentro deposita e rilegge; una senza, no", async () => {
    await withRig(async ({ app, annaToken }) => {
      const conv = await app.inject({
        headers: bearer(annaToken),
        method: "POST",
        payload: { recipientUserId: "remote:casa-uno:bruno" },
        url: "/api/v1/conversazioni",
      });
      const id = conv.json().conversazione.id as string;
      const messaggi = app.messaggiService;
      await avanza(app, annaToken, id, 2);

      expect(
        messaggi.depositaStatoRemoto(id, "casa-uno", "group-info", { blob: "GI", epoch: 2 }),
      ).toEqual({ updatedAt: expect.any(String) });
      expect(messaggi.statoRemoto(id, "casa-uno", "group-info")).toMatchObject({
        blob: "GI",
        epoch: 2,
      });

      // Una casa senza membri dentro: un rifiuto solo, e nessuna scrittura.
      expect(
        messaggi.depositaStatoRemoto(id, "casa-estranea", "group-info", { blob: "X", epoch: 9 }),
      ).toBe("rifiutato");
      expect(messaggi.statoRemoto(id, "casa-uno", "group-info")).toMatchObject({ epoch: 2 });

      // E l'epoch è quella della fila anche se chi deposita è una casa: non
      // torna indietro, e non salta avanti.
      await avanza(app, annaToken, id, 4, 3);
      expect(
        messaggi.depositaStatoRemoto(id, "casa-uno", "mazzo", { blob: "M4", epoch: 4 }),
      ).toEqual({ updatedAt: expect.any(String) });
      expect(messaggi.depositaStatoRemoto(id, "casa-uno", "mazzo", { blob: "M1", epoch: 1 })).toBe(
        "indietro",
      );
      expect(
        messaggi.depositaStatoRemoto(id, "casa-uno", "mazzo", { blob: "M9", epoch: 2 ** 53 - 1 }),
      ).toBe("indietro");
      expect(messaggi.statoRemoto(id, "casa-uno", "mazzo")).toMatchObject({ blob: "M4", epoch: 4 });
    });
  });

  it("se ordina un'altra casa, qui non si conserva niente e si dice che non risponde", async () => {
    await withRig(async ({ app, annaToken }) => {
      app.messaggiService.useChiPuoScrivere({ puoAprire: () => true });
      app.messaggiService.riceviSegnapostiSpinti({
        conversazioneId: "conv-nata-altrove",
        da: "matteo",
        destinatari: ["anna"],
        remoteKey: "casa-dove-e-nata",
        voci: [],
      });

      const deposito = await app.inject({
        headers: bearer(annaToken),
        method: "PUT",
        payload: { epoch: 3, groupInfo: "GI_EPOCH_3" },
        url: "/api/v1/conversazioni/conv-nata-altrove/group-info",
      });

      // La casa che ordina non risponde: il deposito fallisce in modo
      // dichiarato, e **non** si ripiega su una copia qui.
      expect(deposito.statusCode).toBe(503);
      expect(
        app.messaggiService.statoRemoto("conv-nata-altrove", "casa-dove-e-nata", "group-info"),
      ).toBe("rifiutato");

      const lettura = await app.inject({
        headers: bearer(annaToken),
        method: "GET",
        url: "/api/v1/conversazioni/conv-nata-altrove/archivio/chiavi",
      });

      expect(lettura.statusCode).toBe(503);
    });
  });
});

/**
 * La corsa di [ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §3:
 * due commit che creano la stessa epoch. La fila ne accetta uno e rifiuta
 * l'altro, e chi l'ha scritto lo rifà sull'epoch nuova — un fallimento visibile
 * e ripetibile invece di due alberi che divergono in silenzio.
 *
 * La verifica 2 di quell'ADR vuole anche due istanze vere; questa è la regola,
 * provata sul database che la applica.
 */
describe("la corsa fra due commit", () => {
  it("il secondo commit alla stessa epoch si rifiuta, e chi l'ha scritto lo sa", async () => {
    await withRig(async ({ app, annaToken, brunoToken, conversazioneId }) => {
      await avanza(app, annaToken, conversazioneId, 4);
      const primo = await deposita(app, annaToken, conversazioneId, {
        busta: "COMMIT_DI_ANNA",
        epoch: 5,
        tipo: "commit",
      });
      const secondo = await deposita(app, brunoToken, conversazioneId, {
        busta: "COMMIT_DI_BRUNO",
        epoch: 5,
        tipo: "commit",
      });

      expect(primo.statusCode).toBe(200);
      expect(secondo.statusCode).toBe(409);

      // Nella fila c'è un commit solo per quell'epoch: tutti applicano lo stesso.
      const coda = (await leggi(app, brunoToken, conversazioneId)).json().handshake as {
        busta: string;
      }[];
      expect(coda.map((v) => v.busta)).toEqual(["C1", "C2", "C3", "C4", "COMMIT_DI_ANNA"]);

      // Rifatto sull'epoch nuova, entra.
      const rifatto = await deposita(app, brunoToken, conversazioneId, {
        busta: "COMMIT_DI_BRUNO_RIFATTO",
        epoch: 6,
        tipo: "commit",
      });
      expect(rifatto.statusCode).toBe(200);
    });
  });

  it("un commit più vecchio dell'ultimo in fila non entra", async () => {
    await withRig(async ({ app, annaToken, conversazioneId }) => {
      await avanza(app, annaToken, conversazioneId, 7);

      const vecchio = await deposita(app, annaToken, conversazioneId, {
        busta: "C6",
        epoch: 6,
        tipo: "commit",
      });

      expect(vecchio.statusCode).toBe(409);
    });
  });

  it("un commit entra solo all'epoch che segue l'ultima: non si salta in avanti", async () => {
    // Il difetto del 2026-11-27: bastava un'epoch più alta di tutte, e un
    // membro che dichiarava 2^53 chiudeva la fila per sempre — nessun commit
    // vero sarebbe più stato più alto del suo.
    await withRig(async ({ app, annaToken, brunoToken, conversazioneId }) => {
      // La prima epoch che un commit crea è la 1.
      for (const epoch of [0, 2, 2 ** 53 - 1]) {
        const res = await deposita(app, brunoToken, conversazioneId, commit(epoch, "SALTO"));
        expect({ epoch, stato: res.statusCode }).toEqual({ epoch, stato: 409 });
        expect(res.json().code).toBe("conflict");
      }

      await avanza(app, annaToken, conversazioneId, 3);

      for (const epoch of [5, 9_007_199_254_740_991]) {
        const res = await deposita(app, brunoToken, conversazioneId, commit(epoch, "SALTO"));
        expect({ epoch, stato: res.statusCode }).toEqual({ epoch, stato: 409 });
      }

      // E dopo il tentativo il gruppo va avanti come prima.
      expect((await deposita(app, annaToken, conversazioneId, commit(4))).statusCode).toBe(200);
      const coda = (await leggi(app, annaToken, conversazioneId)).json().handshake as {
        busta: string;
      }[];
      expect(coda.map((v) => v.busta)).toEqual(["C1", "C2", "C3", "C4"]);
    });
  });

  it("il salto si rifiuta anche quando arriva da un'altra casa", async () => {
    await withRig(async ({ app, annaToken }) => {
      const conv = await app.inject({
        headers: bearer(annaToken),
        method: "POST",
        payload: { recipientUserId: "remote:casa-uno:bruno" },
        url: "/api/v1/conversazioni",
      });
      const id = conv.json().conversazione.id as string;
      await avanza(app, annaToken, id, 1);

      const remoto = (epoch: number): unknown =>
        app.messaggiService.depositaHandshakeRemoto({
          busta: "COMMIT_REMOTO",
          conversazioneId: id,
          createdAt: new Date().toISOString(),
          epoch,
          id: `hs-${epoch}`,
          remoteKey: "casa-uno",
          tipo: "commit",
        });

      expect(remoto(2 ** 53 - 1)).toBe("indietro");
      expect(remoto(3)).toBe("indietro");
      expect(remoto(2)).toEqual({ id: expect.any(String) });
      expect((await deposita(app, annaToken, id, commit(3))).statusCode).toBe(200);
    });
  });

  it("la stessa regola vale per il commit che arriva da un'altra casa", async () => {
    await withRig(async ({ app, annaToken }) => {
      const conv = await app.inject({
        headers: bearer(annaToken),
        method: "POST",
        payload: { recipientUserId: "remote:casa-uno:bruno" },
        url: "/api/v1/conversazioni",
      });
      const id = conv.json().conversazione.id as string;

      await avanza(app, annaToken, id, 2);
      await deposita(app, annaToken, id, { busta: "COMMIT_LOCALE", epoch: 3, tipo: "commit" });

      // Bruno, dall'altra casa, ha committato sulla stessa epoch: arriva
      // secondo, e la casa che ordina lo rimanda indietro.
      expect(
        app.messaggiService.depositaHandshakeRemoto({
          busta: "COMMIT_REMOTO",
          conversazioneId: id,
          createdAt: new Date().toISOString(),
          epoch: 3,
          id: "hs-remoto",
          remoteKey: "casa-uno",
          tipo: "commit",
        }),
      ).toBe("indietro");
    });
  });

  it("i Welcome non concorrono: stanno con il loro commit", async () => {
    // Un commit e il suo Welcome portano la stessa epoch, ed è giusto così: il
    // controllo riguarda solo chi cambia il gruppo, non chi ci entra.
    await withRig(async ({ app, annaToken, brunoId, conversazioneId }) => {
      await avanza(app, annaToken, conversazioneId, 2);
      const welcome = await deposita(app, annaToken, conversazioneId, {
        busta: "W",
        destinatario: brunoId,
        epoch: 2,
        tipo: "welcome",
      });

      expect(welcome.statusCode).toBe(200);
    });
  });
});

describe("il cursore della coda", () => {
  it("un cursore dato come id dell'ultimo handshake riparte da lì, non da capo", async () => {
    // Il client ricorda l'id dell'ultimo handshake applicato. Prima diventava
    // NaN, cioè zero, e ogni giro rimandava tutta la coda.
    await withRig(async ({ app, annaToken, conversazioneId }) => {
      await deposita(app, annaToken, conversazioneId, { busta: "C1", epoch: 1, tipo: "commit" });
      await deposita(app, annaToken, conversazioneId, { busta: "C2", epoch: 2, tipo: "commit" });

      const tutta = (await leggi(app, annaToken, conversazioneId)).json().handshake as {
        id: string;
        busta: string;
      }[];
      const primo = tutta[0]!.id;

      const dopo = (await leggi(app, annaToken, conversazioneId, `?dopo=${primo}`)).json()
        .handshake as { busta: string }[];

      expect(dopo.map((h) => h.busta)).toEqual(["C2"]);
    });
  });
});
