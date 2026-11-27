// S7: OpenMLS (Rust) e ts-mls (web) nella stessa conversazione.
//
// Il pilota tiene i client ts-mls in memoria e comanda i membri OpenMLS, uno
// per processo (`ponte/`), a righe JSON. Fra i due lati passano soltanto byte
// `MLSMessage` di RFC 9420, come sul canale vero. Dopo ogni passo si confronta
// l'`epoch_authenticator` e la serratura del mazzo d'archivio (l'exporter con
// l'etichetta di ESTIA): se coincidono, i due lati hanno lo stesso key schedule.
//
//   cargo build --manifest-path infra/spike-mls/ponte/Cargo.toml
//   node infra/spike-mls/prova.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";

const qui = fileURLToPath(new URL(".", import.meta.url));
const radiceTsMls = join(qui, "../../apps/web/node_modules/ts-mls/dist/src");
const daTsMls = (f) => import(pathToFileURL(join(radiceTsMls, f)).href);

const mls = await daTsMls("index.js");
const { defaultClientConfig } = await daTsMls("clientConfig.js");
const { encodeMlsMessage, decodeMlsMessage } = await daTsMls("message.js");
const { ratchetTreeFromExtension } = await daTsMls("groupInfo.js");
const { defaultLifetime } = await daTsMls("lifetime.js");

const CIPHERSUITE = "MLS_128_DHKEMP256_AES128GCM_SHA256_P256";
const ETICHETTA_ARCHIVIO = "estia archive wrap v1";
const CASA = "casa-di-prova";
const cs = await mls.getCiphersuiteImpl(mls.getCiphersuiteFromName(CIPHERSUITE));
const te = new TextEncoder();
const td = new TextDecoder();
const esa = (b) => Buffer.from(b).toString("hex");
const daEsa = (s) => new Uint8Array(Buffer.from(s, "hex"));

// Il registro delle chiavi di firma, come lo terrebbe l'istanza. Il lato
// ts-mls autentica ogni foglia contro questo, come fa `gruppo.ts`.
const registro = new Map();
const uguali = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const config = {
  ...defaultClientConfig,
  authService: {
    async validateCredential(cred, chiave) {
      if (cred.credentialType !== "basic") return false;
      const ammessa = registro.get(td.decode(cred.identity));
      return ammessa !== undefined && uguali(ammessa, chiave);
    },
  },
};

const sulFilo = (c) => encodeMlsMessage({ version: "mls10", ...c });
const dalFilo = (b) => {
  const letto = decodeMlsMessage(b, 0);
  if (!letto) throw new Error("non è un MLSMessage");
  return letto[0];
};

/* ---------- un membro ts-mls ---------- */

