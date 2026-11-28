import { randomBytes } from "node:crypto";

import { loadConfig, type AppConfig } from "@estia/config";
import {
  ALPN_DISPOSITIVO,
  ALPN_INGRESSO,
  INGRESSO_DURATA_MS,
  codificaFrame,
  decodificaFrame,
  leggiQrDiIngresso,
  leggiQrDiInvito,
  type EsitoDiIngresso,
  type IngressoEmessoView,
  type RispostaSuStream,
} from "@estia/contracts";
import { withTempDataDir } from "@estia/testing";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { InstanceEndpoint, type IrohConnection } from "../federation/endpoint.js";
import { INTESTAZIONE_CANALE } from "./canale.js";

/**
 * L'accesso del Dispositivo (ADR 0044 §4–§5) su iroh vero, in `local`.
 *
 * La Casa è l'app intera, con la rete accesa; il Dispositivo è un endpoint con
 * una chiave sua e nessun servizio, che è quello che sarà l'app. In `local`
 * non c'è scoperta, quindi il Dispositivo arriva con il ticket che il QR porta
 * proprio per questo caso.
 */

const SETUP_TOKEN = "setup-token-accesso-test";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function configFor(dataDir: string, probe: "local" | "off"): AppConfig {
  return loadConfig({
    ESTIA_DATA_DIR: dataDir,
    ESTIA_HOST: "127.0.0.1",
    ESTIA_LOG_LEVEL: "silent",
    ESTIA_NETWORK_PROBE: probe,
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface Rig {
  app: FastifyInstance;
  /** Sposta in avanti l'orologio della Casa. */
  avanza: (ms: number) => void;
  alice: string;
  bob: string;
  dispositivo: () => Promise<InstanceEndpoint>;
}

async function conLaCasa(
  use: (rig: Rig) => Promise<void>,
  probe: "local" | "off" = "local",
): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    let scarto = 0;
    const app = await buildApp(configFor(dataDir, probe), {
      now: () => new Date(Date.now() + scarto),
      setupToken: SETUP_TOKEN,
    });
    const dispositivi: InstanceEndpoint[] = [];

    try {
      await app.inject({
        method: "POST",
        payload: {
          adminPassword: "password-valida-123",
          adminUsername: "admin",
          name: "Casa di prova",
          setupToken: SETUP_TOKEN,
        },
        url: "/api/v1/instance/setup",
      });

      for (const username of ["alice", "bob"]) {
        await app.identityService.createUser({
          password: `password-lunga-${username}`,
          role: "member",
          username,
        });
      }

      const alice = await app.identityService.login({
        password: "password-lunga-alice",
        username: "alice",
      });
      const bob = await app.identityService.login({
        password: "password-lunga-bob",
        username: "bob",
      });

      await use({
        alice: alice.token,
        app,
        avanza: (ms) => {
          scarto += ms;
        },
        bob: bob.token,
        dispositivo: async () => {
          const endpoint = new InstanceEndpoint(new Uint8Array(randomBytes(32)));
          await endpoint.open("local");
          dispositivi.push(endpoint);
          return endpoint;
        },
      });
    } finally {
      for (const endpoint of dispositivi) {
        await endpoint.close();
      }
      await app.close();
    }
  });
}

async function emetti(app: FastifyInstance, token: string): Promise<IngressoEmessoView> {
  const risposta = await app.inject({
    headers: bearer(token),
    method: "POST",
    url: "/api/v1/dispositivi/ingressi",
  });

  expect(risposta.statusCode).toBe(200);

  return risposta.json<IngressoEmessoView>();
}

/** Bussa su `estia/ingresso/1`. `undefined` vuol dire: non ha ricevuto niente. */
async function entra(
  dispositivo: InstanceEndpoint,
  ticket: string,
  domanda: unknown,
): Promise<EsitoDiIngresso | undefined> {
  try {
    const connessione = await dispositivo.connect(ticket, ALPN_INGRESSO);
    const stream = await connessione.openBi();
    await stream.send.writeAll(Array.from(encoder.encode(JSON.stringify(domanda))));
    await stream.send.finish();
    const bytes = await stream.recv.readToEnd(4096);
    connessione.close(0n, []);

    return bytes.length === 0
      ? undefined
      : (JSON.parse(decoder.decode(Uint8Array.from(bytes))) as EsitoDiIngresso);
  } catch {
    return undefined;
  }
}

