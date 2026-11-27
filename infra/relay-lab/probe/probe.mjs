/**
 * Sonda del laboratorio dei relay (ADR 0045 §«Prima di costruire», verifiche 1-3).
 *
 * Non è codice di ESTIA e non ne dipende: parla direttamente con lo stesso
 * binding che usa `apps/core-api` (`@number0/iroh` 1.1.0), così che quello che
 * misura sia quello che farà una Casa.
 *
 * Ruoli, scelti con la variabile `ROLE`:
 *
 * - `serve`  apre un endpoint, scrive il proprio indirizzo in `OUT` e risponde
 *            a ogni stream rimandando i byte ricevuti.
 * - `dial`   legge l'indirizzo dell'altro da `PEER`, si collega, manda `BYTES`
 *            byte, misura, e stampa una riga JSON con il percorso usato.
 * - `idle`   apre un endpoint, aspetta `HOLD_MS` e stampa le sue prese: serve
 *            alla verifica 3, mentre qualcuno ascolta che cosa manda alla rete.
 *
 * Configurazione comune:
 *
 * - `PRESET`   `minimal` (nessuna scoperta) oppure `n0` (scoperta DNS di n0).
 * - `RELAYS`   URL separati da virgole; vuoto con `PRESET=n0` vuol dire i relay di n0.
 * - `ADDR`     per `dial`: `full` (chiave + relay dell'altro), `id` (solo chiave,
 *              serve la scoperta), `id-no-relay` (chiave senza relay né scoperta:
 *              il controllo che deve fallire).
 */

import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { Endpoint, EndpointAddr, EndpointId, RelayMode, setLogLevel } from "@number0/iroh";

const ALPN = Array.from(new TextEncoder().encode("estia-relay-lab/1"));
const env = process.env;

// `IROH_LOG=Debug` per vedere che cosa fa il binding (portmapper compreso), su stderr.
if (env.IROH_LOG) setLogLevel(env.IROH_LOG);

function log(event) {
  process.stdout.write(`${JSON.stringify({ role: env.ROLE, name: env.NAME, ...event })}\n`);
}

async function bind() {
  const builder = Endpoint.builder();
  const preset = env.PRESET ?? "minimal";

  if (preset === "n0") {
    builder.applyN0();
  } else if (preset === "minimal") {
    builder.applyMinimal();
  } else {
    throw new Error(`PRESET sconosciuto: ${preset}`);
  }

  const relays = (env.RELAYS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    // iroh scrive i relay con la barra finale: si confrontano nella stessa forma.
    .map((url) => new URL(url).href);

  if (relays.length > 0) {
    builder.relayMode(RelayMode.customFromUrls(relays));
  }

  if (env.BIND_ADDR) {
    builder.bindAddr(env.BIND_ADDR);
  }

  builder.alpns([ALPN]);
  const endpoint = await builder.bind();

  const onlineMs = Number(env.ONLINE_TIMEOUT_MS ?? 20000);
  const started = Date.now();
  const online = await Promise.race([
    endpoint.online().then(() => true),
    sleep(onlineMs).then(() => false),
  ]);

  return { endpoint, online, onlineAfterMs: Date.now() - started, relays, preset };
}

function homeRelay(endpoint) {
  return endpoint.addr().relayUrl();
}

async function serve() {
  const { endpoint, online, onlineAfterMs, relays, preset } = await bind();
  const addr = endpoint.addr();
  const info = {
    id: endpoint.id().toString(),
    relayUrl: addr.relayUrl(),
    directAddresses: addr.directAddresses(),
  };

  await writeFile(env.OUT, JSON.stringify(info));
  log({ event: "ready", online, onlineAfterMs, preset, relays, ...info });

  for (;;) {
    const incoming = await endpoint.acceptNext();
    if (incoming === null) break;

    void (async () => {
      try {
        const connection = await (await incoming.accept()).connect();
        for (;;) {
          const stream = await connection.acceptBi();
          const data = await stream.recv.readToEnd(64 * 1024 * 1024);
          await stream.send.writeAll(data);
          await stream.send.finish();
        }
      } catch {
        // La connessione chiusa dall'altro capo finisce qui: non è un errore della prova.
      }
    })();
  }
}

async function readPeer() {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      return JSON.parse(await readFile(env.PEER, "utf8"));
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(250);
    }
  }
}

