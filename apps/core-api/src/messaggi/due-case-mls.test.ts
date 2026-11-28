/**
 * Due case vere, due persone, MLS vero: il percorso intero di una chat fra
 * istanze ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md),
 * [ADR 0043](../../../../docs/adr/0043-custodia-lato-mittente.md)).
 *
 * Qui dentro c'è tutto quello che un'installazione da zero usa davvero, tranne
 * iroh:
 *
 * - **due istanze intere** (`buildApp`), ciascuna col suo database, le sue
 *   rotte HTTP e **il suo `FederationService` collegato come in produzione**;
 * - **il client MLS del browser** — `conversazione`, `sessione`,
 *   `dispositivo`, `gruppo` — che parla a quelle rotte come parla la schermata;
 * - **al posto di iroh**, [`filo-finto.ts`](../federation/filo-finto.ts): porta
 *   i byte da una casa all'altra e dice a chi li riceve da quale chiave
 *   arrivano. Tutto il resto è quello vero: la domanda viene serializzata, la
 *   legge `parseRequest`, passa dai limiti e dal controllo del rapporto, e la
 *   serve ciò che `buildApp` ha collegato.
 *
 * Fino al 2026-11-27 qui il filo era un'altra cosa: i metodi con cui una casa
 * chiede venivano sostituiti da chiamate dirette al servizio dell'altra. La
 * prova era verde, e intanto `buildApp` non collegava nessuna delle operazioni
 * di ADR 0042 oltre a KeyPackage e registro: su un'istanza vera una chat fra
 * due case non funzionava, e questa prova non poteva saperlo. Adesso, se manca
 * un collegamento, è la prima a cadere.
 *
 * Il filo vero ha le sue prove, operazione per operazione, in
 * `federation/federation.test.ts`, con endpoint iroh veri. Su `local` una
 * chiave non si risolve e due istanze non si possono chiamare a vicenda; su
 * `internet` una prova dipenderebbe dai server di n0.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "@estia/config";
import { messaggioDiProvaChiave } from "@estia/contracts";
import { withTempDataDir } from "@estia/testing";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { rileggiLegata } from "../../../web/src/mls/archivio.js";
import {
  apriConversazione,
  faiEntrare,
  faiUscire,
  leggi,
  manda,
  type Invitato,
  type Invito,
} from "../../../web/src/mls/conversazione.js";
import { ALGORITMO, preparaDispositivo, type Anagrafe } from "../../../web/src/mls/dispositivo.js";
import { cassettoFinto, depositoFinto } from "../../../web/src/mls/finte.js";
import { epochDi, foglie, leggiKeyPackage } from "../../../web/src/mls/gruppo.js";
import type { Contesto, Istanza, Sessione } from "../../../web/src/mls/sessione.js";
import { composizioneDi } from "../../../web/src/screens/gruppi/logica.js";
import { membroDi } from "../../../web/src/screens/sicurezza/membri.js";
import { buildApp } from "../app.js";
import { FiloFinto } from "../federation/filo-finto.js";

const SETUP_TOKEN = "setup-token-due-case-mls";

interface Casa {
  app: FastifyInstance;
  dataDir: string;
  /** La chiave della casa: quella con cui l'altra la nomina, e che firma le credenziali. */
  casa: string;
  token: string;
  username: string;
  /** Il client di questa persona, sul suo browser. */
  ctx: Contesto;
  /** Ciò che il browser tiene del dispositivo: sopravvive a un accesso nuovo. */
  cassetto: ReturnType<typeof cassettoFinto>;
}