async function chiedi(
  connessione: IrohConnection,
  metodo: string,
  percorso: string,
  opzioni: { intestazioni?: Record<string, string>; corpo?: unknown } = {},
): Promise<{ stato: number; intestazioni: Record<string, string>; json: () => unknown }> {
  const stream = await connessione.openBi();
  const corpo =
    opzioni.corpo === undefined ? undefined : encoder.encode(JSON.stringify(opzioni.corpo));
  const intestazioni = {
    ...(corpo === undefined ? {} : { "content-type": "application/json" }),
    ...opzioni.intestazioni,
  };

  await stream.send.writeAll(Array.from(codificaFrame({ intestazioni, metodo, percorso }, corpo)));
  await stream.send.finish();

  const frame = decodificaFrame(Uint8Array.from(await stream.recv.readToEnd(1024 * 1024)));
  const testa = frame.intestazione as RispostaSuStream;

  return {
    intestazioni: testa.intestazioni,
    json: () => JSON.parse(decoder.decode(frame.corpo)) as unknown,
    stato: testa.stato,
  };
}

/** Un Dispositivo di `token`, già entrato, con la sua connessione all'API. */
async function dispositivoDi(rig: Rig, token: string, etichetta: string) {
  const dispositivo = await rig.dispositivo();
  const ingresso = await emetti(rig.app, token);
  const esito = await entra(dispositivo, ingresso.ticket ?? "", {
    codice: ingresso.codice,
    etichetta,
  });

  expect(esito?.esito).toBe("ammesso");

  const connessione = await dispositivo.connect(ingresso.ticket ?? "", ALPN_DISPOSITIVO);

  return { connessione, dispositivo, esito: esito!, ingresso };
}

