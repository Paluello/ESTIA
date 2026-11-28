// L'archivio della conversazione fra il telefono e il browser.
//
// Da una parte il client web **vero**: `archivio.ts`, `gruppo.ts` e
// `sessione.ts` di `apps/web/src/mls`, con l'istanza finta dei suoi test. Dall'altra
// il nucleo delle app native (`apps/nucleo`), un dispositivo per processo,
// comandato a righe JSON dal confine che vedono Swift e Kotlin
// (`apps/nucleo/examples/ponte_archivio.rs`). Questo pilota fa l'app del
// telefono: porta le buste fra il nucleo e l'istanza, e non vede mai una chiave.
//
// Due parti:
//
// 1. il modulo, a chiavi scoperte: stessa serratura e stessa catena sui due
//    lati, voci e mazzi scritti da uno e letti dall'altro;
// 2. una conversazione vera: la serratura la deriva OpenMLS da una parte e
//    ts-mls dall'altra, e così la chiave che la catena guadagna a ogni
//    rimozione (ADR 0052 §2). È il punto in cui i due client si incontrano.
//
//   cargo build --manifest-path apps/nucleo/Cargo.toml --example ponte_archivio
//   node infra/prova-archivio/prova.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const radice = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const web = join(radice, "apps/web");
const sorgentiWeb = pathToFileURL(join(web, "src/")).href;

// I sorgenti del web si caricano così come sono: Node toglie i tipi da sé. Gli
// import fra moduli dicono `.js`, come vuole TypeScript, e i contratti si
// leggono dal sorgente, così la prova non dipende da una build.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@estia/contracts") {
      return {
        shortCircuit: true,
        url: pathToFileURL(join(radice, "packages/contracts/src/index.ts")).href,
      };
    }
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith(sorgentiWeb)
    ) {
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
    return next(specifier, context);
  },
});

const delWeb = (f) => import(pathToFileURL(join(web, "src/mls", f)).href);
const archivio = await delWeb("archivio.ts");
const gruppo = await delWeb("gruppo.ts");
const sessione = await delWeb("sessione.ts");
const finte = await delWeb("finte.ts");
const { decodeMlsMessage } = await import(
  pathToFileURL(join(web, "node_modules/ts-mls/dist/src/message.js")).href
);
const { gcm } = await import(pathToFileURL(join(web, "node_modules/@noble/ciphers/aes.js")).href);

const { CASA } = finte;
const b64 = (b) => Buffer.from(b).toString("base64");
const daB64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const impronta = (catena) => catena.map((c) => Buffer.from(c).toString("hex"));

const esiti = [];
const fatto = (che) => esiti.push(`ok  ${che}`);

/* ---------- il nucleo, in un processo suo ---------- */

const PONTE = join(radice, "apps/nucleo/target/debug/examples/ponte_archivio");
const ponti = [];

class Ponte {
  constructor() {
    this.p = spawn(PONTE, [], { stdio: ["pipe", "pipe", "inherit"] });
    this.righe = createInterface({ input: this.p.stdout })[Symbol.asyncIterator]();
    ponti.push(this);
  }
  async chiedi(cmd, args = {}) {
    this.p.stdin.write(JSON.stringify({ cmd, ...args }) + "\n");
    const { value } = await this.righe.next();
    const r = JSON.parse(value);
    if (r.errore !== undefined) throw new Error(`nucleo, ${cmd}: ${r.errore}`);
    return r.ok;
  }
  chiudi() {
    this.p.stdin.end();
  }
}

/* ================================================================== */
/* 1. Il modulo: stessa serratura, stessa catena                        */
/* ================================================================== */

