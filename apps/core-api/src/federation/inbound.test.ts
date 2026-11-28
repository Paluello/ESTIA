import { randomBytes } from "node:crypto";

import { withTempDataDir } from "@estia/testing";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../db/database.js";
import { InstanceEndpoint, type IrohConnection, type IrohStream } from "./endpoint.js";
import { SqliteRemoteInstanceRepository } from "./repository.js";
import { FederationService, type InboundLimits } from "./service.js";

/**
 * Revisione interna, 2026-11-27: chi entra non aveva tetti. Una connessione
 * poteva aprire stream senza fine e non scriverci mai, e ognuno restava una
 * promessa in attesa sul NAS (ADR 0020 §2.2). Niente rete: connessioni finte,
 * che fanno solo quello che servirebbe a tenere occupata un'istanza.
 */

const muto = (): IrohStream => ({
  // Una domanda che non finisce mai di arrivare.
  recv: { readToEnd: () => new Promise<number[]>(() => undefined) },
  send: { finish: async () => undefined, writeAll: async () => undefined },
});

function connessione(
  chiave: string,
  stream: () => IrohStream,
): IrohConnection & { chiusa: boolean; accettati: number; finisci: () => void } {
  let finisci: () => void = () => undefined;
  const fine = new Promise<never>((_resolve, reject) => {
    finisci = () => reject(new Error("finita"));
  });
  fine.catch(() => undefined);
  const stato = {
    accettati: 0,
    chiusa: false,
  };

  return Object.assign(stato, {
    acceptBi: async (): Promise<IrohStream> => {
      if (stato.chiusa) {
        return fine;
      }

      // Come la rete vera: uno stream arriva in un altro giro del ciclo, non
      // nella stessa microtask. Senza, un rifiuto immediato (il budget) farebbe
      // girare il ciclo d'accettazione senza mai lasciar scattare un timer.
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (stato.chiusa) {
        return fine;
      }

      stato.accettati += 1;
      return stream();
    },
    close: () => {
      stato.chiusa = true;
      finisci();
    },
    finisci: () => finisci(),
    openBi: async () => stream(),
    paths: () => [],
    remoteId: () => ({ toString: () => chiave }),
  });
}

async function conFederazione(
  limiti: Partial<InboundLimits>,
  use: (federation: FederationService) => Promise<void>,
): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    const federation = new FederationService({
      endpoint: new InstanceEndpoint(new Uint8Array(randomBytes(32))),
      inbound: limiti,
      instanceName: () => "Via Roma",
      remotes: new SqliteRemoteInstanceRepository(openDatabase(dataDir)),
    });

    await use(federation);
  });
}

const pausa = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("i tetti di chi entra", () => {
  it("chi apre uno stream e tace perde la connessione", async () => {
    await conFederazione({ readTimeoutMs: 20 }, async (federation) => {
      const c = connessione("tace", muto);
      const servita = federation.serve(c);

      await pausa(60);

      expect(c.chiusa).toBe(true);
      await servita;
    });
  });

  it("non accetta più stream insieme di quanti ne regge, e gli altri aspettano", async () => {
    await conFederazione({ readTimeoutMs: 300, streamsPerConnection: 3 }, async (federation) => {
      const c = connessione("insistente", muto);
      const servita = federation.serve(c);

      await pausa(20);

      expect(c.accettati).toBe(3);

      c.finisci();
      await servita;
    });
  });

  it("chiude subito una connessione di troppo dalla stessa chiave", async () => {
    await conFederazione(
      { connectionsPerKey: 2, readTimeoutMs: 300, streamsPerConnection: 1 },
      async (federation) => {
        const prime = [connessione("stessa", muto), connessione("stessa", muto)];
        const servite = prime.map((c) => federation.serve(c));
        const terza = connessione("stessa", muto);

        await federation.serve(terza);
        expect(terza.chiusa).toBe(true);
        expect(terza.accettati).toBe(0);
        expect(prime.every((c) => !c.chiusa)).toBe(true);

        // Un'altra chiave ha il suo conto.
        const altra = connessione("altra", muto);
        const servitaAltra = federation.serve(altra);
        await pausa(10);
        expect(altra.chiusa).toBe(false);

        for (const c of [...prime, altra]) {
          c.finisci();
        }
        await Promise.all([...servite, servitaAltra]);
      },
    );
  });

  it("tiene un tetto alle connessioni di chi non è collegato, e lo libera", async () => {
    await conFederazione(
      { connectionsFromStrangers: 2, readTimeoutMs: 300, streamsPerConnection: 1 },
      async (federation) => {
        const prime = [connessione("una", muto), connessione("due", muto)];
        const servite = prime.map((c) => federation.serve(c));
        const terza = connessione("tre", muto);

        await federation.serve(terza);
        expect(terza.chiusa).toBe(true);

        // Finita una, c'è di nuovo posto.
        prime[0]!.finisci();
        await servite[0];
        const quarta = connessione("quattro", muto);
        const servitaQuarta = federation.serve(quarta);
        await pausa(10);
        expect(quarta.chiusa).toBe(false);

        prime[1]!.finisci();
        quarta.finisci();
        await Promise.all([servite[1], servitaQuarta]);
      },
    );
  });
});