class ErroreHttp extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function chiama(
  app: FastifyInstance,
  token: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
): Promise<unknown> {
  const res = await app.inject({
    headers: { authorization: `Bearer ${token}` },
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

  if (res.statusCode === 204) {
    return undefined;
  }

  const corpo = res.body.length === 0 ? undefined : (JSON.parse(res.body) as unknown);
  if (res.statusCode >= 400) {
    const errore = corpo as { code?: string; message?: string } | undefined;
    throw new ErroreHttp(res.statusCode, errore?.code ?? "?", errore?.message ?? res.body);
  }

  return corpo;
}

/** `undefined` su 404: «non c'è ancora», come negli adattatori del browser. */
async function seEsiste<T>(chiamata: Promise<unknown>): Promise<T | undefined> {
  try {
    return (await chiamata) as T;
  } catch (causa) {
    if (causa instanceof ErroreHttp && causa.status === 404) {
      return undefined;
    }
    throw causa;
  }
}

const daB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/**
 * L'istanza vista dal client, sulle rotte vere. È `istanzaSuApi` di
 * `adattatori.ts` con `app.inject` al posto di `fetch`: stessi percorsi, stessa
 * regola di instradamento del registro.
 */
function istanzaSu(app: FastifyInstance, token: string, casa: string): Istanza {
  const conv = (id: string): string => `/api/v1/conversazioni/${encodeURIComponent(id)}`;

  return {
    async chiaviDiFirmaDi(membro) {
      const url =
        membro.casa === casa
          ? `/api/v1/dispositivi/di/${membro.username}/chiavi`
          : `/api/v1/mls/chiavi/${membro.casa}/${membro.username}`;
      const registro = (await chiama(app, token, "GET", url)) as {
        chiavi: { publicKey: string; algorithm: string }[];
      };
      return registro.chiavi
        .filter((c) => c.algorithm === ALGORITMO)
        .map((c) => daB64(c.publicKey));
    },
    cronologia: async (id, prima) =>
      (await chiama(
        app,
        token,
        "GET",
        `${conv(id)}/cronologia${prima === undefined ? "" : `?prima=${encodeURIComponent(prima)}`}`,
      )) as Awaited<ReturnType<Istanza["cronologia"]>>,
    depositaArchivio: async (id, voci) => {
      await chiama(app, token, "POST", `${conv(id)}/archivio`, { voci });
    },
    depositaHandshake: async (id, busta) => {
      await chiama(app, token, "POST", `${conv(id)}/handshake`, busta);
    },
    handshakeDopo: async (id, dopo) =>
      (await chiama(
        app,
        token,
        "GET",
        `${conv(id)}/handshake${dopo === undefined ? "" : `?dopo=${encodeURIComponent(dopo)}`}`,
      )) as Awaited<ReturnType<Istanza["handshakeDopo"]>>,
    mazzo: (id) => seEsiste(chiama(app, token, "GET", `${conv(id)}/archivio/chiavi`)),
    puntoDiRientro: (id) => seEsiste(chiama(app, token, "GET", `${conv(id)}/group-info`)),
    salvaMazzo: async (id, dati) => {
      await chiama(app, token, "PUT", `${conv(id)}/archivio/chiavi`, dati);
    },
    salvaPuntoDiRientro: async (id, dati) => {
      await chiama(app, token, "PUT", `${conv(id)}/group-info`, dati);
    },
  };
}

/** L'anagrafe vera: `device_keys`, i KeyPackage e il backup, sulle rotte. */
function anagrafeSu(app: FastifyInstance, token: string): Anagrafe {
  return {
    leggiBackup: () => seEsiste(chiama(app, token, "GET", "/api/v1/dispositivi/backup")),
    pubblica: async (keyPackages) => {
      await chiama(app, token, "POST", "/api/v1/dispositivi/key-packages", { keyPackages });
    },
    registra: async ({ firma, ...chiave }) => {
      // Come `adattatori.ts`: la prova di possesso si manda sempre, e
      // l'istanza la guarda quando la chiave è già approvata e si ripresenta
      // da una sessione nuova (ADR 0040).
      const { sfida } = (await chiama(app, token, "POST", "/api/v1/dispositivi/sfida")) as {
        sfida: string;
      };
      const prova =
        firma === undefined
          ? undefined
          : Buffer.from(
              await firma(
                new TextEncoder().encode(messaggioDiProvaChiave(sfida, chiave.publicKey)),
              ),
            ).toString("base64");
      const r = (await chiama(app, token, "POST", "/api/v1/dispositivi/chiave", {
        ...chiave,
        ...(prova === undefined ? {} : { prova }),
      })) as { device: { id: string } };
      return { deviceId: r.device.id };
    },
    salvaBackup: async (backup) => {
      await chiama(app, token, "PUT", "/api/v1/dispositivi/backup", backup);
    },
  };
}

/** Una casa installata da zero, con una persona dentro e il suo browser pronto. */
async function casaNuova(
  dataDir: string,
  nome: string,
  username: string,
  filo: FiloFinto,
  now?: () => Date,
): Promise<Casa> {
  const app = await buildApp(
    loadConfig({ ESTIA_DATA_DIR: dataDir, ESTIA_HOST: "127.0.0.1", ESTIA_LOG_LEVEL: "silent" }),
    {
      createEndpoint: filo.endpoint,
      setupToken: SETUP_TOKEN,
      ...(now === undefined ? {} : { now }),
    },
  );

  const password = `password-lunga-di-${username}`;
  await app.inject({
    method: "POST",
    payload: {
      adminPassword: password,
      adminUsername: username,
      name: nome,
      setupToken: SETUP_TOKEN,
    },
    url: "/api/v1/instance/setup",
  });
  const login = await app.inject({
    method: "POST",
    payload: { password, username },
    url: "/api/v1/auth/login",
  });
  const token = (JSON.parse(login.body) as { token: string }).token;
  const { casa } = (await chiama(app, token, "GET", "/api/v1/mls/casa")) as { casa: string };

  const cassetto = cassettoFinto();
  const dispositivo = await preparaDispositivo(
    { anagrafe: anagrafeSu(app, token), casa, cassetto },
    username,
  );

  return {
    app,
    casa,
    cassetto,
    ctx: {
      deposito: depositoFinto(),
      io: dispositivo.portachiavi,
      istanza: istanzaSu(app, token, casa),
    },
    dataDir,
    token,
    username,
  };
}

/**
 * La sessione è scaduta — dura trenta giorni — e la persona accede di nuovo
 * **dallo stesso browser**: il token è nuovo, il dispositivo e gli stati dei
 * gruppi sono quelli che il browser aveva.
 */
async function riaccede(c: Casa): Promise<void> {
  const login = await c.app.inject({
    method: "POST",
    payload: { password: `password-lunga-di-${c.username}`, username: c.username },
    url: "/api/v1/auth/login",
  });
  c.token = (JSON.parse(login.body) as { token: string }).token;

  const dispositivo = await preparaDispositivo(
    { anagrafe: anagrafeSu(c.app, c.token), casa: c.casa, cassetto: c.cassetto },
    c.username,
  );
  c.ctx = { ...c.ctx, io: dispositivo.portachiavi, istanza: istanzaSu(c.app, c.token, c.casa) };
}

/**
 * Le due case si collegano, come fa chi le amministra: una chiede, l'altra
 * accetta. E le due persone scelgono di esserci, in rete. Sono le due cose che
 * permettono a una casa di aprire una conversazione con qualcuno dell'altra
 * (ADR 0030, `direttorio.ts`): senza, l'annuncio si rifiuta.
 */
async function collega(a: Casa, b: Casa): Promise<void> {
  await a.app.federationService.requestConnection(b.casa);
  await b.app.federationService.accept(a.casa);

  for (const io of [a, b]) {
    const [altra] = io.app.federationService.list();
    expect(altra?.state).toBe("collegata");
    await chiama(io.app, io.token, "PUT", "/api/v1/profile", {
      bio: "",
      openFollows: false,
      presence: "presente_privato",
    });
  }
}

/** Ogni byte di ogni file del database di una casa, come testo: per cercarci dentro. */
function tuttiIFile(c: Casa): string {
  return readdirSync(c.dataDir)
    .filter((nome) => nome.startsWith("estia.db"))
    .map((nome) => readFileSync(path.join(c.dataDir, nome)).toString("latin1"))
    .join("\n");
}

async function dueCase(
  use: (aia: Casa, borgo: Casa, filo: FiloFinto) => Promise<void>,
  opzioni: { collegate: boolean } = { collegate: true },
): Promise<void> {
  await withTempDataDir(async (primo) => {
    await withTempDataDir(async (secondo) => {
      const filo = new FiloFinto();
      const aia = await casaNuova(primo, "Aia", "anna", filo);
      const borgo = await casaNuova(secondo, "Borgo", "bruno", filo);

      try {
        if (opzioni.collegate) {
          await collega(aia, borgo);
        }
        await use(aia, borgo, filo);
      } finally {
        await aia.app.close();
        await borgo.app.close();
      }
    });
  });
}

/** Il nome della persona dall'altra parte, come lo vede la conversazione di questa casa. */
function invitoPer(chi: Casa, altra: Casa, conversazione: { membri: { id: string }[] }): Invito {
  return async () => {
    const preso = (await chiama(
      chi.app,
      chi.token,
      "GET",
      `/api/v1/mls/key-package/${altra.casa}/${altra.username}`,
    )) as { keyPackage: string };
    const keyPackage = leggiKeyPackage(daB64(preso.keyPackage));
    if (keyPackage === undefined) {
      throw new Error("KeyPackage illeggibile");
    }

    const idDiChiEntra = conversazione.membri.find((m) => m.id.startsWith("remote:"))!.id;
    return { idDiChiEntra, keyPackage };
  };
}

const nessunInvito: Invito = () => Promise.reject(new Error("Chi sta altrove non invita"));

interface VistaConversazione {
  id: string;
  ordinataQui: boolean;
  membri: { id: string; username: string }[];
}

/**
 * La scena di partenza, fatta come la fa la schermata: Anna cerca Bruno, apre
 * la conversazione dalla sua casa e il suo browser crea il gruppo; Bruno trova
 * la conversazione nella sua e ci entra dal Welcome.
 */
async function conversazioneAperta(
  aia: Casa,
  borgo: Casa,
): Promise<{ conv: string; sessioneAnna: Sessione; sessioneBruno: Sessione }> {
  const creata = (await chiama(aia.app, aia.token, "POST", "/api/v1/conversazioni", {
    recipientUsername: borgo.username,
    remoteInstanceKey: borgo.casa,
  })) as { conversazione: VistaConversazione };
  const perAnna = creata.conversazione;
  expect(perAnna.ordinataQui).toBe(true);

  const aperturaAnna = await apriConversazione(aia.ctx, perAnna, invitoPer(aia, borgo, perAnna));
  if (aperturaAnna.kind !== "pronta") {
    throw new Error("La conversazione di Anna doveva aprirsi");
  }

  // L'annuncio è partito con il Welcome: la casa di Bruno la conosce.
  const diBruno = (await chiama(borgo.app, borgo.token, "GET", "/api/v1/conversazioni")) as {
    conversazioni: VistaConversazione[];
  };
  const perBruno = diBruno.conversazioni.find((c) => c.id === perAnna.id);
  expect(perBruno?.ordinataQui).toBe(false);

  const aperturaBruno = await apriConversazione(borgo.ctx, perBruno!, nessunInvito);
  if (aperturaBruno.kind !== "pronta") {
    throw new Error("Bruno doveva entrare dal Welcome");
  }

  return {
    conv: perAnna.id,
    sessioneAnna: aperturaAnna.sessione,
    sessioneBruno: aperturaBruno.sessione,
  };
}

describe("una chat fra due case, dall'installazione alla risposta", () => {
  it("Anna scrive da Aia, Bruno legge da Borgo, risponde, e Anna legge", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, sessioneAnna, sessioneBruno } = await conversazioneAperta(aia, borgo);

      await manda(
        aia.ctx,
        sessioneAnna,
        { testo: "Ciao Bruno, alle otto in piazza" },
        "m-anna",
        "2026-09-23T18:00:00.000Z",
      );
      const letturaBruno = await leggi(borgo.ctx, sessioneBruno);
      expect(letturaBruno.righe.map((r) => [r.mittente, r.testo])).toEqual([
        [`anna@${aia.casa}`, "Ciao Bruno, alle otto in piazza"],
      ]);

      await manda(
        borgo.ctx,
        letturaBruno.sessione,
        { risponde: "m-anna", testo: "Perfetto, porto io il pane" },
        "m-bruno",
        "2026-09-23T18:01:00.000Z",
      );
      const letturaAnna = await leggi(aia.ctx, sessioneAnna);
      expect(letturaAnna.righe.map((r) => [r.mittente, r.testo, r.risponde])).toEqual([
        [`anna@${aia.casa}`, "Ciao Bruno, alle otto in piazza", undefined],
        [`bruno@${borgo.casa}`, "Perfetto, porto io il pane", "m-anna"],
      ]);

      // La conversazione la ordina Aia: la coda sta là, e Borgo non ne ha una.
      expect(borgo.app.messaggiService.handshakeRemoti(conv, aia.casa)).toBeUndefined();
    });
  }, 60_000);

  it("ogni operazione di ADR 0042 passa dal protocollo, ed è collegata", async () => {
    await dueCase(async (aia, borgo, filo) => {
      // Da qui in poi: il collegamento fra le due case è già passato dal filo.
      const inizio = filo.domande.length;
      const { sessioneAnna, sessioneBruno } = await conversazioneAperta(aia, borgo);
      await manda(aia.ctx, sessioneAnna, { testo: "uno" }, "m-anna", "2026-09-23T18:00:00.000Z");
      const letturaBruno = await leggi(borgo.ctx, sessioneBruno);
      await manda(
        borgo.ctx,
        letturaBruno.sessione,
        { testo: "due" },
        "m-bruno",
        "2026-09-23T18:01:00.000Z",
      );
      await leggi(aia.ctx, sessioneAnna);
      // Bruno chiede il punto di rientro: lo tiene Aia, che ordina.
      await chiama(
        borgo.app,
        borgo.token,
        "GET",
        `/api/v1/conversazioni/${sessioneBruno.conversazioneId}/group-info`,
      );

      const viste = (da: Casa, a: Casa): Set<string> =>
        new Set(
          filo.domande
            .slice(inizio)
            .filter((d) => d.da === da.casa && d.a === a.casa)
            .map((d) => d.tipo),
        );

      // Da Aia, che ordina: prende il KeyPackage di Bruno, ne controlla le
      // chiavi, annuncia la conversazione, spinge i suoi segnaposto, chiede
      // quelli di Borgo e visita le sue voci.
      expect([...viste(aia, borgo)].sort()).toEqual(
        ["archivio", "chiavi", "chiavi-di-firma", "segnaposto", "segnaposto-da"].sort(),
      );
      // Da Borgo: legge la coda e lo stato presso chi ordina, deposita il suo
      // riavvolgimento, e per i messaggi fa le stesse tre cose di Aia.
      expect([...viste(borgo, aia)].sort()).toEqual(
        [
          "archivio",
          "chiavi-di-firma",
          "group-info",
          "handshake-da",
          "mazzo",
          "segnaposto",
          "segnaposto-da",
        ].sort(),
      );

      // E nessuna ha risposto «questa operazione non la conosco».
      const sconosciute = filo.domande.filter(
        (d) => (d.risposta as { codice?: string } | undefined)?.codice === "richiesta_sconosciuta",
      );
      expect(sconosciute).toEqual([]);
    });
  }, 60_000);

  it("un commit depositato dall'altra casa attraversa, e un salto di epoch torna indietro come conflitto", async () => {
    await dueCase(async (aia, borgo, filo) => {
      const { conv, sessioneAnna, sessioneBruno } = await conversazioneAperta(aia, borgo);
      const handshake = `/api/v1/conversazioni/${conv}/handshake`;
      const inFila = (): number =>
        aia.app.messaggiService.handshakeRemoti(conv, borgo.casa)?.handshake.length ?? -1;
      const prima = inFila();

      // Il difetto del 2026-11-27, per la strada vera: il client di Bruno
      // dichiara un'epoch enorme, la sua casa la porta a chi ordina.
      for (const epoch of [2 ** 53 - 1, 3]) {
        await expect(
          chiama(borgo.app, borgo.token, "POST", handshake, {
            busta: "U0FMVE8=",
            epoch,
            tipo: "commit",
          }),
        ).rejects.toMatchObject({ code: "conflict", status: 409 });
      }
      expect(inFila()).toBe(prima);
      expect(filo.domande.filter((d) => d.tipo === "handshake").map((d) => d.risposta)).toEqual([
        expect.objectContaining({ codice: "epoch_superata" }),
        expect.objectContaining({ codice: "epoch_superata" }),
      ]);

      // L'epoch giusta entra, da Borgo, nella coda che sta ad Aia.
      await chiama(borgo.app, borgo.token, "POST", handshake, {
        busta: "Q09NTUlU",
        epoch: 2,
        tipo: "commit",
      });
      expect(inFila()).toBe(prima + 1);

      // E la conversazione si legge ancora, da tutte e due le parti: quel
      // commit non è di MLS, ma la fila non si è chiusa.
      expect(sessioneAnna.conversazioneId).toBe(sessioneBruno.conversazioneId);
    });
  }, 60_000);

  it("nessuna casa conserva la voce dell'altra, nemmeno cifrata (ADR 0043, verifica 1)", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, sessioneAnna, sessioneBruno } = await conversazioneAperta(aia, borgo);

      await manda(
        aia.ctx,
        sessioneAnna,
        { testo: "segreto di Anna" },
        "m-anna",
        "2026-09-23T18:00:00.000Z",
      );
      await manda(
        borgo.ctx,
        sessioneBruno,
        { testo: "segreto di Bruno" },
        "m-bruno",
        "2026-09-23T18:01:00.000Z",
      );
      await leggi(aia.ctx, sessioneAnna);
      await leggi(borgo.ctx, sessioneBruno);

      // Le voci cifrate, come ciascuna casa le serve all'altra per i suoi autori.
      const vocedi = (autore: Casa, lettore: Casa, id: string): string => {
        const esito = autore.app.messaggiService.vociPerCasa(conv, lettore.casa, [id]);
        return esito === "rifiutato" ? "" : (esito.voci[0]?.busta ?? "");
      };

      const diAnna = vocedi(aia, borgo, "m-anna");
      const diBruno = vocedi(borgo, aia, "m-bruno");
      expect(diAnna.length).toBeGreaterThan(0);
      expect(diBruno.length).toBeGreaterThan(0);

      // Dopo le letture: ciascuna voce sta **solo** nella casa del suo autore —
      // nel file, nel WAL, nella memoria condivisa.
      expect(tuttiIFile(aia)).toContain(diAnna);
      expect(tuttiIFile(aia)).not.toContain(diBruno);
      expect(tuttiIFile(borgo)).toContain(diBruno);
      expect(tuttiIFile(borgo)).not.toContain(diAnna);

      // E il testo in chiaro non è da nessuna parte.
      for (const c of [aia, borgo]) {
        expect(tuttiIFile(c)).not.toContain("segreto di");
      }
    });
  }, 60_000);

  it("con Borgo spenta restano chi e quando; riaccesa, il contenuto torna (ADR 0043, verifica 3)", async () => {
    await dueCase(async (aia, borgo, filo) => {
      const { sessioneAnna, sessioneBruno } = await conversazioneAperta(aia, borgo);
      await manda(
        borgo.ctx,
        sessioneBruno,
        { testo: "ci sono" },
        "m-bruno",
        "2026-09-23T18:00:00.000Z",
      );
      await leggi(aia.ctx, sessioneAnna);

      filo.spegni(borgo.casa);
      const spenta = await leggi(aia.ctx, sessioneAnna);
      expect(spenta.nonRispondono).toEqual([borgo.casa]);
      expect(spenta.righe).toEqual([
        {
          createdAt: "2026-09-23T18:00:00.000Z",
          id: "m-bruno",
          mittente: `bruno@${borgo.casa}`,
          stato: "non-disponibile",
        },
      ]);

      filo.accendi(borgo.casa);
      const riaccesa = await leggi(aia.ctx, sessioneAnna);
      expect(riaccesa.righe.map((r) => [r.stato, r.testo])).toEqual([["letta", "ci sono"]]);
    });
  }, 60_000);

  it("Bruno ritira la sua parola: alla lettura dopo, per Anna non c'è più", async () => {
    await dueCase(async (aia, borgo) => {
      const { conv, sessioneAnna, sessioneBruno } = await conversazioneAperta(aia, borgo);
      await manda(
        borgo.ctx,
        sessioneBruno,
        { testo: "ci ripenso" },
        "m-bruno",
        "2026-09-23T18:00:00.000Z",
      );
      expect((await leggi(aia.ctx, sessioneAnna)).righe).toHaveLength(1);

      await chiama(
        borgo.app,
        borgo.token,
        "DELETE",
        `/api/v1/conversazioni/${conv}/archivio/m-bruno`,
      );

      expect((await leggi(aia.ctx, sessioneAnna)).righe).toEqual([]);
    });
  }, 60_000);

  it("con la casa che ordina spenta Bruno legge quello che c'è, e si dice perché la coda tace", async () => {
    await dueCase(async (aia, borgo, filo) => {
      const { sessioneBruno } = await conversazioneAperta(aia, borgo);

      // Aia ordina, e si spegne: la coda dei commit non si legge. Non è un
      // elenco vuoto — sarebbe «non è successo niente» — è la frase di §3.
      filo.spegni(aia.casa);
      await expect(leggi(borgo.ctx, sessioneBruno)).rejects.toMatchObject({
        code: "casa_che_ordina_non_raggiungibile",
      });
    });
  }, 60_000);

  it("due case che non si conoscono: l'annuncio si rifiuta, e non dice chi abita qua", async () => {
    await dueCase(
      async (aia, borgo, filo) => {
        // Anna può aprire la conversazione a casa sua: è un gesto suo. Ma il
        // suo browser non arriva nemmeno all'invito, e quello che conta è che
        // cosa succede a Borgo quando Aia annuncia.
        const creata = (await chiama(aia.app, aia.token, "POST", "/api/v1/conversazioni", {
          recipientUsername: borgo.username,
          remoteInstanceKey: borgo.casa,
        })) as { conversazione: VistaConversazione };

        const annuncia = async (
          conversazioneId: string,
          destinatario: string,
        ): Promise<unknown> => {
          await aia.app.federationService.spingiSegnapostiA(borgo.casa, {
            conversazioneId,
            da: aia.username,
            destinatari: [destinatario],
            voci: [],
          });
          return filo.domande.findLast((d) => d.tipo === "segnaposto")?.risposta;
        };

        const perBruno = await annuncia(creata.conversazione.id, borgo.username);
        const perNessuno = await annuncia("un-altra-conversazione", "nessuno-con-questo-nome");

        // Bruno esiste e «nessuno» no: la risposta è la stessa, byte per byte.
        expect(perBruno).toMatchObject({ codice: "non_trovato" });
        expect(perNessuno).toEqual(perBruno);

        const diBruno = (await chiama(borgo.app, borgo.token, "GET", "/api/v1/conversazioni")) as {
          conversazioni: VistaConversazione[];
        };
        expect(diBruno.conversazioni).toEqual([]);
        // E Aia non si è data da sola il budget di una casa collegata.
        expect(borgo.app.messaggiService.casaPartecipa(aia.casa)).toBe(false);
      },
      { collegate: false },
    );
  }, 60_000);

  it("collegate, ma Bruno non è in rete: non lo si raggiunge, e la risposta è ancora la stessa", async () => {
    await dueCase(async (aia, borgo, filo) => {
      await chiama(borgo.app, borgo.token, "PUT", "/api/v1/profile", {
        bio: "",
        openFollows: false,
        presence: "non_presente",
      });

      await aia.app.federationService.spingiSegnapostiA(borgo.casa, {
        conversazioneId: "conv-per-chi-non-c-e",
        da: aia.username,
        destinatari: [borgo.username],
        voci: [],
      });

      expect(filo.domande.findLast((d) => d.tipo === "segnaposto")?.risposta).toMatchObject({
        codice: "non_trovato",
      });
      expect(borgo.app.messaggiService.casaPartecipa(aia.casa)).toBe(false);
    });
  }, 60_000);
});