async function ilModulo() {
  const nucleo = new Ponte();
  const serratura = randomBytes(32);
  const s = b64(serratura);
  const perIlNucleo = (catena) => catena.map(b64);
  const perIlWeb = (catena) => catena.map(daB64);

  // Una catena nata sul web, ruotata due volte: tre chiavi.
  const catena = archivio.catenaRuotata(archivio.catenaRuotata(archivio.catenaNuova()));
  const c = perIlNucleo(catena);

  // Il mazzo, nei due versi.
  const delWeb = archivio.avvolgi(catena, serratura);
  assert.deepEqual(await nucleo.chiedi("puro.svolgi", { mazzo: delWeb, serratura: s }), c);
  const delNucleo = await nucleo.chiedi("puro.avvolgi", { catena: c, serratura: s });
  assert.deepEqual(impronta(archivio.svolgi(delNucleo, serratura)), impronta(catena));
  fatto("il mazzo del web lo apre il nucleo, e quello del nucleo lo apre il web");

  // Non solo «si apre»: sotto il sigillo ci sono gli stessi byte.
  const sotto = (mazzo) => {
    const insieme = daB64(mazzo);
    return Buffer.from(gcm(serratura, insieme.subarray(0, 12)).decrypt(insieme.subarray(12)));
  };
  assert.deepEqual(sotto(delNucleo), sotto(delWeb));
  assert.equal(sotto(delNucleo).toString(), JSON.stringify(c));
  assert.equal(delNucleo.length, delWeb.length);
  fatto("sotto il sigillo, i due mazzi sono gli stessi byte");

  // Un'altra serratura non apre, da nessuna delle due parti.
  const altra = randomBytes(32);
  assert.throws(() => archivio.svolgi(delNucleo, altra));
  await assert.rejects(nucleo.chiedi("puro.svolgi", { mazzo: delWeb, serratura: b64(altra) }));

  // Una catena nata e ruotata nel nucleo, avvolta lì, aperta dal web.
  const nata = await nucleo.chiedi("puro.catenaRuotata", {
    catena: await nucleo.chiedi("puro.catenaNuova"),
  });
  assert.equal(nata.length, 2);
  assert.deepEqual(
    impronta(
      archivio.svolgi(
        await nucleo.chiedi("puro.avvolgi", { catena: nata, serratura: s }),
        serratura,
      ),
    ),
    impronta(perIlWeb(nata)),
  );
  fatto("una catena ruotata passa dal nucleo al web con tutte le sue chiavi");

  // Le voci semplici, nei due versi, con testi scelti per dare fastidio.
  const testi = [
    "i preventivi del tetto",
    "",
    "però, perché no? — «così» 🏠👨‍👩‍👧",
    "riga\nnuova\te \u0000 uno zero",
    "﻿comincia con un BOM",
    "x".repeat(20000),
  ];
  for (const testo of testi) {
    const scritta = await nucleo.chiedi("puro.archivia", { catena: c, testo });
    assert.equal(scritta.chiaveN, 3);
    assert.equal(
      archivio.rileggi(catena, scritta),
      new TextDecoder().decode(new TextEncoder().encode(testo)),
    );
    const voce = archivio.archivia(catena, testo);
    assert.equal(voce.chiaveN, 3);
    assert.equal(
      await nucleo.chiedi("puro.rileggi", { catena: c, voce }),
      archivio.rileggi(catena, voce),
    );
    // Stessa forma: IV, testo, tag, in base64 con il riempimento.
    assert.equal(scritta.busta.length, voce.busta.length);
  }
  fatto(`${testi.length} voci semplici scritte da un lato e lette dall'altro`);

  // Le voci legate: il legame è lo stesso sui due lati, byte per byte, anche
  // quando i campi hanno virgolette, barre, controlli e caratteri non ASCII.
  const legami = [
    {
      conversazioneId: "conv-1",
      createdAt: "2026-11-28T10:00:00.000Z",
      id: "m-1",
      mittente: `anna@${CASA}`,
    },
    {
      conversazioneId: 'a"b\\c/d',
      createdAt: "  \b\f\r\u007f",
      id: "riga\nnuova\ttab\u0001\u001f",
      mittente: "però@casa 🏠 <script>&'",
    },
    { conversazioneId: "", createdAt: "", id: "", mittente: "" },
  ];
  for (const legame of legami) {
    const altro = { ...legame, mittente: `${legame.mittente}x` };
    const testo = "detto da chi dice di averlo detto";

    const delNucleo = await nucleo.chiedi("puro.archivia", { catena: c, legame, testo });
    assert.deepEqual(archivio.rileggiLegata(catena, delNucleo, legame), { legata: true, testo });
    assert.equal(archivio.rileggiLegata(catena, delNucleo, altro), undefined);
    assert.equal(archivio.rileggiLegata(catena, delNucleo, undefined), undefined);
    assert.equal(archivio.rileggi(catena, delNucleo), undefined);

    const delWeb = archivio.archiviaLegata(catena, testo, legame);
    const chiedi = (l) =>
      nucleo.chiedi("puro.rileggiLegata", { catena: c, legame: l, voce: delWeb });
    assert.deepEqual(await chiedi(legame), { legata: true, testo });
    assert.equal(await chiedi(altro), null);
    assert.equal(await chiedi(null), null);
    assert.equal(await nucleo.chiedi("puro.rileggi", { catena: c, voce: delWeb }), null);
  }
  fatto(
    `${legami.length} legami: una voce legata si apre col suo, sui due lati, e con nessun altro`,
  );

  // Una voce di prima del legame si apre come non legata, da tutti e due.
  const diPrima = archivio.archivia(catena, "di prima");
  assert.deepEqual(
    await nucleo.chiedi("puro.rileggiLegata", { catena: c, legame: legami[0], voce: diPrima }),
    { legata: false, testo: "di prima" },
  );
  const diPrimaNucleo = await nucleo.chiedi("puro.archivia", { catena: c, testo: "di prima" });
  assert.deepEqual(archivio.rileggiLegata(catena, diPrimaNucleo, legami[0]), {
    legata: false,
    testo: "di prima",
  });
  fatto("una voce di prima del legame si apre come non legata");

  // La catena ruotata: chi ha le chiavi vecchie legge il pregresso e non il seguito.
  const vecchia = catena.slice(0, 2);
  const pregresso = await nucleo.chiedi("puro.archivia", {
    catena: perIlNucleo(vecchia),
    testo: "prima",
  });
  const seguito = await nucleo.chiedi("puro.archivia", { catena: c, testo: "dopo" });
  assert.equal(pregresso.chiaveN, 2);
  assert.equal(archivio.rileggi(vecchia, pregresso), "prima");
  assert.equal(archivio.rileggi(vecchia, seguito), undefined);
  assert.equal(archivio.rileggi(catena, pregresso), "prima");
  const seguitoWeb = archivio.archivia(catena, "dopo");
  const chiedi = (cat, voce) => nucleo.chiedi("puro.rileggi", { catena: perIlNucleo(cat), voce });
  assert.equal(await chiedi(vecchia, seguitoWeb), null);
  assert.equal(await chiedi(catena, seguitoWeb), "dopo");
  assert.equal(await chiedi(catena, archivio.archivia(vecchia, "prima")), "prima");
  fatto("dopo una rotazione: le chiavi vecchie leggono il pregresso e non il seguito");

  // Ciò che non si apre non diventa testo, e non fa cadere nessuno.
  for (const voce of [
    { busta: "abc", chiaveN: 99 },
    { busta: "abc", chiaveN: 0 },
    { busta: "abc", chiaveN: 1 },
    { busta: "", chiaveN: 1 },
    { busta: seguito.busta.slice(0, -4), chiaveN: 3 },
    { ...seguito, chiaveN: 2 },
  ]) {
    assert.equal(archivio.rileggi(catena, voce), undefined);
    assert.equal(await nucleo.chiedi("puro.rileggi", { catena: c, voce }), null);
  }
  fatto("una voce che non si apre è indefinita sul web e assente nel nucleo");
}

