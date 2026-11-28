// Una conversazione vera fra il telefono e il browser, sessione contro sessione.
//
// Da una parte il client web **vero**: `conversazione.ts` e `sessione.ts` di
// `apps/web/src/mls`, con ts-mls sotto e l'istanza finta dei loro test.
// Dall'altra la sessione del nucleo delle app native (`apps/nucleo`, OpenMLS):
// lo stesso `Motore` che sta dentro `Sessioni`, sopra la stessa
// `IstanzaSuCasa`, un dispositivo per processo
// (`apps/nucleo/examples/ponte_sessione.rs`).
//
// Il nucleo parla con la Casa da sé: ogni sua richiesta arriva qui com'è sul
// filo (metodo, percorso, corpo) e questo pilota fa la Casa. Ogni corpo che il
// nucleo manda e ogni risposta che riceve si confrontano con gli schemi di
// `packages/contracts`, quelli con cui `apps/core-api` valida le stesse rotte.
// Ciò che conta per MLS (la fila degli handshake, il mazzo, il punto di
// rientro, l'archivio, il registro delle chiavi) sta nella stessa istanza
// finta che usa il web: i due client si incontrano lì.
//
//   cargo build --manifest-path apps/nucleo/Cargo.toml --example ponte_sessione
//   node --experimental-transform-types infra/prova-sessione/prova.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as aspetta } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// `conversazione.ts` ha una proprietà dichiarata nel costruttore: a Node non
// basta togliere i tipi, li deve trasformare.
if (process.features.typescript !== "transform") {
  console.error("lancia con: node --experimental-transform-types infra/prova-sessione/prova.mjs");
  process.exit(2);
}

const radice = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const web = join(radice, "apps/web");
const sorgentiWeb = pathToFileURL(join(web, "src/")).href;
const contrattiUrl = pathToFileURL(join(radice, "packages/contracts/src/index.ts")).href;

// I sorgenti del web si caricano così come sono: Node toglie i tipi da sé. Gli
// import fra moduli dicono `.js`, come vuole TypeScript, e i contratti si
// leggono dal sorgente, così la prova non dipende da una build.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@estia/contracts") {
      return { shortCircuit: true, url: contrattiUrl };
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
const { codiceDi } = await import(
  pathToFileURL(join(web, "src/screens/impostazioni/codice-dispositivo.ts")).href
);
const conversazione = await delWeb("conversazione.ts");
const finte = await delWeb("finte.ts");
const contratti = await import(contrattiUrl);
const { decodeMlsMessage, encodeMlsMessage } = await import(
  pathToFileURL(join(web, "node_modules/ts-mls/dist/src/message.js")).href
);

// Ajv è quello di Fastify: lo stesso validatore che la Casa vera mette davanti
// a queste rotte. Si trova passando da lui, senza nominare una versione.
const daCoreApi = createRequire(join(radice, "apps/core-api/package.json"));
const daFastify = createRequire(daCoreApi.resolve("fastify"));
const daCompilatore = createRequire(daFastify.resolve("@fastify/ajv-compiler"));
const Ajv = daCompilatore("ajv");
const ajv = new (Ajv.default ?? Ajv)({ allErrors: true, strict: false, validateFormats: false });

const { CASA } = finte;
const ALGORITMO = "MLS-P256-v1";
const b64 = (b) => Buffer.from(b).toString("base64");
const daB64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

const esiti = [];
const fatto = (che) => esiti.push(`ok  ${che}`);

/* ================================================================== */
/* La Casa del pilota                                                   */
/* ================================================================== */

const istanza = finte.istanzaFinta();
const idDi = (username) => `u-${username}`;
const nomeDi = (id) => id.slice(2);
const indirizzo = (username) => `${username}@${CASA}`;

/** Le persone, i loro dispositivi e le conversazioni: ciò che di MLS non è. */
const casa = {
  conversazioni: new Map(),
  dispositivi: [],
  persone: new Map(),
  prossima: 0,
  /** L'ultima sfida data a ciascuna persona, che si usa una volta. */
  sfide: new Map(),
  /** Le prove di possesso arrivate dal nucleo, e quante la Casa avrebbe accettato. */
  prove: { arrivate: 0, valide: 0 },
};

/**
 * Le chiavi tolte da qualcuno: il registro del web non sa revocare, e il
 * pilota le toglie da ciò che risponde, a chi lo chiede dal filo come a chi lo
 * chiede dai doppi del web.
 */
const revocate = new Set();
const senzaRevocate = (chiavi) => chiavi.filter((k) => !revocate.has(b64(k)));

/** L'inizio DER di una chiave P-256 non compressa: quello di `apps/core-api`. */
const SPKI_P256 = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

/**
 * `firmaValida` di `apps/core-api/src/dispositivi/service.ts`: la firma ECDSA
 * P-256, DER, di `messaggio` con la privata di `publicKey`. È così che la Casa
 * vera controlla la prova che il nucleo firma con OpenMLS.
 */
function firmaValida(publicKey, messaggio, firma) {
  try {
    const chiave = createPublicKey({
      format: "der",
      key: Buffer.concat([SPKI_P256, Buffer.from(publicKey, "base64")]),
      type: "spki",
    });
    return verify(
      "sha256",
      Buffer.from(messaggio, "utf8"),
      { dsaEncoding: "der", key: chiave },
      Buffer.from(firma, "base64"),
    );
  } catch {
    return false;
  }
}

/** Chi chiede dal filo: un dispositivo che ha il sì, e che nessuno ha tolto. */
function approvato(dispositivo) {
  if (
    dispositivo === undefined ||
    dispositivo.approvatoIl === null ||
    dispositivo.revokedAt !== null
  ) {
    throw new Rifiuto(403, "device_not_approved");
  }
}

/** Il dispositivo della persona, com'è nell'elenco: senza la scorta. */
const comeInElenco = (dispositivo) => {
  const elencato = { ...dispositivo };
  delete elencato.pacchetti;
  return elencato;
};

/** Le domande che il nucleo ha fatto, per guardarle dalla prova. */
const viste = [];

/**
 * Le voci ritirate (`DELETE …/archivio/:voce`): l'istanza finta del web non
 * ritira, e il pilota le toglie dalla cronologia di tutti, browser compresi.
 */
const ritirate = new Set();
const senzaRitirate = (pagina) => ({
  ...pagina,
  righe: pagina.righe.filter((r) => !ritirate.has(r.id)),
});

class Rifiuto extends Error {
  constructor(stato, code) {
    super(code);
    this.stato = stato;
    this.code = code;
  }
}

const validatori = new Map();
function conforme(schema, valore, che) {
  let valida = validatori.get(schema);
  if (valida === undefined) {
    valida = ajv.compile(schema);
    validatori.set(schema, valida);
  }
  assert.ok(valida(valore), `${che}: ${ajv.errorsText(valida.errors)} — ${JSON.stringify(valore)}`);
  return valore;
}

const unaConversazione = {
  type: "object",
  additionalProperties: false,
  required: ["conversazione"],
  properties: { conversazione: contratti.conversazioneViewSchema },
};
const leConversazioni = {
  type: "object",
  additionalProperties: false,
  required: ["conversazioni"],
  properties: {
    conversazioni: { type: "array", items: contratti.conversazioneViewSchema },
  },
};