/* ------------------------------ i gruppi (M8) ------------------------------ */

interface VistaGruppo extends VistaConversazione {
  tipo: "gruppo" | "diretta";
  membri: { id: string; username: string; displayName: string }[];
  ruoli?: Record<string, "creatore" | "amministratore" | "membro">;
  rimossi?: string[];
  casaPersaDal?: string;
  puoTraslocare?: boolean;
  congelata?: boolean;
  successori?: { id: string; da: string; il: string }[];
  continua?: { conversazioneId: string; nome: string; epoch: number; da: string; il: string };
}

async function treCase(
  use: (aia: Casa, borgo: Casa, colle: Casa, filo: FiloFinto) => Promise<void>,
  /** Un orologio finto, lo stesso per le tre case: serve a far passare un mese. */
  now?: () => Date,
): Promise<void> {
  await withTempDataDir(async (primo) => {
    await withTempDataDir(async (secondo) => {
      await withTempDataDir(async (terzo) => {
        const filo = new FiloFinto();
        const aia = await casaNuova(primo, "Aia", "anna", filo, now);
        const borgo = await casaNuova(secondo, "Borgo", "bruno", filo, now);
        const colle = await casaNuova(terzo, "Colle", "carla", filo, now);

        try {
          await collega(aia, borgo);
          await collega(aia, colle);
          await collega(borgo, colle);
          await use(aia, borgo, colle, filo);
        } finally {
          await aia.app.close();
          await borgo.app.close();
          await colle.app.close();
        }
      });
    });
  });
}

