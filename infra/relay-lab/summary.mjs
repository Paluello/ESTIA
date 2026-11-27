/**
 * Legge le righe JSON scritte da `run.sh`, le confronta con l'atteso e scrive
 * un riassunto in Markdown: su stdout, in `<out>/summary.md` e, sul runner, nel
 * riassunto del lavoro. Esce con 1 se una prova non torna.
 */

import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const out = process.argv[2];
const files = new Set(await readdir(out));

async function one(name) {
  if (!files.has(`${name}.json`)) return undefined;
  const text = await readFile(join(out, `${name}.json`), "utf8");
  const line = text
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row.startsWith("{"))
    .at(-1);
  if (line === undefined) return { ok: false, error: "nessuna riga JSON" };
  try {
    return JSON.parse(line);
  } catch {
    // Il file della verifica 3 è un oggetto su più righe.
    return JSON.parse(text);
  }
}

async function many(name) {
  if (!files.has(`${name}.jsonl`)) return undefined;
  const text = await readFile(join(out, `${name}.jsonl`), "utf8");
  return text
    .split("\n")
    .filter((row) => row.trim().startsWith("{"))
    .map((row) => JSON.parse(row));
}

const rows = [];
let failed = false;

const oneLine = (text) =>
  String(text)
    .replace(/\s*\n\s*/g, " ")
    .replaceAll("|", "\\|");

/** Una prova del laboratorio: se non torna, il laboratorio fallisce. */
function check(test, passed, detail) {
  if (passed === undefined) {
    rows.push(`| ${test} | saltata | ${oneLine(detail)} |`);
    return;
  }
  if (!passed) failed = true;
  rows.push(`| ${test} | ${passed ? "ok" : "**NO**"} | ${oneLine(detail)} |`);
}

/** Una risposta a una domanda di ADR 0045: sì o no sono entrambi esiti validi. */
function answer(test, verdict, detail) {
  rows.push(`| ${test} | **${verdict}** | ${oneLine(detail)} |`);
}

function path(result) {
  if (result === undefined) return "—";
  if (!result.ok) return `errore: ${result.error ?? "eco diversa"}`;
  return `${result.selectedIsRelay ? "via relay" : "diretto"} ${result.selectedRemote ?? ""}, connessione ${result.connectMs} ms`;
}

// ── Verifica 1 ──
const reachedViaPeerRelay = (result) =>
  result === undefined
    ? undefined
    : result.ok === true && result.selectedIsRelay === true && result.peerRelayInOwnMap === false;

const v1a = await one("v1a-indirizzo-completo");
check(
  "1a · chiave + relay dell'altro, relay diversi, nessuna scoperta",
  reachedViaPeerRelay(v1a),
  path(v1a),
);

const v1b = await one("v1b-controllo-senza-relay");
check(
  "1b · controllo: solo la chiave, nessuna scoperta (deve fallire)",
  v1b === undefined ? undefined : v1b.ok === false,
  v1b?.ok
    ? `è passato: ${path(v1b)} — le reti non sono separate`
    : `fallito come atteso (${v1b?.error})`,
);

for (const [name, label] of [
  [
    "v1c-solo-chiave-scoperta-n0",
    "1c · solo la chiave, scoperta di n0, relay della comunità diversi",
  ],
  ["v1d-comunita-verso-n0", "1d · A su relay della comunità, B solo su n0"],
  ["v1e-n0-verso-comunita", "1e · A solo su n0, B su relay della comunità"],
]) {
  const result = await one(name);
  const passed =
    result === undefined ? undefined : result.ok === true && result.selectedIsRelay === true;
  check(
    label,
    passed,
    result === undefined ? "LAB_OFFLINE" : `${path(result)}; relay di B ${result.peerHomeRelay}`,
  );
}

// ── Verifica 2 ──
const v2a = await one("v2a-banda-senza-limiti");
const v2b = await one("v2b-banda-con-limiti");
check(
  "2a · 1 MiB andata e ritorno, relay senza limiti",
  v2a?.ok,
  v2a?.ok ? `${v2a.transferMs} ms, ${v2a.kibPerSecond} KiB/s` : path(v2a),
);
check(
  "2b · lo stesso, sull'immagine del Nodo pubblico con `NODO_BANDA_KIB=64`",
  v2a?.ok && v2b?.ok ? v2b.transferMs > 8000 && v2b.transferMs > 4 * v2a.transferMs : false,
  v2b?.ok ? `${v2b.transferMs} ms, ${v2b.kibPerSecond} KiB/s` : path(v2b),
);

