// Spike S6 — la Casa con il binding iroh che usa davvero (`@number0/iroh` 1.1.0,
// quello di apps/core-api), e il dispositivo con iroh 1.4.1 in Rust.
//
// Domanda: le due versioni si parlano? La Casa vera aggiornerà il binding con i
// suoi tempi, l'app con i suoi: se 1.1 e 1.4 non si capissero, l'app sarebbe
// legata alla versione della Casa.
//
//   node infra/spike-app/interop-node/casa-node.mjs <chiave-dispositivo-ammessa>
//
// Stampa INDIRIZZO nel formato che `bussa --locale --casa '<json>'` legge.
// Solo rete locale: nessun server di n0, come la Casa in modo `local`.
/* global process, console, URL, TextEncoder, TextDecoder */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(
  fileURLToPath(new URL("../../../apps/core-api/package.json", import.meta.url)),
);
const iroh = require("@number0/iroh");

const ALPN = Array.from(new TextEncoder().encode("estia/dispositivo/spike-0"));
const ammessa = process.argv[2];
if (ammessa === undefined) {
  console.error("uso: casa-node.mjs <chiave-dispositivo>");
  process.exit(2);
}

const builder = iroh.Endpoint.builder();
builder.applyMinimal();
builder.alpns([ALPN]);
const endpoint = await builder.bind();
const addr = endpoint.addr();
const indirizzo = {
  id: endpoint.id().toString(),
  addrs: addr.directAddresses().map((ip) => ({ Ip: ip })),
};
console.log(`CASA ${indirizzo.id}`);
console.log(`INDIRIZZO ${JSON.stringify(indirizzo)}`);

const td = new TextDecoder();
const te = new TextEncoder();

async function servi(connessione) {
  if (connessione.remoteId().toString() !== ammessa) {
    connessione.close(0n, []);
    return;
  }
  for (;;) {
    let stream;
    try {
      stream = await connessione.acceptBi();
    } catch {
      return;
    }
    const richiesta = JSON.parse(td.decode(new Uint8Array(await stream.recv.readToEnd(65536))));
    const corpo =
      richiesta.tipo === "salute"
        ? "ok"
        : richiesta.tipo === "eco"
          ? "x".repeat(richiesta.byte)
          : "";
    await stream.send.writeAll(Array.from(te.encode(JSON.stringify({ stato: 200, corpo }))));
    await stream.send.finish();
  }
}

for (;;) {
  const incoming = await endpoint.acceptNext();
  if (incoming === null) break;
  const accepting = await incoming.accept();
  const connessione = await accepting.connect();
  servi(connessione).catch((errore) => console.error("connessione:", errore.message));
}