/** Il gruppo come lo vede una casa, chiesto come lo chiede la schermata a ogni giro. */
const vistaDi = async (c: Casa, conv: string): Promise<VistaGruppo> =>
  (
    (await chiama(c.app, c.token, "GET", `/api/v1/conversazioni/${conv}`)) as {
      conversazione: VistaGruppo;
    }
  ).conversazione;

/** Una chiave d'ingresso di qualcuno, chiesta alla sua casa attraverso la propria. */
async function chiaveDi(chi: Casa, altro: { id: string; username: string }) {
  const { casa } = membroDi(altro, chi.casa);
  const preso = (await chiama(
    chi.app,
    chi.token,
    "GET",
    `/api/v1/mls/key-packages/${casa}/${altro.username}`,
  )) as { keyPackages: { keyPackage: string }[] };
  // Il prelievo per persona, anche attraverso le case: qui ognuno ha un dispositivo solo.
  expect(preso.keyPackages).toHaveLength(1);
  const keyPackage = leggiKeyPackage(daB64(preso.keyPackages[0]!.keyPackage));
  if (keyPackage === undefined) {
    throw new Error("KeyPackage illeggibile");
  }
  return keyPackage;
}

/** Un giro di lettura, come lo fa la schermata: con le persone accanto all'albero. */
async function giro(c: Casa, sessione: Sessione, conv: string) {
  const vista = await vistaDi(c, conv);
  return leggi(c.ctx, sessione, undefined, composizioneDi(vista as never, c.casa));
}