function persona(username) {
  const id = idDi(username);
  if (!casa.persone.has(id)) {
    casa.persone.set(id, {
      displayName: username[0].toUpperCase() + username.slice(1),
      id,
      username,
    });
  }
  return casa.persone.get(id);
}

/** Registra una chiave di firma. Il primo dispositivo di una persona si approva da sé. */
function registra(utente, chiave) {
  let dispositivo = casa.dispositivi.find((d) => d.userId === utente && d.publicKey === chiave);
  if (dispositivo === undefined) {
    const adesso = new Date().toISOString();
    const primo = !casa.dispositivi.some((d) => d.userId === utente);
    dispositivo = {
      algorithm: ALGORITMO,
      approvatoIl: primo ? adesso : null,
      createdAt: adesso,
      id: `d-${casa.dispositivi.length + 1}`,
      pacchetti: [],
      publicKey: chiave,
      revokedAt: null,
      sessionId: `s-${casa.dispositivi.length + 1}`,
      userId: utente,
    };
    casa.dispositivi.push(dispositivo);
    if (primo) {
      istanza.ammetti(nomeDi(utente), daB64(chiave));
    }
  }
  return dispositivo;
}

/** La revoca: la chiave esce dal registro, per sempre. */
function revoca(dispositivo) {
  dispositivo.revokedAt = new Date().toISOString();
  revocate.add(dispositivo.publicKey);
}

/** Un `KeyPackage` per ogni dispositivo approvato di quella persona: monouso. */
function preleva(utente) {
  const presi = [];
  for (const d of casa.dispositivi) {
    if (
      d.userId === utente &&
      d.approvatoIl !== null &&
      d.revokedAt === null &&
      d.pacchetti.length > 0
    ) {
      presi.push({ deviceId: d.id, keyPackage: d.pacchetti.shift() });
    }
  }
  return presi;
}

function vistaDi(conv) {
  return {
    createdAt: conv.createdAt,
    id: conv.id,
    membri: conv.membri.map((id) => ({ ...casa.persone.get(id) })),
    nonLetti: 0,
    ordinataQui: true,
    tipo: conv.tipo,
    ...(conv.tipo === "gruppo"
      ? { nome: conv.nome, rimossi: [...conv.rimossi], ruoli: { ...conv.ruoli } }
      : {}),
  };
}

function nuovaConversazione(tipo, creatore, altri, nome) {
  casa.prossima += 1;
  const conv = {
    createdAt: new Date().toISOString(),
    id: `conv-${casa.prossima}`,
    membri: [creatore, ...altri],
    nome,
    rimossi: [],
    ruoli: Object.fromEntries([[creatore, "creatore"], ...altri.map((id) => [id, "membro"])]),
    tipo,
  };
  casa.conversazioni.set(conv.id, conv);
  return conv;
}

function diretta(chi, conChi) {
  const gia = [...casa.conversazioni.values()].find(
    (c) => c.tipo === "diretta" && c.membri.includes(chi) && c.membri.includes(conChi),
  );
  return gia ?? nuovaConversazione("diretta", chi, [conChi]);
}

function ammetteNelGruppo(conv, id) {
  if (!conv.membri.includes(id)) {
    conv.membri.push(id);
    conv.ruoli[id] = "membro";
  }
  conv.rimossi = conv.rimossi.filter((r) => r !== indirizzo(nomeDi(id)));
}

function toglieDalGruppo(conv, id) {
  conv.membri = conv.membri.filter((m) => m !== id);
  delete conv.ruoli[id];
  conv.rimossi.push(indirizzo(nomeDi(id)));
}

/** Chi non è nella conversazione non ne legge niente; chi è stato tolto lo sa. */
function membroDi(idConv, chi) {
  const conv = casa.conversazioni.get(idConv);
  if (conv === undefined) throw new Rifiuto(404, "not_found");
  if (!conv.membri.includes(chi)) {
    throw new Rifiuto(
      403,
      conv.rimossi.includes(indirizzo(nomeDi(chi))) ? "rimosso_dal_gruppo" : "non_membro",
    );
  }
  return conv;
}

function cercata(corpo) {
  const id = idDi(corpo.username);
  if (corpo.casa !== undefined && corpo.casa !== CASA) throw new Rifiuto(404, "not_found");
  if (!casa.persone.has(id)) throw new Rifiuto(404, "user_not_found");
  return id;
}

/**
 * Una richiesta del nucleo, come la riceverebbe `apps/core-api`: le stesse
 * rotte, gli stessi corpi, gli stessi codici.
 */
