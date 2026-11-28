import { describe, expect, it } from "vitest";

import type { SettingsRepository } from "../backup/settings.js";
import {
  canonicalRelayUrl,
  plannedRelayMap,
  readAdoptedRelays,
  RelayWatch,
  writeAdoptedRelays,
  type AdoptedRelay,
  type RelayMapTarget,
} from "./relays.js";

/**
 * La mappa dei relay di ADR 0045 §2, e la ragione per cui non è una lista con
 * n0 in fondo: iroh sceglie il relay principale per latenza (laboratorio dei
 * relay, 2026-11-27), quindi n0 entra nella mappa solo quando tutti gli
 * adottati tacciono, e ne esce appena uno torna.
 */

class MemorySettings implements SettingsRepository {
  readonly values = new Map<string, string>();
  read(key: string) {
    return this.values.get(key);
  }
  write(key: string, value: string) {
    this.values.set(key, value);
  }
  clear(key: string) {
    this.values.delete(key);
  }
}

const N0 = ["https://euc1-1.relay.n0.iroh.link./", "https://use1-1.relay.n0.iroh.link./"];
const CIRCOLO = "https://relay.circolo.example/";
const BIBLIOTECA = "https://relay.biblioteca.example/";

function adopted(...urls: string[]): AdoptedRelay[] {
  return urls.map((url) => ({
    url,
    gestore: `chi gestisce ${url}`,
    adottatoIl: "2026-11-28T00:00:00.000Z",
  }));
}

class FakeTarget implements RelayMapTarget {
  maps: string[][] = [];
  n0: string[] | undefined = N0;
  n0RelayUrls() {
    return this.n0;
  }
  async setRelayMap(urls: readonly string[]) {
    this.maps.push([...urls]);
  }
}

describe("canonicalRelayUrl", () => {
  it("riduce un indirizzo alla sua origine con la barra finale", () => {
    expect(canonicalRelayUrl(" https://Relay.Circolo.example ")).toBe(CIRCOLO);
    expect(canonicalRelayUrl("https://relay.circolo.example:8443/")).toBe(
      "https://relay.circolo.example:8443/",
    );
  });

  it("rifiuta ciò che non è un relay da adottare", () => {
    for (const value of [
      "http://relay.circolo.example/",
      "https://chi:segreto@relay.circolo.example/",
      "https://relay.circolo.example/percorso",
      "https://relay.circolo.example/?a=1",
      "relay.circolo.example",
      "",
    ]) {
      expect(canonicalRelayUrl(value), value).toBeUndefined();
    }
  });
});

describe("plannedRelayMap", () => {
  it("senza relay adottati è la mappa di n0, cioè la Casa di oggi", () => {
    expect(plannedRelayMap({ adopted: [], healthy: new Set(), n0: N0 })).toEqual(N0);
  });

  it("finché un adottato risponde, n0 resta fuori, anche con gli altri adottati muti", () => {
    expect(
      plannedRelayMap({ adopted: [CIRCOLO, BIBLIOTECA], healthy: new Set([BIBLIOTECA]), n0: N0 }),
    ).toEqual([CIRCOLO, BIBLIOTECA]);
  });

  it("quando tacciono tutti, n0 entra accanto a loro", () => {
    expect(plannedRelayMap({ adopted: [CIRCOLO], healthy: new Set(), n0: N0 })).toEqual([
      CIRCOLO,
      ...N0,
    ]);
  });
});

describe("i relay adottati nelle impostazioni", () => {
  it("si rileggono come si sono scritti, e la lista vuota toglie la chiave", () => {
    const settings = new MemorySettings();
    writeAdoptedRelays(settings, adopted(CIRCOLO), "2026-11-28T00:00:00.000Z");
    expect(readAdoptedRelays(settings)).toEqual(adopted(CIRCOLO));

    writeAdoptedRelays(settings, [], "2026-11-28T00:00:00.000Z");
    expect(settings.values.size).toBe(0);
  });

  it("una riga illeggibile non spegne la rete: si salta", () => {
    const settings = new MemorySettings();
    settings.values.set(
      "network.relays",
      JSON.stringify([
        { url: "http://non-https.example/", gestore: "x", adottatoIl: "y" },
        ...adopted(CIRCOLO),
      ]),
    );
    expect(readAdoptedRelays(settings).map((relay) => relay.url)).toEqual([CIRCOLO]);

    settings.values.set("network.relays", "{non è json");
    expect(readAdoptedRelays(settings)).toEqual([]);
  });
});

describe("RelayWatch", () => {
  function watch(options: { up: Set<string>; settings?: MemorySettings; target?: FakeTarget }) {
    const settings = options.settings ?? new MemorySettings();
    const target = options.target ?? new FakeTarget();
    const relayWatch = new RelayWatch({
      settings,
      target,
      ping: async (url) => options.up.has(url),
      now: () => new Date("2026-11-28T10:00:00.000Z"),
    });

    return { relayWatch, settings, target };
  }

  it("senza relay adottati dà all'endpoint la mappa di n0, una volta sola", async () => {
    const { relayWatch, target } = watch({ up: new Set() });
    await relayWatch.check();
    await relayWatch.check();
    expect(target.maps).toEqual([N0]);
  });

  it("ripiega su n0 quando l'adottato tace, e ne esce quando torna", async () => {
    const up = new Set([CIRCOLO]);
    const settings = new MemorySettings();
    writeAdoptedRelays(settings, adopted(CIRCOLO), "2026-11-28T00:00:00.000Z");
    const { relayWatch, target } = watch({ up, settings });

    await relayWatch.check();
    up.delete(CIRCOLO);
    await relayWatch.check();
    up.add(CIRCOLO);
    await relayWatch.check();

    expect(target.maps).toEqual([[CIRCOLO], [CIRCOLO, ...N0], [CIRCOLO]]);
    expect(relayWatch.status()).toEqual([
      {
        url: CIRCOLO,
        gestore: `chi gestisce ${CIRCOLO}`,
        risponde: true,
        controllatoIl: "2026-11-28T10:00:00.000Z",
      },
    ]);
  });

  it("dove non si usano relay (rete locale, nessun binding) non tocca niente", async () => {
    const target = new FakeTarget();
    target.n0 = undefined;
    const { relayWatch } = watch({ up: new Set(), target });
    await relayWatch.check();
    expect(target.maps).toEqual([]);
  });

  it("un relay che non risponde in tempo conta come muto", async () => {
    const settings = new MemorySettings();
    writeAdoptedRelays(settings, adopted(CIRCOLO), "2026-11-28T00:00:00.000Z");
    const target = new FakeTarget();
    const relayWatch = new RelayWatch({
      settings,
      target,
      timeoutMs: 20,
      ping: (_url, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve(false))),
    });

    await relayWatch.check();
    expect(target.maps).toEqual([[CIRCOLO, ...N0]]);
    expect(relayWatch.status()[0]?.risponde).toBe(false);
  });

  it("se l'endpoint rifiuta la mappa, la riprova al giro dopo", async () => {
    const target = new FakeTarget();
    let fail = true;
    target.setRelayMap = async (urls) => {
      if (fail) throw new Error("chiuso");
      target.maps.push([...urls]);
    };
    const { relayWatch } = watch({ up: new Set(), target });

    await relayWatch.check();
    fail = false;
    await relayWatch.check();
    expect(target.maps).toEqual([N0]);
  });
});