class MembroTs {
  constructor(nome) {
    this.nome = nome;
    this.chi = `${nome}@${CASA}`;
    this.lato = "ts-mls";
  }
  async identita() {
    this.io = await mls.generateKeyPackage(
      { credentialType: "basic", identity: te.encode(this.chi) },
      mls.defaultCapabilities(),
      defaultLifetime,
      [],
      cs,
    );
    registro.set(this.chi, this.io.publicPackage.leafNode.signaturePublicKey);
    return sulFilo({ keyPackage: this.io.publicPackage, wireformat: "mls_key_package" });
  }
  async crea(gruppo) {
    this.stato = await mls.createGroup(
      te.encode(gruppo),
      this.io.publicPackage,
      this.io.privatePackage,
      [],
      cs,
      config,
    );
  }
  async commit(proposte) {
    const r = await mls.createCommit(
      { cipherSuite: cs, state: { ...this.stato, clientConfig: config } },
      { extraProposals: proposte, ratchetTreeExtension: true },
    );
    this.stato = r.newState;
    return {
      commit: encodeMlsMessage(r.commit),
      welcome: r.welcome && sulFilo({ welcome: r.welcome, wireformat: "mls_welcome" }),
    };
  }
  async aggiungi(kp) {
    const m = dalFilo(kp);
    assert.equal(m.wireformat, "mls_key_package");
    return this.commit([{ proposalType: "add", add: { keyPackage: m.keyPackage } }]);
  }
  async rimuovi(chi) {
    const foglia = this.stato.ratchetTree.findIndex(
      (n, i) =>
        i % 2 === 0 && n?.nodeType === "leaf" && td.decode(n.leaf.credential.identity) === chi,
    );
    assert.ok(foglia >= 0, `${chi} non è nell'albero`);
    return this.commit([{ proposalType: "remove", remove: { removed: foglia / 2 } }]);
  }
  async aggiorna() {
    return this.commit([]);
  }
  async entra(welcome) {
    const m = dalFilo(welcome);
    this.stato = await mls.joinGroup(
      m.welcome,
      this.io.publicPackage,
      this.io.privatePackage,
      mls.emptyPskIndex,
      cs,
      undefined,
      undefined,
      config,
    );
  }
  async punto() {
    const gi = await mls.createGroupInfoWithExternalPubAndRatchetTree(this.stato, [], cs);
    return sulFilo({ groupInfo: gi, wireformat: "mls_group_info" });
  }
  async rientra(punto) {
    const gi = dalFilo(punto).groupInfo;
    const r = await mls.joinGroupExternal(
      gi,
      this.io.publicPackage,
      this.io.privatePackage,
      false,
      cs,
      ratchetTreeFromExtension(gi),
      config,
    );
    this.stato = r.newState;
    return {
      commit: sulFilo({ publicMessage: r.publicMessage, wireformat: "mls_public_message" }),
    };
  }
  async cifra(testo) {
    const r = await mls.createApplicationMessage(this.stato, te.encode(testo), cs);
    this.stato = r.newState;
    return sulFilo({ privateMessage: r.privateMessage, wireformat: "mls_private_message" });
  }
  async applica(busta) {
    const m = dalFilo(busta);
    const msg =
      m.wireformat === "mls_private_message"
        ? { privateMessage: m.privateMessage, wireformat: m.wireformat }
        : { publicMessage: m.publicMessage, wireformat: m.wireformat };
    const r = await mls.processMessage(
      msg,
      { ...this.stato, clientConfig: config },
      mls.makePskIndex(this.stato, {}),
      mls.acceptAll,
      cs,
    );
    this.stato = r.newState;
    return r.kind === "applicationMessage"
      ? { kind: "messaggio", testo: td.decode(r.message) }
      : { kind: "commit" };
  }
  async stato_() {
    const serratura = await mls.mlsExporter(
      this.stato.keySchedule.exporterSecret,
      ETICHETTA_ARCHIVIO,
      new Uint8Array(),
      32,
      cs,
    );
    return {
      epoch: Number(this.stato.groupContext.epoch),
      autenticatore: esa(this.stato.keySchedule.epochAuthenticator),
      serratura: esa(serratura),
      membri: this.stato.ratchetTree
        .filter((n, i) => i % 2 === 0 && n?.nodeType === "leaf")
        .map((n) => td.decode(n.leaf.credential.identity)),
    };
  }
}

/* ---------- un membro OpenMLS, in un processo suo ---------- */

const PONTE = join(qui, "ponte/target/debug/spike-mls-ponte");

