import { loadConfig } from "@estia/config";
import type { CommunityRelaysView } from "@estia/contracts";
import { withClosable, withTempDataDir } from "@estia/testing";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";

/**
 * I relay della comunità dal pannello (ADR 0045 §3). Qui la rete è spenta,
 * quindi i relay non sono «attivi» e nessuna mappa si applica: si prova che
 * l'adozione passa dalle regole (https, gestore, doppioni, tetto) e che solo
 * chi amministra la fa.
 */

const SETUP_TOKEN = "token-di-prova";
const ADMIN = { password: "una-password-lunga", username: "palu" };

async function withAdmin(
  use: (app: FastifyInstance, token: string) => Promise<void>,
): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const config = loadConfig({
      ESTIA_DATA_DIR: dataDir,
      ESTIA_HOST: "127.0.0.1",
      ESTIA_LOG_LEVEL: "silent",
    });
    const app = await buildApp(config, { setupToken: SETUP_TOKEN });

    await withClosable(app, async (instance) => {
      await instance.inject({
        method: "POST",
        payload: {
          adminPassword: ADMIN.password,
          adminUsername: ADMIN.username,
          name: "Via Roma",
          setupToken: SETUP_TOKEN,
        },
        url: "/api/v1/instance/setup",
      });
      const token = (
        await instance.inject({ method: "POST", payload: ADMIN, url: "/api/v1/auth/login" })
      ).json().token as string;

      await use(instance, token);
    });
  });
}

describe("i relay della comunità dal pannello", () => {
  it("si adottano con il nome di chi li gestisce, e si tolgono", async () => {
    await withAdmin(async (app, token) => {
      const headers = { authorization: `Bearer ${token}` };

      const adopted = await app.inject({
        headers,
        method: "POST",
        payload: { gestore: "  Luca, Circolo Arci  ", url: "https://Relay.Circolo.example" },
        url: "/api/v1/admin/network/relays",
      });
      expect(adopted.statusCode).toBe(200);
      const view = adopted.json<CommunityRelaysView>();
      expect(view.attivi).toBe(false);
      expect(view.relays.map(({ url, gestore }) => ({ url, gestore }))).toEqual([
        { gestore: "Luca, Circolo Arci", url: "https://relay.circolo.example/" },
      ]);

      const twice = await app.inject({
        headers,
        method: "POST",
        payload: { gestore: "Luca", url: "https://relay.circolo.example/" },
        url: "/api/v1/admin/network/relays",
      });
      expect(twice.statusCode).toBe(409);
      expect(twice.json().code).toBe("relay_gia_adottato");

      const removed = await app.inject({
        headers,
        method: "POST",
        payload: { url: "https://relay.circolo.example/" },
        url: "/api/v1/admin/network/relays/remove",
      });
      expect(removed.json<CommunityRelaysView>().relays).toEqual([]);

      const again = await app.inject({
        headers,
        method: "POST",
        payload: { url: "https://relay.circolo.example/" },
        url: "/api/v1/admin/network/relays/remove",
      });
      expect(again.json().code).toBe("relay_non_adottato");
    });
  });

  it("rifiuta un indirizzo senza https e un relay senza gestore", async () => {
    await withAdmin(async (app, token) => {
      const headers = { authorization: `Bearer ${token}` };
      const http = await app.inject({
        headers,
        method: "POST",
        payload: { gestore: "Luca", url: "http://relay.circolo.example/" },
        url: "/api/v1/admin/network/relays",
      });
      expect(http.json().code).toBe("relay_indirizzo_non_valido");

      const anonymous = await app.inject({
        headers,
        method: "POST",
        payload: { gestore: "   ", url: "https://relay.circolo.example/" },
        url: "/api/v1/admin/network/relays",
      });
      expect(anonymous.json().code).toBe("relay_gestore_mancante");
    });
  });

  it("non si toccano senza essere amministratori", async () => {
    await withAdmin(async (app) => {
      const response = await app.inject({ method: "GET", url: "/api/v1/admin/network/relays" });
      expect(response.statusCode).toBe(401);
    });
  });
});
