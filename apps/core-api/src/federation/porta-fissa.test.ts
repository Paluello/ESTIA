import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";

import { describe, expect, it } from "vitest";

import { InstanceEndpoint } from "./endpoint.js";

/**
 * La porta fissa di ADR 0045 §6, con il binding vero: chi apre una porta sul
 * router deve poter contare che la Casa sia lì dopo ogni avvio, e una porta
 * occupata non deve spegnere la rete.
 */

async function portaLibera(): Promise<number> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "0.0.0.0", resolve));
  const { port } = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));

  return port;
}

describe("la porta UDP fissa (ADR 0045 §6)", () => {
  it("l'endpoint si lega alla porta scelta, e lo dice", async () => {
    const porta = await portaLibera();
    const endpoint = new InstanceEndpoint(new Uint8Array(randomBytes(32)), { udpPort: porta });

    try {
      await endpoint.open("local");
      expect(endpoint.unavailableReason).toBeUndefined();
      expect(endpoint.udpPort).toEqual({ inUso: true, porta });
      expect(endpoint.boundSockets()).toContain(`0.0.0.0:${porta}`);
    } finally {
      await endpoint.close();
    }
  }, 30_000);

  it("con la porta occupata si apre lo stesso, su un'altra, e dice perché", async () => {
    const occupante = createSocket("udp4");
    await new Promise<void>((resolve) => occupante.bind(0, "0.0.0.0", resolve));
    const porta = occupante.address().port;
    const endpoint = new InstanceEndpoint(new Uint8Array(randomBytes(32)), { udpPort: porta });

    try {
      await endpoint.open("local");
      expect(endpoint.unavailableReason).toBeUndefined();
      expect(endpoint.udpPort?.inUso).toBe(false);
      expect(endpoint.udpPort?.rifiutata).toBeTruthy();
    } finally {
      await endpoint.close();
      await new Promise<void>((resolve) => occupante.close(() => resolve()));
    }
  }, 30_000);
});