async function dial() {
  const peer = await readPeer();
  const { endpoint, online, onlineAfterMs, relays, preset } = await bind();
  const mode = env.ADDR ?? "full";
  const id = EndpointId.fromString(peer.id);

  const addr =
    mode === "full"
      ? new EndpointAddr(id, peer.relayUrl, [])
      : mode === "id" || mode === "id-no-relay"
        ? new EndpointAddr(id)
        : undefined;
  if (addr === undefined) throw new Error(`ADDR sconosciuto: ${mode}`);

  const bytes = Number(env.BYTES ?? 1024);
  const timeoutMs = Number(env.CONNECT_TIMEOUT_MS ?? 30000);
  const result = {
    event: "result",
    preset,
    relays,
    online,
    onlineAfterMs,
    ownHomeRelay: homeRelay(endpoint),
    peerHomeRelay: peer.relayUrl,
    peerRelayInOwnMap: relays.includes(peer.relayUrl),
    addrMode: mode,
    bytes,
  };

  const started = Date.now();
  try {
    const connection = await Promise.race([
      endpoint.connect(addr, ALPN),
      sleep(timeoutMs).then(() => {
        throw new Error(`nessuna connessione entro ${timeoutMs} ms`);
      }),
    ]);
    result.connectMs = Date.now() - started;

    const payload = new Array(bytes);
    for (let index = 0; index < bytes; index += 1) payload[index] = index % 251;

    const transferStarted = Date.now();
    const stream = await connection.openBi();
    await stream.send.writeAll(payload);
    await stream.send.finish();
    const echoed = await stream.recv.readToEnd(bytes + 1);
    const transferMs = Date.now() - transferStarted;

    result.echoOk = echoed.length === bytes && echoed.every((byte, index) => byte === index % 251);
    result.transferMs = transferMs;
    result.kibPerSecond = Math.round(((bytes * 2) / 1024 / (transferMs / 1000)) * 10) / 10;
    result.paths = connection
      .paths()
      .map(({ isSelected, isRelay, remoteAddr, rttMs }) => ({
        isSelected,
        isRelay,
        remoteAddr,
        rttMs,
      }));
    const selected = result.paths.find((path) => path.isSelected);
    result.selectedIsRelay = selected?.isRelay ?? null;
    result.selectedRemote = selected?.remoteAddr ?? null;
    result.ok = result.echoOk;
    connection.close(0n, []);
  } catch (error) {
    result.ok = false;
    result.connectMs = Date.now() - started;
    result.error = error instanceof Error ? error.message : String(error);
  }

  log(result);
  await endpoint.close();
  process.exit(result.ok || env.EXPECT === "fail" ? 0 : 1);
}

async function idle() {
  const { endpoint, online, onlineAfterMs, relays, preset } = await bind();
  await sleep(Number(env.HOLD_MS ?? 15000));
  log({
    event: "idle",
    preset,
    relays,
    online,
    onlineAfterMs,
    homeRelay: homeRelay(endpoint),
    boundSockets: endpoint.boundSockets(),
    stats: Object.fromEntries(
      Object.entries(endpoint.stats()).filter(([name]) =>
        /portmap|port_map|upnp|pcp|pmp/i.test(name),
      ),
    ),
  });
  await endpoint.close();
  process.exit(0);
}

const roles = { serve, dial, idle };
const role = roles[env.ROLE];
if (role === undefined) {
  console.error(`ROLE deve essere uno di: ${Object.keys(roles).join(", ")}`);
  process.exit(2);
}

await role();