const nomiNellAlbero = (sessione: Sessione): string[] =>
  foglie(sessione.stato)
    .map((f) => f.membro.username)
    .sort();

describe("un gruppo fra tre case, con MLS vero (M8)", () => {
  it("nasce, si scrive, si toglie, si esce e si riammette — e chi è fuori non legge il seguito", async () => {
    await treCase(async (aia, borgo, colle) => {
      /* --- nasce --- */
      const { conversazione: creato } = (await chiama(
        aia.app,
        aia.token,
        "POST",
        "/api/v1/gruppi",
        {
          membri: [
            { casa: borgo.casa, username: "bruno" },
            { casa: colle.casa, username: "carla" },
          ],
          nome: "Orto",
        },
      )) as { conversazione: VistaGruppo };
      const conv = creato.id;
      const idAnna = Object.keys(creato.ruoli ?? {}).find(
        (id) => creato.ruoli?.[id] === "creatore",
      );
      const altri = creato.membri.filter((m) => m.id !== idAnna);
      expect(altri.map((m) => m.username).sort()).toEqual(["bruno", "carla"]);

      // Il browser di Anna crea il gruppo cifrato con tutti e due, in un commit.
      const invito: Invito = async () => {
        const invitati: Invitato[] = [];
        for (const altro of altri) {
          invitati.push({ idDiChiEntra: altro.id, keyPackage: await chiaveDi(aia, altro) });
        }
        return invitati;
      };
      const aperturaAnna = await apriConversazione(aia.ctx, { ...creato, creaQui: true }, invito);
      if (aperturaAnna.kind !== "pronta") {
        throw new Error("Il gruppo di Anna doveva aprirsi");
      }
      let sAnna = aperturaAnna.sessione;

      const entra = async (c: Casa): Promise<Sessione> => {
        const vista = await vistaDi(c, conv);
        expect(vista.ordinataQui).toBe(false);
        const apertura = await apriConversazione(c.ctx, vista, nessunInvito);
        if (apertura.kind !== "pronta") {
          throw new Error(`${c.username} doveva entrare dal Welcome`);
        }
        return apertura.sessione;
      };
      let sBruno = await entra(borgo);
      const sCarla = await entra(colle);

      await manda(aia.ctx, sAnna, { testo: "si semina sabato" }, "m1", "2026-11-27T10:00:00.000Z");
      const primaDiBruno = await giro(borgo, sBruno, conv);
      expect(primaDiBruno.righe.map((r) => [r.mittente, r.testo, r.attestata])).toEqual([
        [`anna@${aia.casa}`, "si semina sabato", true],
      ]);
      // L'albero e le persone dicono la stessa cosa, anche visti da un'altra casa.
      expect(primaDiBruno.confronto).toEqual({ assenti: [], estranei: [] });
      // Carla ha la catena: potrebbe leggere. Non lo fa qui per una ragione
      // dell'istanza, non del gruppo: una casa chiede i segnaposto a un'altra
      // al più ogni dieci secondi, e questa prova non li aspetta.
      expect(sCarla.catena).toHaveLength(1);
      const catenaDiCarla = sCarla.catena ?? [];

      /* --- Anna toglie Carla --- */
      const carla = altri.find((m) => m.username === "carla")!;
      await chiama(
        aia.app,
        aia.token,
        "DELETE",
        `/api/v1/conversazioni/${conv}/membri/${carla.id}`,
      );
      sAnna = await faiUscire(aia.ctx, sAnna, membroDi(carla, aia.casa));
      expect(nomiNellAlbero(sAnna)).toEqual(["anna", "bruno"]);
      expect(sAnna.catena).toHaveLength(2);

      await manda(aia.ctx, sAnna, { testo: "senza Carla" }, "m2", "2026-11-27T11:00:00.000Z");

      // Bruno, da un'altra casa, applica il commit, deriva la stessa chiave e legge.
      const diBruno = await giro(borgo, sBruno, conv);
      sBruno = diBruno.sessione;
      expect(diBruno.righe.map((r) => r.testo)).toEqual(["si semina sabato", "senza Carla"]);
      expect(sBruno.catena).toEqual(sAnna.catena);
      expect(diBruno.confronto).toEqual({ assenti: [], estranei: [] });

      // Criterio 3: la casa di Carla non le serve più niente di questo gruppo.
      await expect(giro(colle, sCarla, conv)).rejects.toMatchObject({
        code: "rimosso_dal_gruppo",
        status: 403,
      });
      // E se anche avesse in mano la voce nuova, con le chiavi che ha non la apre.
      const [, nuova] = (await aia.ctx.istanza.cronologia(conv)).righe;
      expect(nuova?.voce?.chiaveN).toBe(2);
      expect(
        rileggiLegata(catenaDiCarla, nuova!.voce!, {
          conversazioneId: conv,
          createdAt: nuova!.createdAt,
          id: nuova!.id,
          mittente: nuova!.mittente!,
        }),
      ).toBeUndefined();

      /* --- Bruno esce: la sua foglia la toglie chi resta --- */
      await chiama(borgo.app, borgo.token, "POST", `/api/v1/conversazioni/${conv}/uscita`);
      expect((await vistaDi(aia, conv)).rimossi?.sort()).toEqual(
        [`bruno@${borgo.casa}`, `carla@${colle.casa}`].sort(),
      );

      const dopoLUscita = await giro(aia, sAnna, conv);
      sAnna = dopoLUscita.sessione;
      expect(nomiNellAlbero(sAnna)).toEqual(["anna"]);
      expect(sAnna.catena).toHaveLength(3);
      expect(dopoLUscita.confronto).toEqual({ assenti: [], estranei: [] });

      /* --- Anna riammette Carla --- */
      const { conversazione: conCarla } = (await chiama(
        aia.app,
        aia.token,
        "POST",
        `/api/v1/conversazioni/${conv}/membri`,
        { casa: colle.casa, username: "carla" },
      )) as { conversazione: VistaGruppo };
      const dinuovo = conCarla.membri.find((m) => m.username === "carla")!;
      sAnna = await faiEntrare(
        aia.ctx,
        sAnna,
        { id: dinuovo.id, membro: membroDi(dinuovo, aia.casa) },
        [await chiaveDi(aia, dinuovo)],
      );
      expect(nomiNellAlbero(sAnna)).toEqual(["anna", "carla"]);

      // Carla rientra dal Welcome nuovo, e da qui legge tutto: anche quello che
      // è stato scritto mentre era fuori. È ciò che l'ingresso dichiara.
      colle.ctx.deposito = depositoFinto();
      const tornata = await entra(colle);
      const diCarla = await giro(colle, tornata, conv);
      expect(diCarla.righe.map((r) => r.testo)).toEqual(["si semina sabato", "senza Carla"]);
      expect(diCarla.confronto).toEqual({ assenti: [], estranei: [] });
    });
  }, 120_000);
});