async function rotta(chi, metodo, url, corpo, telefono) {
  const pezzi = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  assert.deepEqual(pezzi.slice(0, 2), ["api", "v1"], `rotta fuori dall'API: ${url.pathname}`);
  const [, , zona, ...resto] = pezzi;
  const dove = `${metodo} /${[zona, ...resto].join("/")}`;
  const vista = istanza.per(chi);

  if (dove === "GET /auth/me") {
    return conforme(
      contratti.authenticatedUserSchema,
      {
        ...casa.persone.get(chi),
        appearance: {
          aspetto: contratti.ASPETTI[0],
          contrasto: contratti.CONTRASTI[0],
          palette: contratti.PALETTE[0],
        },
        role: "member",
      },
      dove,
    );
  }
  if (dove === "GET /mls/casa") {
    return conforme(contratti.casaViewSchema, { casa: CASA }, dove);
  }
  if (dove === "POST /dispositivi/sfida") {
    const sfida = {
      scadeIl: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      sfida: randomBytes(32).toString("base64url"),
    };
    casa.sfide.set(chi, sfida.sfida);
    return conforme(contratti.sfidaViewSchema, sfida, dove);
  }
  if (dove === "POST /dispositivi/chiave") {
    conforme(contratti.registerDeviceKeyRequestSchema, corpo, dove);
    assert.equal(corpo.algorithm, ALGORITMO);
    // La prova di possesso: la sfida si consuma, e la firma si controlla come
    // la controlla la Casa vera.
    const sfida = casa.sfide.get(chi);
    casa.sfide.delete(chi);
    if (corpo.prova !== undefined) {
      casa.prove.arrivate += 1;
      if (
        sfida !== undefined &&
        firmaValida(
          corpo.publicKey,
          contratti.messaggioDiProvaChiave(sfida, corpo.publicKey),
          corpo.prova,
        )
      ) {
        casa.prove.valide += 1;
      }
    }
    const registrato = registra(chi, corpo.publicKey);
    if (telefono !== undefined) telefono.dispositivo = registrato;
    return conforme(
      contratti.registerDeviceKeyResponseSchema,
      { device: comeInElenco(registrato) },
      dove,
    );
  }
  if (dove === "POST /dispositivi/key-packages") {
    conforme(contratti.publishKeyPackagesRequestSchema, corpo, dove);
    // I KeyPackage vanno al dispositivo della sessione che li pubblica.
    const dispositivo = telefono?.dispositivo;
    if (dispositivo === undefined) throw new Rifiuto(404, "no_device_key");
    dispositivo.pacchetti.push(...corpo.keyPackages);
    return { count: corpo.keyPackages.length };
  }
  if (dove === "GET /dispositivi") {
    const suoi = casa.dispositivi.filter((d) => d.userId === chi).map(comeInElenco);
    return conforme(contratti.dispositiviResponseSchema, { dispositivi: suoi }, dove);
  }
  if (dove === "GET /auth/sessions") {
    // Il no della Casa chiude anche la sessione: un revocato non c'è più.
    const aperte = casa.dispositivi
      .filter((d) => d.userId === chi && d.revokedAt === null)
      .map((d) => ({
        createdAt: d.createdAt,
        current: d === telefono?.dispositivo,
        deviceLabel: `Telefono ${d.id}`,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        id: d.sessionId,
        lastSeenAt: new Date().toISOString(),
      }));
    return conforme(contratti.sessionListSchema, { sessions: aperte }, dove);
  }
  if (
    metodo === "POST" &&
    zona === "dispositivi" &&
    resto.length === 2 &&
    ["approva", "rifiuta"].includes(resto[1])
  ) {
    // Il sì e il no (`…/:id/approva`, `…/:id/rifiuta`): soltanto da un
    // dispositivo che ha il sì, e soltanto per un dispositivo proprio.
    approvato(telefono?.dispositivo);
    const d = casa.dispositivi.find((x) => x.id === resto[0] && x.userId === chi);
    if (d === undefined) throw new Rifiuto(404, "device_not_found");
    if (resto[1] === "approva") {
      if (d.approvatoIl === null) {
        d.approvatoIl = new Date().toISOString();
        istanza.ammetti(nomeDi(chi), daB64(d.publicKey));
      }
      return conforme(contratti.registerDeviceKeyResponseSchema, { device: comeInElenco(d) }, dove);
    }
    revoca(d);
    return { ok: true };
  }
  if (dove === "POST /dispositivi/miei/key-packages") {
    conforme(contratti.mieiKeyPackagesRequestSchema, corpo, dove);
    approvato(telefono?.dispositivo);
    const presi = casa.dispositivi
      .filter((d) => d.userId === chi && d.approvatoIl !== null && d.revokedAt === null)
      .filter((d) => corpo.chiaviDiFirma.includes(d.publicKey) && d.pacchetti.length > 0)
      .map((d) => ({ deviceId: d.id, keyPackage: d.pacchetti.shift() }));
    return conforme(contratti.keyPackagesMlsViewSchema, { keyPackages: presi }, dove);
  }
  if (metodo === "GET" && zona === "mls" && resto[0] === "chiavi" && resto.length === 3) {
    const chiavi = senzaRevocate(
      await vista.chiaviDiFirmaDi({ casa: resto[1], username: resto[2] }),
    );
    return conforme(
      contratti.chiaviDiFirmaViewSchema,
      { chiavi: chiavi.map((k) => ({ algorithm: ALGORITMO, publicKey: b64(k) })) },
      dove,
    );
  }
  if (metodo === "GET" && zona === "mls" && resto[0] === "key-packages" && resto.length === 3) {
    assert.equal(resto[1], CASA);
    const presi = preleva(idDi(resto[2]));
    if (presi.length === 0) throw new Rifiuto(404, "no_device_available");
    return conforme(contratti.keyPackagesMlsViewSchema, { keyPackages: presi }, dove);
  }
  if (dove === "GET /conversazioni") {
    const mie = [...casa.conversazioni.values()].filter((c) => c.membri.includes(chi));
    return conforme(leConversazioni, { conversazioni: mie.map((c) => vistaDi(c)) }, dove);
  }
  if (dove === "POST /conversazioni") {
    conforme(contratti.createConversazioneRequestSchema, corpo, dove);
    assert.equal(corpo.remoteInstanceKey, undefined);
    const conv = diretta(chi, cercata({ username: corpo.recipientUsername }));
    return conforme(unaConversazione, { conversazione: vistaDi(conv) }, dove);
  }
  if (dove === "POST /gruppi") {
    conforme(contratti.creaGruppoRequestSchema, corpo, dove);
    const conv = nuovaConversazione("gruppo", chi, corpo.membri.map(cercata), corpo.nome);
    return conforme(unaConversazione, { conversazione: vistaDi(conv) }, dove);
  }

  if (zona !== "conversazioni" || resto.length === 0) {
    throw new Rifiuto(404, "not_found");
  }
  const [idConv, cosa, ...coda] = resto;
  const conv = membroDi(idConv, chi);
  const qui =
    cosa === "membri" && coda.length === 1
      ? `${metodo} /membri/:x`
      : metodo === "DELETE" && cosa === "archivio" && coda.length === 1
        ? "DELETE /archivio/:x"
        : `${metodo} /${[cosa, ...coda].filter(Boolean).join("/")}`;

  switch (qui) {
    case "GET /":
      return conforme(unaConversazione, { conversazione: vistaDi(conv) }, dove);

    case "POST /membri": {
      conforme(contratti.membroGruppoInputSchema, corpo, dove);
      if (conv.ruoli[chi] === "membro") throw new Rifiuto(403, "non_amministratore");
      ammetteNelGruppo(conv, cercata(corpo));
      return conforme(unaConversazione, { conversazione: vistaDi(conv) }, dove);
    }
    case "DELETE /membri/:x": {
      if (conv.ruoli[chi] === "membro") throw new Rifiuto(403, "non_amministratore");
      if (!conv.membri.includes(coda[0])) throw new Rifiuto(404, "not_found");
      toglieDalGruppo(conv, coda[0]);
      return conforme(unaConversazione, { conversazione: vistaDi(conv) }, dove);
    }

    case "GET /handshake": {
      const dopo = url.searchParams.get("dopo") ?? undefined;
      const { handshake } = await vista.handshakeDopo(idConv, dopo);
      return conforme(
        contratti.handshakePageSchema,
        {
          handshake: handshake.map((h) => ({
            busta: h.busta,
            createdAt: conv.createdAt,
            epoch: h.epoch,
            id: h.id,
            tipo: h.tipo,
          })),
        },
        dove,
      );
    }
    case "POST /handshake": {
      conforme(contratti.depositaHandshakeRequestSchema, corpo, dove);
      if (corpo.tipo === "welcome") {
        // Come la fila vera: un invito porta a un'epoch che la fila conosce, e
        // va a qualcuno che nella conversazione c'è.
        const ultima = istanza
          .depositati()
          .filter((h) => h.conversazioneId === idConv && h.tipo === "commit")
          .reduce((max, h) => Math.max(max, h.epoch), 0);
        if (corpo.epoch < 1 || corpo.epoch > ultima) throw new Rifiuto(409, "conflict");
        if (!conv.membri.includes(corpo.destinatario)) throw new Rifiuto(400, "validation_error");
      } else {
        assert.equal(corpo.destinatario, undefined, "un commit non ha destinatario");
      }
      try {
        await vista.depositaHandshake(idConv, corpo);
      } catch (errore) {
        if (errore.status === 409) throw new Rifiuto(409, "conflict");
        throw errore;
      }
      return { id: istanza.depositati().at(-1).id };
    }

    case "GET /archivio/chiavi": {
      const mazzo = await vista.mazzo(idConv);
      if (mazzo === undefined) throw new Rifiuto(404, "nessun_archivio");
      return conforme(
        contratti.mazzoArchivioViewSchema,
        { ...mazzo, updatedAt: conv.createdAt },
        dove,
      );
    }
    case "PUT /archivio/chiavi": {
      conforme(contratti.saveMazzoArchivioRequestSchema, corpo, dove);
      const attuale = await vista.mazzo(idConv);
      if (attuale !== undefined && attuale.epoch > corpo.epoch) throw new Rifiuto(409, "conflict");
      await vista.salvaMazzo(idConv, corpo);
      return conforme(
        contratti.mazzoArchivioViewSchema,
        { ...corpo, updatedAt: new Date().toISOString() },
        dove,
      );
    }

    case "GET /group-info": {
      const punto = await vista.puntoDiRientro(idConv);
      if (punto === undefined) throw new Rifiuto(404, "nessun_punto_di_rientro");
      return conforme(contratti.groupInfoViewSchema, { ...punto, updatedAt: conv.createdAt }, dove);
    }
    case "PUT /group-info": {
      conforme(contratti.saveGroupInfoRequestSchema, corpo, dove);
      const attuale = await vista.puntoDiRientro(idConv);
      if (attuale !== undefined && attuale.epoch > corpo.epoch) throw new Rifiuto(409, "conflict");
      await vista.salvaPuntoDiRientro(idConv, corpo);
      return conforme(
        contratti.groupInfoViewSchema,
        { ...corpo, updatedAt: new Date().toISOString() },
        dove,
      );
    }

    case "GET /cronologia":
      return conforme(
        contratti.cronologiaPageSchema,
        senzaRitirate(await vista.cronologia(idConv)),
        dove,
      );

    // Il ritiro (ADR 0043 §2): soltanto la propria voce, e una volta sola.
    case "DELETE /archivio/:x": {
      const { righe } = senzaRitirate(await vista.cronologia(idConv));
      const sua = righe.find((r) => r.id === coda[0] && r.mittente === indirizzo(nomeDi(chi)));
      if (sua === undefined) throw new Rifiuto(404, "messaggio_inesistente");
      ritirate.add(sua.id);
      return undefined;
    }

    // L'uscita: chi esce non chiede permesso, e non manda un corpo.
    case "POST /uscita": {
      if (conv.tipo !== "gruppo") throw new Rifiuto(400, "non_un_gruppo");
      toglieDalGruppo(conv, chi);
      return undefined;
    }

    case "POST /archivio": {
      conforme(contratti.depositaArchivioRequestSchema, corpo, dove);
      for (const voce of corpo.voci) {
        assert.match(voce.id, /^[A-Za-z0-9._:-]{1,120}$/);
        assert.match(voce.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      }
      try {
        await vista.depositaArchivio(idConv, corpo.voci);
      } catch {
        throw new Rifiuto(409, "conflict");
      }
      return { scritte: corpo.voci.length };
    }

    default:
      throw new Rifiuto(404, "not_found");
  }
}

async function servi(chi, { metodo, percorso, corpo }, telefono) {
  viste.push(`${metodo} ${percorso.split("?")[0]}`);
  try {
    // Come sul canale del dispositivo: chi manda un corpo manda JSON.
    const letto = corpo === null ? undefined : JSON.parse(corpo);
    assert.equal(
      letto === undefined,
      metodo === "GET" || metodo === "DELETE" || /\/(uscita|sfida|approva|rifiuta)$/.test(percorso),
      `${metodo} ${percorso}`,
    );
    const risposta = await rotta(chi, metodo, new URL(percorso, "http://casa"), letto, telefono);
    // Le rotte che rispondono 204, come quelle vere, non hanno corpo.
    if (risposta === undefined) return { corpo: "", stato: 204 };
    return { corpo: JSON.stringify(risposta), stato: 200 };
  } catch (errore) {
    if (errore instanceof Rifiuto) {
      const rifiuto = conforme(
        contratti.errorResponseSchema,
        { code: errore.code, message: errore.code },
        "il rifiuto",
      );
      return { corpo: JSON.stringify(rifiuto), stato: errore.stato };
    }
    throw errore;
  }
}

/* ================================================================== */
/* I due client                                                         */
/* ================================================================== */

const PONTE = join(radice, "apps/nucleo/target/debug/examples/ponte_sessione");
const ponti = [];

/** Un telefono: la sessione del nucleo, che parla con la Casa da sé. */
class Telefono {
  constructor(nome) {
    this.nome = nome;
    this.id = persona(nome).id;
    this.chi = indirizzo(nome);
    this.p = spawn(PONTE, [], { stdio: ["pipe", "pipe", "inherit"] });
    this.righe = createInterface({ input: this.p.stdout })[Symbol.asyncIterator]();
    ponti.push(this);
  }
  async chiedi(cmd, args = {}) {
    this.p.stdin.write(JSON.stringify({ cmd, ...args }) + "\n");
    for (;;) {
      const { value, done } = await this.righe.next();
      assert.ok(!done, `il nucleo di ${this.nome} si è chiuso durante ${cmd}`);
      const r = JSON.parse(value);
      if (r.chiedi !== undefined) {
        this.p.stdin.write(JSON.stringify(await servi(this.id, r.chiedi, this)) + "\n");
        continue;
      }
      if (r.errore !== undefined) throw new Error(`nucleo di ${this.nome}, ${cmd}: ${r.errore}`);
      return r.ok;
    }
  }
  async apre() {
    this.io = await this.chiedi("apri");
    return this.io;
  }
  aggiorna(conv) {
    return this.chiedi("aggiorna", { conv });
  }
  scrive(conv, testo, risponde) {
    return this.chiedi("invia", { conv, testo, ...(risponde === undefined ? {} : { risponde }) });
  }
  async legge(conv) {
    return (await this.chiedi("cronologia", { conv })).messaggi;
  }
  chiudi() {
    this.p.stdin.end();
  }
}

/** Un `KeyPackage` del web, com'è sul filo: è così che la Casa lo custodisce. */
const pacchettoSulFilo = (keyPackage) =>
  b64(encodeMlsMessage({ keyPackage, version: "mls10", wireformat: "mls_key_package" }));

/** Un `KeyPackage` che la Casa custodisce, come lo legge il web. */
function pacchettoPerIlWeb(sulFilo) {
  const letto = decodeMlsMessage(daB64(sulFilo), 0);
  assert.equal(letto?.[0].wireformat, "mls_key_package");
  return letto[0].keyPackage;
}

/** Un browser: il client web vero, con i doppi dei suoi test. */
class Browser {
  constructor(nome) {
    this.nome = nome;
    this.id = persona(nome).id;
    this.chi = indirizzo(nome);
    this.membro = { casa: CASA, username: nome };
    this.sessioni = new Map();
  }
  async nasce() {
    this.io = await finte.portachiaviFinto(this.nome);
    const sua = istanza.per(this.id);
    // La stessa cronologia che il pilota dà al telefono: senza le ritirate.
    const cronologia = async (...args) => senzaRitirate(await sua.cronologia(...args));
    const chiaviDiFirmaDi = async (membro) => senzaRevocate(await sua.chiaviDiFirmaDi(membro));
    this.ctx = {
      deposito: finte.depositoFinto(),
      io: this.io,
      istanza: { ...sua, chiaviDiFirmaDi, cronologia },
    };
    this.dispositivo = registra(this.id, b64(this.io.chiaveDiFirma));
    for (let i = 0; i < 5; i += 1) {
      this.dispositivo.pacchetti.push(pacchettoSulFilo(await this.io.pubblica()));
    }
  }
  /** Chi è nel gruppo secondo la Casa, detto come lo vuole `conversazione.ts`. */
  composizione(conv) {
    const c = casa.conversazioni.get(conv);
    return {
      autorevole: true,
      membri: c.membri.map((id) => ({ id, membro: { casa: CASA, username: nomeDi(id) } })),
      rimossi: c.rimossi.map((r) => ({ casa: CASA, username: r.split("@")[0] })),
    };
  }
  /** Apre la conversazione come fa la schermata: riprende, entra, rientra o crea. */
  async apre(conv) {
    const c = casa.conversazioni.get(conv);
    const apertura = await conversazione.apriConversazione(
      this.ctx,
      {
        creaQui: c.tipo === "diretta" || c.ruoli[this.id] === "creatore",
        id: conv,
        ordinataQui: true,
      },
      async () =>
        c.membri
          .filter((id) => id !== this.id)
          .flatMap((id) =>
            preleva(id).map((p) => ({
              idDiChiEntra: id,
              keyPackage: pacchettoPerIlWeb(p.keyPackage),
              membro: { casa: CASA, username: nomeDi(id) },
            })),
          ),
    );
    if (apertura.kind === "pronta") {
      this.sessioni.set(conv, apertura.sessione);
    }
    return apertura.kind;
  }
  /** Un giro: handshake arretrati, mazzo, albero accanto ai membri, cronologia. */
  async legge(conv) {
    const lettura = await conversazione.leggi(
      this.ctx,
      this.sessioni.get(conv),
      undefined,
      this.composizione(conv),
    );
    this.sessioni.set(conv, lettura.sessione);
    return lettura;
  }
  async scrive(conv, testo) {
    const id = randomUUID();
    await conversazione.manda(
      this.ctx,
      this.sessioni.get(conv),
      { testo },
      id,
      new Date().toISOString(),
      this.composizione(conv).membri.map((m) => m.membro),
    );
    return id;
  }
}

// Due voci scritte nello stesso millisecondo non hanno un ordine da provare.
const attimo = () => aspetta(3);
const testi = (messaggi) => messaggi.filter((m) => m.evento == null).map((m) => m.testo);
/** Ciò a cui una voce è legata: lo dichiara l'istanza, lo sigilla chi scrive. */
const legame = (conversazioneId, riga) => ({
  conversazioneId,
  createdAt: riga.createdAt,
  id: riga.id,
  mittente: riga.mittente,
});
const frasi = (lettura) => lettura.righe.filter((r) => r.evento === undefined).map((r) => r.testo);

/* ================================================================== */
/* 1. Una chat a due creata dal telefono                                */
/* ================================================================== */

async function dalTelefonoAlBrowser() {
  const anna = new Telefono("anna");
  const bruno = new Browser("bruno");
  await bruno.nasce();

  const io = await anna.apre();
  assert.deepEqual(
    { ...io, codice: undefined, dispositivo: undefined },
    {
      approvato: true,
      casa: CASA,
      codice: undefined,
      dispositivo: undefined,
      id: "u-anna",
      username: "anna",
    },
  );
  assert.ok(viste.includes("POST /api/v1/dispositivi/chiave"));
  assert.ok(viste.includes("POST /api/v1/dispositivi/key-packages"));
  fatto("il telefono si presenta alla Casa: chi è, la chiave di firma, i KeyPackage");

  // La prova di possesso: una sfida, e la firma di OpenMLS che la Casa
  // controlla con la crittografia di Node, come `apps/core-api`.
  assert.ok(viste.includes("POST /api/v1/dispositivi/sfida"));
  assert.deepEqual(casa.prove, { arrivate: 1, valide: 1 });
  // Il codice da confrontare è quello che il web calcola dalla stessa chiave.
  assert.equal(io.codice, codiceDi(anna.dispositivo.publicKey));
  fatto("il telefono prova di avere la chiave, e il suo codice è quello del web");

  const conv = (await anna.chiedi("creaDiretta", { username: "bruno" })).id;
  assert.equal(await anna.chiedi("apriConversazione", { conv }), "pronta");
  assert.equal(await anna.chiedi("epoch", { conv }), 1);
  const inFila = istanza.depositati().filter((h) => h.conversazioneId === conv);
  assert.deepEqual(
    inFila.map((h) => [h.tipo, h.epoch, h.destinatario]),
    [
      ["commit", 1, undefined],
      ["welcome", 1, "u-bruno"],
    ],
  );
  assert.equal(istanza.mazzo(conv).epoch, 1);
  fatto("il telefono crea il gruppo con OpenMLS: commit, mazzo e invito sono in fila");

  // Il browser entra dall'invito di OpenMLS e apre il mazzo avvolto da OpenMLS.
  assert.equal(await bruno.apre(conv), "pronta");
  assert.ok(bruno.sessioni.get(conv).catena !== undefined, "il browser ha aperto il mazzo");
  fatto("il browser (ts-mls) entra dall'invito del telefono e apre il suo mazzo");

  const primo = await anna.scrive(conv, "ciao dal telefono");
  assert.equal(primo.mio, true);
  let letto = await bruno.legge(conv);
  assert.deepEqual(frasi(letto), ["ciao dal telefono"]);
  assert.equal(letto.righe[0].mittente, anna.chi);
  assert.equal(letto.righe[0].attestata, true);
  assert.equal(letto.righe[0].id, primo.id);
  fatto("il browser legge ciò che il telefono ha scritto, con chi e quando sigillati");

  await attimo();
  const idDiBruno = await bruno.scrive(conv, "ciao dal browser");
  const giro = await anna.aggiorna(conv);
  assert.equal(giro.apertura, "pronta");
  const diBruno = giro.nuovi.find((m) => m.id === idDiBruno);
  assert.deepEqual(
    { ...diBruno, creatoIl: undefined },
    {
      attestato: true,
      creatoIl: undefined,
      evento: null,
      id: idDiBruno,
      mio: false,
      mittente: bruno.chi,
      risponde: null,
      stato: "letto",
      testo: "ciao dal browser",
    },
  );
  assert.match(diBruno.creatoIl, /^\d{4}-\d\d-\d\dT/);
  fatto("il telefono legge ciò che il browser ha scritto: testo, mittente e ora");

  // Una risposta: `r` viaggia dentro la voce, e il web la ritrova.
  await attimo();
  const risposta = await anna.scrive(conv, "ti rispondo", idDiBruno);
  letto = await bruno.legge(conv);
  assert.equal(letto.righe.find((r) => r.id === risposta.id).risponde, idDiBruno);
  assert.deepEqual(testi(await anna.legge(conv)), [
    "ciao dal telefono",
    "ciao dal browser",
    "ti rispondo",
  ]);
  fatto("una risposta scritta dal telefono il browser la legge come risposta");

  // Il telefono ritira un suo messaggio: sparisce anche per il browser.
  await attimo();
  const sbagliato = await anna.scrive(conv, "scritto per sbaglio");
  assert.equal(frasi(await bruno.legge(conv)).at(-1), "scritto per sbaglio");
  await anna.chiedi("ritira", { conv, messaggio: sbagliato.id });
  assert.ok(!(await bruno.legge(conv)).righe.some((r) => r.id === sbagliato.id));
  assert.ok(!(await anna.aggiorna(conv)).pagina.includes(sbagliato.id));
  // Ciò che ha scritto un altro non lo ritira: la Casa dice 404.
  await assert.rejects(
    anna.chiedi("ritira", { conv, messaggio: idDiBruno }),
    /messaggio_inesistente/,
  );
  assert.ok((await bruno.legge(conv)).righe.some((r) => r.id === idDiBruno));
  fatto("il telefono ritira un suo messaggio, e il browser non lo vede più");

  // L'app si chiude e si riapre: lo stato sta nel deposito, non nella memoria.
  await anna.apre();
  assert.equal((await anna.aggiorna(conv)).apertura, "pronta");
  await attimo();
  await anna.scrive(conv, "dopo il riavvio");
  assert.deepEqual(frasi(await bruno.legge(conv)).at(-1), "dopo il riavvio");
  fatto("il telefono riparte dal suo deposito e continua la conversazione");

  return { anna, bruno };
}

/* ================================================================== */
/* 2. Una chat a due creata dal browser                                 */
/* ================================================================== */

async function dalBrowserAlTelefono() {
  const dario = new Browser("dario");
  await dario.nasce();
  const carla = new Telefono("carla");
  await carla.apre();

  const conv = diretta(dario.id, carla.id).id;
  // Il browser crea il gruppo con il KeyPackage che il telefono ha pubblicato.
  assert.equal(await dario.apre(conv), "pronta");
  await dario.scrive(conv, "ti scrivo dal browser");

  // Il telefono trova l'invito di ts-mls e il mazzo avvolto da ts-mls.
  const giro = await carla.aggiorna(conv);
  assert.equal(giro.apertura, "pronta");
  assert.equal(giro.senzaCronologia, false);
  assert.deepEqual(testi(giro.nuovi), ["ti scrivo dal browser"]);
  assert.equal(giro.nuovi[0].mittente, dario.chi);
  assert.equal(giro.nuovi[0].attestato, true);
  fatto("il telefono entra dall'invito del browser (ts-mls) e ne legge il messaggio");

  await attimo();
  await carla.scrive(conv, "e io dal telefono");
  assert.deepEqual(frasi(await dario.legge(conv)), ["ti scrivo dal browser", "e io dal telefono"]);
  fatto("e il browser legge la risposta del telefono");

  return { carla, dario };
}

/* ================================================================== */
/* 3. Un gruppo: due telefoni e due browser, chi entra e chi esce       */
/* ================================================================== */

async function unGruppo({ anna, bruno, carla, dario }) {
  const gruppo = await anna.chiedi("creaGruppo", {
    membri: [{ username: "bruno" }, { username: "carla" }],
    nome: "gita",
  });
  const conv = gruppo.id;
  assert.equal(gruppo.gruppo, true);

  // Chi non l'ha creato aspetta, anche dalla stessa casa: non lo crea lui.
  assert.equal((await carla.aggiorna(conv)).apertura, "in-attesa");
  assert.equal(await anna.chiedi("apriConversazione", { conv }), "pronta");
  assert.equal(await bruno.apre(conv), "pronta");
  assert.equal((await carla.aggiorna(conv)).apertura, "pronta");
  fatto("un gruppo creato dal telefono: entrano un browser e un altro telefono");

  await anna.scrive(conv, "si parte sabato");
  await attimo();
  await bruno.scrive(conv, "porto la tenda");
  await attimo();
  await carla.scrive(conv, "io il fornello");
  const tutti = ["si parte sabato", "porto la tenda", "io il fornello"];
  assert.deepEqual(testi(await anna.legge(conv)), tutti);
  assert.deepEqual(frasi(await bruno.legge(conv)), tutti);
  assert.deepEqual(testi(await carla.legge(conv)), tutti);
  fatto("in tre si leggono tutti, telefono e browser, in ogni verso");

  // Il telefono fa entrare un browser: un commit di OpenMLS che ts-mls applica.
  await attimo();
  await anna.chiedi("aggiungiMembro", { conv, username: "dario" });
  assert.equal(await anna.chiedi("epoch", { conv }), 2);
  assert.equal(await dario.apre(conv), "pronta");
  const diDario = await dario.legge(conv);
  assert.deepEqual(frasi(diDario), tutti, "chi entra legge anche il pregresso");
  assert.deepEqual(
    diDario.righe.filter((r) => r.evento !== undefined).map((r) => r.evento),
    [{ chi: dario.chi, tipo: "ingresso" }],
  );
  const diBruno = await bruno.legge(conv);
  assert.deepEqual(diBruno.confronto, { assenti: [], estranei: [] });
  assert.equal(bruno.sessioni.get(conv).tolto, undefined);
  await carla.aggiorna(conv);
  const presenti = await carla.chiedi("membri", { conv });
  assert.deepEqual(
    presenti.map((m) => [m.membro, m.dispositivi]),
    ["anna", "bruno", "carla", "dario"].map((n) => [indirizzo(n), 1]),
  );
  fatto("il telefono aggiunge un browser: entra, legge il pregresso, e l'ingresso è detto");

  await attimo();
  await dario.scrive(conv, "arrivo anch'io");
  assert.equal(testi((await carla.aggiorna(conv)).nuovi).at(-1), "arrivo anch'io");
  assert.equal(testi((await anna.aggiorna(conv)).nuovi).at(-1), "arrivo anch'io");
  fatto("e i telefoni leggono ciò che scrive chi è appena entrato");

  // --- Il browser toglie un telefono ---------------------------------
  // Il commit lo scrive ts-mls. Chi resta guadagna la stessa chiave nuova
  // senza scambiarsela; il telefono tolto non legge il seguito.
  const catenaDiCarla = [...bruno.sessioni.get(conv).catena];
  toglieDalGruppo(casa.conversazioni.get(conv), carla.id);
  bruno.sessioni.set(
    conv,
    await conversazione.faiUscire(bruno.ctx, bruno.sessioni.get(conv), {
      casa: CASA,
      username: "carla",
    }),
  );
  assert.equal(bruno.sessioni.get(conv).catena.length, catenaDiCarla.length + 1);

  assert.equal((await carla.aggiorna(conv)).apertura, "tolto");
  await assert.rejects(carla.scrive(conv, "ci sono ancora?"), /FuoriDalGruppo|rimosso_dal_gruppo/);
  await assert.rejects(carla.legge(conv), /FuoriDalGruppo|rimosso_dal_gruppo/);

  assert.equal((await anna.aggiorna(conv)).apertura, "pronta");
  assert.equal(await anna.chiedi("epoch", { conv }), 3);
  await attimo();
  const dopoCarla = await anna.scrive(conv, "senza carla");
  const voce = (await istanza.per(anna.id).cronologia(conv)).righe.find(
    (r) => r.id === dopoCarla.id,
  );
  assert.equal(voce.voce.chiaveN, catenaDiCarla.length + 1, "scritta con la chiave nuova");
  assert.equal(frasi(await bruno.legge(conv)).at(-1), "senza carla");
  assert.equal(frasi(await dario.legge(conv)).at(-1), "senza carla");
  // La stessa voce: la catena di chi resta la apre, quella di Carla no.
  assert.equal(
    archivio.rileggiLegata(bruno.sessioni.get(conv).catena, voce.voce, legame(conv, voce))?.testo,
    JSON.stringify({ t: "senza carla", v: 1 }),
  );
  assert.equal(archivio.rileggiLegata(catenaDiCarla, voce.voce, legame(conv, voce)), undefined);
  assert.equal(archivio.rileggi(catenaDiCarla, voce.voce), undefined);
  fatto("il browser toglie un telefono: chi resta deriva la stessa chiave, lui non legge più");

  // --- Il telefono toglie un browser ---------------------------------
  const catenaDiDario = [...dario.sessioni.get(conv).catena];
  await anna.chiedi("togliMembro", { conv, membro: dario.id });
  assert.equal(await anna.chiedi("epoch", { conv }), 4);
  const diDarioDopo = await conversazione.leggi(dario.ctx, dario.sessioni.get(conv));
  assert.equal(diDarioDopo.sessione.tolto, true);

  await attimo();
  const dopoDario = await anna.scrive(conv, "senza dario");
  const ultima = (await istanza.per(anna.id).cronologia(conv)).righe.find(
    (r) => r.id === dopoDario.id,
  );
  assert.equal(ultima.voce.chiaveN, catenaDiDario.length + 1);
  const letto = await bruno.legge(conv);
  assert.equal(frasi(letto).at(-1), "senza dario");
  assert.deepEqual(letto.righe.filter((r) => r.evento !== undefined).at(-1).evento, {
    chi: dario.chi,
    tipo: "rimozione",
  });
  assert.ok(
    archivio.rileggiLegata(bruno.sessioni.get(conv).catena, ultima.voce, legame(conv, ultima)),
  );
  assert.equal(archivio.rileggiLegata(catenaDiDario, ultima.voce, legame(conv, ultima)), undefined);
  assert.equal(archivio.rileggi(catenaDiDario, ultima.voce), undefined);
  fatto("il telefono toglie un browser: la catena ruota, e la sua catena non apre il seguito");

  await attimo();
  await bruno.scrive(conv, "restiamo in due");
  assert.equal(testi((await anna.aggiorna(conv)).nuovi).at(-1), "restiamo in due");
  assert.deepEqual(
    (await anna.chiedi("membri", { conv })).map((m) => m.membro),
    [anna.chi, bruno.chi],
  );
  fatto("chi resta continua a leggersi, alla quarta epoch e con tre chiavi nella catena");

  // L'elenco, come lo mostrerà la schermata: la chat a due e il gruppo.
  const elenco = await anna.chiedi("conversazioni");
  assert.deepEqual(
    elenco.map((c) => [c.gruppo, c.nome, c.membri.map((m) => m.username)]),
    [
      [false, null, ["anna", "bruno"]],
      [true, "gita", ["anna", "bruno"]],
    ],
  );
  assert.equal(elenco[1].membri[0].ruolo, "creatore");
  fatto("e il telefono elenca le sue conversazioni, con chi c'è e che ruolo ha");
}

/* ================================================================== */
/* 4. Un telefono esce da un gruppo                                     */
/* ================================================================== */

async function unTelefonoEsce({ anna, bruno, carla }) {
  const conv = (
    await anna.chiedi("creaGruppo", {
      membri: [{ username: "bruno" }, { username: "carla" }],
      nome: "cena",
    })
  ).id;
  assert.equal(await anna.chiedi("apriConversazione", { conv }), "pronta");
  assert.equal(await bruno.apre(conv), "pronta");
  assert.equal((await carla.aggiorna(conv)).apertura, "pronta");
  await carla.scrive(conv, "porto il vino");
  assert.equal(frasi(await bruno.legge(conv)).at(-1), "porto il vino");

  // Carla esce dal telefono: prima lo racconta, poi lo dice alla Casa. Nessun
  // commit parte da lei.
  const primaDiUscire = istanza.depositati().filter((h) => h.conversazioneId === conv).length;
  await attimo();
  await carla.chiedi("esci", { conv });
  assert.equal(
    istanza.depositati().filter((h) => h.conversazioneId === conv).length,
    primaDiUscire,
  );
  assert.ok(!casa.conversazioni.get(conv).membri.includes(carla.id));
  assert.equal((await carla.aggiorna(conv)).apertura, "tolto");

  // Il browser, che ordina, toglie la sua foglia con ts-mls: la catena ruota,
  // e il telefono di Anna applica il commit.
  const letto = await bruno.legge(conv);
  assert.deepEqual(letto.righe.filter((r) => r.evento !== undefined).at(-1).evento, {
    chi: carla.chi,
    tipo: "uscita",
  });
  assert.equal(bruno.sessioni.get(conv).tolto, undefined);
  const giro = await anna.aggiorna(conv);
  assert.deepEqual(giro.estranei, []);
  assert.equal(await anna.chiedi("epoch", { conv }), 2);
  assert.deepEqual(
    (await anna.chiedi("membri", { conv })).map((m) => [m.membro, m.dispositivi]),
    [
      [anna.chi, 1],
      [bruno.chi, 1],
    ],
  );
  await attimo();
  await anna.scrive(conv, "allora in due");
  assert.equal(frasi(await bruno.legge(conv)).at(-1), "allora in due");
  fatto("un telefono esce: lo racconta, e il browser che ordina toglie la sua foglia");
}

/* ================================================================== */
/* 5. Un secondo telefono: il sì e la revoca dal telefono               */
/* ================================================================== */

async function unSecondoTelefono({ anna, bruno }) {
  const conv = [...casa.conversazioni.values()].find(
    (c) => c.tipo === "diretta" && c.membri.includes(anna.id) && c.membri.includes(bruno.id),
  ).id;
  const nuovo = new Telefono("anna");
  const io = await nuovo.apre();
  assert.equal(io.approvato, false);
  assert.equal(io.codice, codiceDi(nuovo.dispositivo.publicKey));
  await assert.rejects(nuovo.chiedi("apriConversazione", { conv }), /DispositivoInAttesa/);
  fatto("un secondo telefono aspetta il sì, e non crea né rientra");

  const elenco = await anna.chiedi("dispositivi");
  assert.deepEqual(
    elenco.map((d) => [d.questo, d.stato, d.id]),
    [
      [true, "approvato", anna.dispositivo.id],
      [false, "in-attesa", io.dispositivo],
    ],
  );
  assert.equal(elenco[1].codice, io.codice);
  assert.equal(elenco[1].etichetta, `Telefono ${io.dispositivo}`);
  // Chi aspetta non dice di sì, nemmeno a sé.
  await assert.rejects(
    nuovo.chiedi("approvaDispositivo", { id: io.dispositivo }),
    /device_not_approved/,
  );
  fatto("il primo telefono vede la richiesta con lo stesso codice, e chi aspetta non si approva");

  const prima = await anna.chiedi("epoch", { conv });
  await anna.chiedi("approvaDispositivo", { id: io.dispositivo });
  assert.equal(await anna.chiedi("epoch", { conv }), prima + 1);
  // Il browser applica il commit di OpenMLS: la foglia nuova si autentica
  // nel registro, e l'albero è d'accordo con le persone.
  const diBruno = await bruno.legge(conv);
  assert.deepEqual(diBruno.confronto, { assenti: [], estranei: [] });
  assert.deepEqual(
    (await anna.chiedi("membri", { conv })).map((m) => [m.membro, m.dispositivi]),
    [
      [anna.chi, 2],
      [bruno.chi, 1],
    ],
  );
  assert.equal((await nuovo.chiedi("dispositivi"))[0].stato, "approvato");
  assert.equal((await nuovo.aggiorna(conv)).apertura, "pronta");
  assert.ok(testi(await nuovo.legge(conv)).includes("ciao dal browser"));
  await attimo();
  await nuovo.scrive(conv, "dal telefono nuovo");
  const letto = await bruno.legge(conv);
  assert.equal(frasi(letto).at(-1), "dal telefono nuovo");
  assert.equal(letto.righe.at(-1).mittente, anna.chi);
  fatto("al sì il telefono entra subito: il browser applica il commit e legge il nuovo");

  await anna.chiedi("revocaDispositivo", { id: io.dispositivo });
  assert.equal(await anna.chiedi("epoch", { conv }), prima + 2);
  assert.equal(
    (await anna.chiedi("dispositivi")).find((d) => d.id === io.dispositivo).stato,
    "revocato",
  );
  await bruno.legge(conv);
  await attimo();
  const idDopo = await bruno.scrive(conv, "il telefono revocato non lo legge");
  assert.equal((await nuovo.aggiorna(conv)).apertura, "tolto");
  assert.equal(
    testi((await anna.aggiorna(conv)).nuovi).at(-1),
    "il telefono revocato non lo legge",
  );
  const voce = (await istanza.per(bruno.id).cronologia(conv)).righe.find((r) => r.id === idDopo);
  assert.equal(
    archivio.rileggiLegata(bruno.sessioni.get(conv).catena, voce.voce, legame(conv, voce))?.testo,
    JSON.stringify({ t: "il telefono revocato non lo legge", v: 1 }),
  );
  fatto("alla revoca il telefono esce: il browser applica il commit, e il seguito non lo legge");
  nuovo.chiudi();
}

/* ================================================================== */
/* 6. Il sì dato dal browser: allineaMieiDispositivi del web            */
/* ================================================================== */

async function ilSiDalBrowser({ carla, dario }) {
  const conv = diretta(dario.id, carla.id).id;
  const telefono = new Telefono("dario");
  const io = await telefono.apre();
  assert.equal(io.approvato, false);

  // Il browser di Dario dice di sì (la rotta la prova la Casa vera) e rimette
  // d'accordo le sue foglie con `allineaMieiDispositivi`.
  const suo = telefono.dispositivo;
  suo.approvatoIl = new Date().toISOString();
  istanza.ammetti("dario", daB64(suo.publicKey));
  const prendi = async (chiavi) =>
    casa.dispositivi
      .filter((d) => d.userId === dario.id && d.approvatoIl !== null && d.revokedAt === null)
      .filter((d) => chiavi.some((k) => b64(k) === d.publicKey) && d.pacchetti.length > 0)
      .map((d) => pacchettoPerIlWeb(d.pacchetti.shift()));
  const allinea = async () => {
    await dario.legge(conv);
    dario.sessioni.set(
      conv,
      await conversazione.allineaMieiDispositivi(
        dario.ctx,
        dario.sessioni.get(conv),
        { id: dario.id, membro: dario.membro },
        prendi,
      ),
    );
  };
  await allinea();

  // Il telefono di Carla applica il commit di ts-mls: la foglia nuova si
  // autentica dal registro, e il telefono di Dario entra dal suo invito.
  await carla.aggiorna(conv);
  assert.deepEqual(
    (await carla.chiedi("membri", { conv })).map((m) => [m.membro, m.dispositivi]),
    [
      [dario.chi, 2],
      [carla.chi, 1],
    ],
  );
  assert.equal((await telefono.aggiorna(conv)).apertura, "pronta");
  assert.ok(testi(await telefono.legge(conv)).includes("ti scrivo dal browser"));
  await attimo();
  await telefono.scrive(conv, "Dario dal telefono");
  assert.equal(testi((await carla.aggiorna(conv)).nuovi).at(-1), "Dario dal telefono");
  fatto("il sì dato dal browser: ts-mls aggiunge il telefono, e il telefono di Carla lo applica");

  // La revoca: il browser toglie la foglia, e il telefono di Carla applica.
  revoca(suo);
  await allinea();
  await carla.aggiorna(conv);
  assert.deepEqual(
    (await carla.chiedi("membri", { conv })).map((m) => m.dispositivi),
    [1, 1],
  );
  assert.equal((await telefono.aggiorna(conv)).apertura, "tolto");
  await attimo();
  await carla.scrive(conv, "senza il telefono di Dario");
  assert.equal(frasi(await dario.legge(conv)).at(-1), "senza il telefono di Dario");
  fatto("e la revoca dal browser: la foglia esce, e il telefono di Carla continua");
  telefono.chiudi();
}

/* ================================================================== */

try {
  const { anna, bruno } = await dalTelefonoAlBrowser();
  const { carla, dario } = await dalBrowserAlTelefono();
  await unGruppo({ anna, bruno, carla, dario });
  await unTelefonoEsce({ anna, bruno, carla });
  await unSecondoTelefono({ anna, bruno });
  await ilSiDalBrowser({ carla, dario });
} finally {
  for (const p of ponti) p.chiudi();
}

// Ogni volta che il nucleo ha registrato la sua chiave l'ha provata, e la
// prova è una che la Casa vera accetta.
assert.ok(casa.prove.arrivate >= 4);
assert.equal(casa.prove.valide, casa.prove.arrivate);

// Il nucleo non ha chiesto niente che la Casa vera non abbia: ogni rotta che
// ha usato si ritrova, con il suo metodo, fra quelle che `apps/core-api`
// registra. È qui che un endpoint inventato si vedrebbe.
const sorgenti = ["messaggi", "dispositivi", "identity"]
  .map((zona) => join(radice, "apps/core-api/src", zona, "routes.ts"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const vere = [...sorgenti.matchAll(/app\.(get|post|put|delete)\b[^"`]*?"(\/api\/v1\/[^"]+)"/g)].map(
  ([, metodo, percorso]) => ({
    forma: new RegExp(`^${percorso.replace(/:[A-Za-z]+/g, "[^/]+")}$`),
    nome: `${metodo.toUpperCase()} ${percorso}`,
  }),
);
const usate = new Set();
for (const vista of new Set(viste)) {
  const [metodo, percorso] = vista.split(" ");
  const vera = vere.find((v) => v.nome.startsWith(`${metodo} `) && v.forma.test(percorso));
  assert.ok(vera, `il nucleo ha chiesto una rotta che la Casa non ha: ${vista}`);
  usate.add(vera.nome);
}
esiti.push("", `rotte della Casa usate dal nucleo: ${usate.size}`);
for (const r of [...usate].sort()) esiti.push(`  ${r}`);

console.log(esiti.join("\n"));
console.log("\nprova-sessione: ok");
