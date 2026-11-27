/**
 * La strada C di [ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)
 * — «basta saper entrare nell'account» — va **impedita dal codice**. Queste
 * prove la percorrono da chi ha soltanto la password, per le quattro strade che
 * una revisione di sicurezza ha trovato aperte il 2026-11-27, e controllano che
 * la via di riserva vera — la frase segreta, che ridà la chiave privata — resti
 * aperta.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { loadConfig, type AppConfig } from "@estia/config";
import { messaggioDiProvaChiave } from "@estia/contracts";
import { withTempDataDir } from "@estia/testing";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";

const SETUP_TOKEN = "setup-token-strada-c";
const ALGORITMO = "MLS-P256-v1";

function configFor(dataDir: string): AppConfig {
  return loadConfig({
    ESTIA_DATA_DIR: dataDir,
    ESTIA_HOST: "127.0.0.1",
    ESTIA_LOG_LEVEL: "silent",
  });
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** Una chiave P-256 vera, con la pubblica scritta come la scrive `ts-mls`. */
function chiaveVera(): { publicKey: string; privata: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const punto = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);

  return { privata: privateKey, publicKey: punto.toString("base64") };
}

interface Rig {
  app: FastifyInstance;
  accedi: () => Promise<string>;
  avanza: (ms: number) => void;
}

async function conLaCasa(use: (rig: Rig) => Promise<void>): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    let scarto = 0;
    const app = await buildApp(configFor(dataDir), {
      now: () => new Date(Date.now() + scarto),
      setupToken: SETUP_TOKEN,
    });

    try {
      await app.inject({
        method: "POST",
        payload: {
          adminPassword: "password-valida-admin",
          adminUsername: "admin",
          name: "Casa",
          setupToken: SETUP_TOKEN,
        },
        url: "/api/v1/instance/setup",
      });
      await app.identityService.createUser({
        password: "password-lunga-anna",
        role: "member",
        username: "anna",
      });

      await use({
        accedi: async () =>
          (await app.identityService.login({ password: "password-lunga-anna", username: "anna" }))
            .token,
        app,
        avanza: (ms) => {
          scarto += ms;
        },
      });
    } finally {
      await app.close();
    }
  });
}

async function registra(
  app: FastifyInstance,
  token: string,
  publicKey: string,
  privata?: KeyObject,
): Promise<{ id: string; sessionId: string; approvatoIl: string | null }> {
  let prova: string | undefined;

  if (privata !== undefined) {
    const { sfida } = (
      await app.inject({ headers: bearer(token), method: "POST", url: "/api/v1/dispositivi/sfida" })
    ).json<{ sfida: string }>();
    prova = sign("sha256", Buffer.from(messaggioDiProvaChiave(sfida, publicKey)), {
      dsaEncoding: "der",
      key: privata,
    }).toString("base64");
  }

  const risposta = await app.inject({
    headers: bearer(token),
    method: "POST",
    payload: { algorithm: ALGORITMO, publicKey, ...(prova === undefined ? {} : { prova }) },
    url: "/api/v1/dispositivi/chiave",
  });

  expect(risposta.statusCode).toBe(200);

  return risposta.json<{ device: { id: string; sessionId: string; approvatoIl: string | null } }>()
    .device;
}

async function registro(app: FastifyInstance, token: string): Promise<string[]> {
  const risposta = await app.inject({
    headers: bearer(token),
    method: "GET",
    url: "/api/v1/dispositivi/di/anna/chiavi",
  });

  return (risposta.json<{ chiavi: { publicKey: string }[] }>().chiavi ?? []).map(
    (c) => c.publicKey,
  );
}