describe("l'accesso del Dispositivo (ADR 0044)", () => {
  it("dal QR all'API dei membri, sullo stream", async () => {
    await conLaCasa(async (rig) => {
      const ingresso = await emetti(rig.app, rig.alice);

      // Il QR porta la chiave della Casa, il codice, e in `local` il ticket.
      expect(leggiQrDiIngresso(ingresso.qr)).toEqual({
        casa: ingresso.casa,
        codice: ingresso.codice,
        ticket: ingresso.ticket,
      });
      expect(ingresso.casa.length).toBeGreaterThan(0);

      const { connessione, esito } = await dispositivoDi(rig, rig.alice, "iPhone di Alice");

      expect(esito.utente.username).toBe("alice");

      const me = await chiedi(connessione, "GET", "/api/v1/auth/me");

      expect(me.stato).toBe(200);

      // Lo stato della connessione dice da dove si è entrati davvero: non
      // «loopback», che è l'indirizzo finto dell'inject.
      const connessioneVista = await chiedi(connessione, "GET", "/api/v1/connection");
      expect(connessioneVista.json()).toMatchObject({ origin: "dispositivo" });
      expect(me.intestazioni["content-type"]).toContain("application/json");
      expect(me.json()).toMatchObject({ username: "alice" });

      // Una scrittura, con un corpo, per la stessa strada.
      const post = await chiedi(connessione, "POST", "/api/v1/posts", {
        corpo: { body: "scritto da Milano" },
      });

      expect(post.stato).toBe(201);

      // La sessione dell'app compare fra quelle di Alice, con la sua chiave.
      const sessioni = await rig.app.inject({
        headers: bearer(rig.alice),
        method: "GET",
        url: "/api/v1/auth/sessions",
      });
      const app = (
        sessioni.json() as {
          sessions: { id: string; deviceLabel: string; chiaveDiRete?: string }[];
        }
      ).sessions.find((s) => s.id === esito.sessionId);

      expect(app?.deviceLabel).toBe("iPhone di Alice");
      expect(app?.chiaveDiRete).toBeDefined();
    });
  });

  it("una chiave sconosciuta non riceve niente", async () => {
    await conLaCasa(async (rig) => {
      const ingresso = await emetti(rig.app, rig.alice);
      const estraneo = await rig.dispositivo();

      expect(ingresso.ticket).toBeDefined();

      // La connessione si apre — QUIC non sa ancora chi sei — e poi non porta
      // niente: nessuno stato, nessun corpo, nessun errore leggibile.
      const connessione = await estraneo.connect(ingresso.ticket ?? "", ALPN_DISPOSITIVO);

      await expect(chiedi(connessione, "GET", "/api/v1/auth/me")).rejects.toBeDefined();

      // Lo stesso endpoint, con lo stesso ticket, entra appena ha un codice:
      // il rifiuto di prima era per la chiave, non per la strada.
      const nuovo = await emetti(rig.app, rig.alice);
      expect(
        (await entra(estraneo, nuovo.ticket ?? "", { codice: nuovo.codice, etichetta: "PC" }))
          ?.esito,
      ).toBe("ammesso");
      const dentro = await estraneo.connect(nuovo.ticket ?? "", ALPN_DISPOSITIVO);
      expect((await chiedi(dentro, "GET", "/api/v1/auth/me")).stato).toBe(200);
    });
  });

  it("un codice sbagliato, scaduto o già usato non riceve niente", async () => {
    await conLaCasa(async (rig) => {
      const ingresso = await emetti(rig.app, rig.alice);
      const primo = await rig.dispositivo();
      const secondo = await rig.dispositivo();
      const ticket = ingresso.ticket ?? "";

      expect(await entra(primo, ticket, { codice: "inventato", etichetta: "x" })).toBeUndefined();
      expect(await entra(primo, ticket, { etichetta: "senza codice" })).toBeUndefined();
      expect(await entra(primo, ticket, "non un oggetto")).toBeUndefined();

      expect(
        (await entra(primo, ticket, { codice: ingresso.codice, etichetta: "Telefono" }))?.esito,
      ).toBe("ammesso");

      // Monouso: lo stesso codice non fa entrare una seconda chiave.
      expect(
        await entra(secondo, ticket, { codice: ingresso.codice, etichetta: "Altro" }),
      ).toBeUndefined();
    });
  });

  it("un codice scaduto non riceve niente", async () => {
    await conLaCasa(async (rig) => {
      const ingresso = await emetti(rig.app, rig.alice);
      const dispositivo = await rig.dispositivo();

      rig.avanza(INGRESSO_DURATA_MS + 1000);

      expect(
        await entra(dispositivo, ingresso.ticket ?? "", {
          codice: ingresso.codice,
          etichetta: "Tardi",
        }),
      ).toBeUndefined();
    });
  });

  it("due chiavi con lo stesso codice nello stesso istante: ne entra una", async () => {
    await conLaCasa(async (rig) => {
      const ingresso = await emetti(rig.app, rig.alice);
      const chiavi = await Promise.all([1, 2, 3].map(() => rig.dispositivo()));
      const esiti = await Promise.all(
        chiavi.map((chiave) =>
          entra(chiave, ingresso.ticket ?? "", { codice: ingresso.codice, etichetta: "x" }),
        ),
      );

      expect(esiti.filter((esito) => esito?.esito === "ammesso")).toHaveLength(1);
    });
  });

  it("due dispositivi della stessa persona, e la revoca di uno lascia l'altro", async () => {
    await conLaCasa(async (rig) => {
      const telefono = await dispositivoDi(rig, rig.alice, "Telefono");
      const pc = await dispositivoDi(rig, rig.alice, "PC");

      expect((await chiedi(telefono.connessione, "GET", "/api/v1/auth/me")).stato).toBe(200);
      expect((await chiedi(pc.connessione, "GET", "/api/v1/auth/me")).stato).toBe(200);

      // Alice toglie il telefono dal browser di casa.
      const revoca = await rig.app.inject({
        headers: bearer(rig.alice),
        method: "DELETE",
        url: `/api/v1/auth/sessions/${telefono.esito.sessionId}`,
      });

      expect(revoca.statusCode).toBeLessThan(300);

      // Sulla connessione già aperta: dalla richiesta dopo, niente.
      await expect(chiedi(telefono.connessione, "GET", "/api/v1/auth/me")).rejects.toBeDefined();

      // E nemmeno ricollegandosi.
      await expect(
        (async () => {
          const di_nuovo = await telefono.dispositivo.connect(
            telefono.ingresso.ticket ?? "",
            ALPN_DISPOSITIVO,
          );
          return chiedi(di_nuovo, "GET", "/api/v1/auth/me");
        })(),
      ).rejects.toBeDefined();

      // Il PC continua.
      expect((await chiedi(pc.connessione, "GET", "/api/v1/auth/me")).stato).toBe(200);
    });
  });

  it("l'identità la decide la chiave, non un'intestazione", async () => {
    await conLaCasa(async (rig) => {
      const { connessione } = await dispositivoDi(rig, rig.alice, "Telefono");

      // Il token di Bob, mandato dal dispositivo di Alice, non conta.
      const me = await chiedi(connessione, "GET", "/api/v1/auth/me", {
        intestazioni: bearer(rig.bob),
      });

      expect(me.json()).toMatchObject({ username: "alice" });

      // Nemmeno un cookie, né un contrassegno del canale inventato, mandati
      // dallo stream: la Casa li scarta prima di iniettare.
      const conAltro = await chiedi(connessione, "GET", "/api/v1/auth/me", {
        intestazioni: {
          Cookie: "sessione=qualcosa",
          [INTESTAZIONE_CANALE.toUpperCase()]: "inventato",
        },
      });

      expect(conAltro.stato).toBe(200);
      expect(conAltro.json()).toMatchObject({ username: "alice" });

      // E il contrassegno del canale, falsificato via HTTP, non apre niente.
      const falso = await rig.app.inject({
        headers: { [INTESTAZIONE_CANALE]: `inventato.${"0".repeat(8)}.chiave` },
        method: "GET",
        url: "/api/v1/auth/me",
      });

      expect(falso.statusCode).toBe(401);
    });
  });

  it("solo l'API, e un frame malformato riceve un errore leggibile", async () => {
    await conLaCasa(async (rig) => {
      const { connessione } = await dispositivoDi(rig, rig.alice, "Telefono");

      for (const percorso of [
        "/health/live",
        "/openapi.json",
        "/api/../health/live",
        "/api/%2e%2e/health/live",
        "/api/.%2E/openapi.json",
        "/api/./v1/auth/me",
        "/api\\..\\health/live",
        "//api/v1/auth/me",
        "/api/v1/auth/me#frammento",
      ]) {
        const risposta = await chiedi(connessione, "GET", percorso);
        expect(risposta.stato).toBe(400);
        expect(risposta.json()).toMatchObject({ code: "richiesta_su_stream_non_valida" });
      }

      const stream = await connessione.openBi();
      await stream.send.writeAll([0, 0, 0, 200, 1, 2]);
      await stream.send.finish();
      const frame = decodificaFrame(Uint8Array.from(await stream.recv.readToEnd(65536)));

      expect((frame.intestazione as RispostaSuStream).stato).toBe(400);
    });
  });

  it("a rete spenta non si emette un QR", async () => {
    await conLaCasa(async (rig) => {
      const risposta = await rig.app.inject({
        headers: bearer(rig.alice),
        method: "POST",
        url: "/api/v1/dispositivi/ingressi",
      });

      expect(risposta.statusCode).toBe(409);
      expect(risposta.json()).toMatchObject({ code: "rete_spenta" });
    }, "off");
  });
});