/* ================================================================== */
/* 2. Una conversazione: OpenMLS da una parte, ts-mls dall'altra        */
/* ================================================================== */

const CONV = "conv-archivio";
const istanza = finte.istanzaFinta();
const telefoni = [];

/** Una chiave di firma riconosciuta: lo sa l'istanza, e lo sa il registro di ogni telefono. */
async function ammetti(nome, chiave) {
  istanza.ammetti(nome, chiave);
  for (const t of telefoni) {
    await t.nucleo.chiedi("registra", { chiave: b64(chiave), membro: `${nome}@${CASA}` });
  }
}

/** Un `KeyPackage` del nucleo, come lo legge il web. */
function pacchettoPerIlWeb(byte) {
  const letto = decodeMlsMessage(byte, 0);
  assert.equal(letto?.[0].wireformat, "mls_key_package");
  return letto[0].keyPackage;
}

/** Un browser: il client web vero, con i doppi dei suoi test. */
class Browser {
  constructor(nome) {
    this.nome = nome;
    this.id = `u-${nome}`;
    this.membro = { casa: CASA, username: nome };
  }
  async nasce() {
    this.io = await finte.portachiaviFinto(this.nome);
    this.ctx = { deposito: finte.depositoFinto(), io: this.io, istanza: istanza.per(this.id) };
    await ammetti(this.nome, this.io.chiaveDiFirma);
  }
  async ingresso() {
    return { destinatario: this.id, keyPackage: await this.io.pubblica() };
  }
  /** Entra dal Welcome che il canale ha per lui. */
  async entra() {
    const { handshake } = await this.ctx.istanza.handshakeDopo(CONV);
    const welcome = handshake.findLast((h) => h.tipo === "welcome");
    assert.ok(welcome, `${this.nome} doveva trovare un Welcome`);
    this.sessione = await sessione.entra(this.ctx, CONV, welcome);
    assert.ok(this.sessione, `${this.nome} doveva entrare`);
  }
  async sincronizza() {
    this.sessione = await sessione.sincronizza(this.ctx, this.sessione);
  }
  async scrive(id, testo, quando) {
    await sessione.invia(this.ctx, this.sessione, testo, id, quando);
  }
  async cronologia() {
    return (await sessione.cronologia(this.ctx, this.sessione)).righe;
  }
}