class MembroRust {
  constructor(nome) {
    this.nome = nome;
    this.chi = `${nome}@${CASA}`;
    this.lato = "OpenMLS";
    this.p = spawn(PONTE, [], { stdio: ["pipe", "pipe", "inherit"] });
    this.righe = createInterface({ input: this.p.stdout })[Symbol.asyncIterator]();
  }
  async chiedi(cmd, args = {}) {
    this.p.stdin.write(JSON.stringify({ cmd, ...args }) + "\n");
    const { value } = await this.righe.next();
    const r = JSON.parse(value);
    if (r.errore) throw new Error(`${this.nome} (OpenMLS) ${cmd}: ${r.errore}`);
    return r.ok;
  }
  async identita() {
    const r = await this.chiedi("identita", { membro: this.chi });
    const kp = daEsa(r.keyPackage);
    // La chiave di firma la si legge dal KeyPackage stesso, con ts-mls: è anche
    // la prova che i due lati la codificano uguale.
    registro.set(this.chi, dalFilo(kp).keyPackage.leafNode.signaturePublicKey);
    return kp;
  }
  async crea(gruppo) {
    await this.chiedi("crea", { gruppo });
  }
  async aggiungi(kp) {
    const r = await this.chiedi("aggiungi", { keyPackage: esa(kp) });
    return { commit: daEsa(r.commit), welcome: daEsa(r.welcome) };
  }
  async rimuovi(chi) {
    return { commit: daEsa((await this.chiedi("rimuovi", { membro: chi })).commit) };
  }
  async aggiorna() {
    return { commit: daEsa((await this.chiedi("aggiorna")).commit) };
  }
  async entra(welcome) {
    await this.chiedi("entra", { welcome: esa(welcome) });
  }
  async punto() {
    return daEsa((await this.chiedi("punto")).groupInfo);
  }
  async rientra(punto) {
    return { commit: daEsa((await this.chiedi("rientra", { groupInfo: esa(punto) })).commit) };
  }
  async cifra(testo) {
    return daEsa((await this.chiedi("cifra", { testo })).busta);
  }
  async applica(busta) {
    return this.chiedi("applica", { busta: esa(busta) });
  }
  async stato_() {
    return this.chiedi("stato");
  }
  chiudi() {
    this.p.stdin.end();
  }
}

/* ---------- la conversazione ---------- */

const esiti = [];
let gruppo = [];

async function controlla(passo) {
  const stati = await Promise.all(gruppo.map(async (m) => [m, await m.stato_()]));
  const [, primo] = stati[0];
  for (const [m, s] of stati) {
    assert.equal(s.epoch, primo.epoch, `${passo}: epoch di ${m.nome}`);
    assert.equal(
      s.autenticatore,
      primo.autenticatore,
      `${passo}: epoch_authenticator di ${m.nome}`,
    );
    assert.equal(s.serratura, primo.serratura, `${passo}: serratura d'archivio di ${m.nome}`);
    assert.deepEqual(
      [...s.membri].sort(),
      [...primo.membri].sort(),
      `${passo}: membri visti da ${m.nome}`,
    );
  }
  const lati = gruppo.map((m) => `${m.nome} (${m.lato})`).join(", ");
  esiti.push(`ok  ${passo}  [epoch ${primo.epoch}: ${lati}]`);
}

/** Il tolto non legge; i rimasti sì, così il messaggio è davvero valido. */
async function nonLegge(tolto, busta, rimasti) {
  const r = await tolto.applica(busta).catch((err) => ({ kind: "rifiutato", err }));
  assert.notEqual(r.kind, "messaggio", `${tolto.nome}, tolto, non deve decifrare`);
  for (const m of rimasti) assert.equal((await m.applica(busta)).kind, "messaggio");
}

/** Chi fa il commit lo ha già applicato; gli altri lo applicano. */
async function distribuisci(da, commit, esclusi = []) {
  for (const m of gruppo) {
    if (m === da || esclusi.includes(m)) continue;
    const r = await m.applica(commit);
    assert.equal(r.kind, "commit", `${m.nome} doveva vedere un commit`);
  }
}

async function parlaATutti(da, testo) {
  const busta = await da.cifra(testo);
  for (const m of gruppo) {
    if (m === da) continue;
    const r = await m.applica(busta);
    assert.equal(r.kind, "messaggio");
    assert.equal(r.testo, testo, `${m.nome} legge il messaggio di ${da.nome}`);
  }
}