describe("l'ingresso con invito, dall'app", () => {
  async function invito(
    app: FastifyInstance,
  ): Promise<{ admin: string; codice: string; qr: string }> {
    const admin = (
      await app.identityService.login({ password: "password-valida-123", username: "admin" })
    ).token;
    const creato = await app.inject({
      headers: bearer(admin),
      method: "POST",
      payload: { maxUses: 1 },
      url: "/api/v1/admin/invites",
    });
    expect(creato.statusCode).toBe(201);
    const { code, qr } = creato.json<{ code: string; qr?: string }>();
    expect(qr).toBeDefined();

    return { admin, codice: code, qr: qr! };
  }

  const domanda = (codice: string, username: string) => ({
    etichetta: `Telefono di ${username}`,
    invito: {
      codice,
      message: "sono del secondo piano",
      password: `password-lunga-${username}`,
      username,
    },
  });

  it("la chiave che chiede è quella che entra, quando l'amministratore dice di sì", async () => {
    await conLaCasa(async (rig) => {
      const { admin, codice, qr } = await invito(rig.app);
      const letto = leggiQrDiInvito(qr);
      expect(letto?.codice).toBe(codice);
      const ticket = letto?.ticket ?? "";

      const telefono = await rig.dispositivo();
      const esito = (await entra(telefono, ticket, domanda(codice, "carla"))) as unknown as {
        esito: string;
        richiestaId: string;
      };
      expect(esito.esito).toBe("richiesta");

      // Finché nessuno decide, la chiave non apre niente.
      const prima = await telefono.connect(ticket, ALPN_DISPOSITIVO);
      await expect(chiedi(prima, "GET", "/api/v1/auth/me")).rejects.toBeDefined();

      // Un invito che vale riceve la ragione del no, come via HTTP.
      const altro = await rig.dispositivo();
      expect(await entra(altro, ticket, domanda(codice, "carla"))).toEqual({
        codice: "username_taken",
        esito: "rifiutata",
      });
      // Uno inventato non riceve niente.
      expect(await entra(altro, ticket, domanda("NON-ESISTE-1234", "dario"))).toBeUndefined();

      const approvata = await rig.app.inject({
        headers: bearer(admin),
        method: "POST",
        url: `/api/v1/admin/join-requests/${esito.richiestaId}/approve`,
      });
      expect(approvata.statusCode).toBe(200);

      const dentro = await telefono.connect(ticket, ALPN_DISPOSITIVO);
      const me = await chiedi(dentro, "GET", "/api/v1/auth/me");
      expect(me.stato).toBe(200);
      expect(me.json()).toMatchObject({ username: "carla" });

      const sessioni = (await chiedi(dentro, "GET", "/api/v1/auth/sessions")).json() as {
        sessions: { label?: string; chiaveDiRete?: string }[];
      };
      expect(sessioni.sessions).toHaveLength(1);
      expect(sessioni.sessions[0]?.chiaveDiRete).toBeDefined();

      // E la stessa persona entra anche con la password, come chiunque.
      const login = await rig.app.identityService.login({
        password: "password-lunga-carla",
        username: "carla",
      });
      expect(login.token).toBeDefined();
    });
  });

  it("una richiesta rifiutata non apre niente, e a rete spenta non c'è il QR", async () => {
    await conLaCasa(async (rig) => {
      const { admin, codice, qr } = await invito(rig.app);
      const ticket = leggiQrDiInvito(qr)?.ticket ?? "";
      const telefono = await rig.dispositivo();
      const esito = (await entra(telefono, ticket, domanda(codice, "dario"))) as unknown as {
        richiestaId: string;
      };

      await rig.app.inject({
        headers: bearer(admin),
        method: "POST",
        url: `/api/v1/admin/join-requests/${esito.richiestaId}/reject`,
      });

      const connessione = await telefono.connect(ticket, ALPN_DISPOSITIVO);
      await expect(chiedi(connessione, "GET", "/api/v1/auth/me")).rejects.toBeDefined();
    });

    await conLaCasa(async (rig) => {
      const admin = (
        await rig.app.identityService.login({ password: "password-valida-123", username: "admin" })
      ).token;
      const creato = await rig.app.inject({
        headers: bearer(admin),
        method: "POST",
        payload: {},
        url: "/api/v1/admin/invites",
      });
      expect(creato.json()).not.toHaveProperty("qr");
    }, "off");
  });
});