const spread = (list) => {
  const times = list.filter((row) => row.online).map((row) => row.onlineAfterMs);
  times.sort((a, b) => a - b);
  return {
    online: times.length,
    total: list.length,
    min: times[0],
    max: times.at(-1),
    times,
  };
};
const v2c = await many("v2c-tasso-di-connessioni");
const v2d = await many("v2d-tasso-senza-limiti");
if (v2c && v2d) {
  const limited = spread(v2c);
  const free = spread(v2d);
  // iroh-relay 1.5.0 legge `accept_conn_limit` e `accept_conn_burst` ma non li
  // applica (`src/server.rs`, «TODO: … not currently implemented»): qui si
  // guarda se il filo dice lo stesso.
  const applied =
    limited.max !== undefined && free.max !== undefined && limited.max > free.max + 3000;
  answer(
    "2c · dieci Case insieme, `accept_conn_limit` 1/s raffica 2",
    applied ? "applicato" : "non applicato",
    `con limiti: ${limited.online}/${limited.total} in linea, ${limited.times.join(", ")} ms · senza: ${free.online}/${free.total}, ${free.times.join(", ")} ms`,
  );
}

// ── Verifica 3 ──
function describe(packet) {
  const payload = Buffer.from(packet.payload, "hex");
  if (packet.toPort === 1900) return { kind: "UPnP (SSDP M-SEARCH)" };
  if (payload[0] === 0 && payload.length >= 12 && (payload[1] === 1 || payload[1] === 2)) {
    return { kind: "NAT-PMP mappa", port: payload.readUInt16BE(4) };
  }
  if (payload[0] === 0) return { kind: "NAT-PMP indirizzo pubblico" };
  if (payload[0] === 2) {
    const opcode = payload[1] & 0x7f;
    return opcode === 1 && payload.length >= 42
      ? { kind: "PCP MAP", port: payload.readUInt16BE(40) }
      : { kind: `PCP op ${opcode}` };
  }
  return { kind: `porta ${packet.toPort}` };
}

const log = (await many("v3-gateway")) ?? [];
const gateway = log.filter((event) => event.payload !== undefined);
const upnpCalls = log.filter((event) => event.upnp !== undefined);
for (const [name, label] of [
  [
    "v3a-porta-casuale",
    "3a · mappatura delle porte, endpoint senza `bindAddr` (come core-api oggi)",
  ],
  ["v3b-porta-fissa", "3b · lo stesso, endpoint legato a 41641"],
]) {
  const probe = await one(name);
  if (probe === undefined) continue;
  const bound = (probe.boundSockets ?? []).map((socket) => Number(socket.split(":").at(-1)));
  // Il gateway non sa da quale prova arriva un pacchetto: lo dice la porta
  // d'origine, che per NAT-PMP e PCP è la presa dell'endpoint stesso o una sua.
  const seen = gateway.map((packet) => ({ ...packet, ...describe(packet) }));
  const mine = [
    ...seen.filter((packet) => packet.port !== undefined && bound.includes(packet.port)),
    ...upnpCalls
      .filter((call) => call.internalPort !== undefined && bound.includes(call.internalPort))
      .map((call) => ({
        kind: `UPnP ${call.action} ${call.protocol} ${call.internalPort}→${call.externalPort}`,
      })),
  ];
  const protocols = [...new Set(mine.map((packet) => packet.kind))];
  answer(
    label,
    mine.length > 0 ? "chiede la porta" : "non chiede",
    `presa ${bound.join(", ") || "—"}; richieste per quella porta: ${protocols.join(", ") || "nessuna"}; portmap_attempts ${probe.stats?.["net_report:portmap_attempts"]?.value ?? "—"}`,
  );
}
const kinds = [...new Set(gateway.map((packet) => describe(packet).kind))];
answer(
  "3 · tutto ciò che il gateway ha ricevuto",
  `${gateway.length} pacchetti, ${upnpCalls.length} chiamate UPnP`,
  [...kinds, ...new Set(upnpCalls.map((call) => call.action ?? call.path))].join(", ") || "niente",
);

const markdown = [
  "## Laboratorio dei relay — ADR 0045, verifiche 1-3",
  "",
  "| Prova | Esito | Dettaglio |",
  "| --- | --- | --- |",
  ...rows,
  "",
].join("\n");

process.stdout.write(markdown);
await writeFile(join(out, "summary.md"), markdown);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
process.exit(failed ? 1 : 0);