describe("la strada C di ADR 0040 è chiusa", () => {
  it("la frase segreta rientra da sola: la stessa chiave, con la prova di possesso", async () => {
    await conLaCasa(async ({ app, accedi }) => {
      const chiave = chiaveVera();
      const primo = await accedi();

      expect((await registra(app, primo, chiave.publicKey)).approvatoIl).not.toBeNull();

      // Un altro browser, la frase segreta ha ridato la stessa privata.
      const rientro = await accedi();
      const dispositivo = await registra(app, rientro, chiave.publicKey, chiave.privata);

      expect(dispositivo.approvatoIl).not.toBeNull();
    });
  });

  it("la stessa chiave pubblica senza la privata aspetta, anche con una firma falsa", async () => {
    await conLaCasa(async ({ app, accedi }) => {
      const vittima = chiaveVera();
      const attaccante = chiaveVera();
      await registra(app, await accedi(), vittima.publicKey);

      // Chi ha la password, e la chiave pubblica letta dal registro, firma con
      // la propria privata: la firma non torna.
      const intruso = await registra(app, await accedi(), vittima.publicKey, attaccante.privata);
      expect(intruso.approvatoIl).toBeNull();

      // E senza nessuna firma, lo stesso.
      expect((await registra(app, await accedi(), vittima.publicKey)).approvatoIl).toBeNull();
    });
  });

  it("una sessione approvata che cambia chiave perde il sì", async () => {
    await conLaCasa(async ({ app, accedi }) => {
      const token = await accedi();
      const prima = await registra(app, token, chiaveVera().publicKey);
      expect(prima.approvatoIl).not.toBeNull();

      const altra = chiaveVera();
      const dopo = await registra(app, token, altra.publicKey);

      expect(dopo.id).toBe(prima.id);
      expect(dopo.approvatoIl).toBeNull();
      expect(await registro(app, token)).not.toContain(altra.publicKey);
    });
  });

  it("uscire dall'unico dispositivo non fa del prossimo un «primo dispositivo»", async () => {
    await conLaCasa(async ({ app, accedi }) => {
      const token = await accedi();
      await registra(app, token, chiaveVera().publicKey);
      await app.inject({ headers: bearer(token), method: "POST", url: "/api/v1/auth/logout" });

      const nuovo = await registra(app, await accedi(), chiaveVera().publicKey);

      expect(nuovo.approvatoIl).toBeNull();
    });
  });

  it("un dispositivo che aspetta non può buttare fuori gli altri", async () => {
    await conLaCasa(async ({ app, accedi }) => {
      const buono = await accedi();
      const dispositivoBuono = await registra(app, buono, chiaveVera().publicKey);

      const intruso = await accedi();
      await registra(app, intruso, chiaveVera().publicKey);

      const revoca = await app.inject({
        headers: bearer(intruso),
        method: "DELETE",
        url: `/api/v1/auth/sessions/${dispositivoBuono.sessionId}`,
      });

      expect(revoca.statusCode).toBe(403);
      expect(revoca.json()).toMatchObject({ code: "device_not_approved" });

      // Uscire da sé, invece, si può sempre.
      const me = (
        await app.inject({ headers: bearer(intruso), method: "GET", url: "/api/v1/auth/sessions" })
      ).json<{ sessions: { id: string; current: boolean }[] }>();
      const propria = me.sessions.find((s) => s.current)!;
      const uscita = await app.inject({
        headers: bearer(intruso),
        method: "DELETE",
        url: `/api/v1/auth/sessions/${propria.id}`,
      });
      expect(uscita.statusCode).toBe(204);
    });
  });

  it("un dispositivo tolto dal proprietario non rientra con la propria chiave", async () => {
    await conLaCasa(async ({ app, accedi }) => {
      const telefono = chiaveVera();
      const pc = await accedi();
      await registra(app, pc, chiaveVera().publicKey);

      // Il telefono entra e viene approvato dal PC.
      const sessioneTelefono = await accedi();
      const dispositivo = await registra(app, sessioneTelefono, telefono.publicKey);
      await app.inject({
        headers: bearer(pc),
        method: "POST",
        url: `/api/v1/dispositivi/${dispositivo.id}/approva`,
      });

      // Il telefono è rubato: il PC lo toglie.
      await app.inject({
        headers: bearer(pc),
        method: "DELETE",
        url: `/api/v1/auth/sessions/${dispositivo.sessionId}`,
      });

      // Il ladro ha la password e la privata del telefono, e firma: aspetta.
      const ladro = await registra(app, await accedi(), telefono.publicKey, telefono.privata);

      expect(ladro.approvatoIl).toBeNull();
      expect(await registro(app, pc)).not.toContain(telefono.publicKey);
    });
  });

  it("una sessione scaduta non tiene la chiave nel registro", async () => {
    await conLaCasa(async ({ app, accedi, avanza }) => {
      const chiave = chiaveVera();
      const token = await accedi();
      await registra(app, token, chiave.publicKey);

      expect(await registro(app, token)).toContain(chiave.publicKey);

      avanza(31 * 24 * 60 * 60 * 1000);
      const altro = await accedi();

      expect(await registro(app, altro)).not.toContain(chiave.publicKey);
    });
  });

  it("una sfida vale una volta, e scade", async () => {
    await conLaCasa(async ({ app, accedi, avanza }) => {
      const chiave = chiaveVera();
      await registra(app, await accedi(), chiave.publicKey);
      const token = await accedi();

      const { sfida } = (
        await app.inject({
          headers: bearer(token),
          method: "POST",
          url: "/api/v1/dispositivi/sfida",
        })
      ).json<{ sfida: string }>();
      const prova = sign("sha256", Buffer.from(messaggioDiProvaChiave(sfida, chiave.publicKey)), {
        dsaEncoding: "der",
        key: chiave.privata,
      }).toString("base64");

      avanza(6 * 60 * 1000);

      const tardi = await app.inject({
        headers: bearer(token),
        method: "POST",
        payload: { algorithm: ALGORITMO, prova, publicKey: chiave.publicKey },
        url: "/api/v1/dispositivi/chiave",
      });

      expect(tardi.json().device.approvatoIl).toBeNull();
    });
  });
});