/** Un telefono: il nucleo, e l'app che gli porta le buste. */
class Telefono {
  constructor(nome) {
    this.nome = nome;
    this.id = `u-${nome}`;
    this.chi = `${nome}@${CASA}`;
    this.membro = { casa: CASA, username: nome };
    this.nucleo = new Ponte();
    this.vista = istanza.per(this.id);
    this.dentro = false;
    this.tolto = false;
    telefoni.push(this);
  }
  chiedi(cmd, args = {}) {
    return this.nucleo.chiedi(cmd, { conv: CONV, ...args });
  }
  async nasce() {
    const { chiaveDiFirma } = await this.chiedi("apri", { membro: this.chi });
    await ammetti(this.nome, daB64(chiaveDiFirma));
  }
  async ingresso() {
    const { keyPackage } = await this.chiedi("pacchetto");
    return { destinatario: this.id, keyPackage: pacchettoPerIlWeb(daB64(keyPackage)) };
  }
  /** Il mazzo dell'istanza, se è dell'epoch in cui si è. */
  async apreIlMazzo() {
    const avvolto = await this.vista.mazzo(CONV);
    return avvolto !== undefined && (await this.chiedi("apriMazzo", avvolto));
  }
  /** Dopo un cambio di epoch: chi conosce il mazzo lo riavvolge e lo deposita. */
  async depositaIlMazzo() {
    const avvolto = await this.chiedi("mazzo");
    if (avvolto !== null) await this.vista.salvaMazzo(CONV, avvolto);
    return avvolto;
  }
  /** Ciò che `sincronizza` fa sul web: gli handshake in ordine, poi il mazzo. */
  async sincronizza() {
    const { handshake } = await this.vista.handshakeDopo(CONV, this.cursore);
    let mutato = false;
    for (const h of handshake) {
      if (h.tipo === "welcome") {
        if (!this.dentro) {
          assert.deepEqual(await this.chiedi("entra", { welcome: h.busta }), { conv: CONV });
          this.dentro = true;
        }
      } else if (this.dentro && !this.tolto && h.epoch > (await this.chiedi("epoch"))) {
        const r = await this.chiedi("applica", { busta: h.busta });
        mutato = true;
        this.tolto = r.kind === "uscito";
      }
      this.cursore = h.id;
    }
    if (this.tolto) return;
    if (mutato) await this.depositaIlMazzo();
    if (!(await this.chiedi("haArchivio"))) await this.apreIlMazzo();
  }
  /** Un commit proprio: in fila, e poi il mazzo sotto l'epoch nuova. */
  async deposita(esito) {
    await this.vista.depositaHandshake(CONV, {
      busta: esito.commit,
      epoch: esito.epoch,
      tipo: "commit",
    });
    return this.depositaIlMazzo();
  }
  async scrive(id, testo, quando) {
    const voce = await this.chiedi("archivia", { creatoIl: quando, id, testo });
    await this.vista.depositaArchivio(CONV, [{ ...voce, createdAt: quando, id }]);
    return voce;
  }
  /** Le righe come le fa `cronologia` sul web. */
  async cronologia() {
    const { righe } = await this.vista.cronologia(CONV);
    return Promise.all(
      righe.map(async (riga) => {
        const riletta = await this.chiedi("rileggi", {
          dichiarato:
            riga.mittente === null
              ? null
              : { creatoIl: riga.createdAt, id: riga.id, mittente: riga.mittente },
          voce: riga.voce,
        });
        const base = { createdAt: riga.createdAt, id: riga.id, mittente: riga.mittente };
        return riletta === null
          ? { ...base, stato: "non-si-apre" }
          : { ...base, attestata: riletta.legata, stato: "letta", testo: riletta.testo };
      }),
    );
  }
}