describe("il trasloco fra tre case, con MLS vero (ADR 0042 §3)", () => {
  it("la casa che ordina si spegne, passa un mese, un amministratore trasloca: nel successore si scrive, il vecchio si legge e non si scrive più", async () => {
    const orologio = { adesso: Date.parse("2026-11-28T10:00:00.000Z") };
    const passano = (ms: number): void => {
      orologio.adesso += ms;
    };
    const adesso = (): string => new Date(orologio.adesso).toISOString();

    await treCase(
      async (aia, borgo, colle, filo) => {
        /* --- il gruppo di prima: nasce ad Aia, e tutti e tre ci scrivono --- */
        const { conversazione: creato } = (await chiama(
          aia.app,
          aia.token,
          "POST",
          "/api/v1/gruppi",
          {
            membri: [
              { casa: borgo.casa, username: "bruno" },
              { casa: colle.casa, username: "carla" },
            ],
            nome: "Orto",
          },
        )) as { conversazione: VistaGruppo };
        const conv = creato.id;
        const altri = creato.membri.filter((m) => m.username !== "anna");
        const bruno = altri.find((m) => m.username === "bruno")!;
        await chiama(
          aia.app,
          aia.token,
          "PUT",
          `/api/v1/conversazioni/${conv}/membri/${bruno.id}/ruolo`,
          { ruolo: "amministratore" },
        );

        const aperturaAnna = await apriConversazione(
          aia.ctx,
          { ...creato, creaQui: true },
          async () => {
            const invitati: Invitato[] = [];
            for (const altro of altri) {
              invitati.push({ idDiChiEntra: altro.id, keyPackage: await chiaveDi(aia, altro) });
            }
            return invitati;
          },
        );
        if (aperturaAnna.kind !== "pronta") {
          throw new Error("Il gruppo di Anna doveva aprirsi");
        }

        const entra = async (c: Casa, id: string): Promise<Sessione> => {
          const apertura = await apriConversazione(c.ctx, await vistaDi(c, id), nessunInvito);
          if (apertura.kind !== "pronta") {
            throw new Error(`${c.username} doveva entrare dal Welcome`);
          }
          return apertura.sessione;
        };
        const vecchiaDiBruno = await entra(borgo, conv);
        const vecchiaDiCarla = await entra(colle, conv);

        await manda(aia.ctx, aperturaAnna.sessione, { testo: "si semina sabato" }, "v1", adesso());
        passano(1000);
        await manda(borgo.ctx, vecchiaDiBruno, { testo: "porto le zappe" }, "v2", adesso());
        passano(1000);
        await manda(colle.ctx, vecchiaDiCarla, { testo: "io i semi" }, "v3", adesso());
        // Una casa chiede i segnaposto a un'altra al più ogni dieci secondi.
        passano(11_000);

        const tutteETre = ["si semina sabato", "porto le zappe", "io i semi"];
        for (const [c, sessione] of [
          [borgo, vecchiaDiBruno],
          [colle, vecchiaDiCarla],
        ] as const) {
          expect((await giro(c, sessione, conv)).righe.map((r) => r.testo)).toEqual(tutteETre);
        }

        /* --- Aia si spegne, e non torna --- */
        filo.spegni(aia.casa);
        passano(60_000);
        // Un'attesa, non una scomparsa: nessun gesto, e la frase è quella di §3.
        const dopoUnMinuto = await vistaDi(borgo, conv);
        expect(dopoUnMinuto.casaPersaDal).toBeUndefined();
        expect(dopoUnMinuto.puoTraslocare).toBe(false);
        await expect(giro(borgo, vecchiaDiBruno, conv)).rejects.toMatchObject({
          code: "casa_che_ordina_non_raggiungibile",
        });
        await expect(
          chiama(borgo.app, borgo.token, "POST", `/api/v1/conversazioni/${conv}/trasloco`, {
            epoch: 1,
          }),
        ).rejects.toMatchObject({ code: "casa_non_persa", status: 409 });

        // Passa più di un mese, e Aia tace. Le sessioni di Bruno e Carla nel
        // frattempo sono scadute: accedono di nuovo, dallo stesso browser.
        passano(31 * 24 * 60 * 60 * 1000);
        await riaccede(borgo);
        await riaccede(colle);
        // Il battito (ADR 0041) vive nel processo e in una prova non gira:
        // fra le due case vive lo si fa a mano, come lo farebbe ogni cinque minuti.
        await borgo.app.federationService.ping(colle.casa);
        await colle.app.federationService.ping(borgo.casa);

        /* --- il gesto: solo chi amministra, e solo adesso --- */
        const perCarla = await vistaDi(colle, conv);
        expect(perCarla.casaPersaDal).toBeDefined();
        expect(perCarla.puoTraslocare).toBe(false);
        await expect(
          chiama(colle.app, colle.token, "POST", `/api/v1/conversazioni/${conv}/trasloco`, {
            epoch: 1,
          }),
        ).rejects.toMatchObject({ code: "trasloco_solo_amministratori", status: 403 });

        const perBruno = await vistaDi(borgo, conv);
        expect(perBruno).toMatchObject({ congelata: false, puoTraslocare: true });
        expect(Date.parse(perBruno.casaPersaDal!)).toBeLessThan(
          orologio.adesso - 30 * 24 * 60 * 60 * 1000,
        );

        const ultimaEpoch = Number(epochDi(vecchiaDiBruno.stato));
        const traslocatoIl = adesso();
        const { conversazione: nuovo } = (await chiama(
          borgo.app,
          borgo.token,
          "POST",
          `/api/v1/conversazioni/${conv}/trasloco`,
          { epoch: ultimaEpoch },
        )) as { conversazione: VistaGruppo };

        // Un gruppo nuovo, ordinato da Borgo, che dichiara che cosa continua.
        // Anna non c'è: la sua casa quel giorno non risponde.
        expect(nuovo.id).not.toBe(conv);
        expect(nuovo).toMatchObject({
          continua: {
            conversazioneId: conv,
            da: `bruno@${borgo.casa}`,
            epoch: ultimaEpoch,
            il: traslocatoIl,
            nome: "Orto",
          },
          nome: "Orto",
          ordinataQui: true,
        });
        expect(nuovo.membri.map((m) => m.username).sort()).toEqual(["bruno", "carla"]);

        /* --- le due case vive si scrivono nel successore --- */
        const carlaNelNuovo = nuovo.membri.find((m) => m.username === "carla")!;
        const aperturaBruno = await apriConversazione(
          borgo.ctx,
          { ...nuovo, creaQui: true },
          async () => [
            { idDiChiEntra: carlaNelNuovo.id, keyPackage: await chiaveDi(borgo, carlaNelNuovo) },
          ],
        );
        if (aperturaBruno.kind !== "pronta") {
          throw new Error("Il successore doveva aprirsi sul browser di Bruno");
        }
        const nuovaDiBruno = aperturaBruno.sessione;
        // Il mazzo è nuovo: le chiavi del gruppo di prima non aprono il seguito.
        expect(nuovaDiBruno.catena).toHaveLength(1);
        expect(nuovaDiBruno.catena).not.toEqual(vecchiaDiBruno.catena);

        expect((await vistaDi(colle, nuovo.id)).continua).toEqual(nuovo.continua);
        const nuovaDiCarla = await entra(colle, nuovo.id);

        await manda(borgo.ctx, nuovaDiBruno, { testo: "si riparte da qui" }, "n1", adesso());
        passano(1000);
        await manda(colle.ctx, nuovaDiCarla, { testo: "ci sono" }, "n2", adesso());
        passano(11_000);
        for (const [c, sessione] of [
          [borgo, nuovaDiBruno],
          [colle, nuovaDiCarla],
        ] as const) {
          const letto = await giro(c, sessione, nuovo.id);
          expect(letto.righe.map((r) => [r.mittente, r.testo])).toEqual([
            [`bruno@${borgo.casa}`, "si riparte da qui"],
            [`carla@${colle.casa}`, "ci sono"],
          ]);
          expect(letto.confronto).toEqual({ assenti: [], estranei: [] });
        }

        /* --- il gruppo di prima: marcato, si legge, non si scrive --- */
        for (const c of [borgo, colle]) {
          const vecchio = await vistaDi(c, conv);
          expect(vecchio).toMatchObject({
            congelata: true,
            nome: "Orto",
            successori: [{ da: `bruno@${borgo.casa}`, id: nuovo.id, il: traslocatoIl }],
          });

          // Come dopo aver ricaricato la pagina: niente in memoria, solo ciò
          // che il browser aveva tenuto. La coda e il mazzo stavano ad Aia.
          const riaperta = await apriConversazione(
            c.ctx,
            { congelata: true, id: conv, ordinataQui: false },
            nessunInvito,
          );
          if (riaperta.kind !== "pronta") {
            throw new Error(`${c.username} doveva riaprire il gruppo di prima`);
          }

          // Le parole di chi ha la casa viva si leggono ancora, con le chiavi
          // che il dispositivo aveva già. Quelle di Anna stavano ad Aia: resta
          // chi e quando, e la casa che non risponde è nominata.
          const letto = await leggi(c.ctx, riaperta.sessione, undefined, undefined, {
            congelata: true,
          });
          expect(letto.righe.map((r) => [r.mittente, r.stato, r.testo])).toEqual([
            [`anna@${aia.casa}`, "non-disponibile", undefined],
            [`bruno@${borgo.casa}`, "letta", "porto le zappe"],
            [`carla@${colle.casa}`, "letta", "io i semi"],
          ]);
          expect(letto.nonRispondono).toEqual([aia.casa]);

          // E la scrittura è spenta dall'istanza, non solo dalla schermata.
          await expect(
            manda(
              c.ctx,
              riaperta.sessione,
              { testo: "ancora qui?" },
              `tardi-${c.username}`,
              adesso(),
            ),
          ).rejects.toMatchObject({ code: "gruppo_congelato", status: 409 });
          await expect(
            chiama(c.app, c.token, "POST", `/api/v1/conversazioni/${conv}/uscita`),
          ).rejects.toMatchObject({ code: "gruppo_congelato" });
        }
      },
      () => new Date(orologio.adesso),
    );
  }, 180_000);
});