const anna = new MembroTs("anna");
const bruno = new MembroRust("bruno");
const carla = new MembroTs("carla");
const dario = new MembroRust("dario");
const elena = new MembroTs("elena");
const tutti = [anna, bruno, carla, dario, elena];

try {
  const kp = {};
  for (const m of tutti) kp[m.nome] = await m.identita();

  // 1. ts-mls crea, OpenMLS entra dal Welcome.
  await anna.crea("conv-s7");
  gruppo = [anna];
  let r = await anna.aggiungi(kp.bruno);
  await bruno.entra(r.welcome);
  gruppo = [anna, bruno];
  await controlla("anna (ts) fa entrare bruno (Rust) con un Welcome");
  await parlaATutti(anna, "ciao bruno, da ts-mls");
  await parlaATutti(bruno, "ciao anna, da OpenMLS");
  esiti.push("ok  messaggi in entrambe le direzioni");

  // 2. OpenMLS fa entrare un client ts-mls; l'altro ts-mls applica il commit.
  r = await bruno.aggiungi(kp.carla);
  await distribuisci(bruno, r.commit);
  await carla.entra(r.welcome);
  gruppo = [anna, bruno, carla];
  await controlla("bruno (Rust) fa entrare carla (ts) e anna applica il commit");
  for (const m of gruppo) await parlaATutti(m, `tre in conversazione, scrive ${m.nome}`);

  // 3. Aggiornamenti di chiave da entrambi i lati (UpdatePath).
  r = await carla.aggiorna();
  await distribuisci(carla, r.commit);
  await controlla("carla (ts) aggiorna la propria foglia");
  r = await bruno.aggiorna();
  await distribuisci(bruno, r.commit);
  await controlla("bruno (Rust) aggiorna la propria foglia");

  // 4. Rientro con l'ingresso esterno, nei due sensi (S3 via A).
  let punto = await anna.punto();
  r = await dario.rientra(punto);
  await distribuisci(dario, r.commit);
  gruppo = [anna, bruno, carla, dario];
  await controlla("dario (Rust) entra da solo dal GroupInfo di anna (ts)");
  punto = await bruno.punto();
  r = await elena.rientra(punto);
  await distribuisci(elena, r.commit);
  gruppo = [anna, bruno, carla, dario, elena];
  await controlla("elena (ts) entra da sola dal GroupInfo di bruno (Rust)");
  for (const m of gruppo) await parlaATutti(m, `cinque in conversazione, scrive ${m.nome}`);

  // 5. Uscite, nei due sensi.
  // Chi viene tolto riceve anche lui il commit, come sul canale vero, e dopo
  // non deve più leggere niente: è la proprietà che il percorso nel commit di
  // rimozione esiste per dare (ts-mls 1.6.2 lo ometteva, vedi S7).
  r = await anna.rimuovi(dario.chi);
  await distribuisci(anna, r.commit);
  gruppo = [anna, bruno, carla, elena];
  await controlla("anna (ts) toglie dario (Rust)");
  await nonLegge(dario, await anna.cifra("dario non deve leggerlo"), [bruno, carla, elena]);
  esiti.push("ok  dario, tolto, non decifra più");

  r = await bruno.rimuovi(carla.chi);
  await distribuisci(bruno, r.commit);
  gruppo = [anna, bruno, elena];
  await controlla("bruno (Rust) toglie carla (ts)");
  await nonLegge(carla, await bruno.cifra("carla non deve leggerlo"), [anna, elena]);
  esiti.push("ok  carla, tolta, non decifra più");
  for (const m of gruppo) await parlaATutti(m, `di nuovo in tre, scrive ${m.nome}`);
  esiti.push("ok  messaggi dopo le uscite");

  console.log(esiti.join("\n"));
  console.log(`\nS7: interoperabili. Ciphersuite ${CIPHERSUITE}.`);
} catch (err) {
  console.log(esiti.join("\n"));
  console.error(`\nFALLITO: ${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  for (const m of tutti) if (m instanceof MembroRust) m.chiudi();
}