const quando = (n) => `2026-11-28T10:${String(n).padStart(2, "0")}:00.000Z`;
const riga = (righe, id) => righe.find((r) => r.id === id);

/** Tutti quelli che ci sono leggono le stesse righe, attestate. */
async function leggonoTutti(chi, attese) {
  for (const m of chi) {
    const righe = await m.cronologia();
    for (const [id, mittente, testo] of attese) {
      assert.deepEqual(
        riga(righe, id),
        {
          attestata: true,
          createdAt: riga(righe, id)?.createdAt,
          id,
          mittente: `${mittente}@${CASA}`,
          stato: "letta",
          testo,
        },
        `${m.nome} legge ${id}`,
      );
    }
  }
}

async function laConversazione() {
  const anna = new Browser("anna");
  const bruno = new Telefono("bruno");
  const carla = new Browser("carla");
  const dario = new Telefono("dario");
  const elena = new Browser("elena");
  for (const m of [anna, bruno, carla, dario, elena]) await m.nasce();
  const epoch = (m) => Number(m.sessione.stato.groupContext.epoch);
  const scritte = [];

  // --- anna (web) apre con bruno (nucleo) e carla (web) ---
  anna.sessione = await sessione.apriCon(anna.ctx, CONV, [
    await bruno.ingresso(),
    await carla.ingresso(),
  ]);
  await carla.entra();
  await bruno.sincronizza();
  assert.equal(await bruno.chiedi("epoch"), epoch(anna));
  // Il mazzo l'ha avvolto il web, sotto la serratura che deriva ts-mls: il
  // nucleo lo apre con quella che deriva OpenMLS.
  assert.equal(await bruno.chiedi("haArchivio"), true);
  fatto("il mazzo avvolto dal web (ts-mls) lo apre il nucleo (OpenMLS), entrando dal Welcome");

  await anna.scrive("m-1", "ciao dal browser", quando(1));
  scritte.push(["m-1", "anna", "ciao dal browser"]);
  const diBruno = await bruno.scrive("m-2", "ciao dal telefono — però 🏠", quando(2));
  scritte.push(["m-2", "bruno", "ciao dal telefono — però 🏠"]);
  assert.equal(diBruno.chiaveN, 1);
  await leggonoTutti([anna, bruno, carla], scritte);
  fatto("una voce del browser la legge il telefono, e una del telefono il browser, attestate");

  // Una voce di prima del legame, com'erano fino ad ADR 0052.
  const diPrima = archivio.archivia(anna.sessione.catena, "di prima del legame");
  await anna.ctx.istanza.depositaArchivio(CONV, [{ ...diPrima, createdAt: quando(0), id: "m-0" }]);
  const vista = riga(await bruno.cronologia(), "m-0");
  assert.equal(vista.testo, "di prima del legame");
  assert.equal(vista.attestata, false);
  fatto("una voce di prima del legame il telefono la apre, e dice che non è attestata");

  // Una casa che mente su chi ha scritto, o quando: la voce non si apre, da
  // nessuno dei due lati, chiunque l'abbia scritta.
  for (const [id, falso] of [
    ["m-1", { mittente: `carla@${CASA}` }],
    ["m-1", { createdAt: quando(59) }],
    ["m-2", { mittente: `anna@${CASA}` }],
    ["m-2", { createdAt: quando(59) }],
  ]) {
    istanza.falsifica(CONV, id, falso);
    assert.equal(riga(await bruno.cronologia(), id).stato, "non-si-apre", `bruno, ${id}`);
    assert.equal(riga(await carla.cronologia(), id).stato, "non-si-apre", `carla, ${id}`);
    istanza.falsifica(CONV, id, {});
  }
  await leggonoTutti([bruno, carla], scritte);
  fatto("se la casa cambia mittente o data, la voce non si apre: né sul telefono né sul browser");

  // --- il punto: il mazzo lo avvolge OpenMLS, e lo apre ts-mls ---
  // bruno fa un commit suo e riavvolge il mazzo sotto l'epoch nuova. Nessun
  // browser ha ancora visto quell'epoch.
  const diOpenMls = await bruno.deposita(await bruno.chiedi("aggiorna"));
  assert.deepEqual(istanza.mazzo(CONV), diOpenMls);
  assert.equal(diOpenMls.epoch, epoch(anna) + 1);

  // carla riparte come una scheda appena aperta: non ha una catena in mano, e
  // la riceve dal mazzo che c'è — quello del nucleo.
  const riavvolti = istanza.chiamate.salvaMazzo;
  carla.sessione = await sessione.riprendi(carla.ctx, CONV);
  assert.equal(istanza.chiamate.salvaMazzo, riavvolti, "nessun browser ha riavvolto");
  assert.equal(epoch(carla), diOpenMls.epoch);
  assert.deepEqual(impronta(carla.sessione.catena), impronta(anna.sessione.catena));
  // E lo stesso, detto senza la sessione di mezzo.
  assert.deepEqual(
    impronta(
      archivio.svolgi(diOpenMls.mazzo, await gruppo.serraturaArchivio(carla.sessione.stato)),
    ),
    impronta(anna.sessione.catena),
  );
  await anna.sincronizza();
  await leggonoTutti([anna, bruno, carla], scritte);
  fatto(
    `il mazzo avvolto dal nucleo (OpenMLS) lo apre il web con la serratura di ts-mls, epoch ${diOpenMls.epoch}`,
  );

  // --- entrano dario (nucleo) ed elena (web) ---
  anna.sessione = await sessione.aggiungiFoglie(anna.ctx, anna.sessione, dario.membro, [
    await dario.ingresso(),
  ]);
  anna.sessione = await sessione.aggiungiFoglie(anna.ctx, anna.sessione, elena.membro, [
    await elena.ingresso(),
  ]);
  await elena.entra();
  for (const m of [bruno, carla, dario]) await m.sincronizza();
  assert.equal(await dario.chiedi("haArchivio"), true);
  // Chi è entrato dopo legge anche il pregresso (ADR 0037 §4).
  await leggonoTutti([dario, elena], scritte);
  fatto("chi entra dopo, telefono o browser, legge anche il pregresso");

  // --- il web toglie carla: la catena ruota, uguale per tutti ---
  const catenaDiCarla = carla.sessione.catena;
  anna.sessione = await sessione.togliFoglie(anna.ctx, anna.sessione, carla.membro);
  assert.equal(anna.sessione.catena.length, 2);
  // I telefoni applicano il commit e derivano la chiave da sé; bruno riavvolge.
  await bruno.sincronizza();
  await dario.sincronizza();
  const dopoCarla = istanza.mazzo(CONV);
  assert.equal(dopoCarla.epoch, epoch(anna));
  await elena.sincronizza();
  assert.equal(elena.sessione.catena.length, 2);
  // Il mazzo che il nucleo ha riavvolto contiene la chiave che ts-mls ha
  // derivato per conto suo: `estia archive chain v1` è la stessa sui due lati.
  assert.deepEqual(
    impronta(
      archivio.svolgi(dopoCarla.mazzo, await gruppo.serraturaArchivio(elena.sessione.stato)),
    ),
    impronta(anna.sessione.catena),
  );
  assert.deepEqual(impronta(elena.sessione.catena), impronta(anna.sessione.catena));

  await anna.scrive("m-3", "dopo che carla è uscita", quando(3));
  const m4 = await dario.scrive("m-4", "lo dice un telefono", quando(4));
  assert.equal(m4.chiaveN, 2);
  scritte.push(["m-3", "anna", "dopo che carla è uscita"], ["m-4", "dario", "lo dice un telefono"]);
  await leggonoTutti([anna, bruno, dario, elena], scritte);

  // carla ha tenuto la catena di prima: legge il pregresso, non il seguito.
  const righe = (await istanza.per(carla.id).cronologia(CONV)).righe;
  const conLaVecchia = (id) => {
    const r = riga(righe, id);
    return archivio.rileggiLegata(catenaDiCarla, r.voce, {
      conversazioneId: CONV,
      createdAt: r.createdAt,
      id,
      mittente: r.mittente,
    });
  };
  assert.equal(conLaVecchia("m-2")?.testo, "ciao dal telefono — però 🏠");
  assert.equal(conLaVecchia("m-3"), undefined);
  assert.equal(conLaVecchia("m-4"), undefined);
  await carla.sincronizza();
  assert.equal(carla.sessione.tolto, true);
  fatto(
    "il web toglie carla: telefoni e browser derivano la stessa chiave nuova, e carla non legge il seguito",
  );

  // --- il nucleo toglie dario: la catena ruota di nuovo ---
  const dopoDario = await bruno.deposita(await bruno.chiedi("rimuovi", { membro: dario.chi }));
  await anna.sincronizza();
  await elena.sincronizza();
  assert.equal(anna.sessione.catena.length, 3);
  assert.deepEqual(
    impronta(archivio.svolgi(dopoDario.mazzo, await gruppo.serraturaArchivio(anna.sessione.stato))),
    impronta(anna.sessione.catena),
  );
  assert.deepEqual(impronta(elena.sessione.catena), impronta(anna.sessione.catena));

  const m5 = await bruno.scrive("m-5", "dopo che dario è uscito", quando(5));
  assert.equal(m5.chiaveN, 3);
  await elena.scrive("m-6", "lo leggiamo in tre", quando(6));
  scritte.push(["m-5", "bruno", "dopo che dario è uscito"], ["m-6", "elena", "lo leggiamo in tre"]);
  await leggonoTutti([anna, bruno, elena], scritte);

  // dario, tolto: il nucleo non gli lascia la catena, come la sessione del web.
  await dario.sincronizza();
  assert.equal(dario.tolto, true);
  assert.equal(await dario.chiedi("haArchivio"), false);
  assert.equal(await dario.chiedi("mazzo"), null);
  for (const r of await dario.cronologia()) assert.equal(r.stato, "non-si-apre");
  await assert.rejects(dario.chiedi("archivia", { creatoIl: quando(7), id: "m-7", testo: "x" }));
  fatto(
    "il nucleo toglie dario: i browser derivano la stessa chiave nuova, e dario non legge né scrive",
  );

  // --- lo stato del nucleo passa dal deposito ---
  await bruno.chiedi("riapri");
  await leggonoTutti([bruno], scritte);
  assert.equal((await bruno.scrive("m-8", "riaperto", quando(8))).chiaveN, 3);
  scritte.push(["m-8", "bruno", "riaperto"]);
  await leggonoTutti([anna, elena], scritte);
  fatto("riaperto dal deposito, il telefono ha ancora la catena intera");
}

try {
  await ilModulo();
  await laConversazione();
  console.log(esiti.join("\n"));
  console.log(
    "\nArchivio: il nucleo e il web leggono e scrivono le stesse voci e gli stessi mazzi.",
  );
} catch (err) {
  console.log(esiti.join("\n"));
  console.error(`\nFALLITO: ${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  for (const p of ponti) p.chiudi();
}
