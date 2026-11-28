/**
 * Un gruppo fra tre case intere, dalle rotte al protocollo (M8 Fase 1).
 *
 * `gruppi.test.ts` prova le regole, con tre servizi e le chiamate dirette fra
 * loro. Qui ci sono **tre istanze** (`buildApp`), le rotte HTTP con cui la
 * schermata le chiama, e fra le case il protocollo vero: ogni domanda viene
 * serializzata, la legge `parseRequest`, la serve ciò che `buildApp` ha
 * collegato. Al posto di iroh c'è [`filo-finto.ts`](../federation/filo-finto.ts),
 * e nient'altro è finto — è la lezione del 2026-11-27, quando le operazioni di
 * ADR 0042 erano provate una per una e non erano collegate.
 *
 * Anna abita ad Aia e crea il gruppo: Aia ordina. Bruno e Dino abitano a
 * Borgo, Carla a Colle. **Borgo e Colle non sono collegate fra loro**: è il
 * difetto che M8 doveva chiudere — la terza casa che alla seconda non risulta.
 */
import { loadConfig } from "@estia/config";
import type { ConversazioneView } from "@estia/contracts";
import { withTempDataDir } from "@estia/testing";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { FiloFinto } from "../federation/filo-finto.js";

const SETUP_TOKEN = "setup-token-gruppi-sul-filo";

interface Casa {
  app: FastifyInstance;
  /** La chiave della casa. */
  casa: string;
  /** I token delle persone che ci abitano, per nome. */
  token: Record<string, string>;
  /** I loro id in questa casa, per nome. */
  id: Record<string, string>;
}

interface Risposta {
  stato: number;
  corpo: { code?: string; conversazione?: ConversazioneView; conversazioni?: ConversazioneView[] };
}

async function chiama(
  casa: Casa,
  chi: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
): Promise<Risposta> {
  const res = await casa.app.inject({
    headers: { authorization: `Bearer ${casa.token[chi] ?? ""}` },
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });

  return {
    corpo: res.body.length === 0 ? {} : (JSON.parse(res.body) as Risposta["corpo"]),
    stato: res.statusCode,
  };
}

async function casaNuova(dataDir: string, nome: string, filo: FiloFinto): Promise<Casa> {
  const app = await buildApp(
    loadConfig({ ESTIA_DATA_DIR: dataDir, ESTIA_HOST: "127.0.0.1", ESTIA_LOG_LEVEL: "silent" }),
    { createEndpoint: filo.endpoint, setupToken: SETUP_TOKEN },
  );
  const password = "password-lunga-di-chi-amministra";
  await app.inject({
    method: "POST",
    payload: {
      adminPassword: password,
      adminUsername: "custode",
      name: nome,
      setupToken: SETUP_TOKEN,
    },
    url: "/api/v1/instance/setup",
  });
  const login = await app.identityService.login({ password, username: "custode" });
  const casa: Casa = { app, casa: "", id: {}, token: { custode: login.token } };
  const letta = await app.inject({
    headers: { authorization: `Bearer ${login.token}` },
    method: "GET",
    url: "/api/v1/mls/casa",
  });
  casa.casa = (JSON.parse(letta.body) as { casa: string }).casa;

  return casa;
}

/** Una persona che abita in una casa, ed è presente in rete. */
async function abita(casa: Casa, username: string): Promise<void> {
  const password = `password-lunga-di-${username}`;
  const utente = await casa.app.identityService.createUser({ password, role: "member", username });
  casa.id[username] = utente.id;
  casa.token[username] = (await casa.app.identityService.login({ password, username })).token;

  const profilo = await chiama(casa, username, "PUT", "/api/v1/profile", {
    bio: "",
    openFollows: false,
    presence: "presente_privato",
  });
  expect(profilo.stato).toBe(200);
}

async function collega(a: Casa, b: Casa): Promise<void> {
  await a.app.federationService.requestConnection(b.casa);
  await b.app.federationService.accept(a.casa);
}

/** Le spinte partono senza essere attese: si aspetta che una cosa diventi vera. */
async function finche<T>(leggi: () => Promise<T>, vera: (valore: T) => boolean): Promise<T> {
  for (let giro = 0; giro < 200; giro += 1) {
    const valore = await leggi();
    if (vera(valore)) {
      return valore;
    }
    await new Promise((fatto) => setTimeout(fatto, 5));
  }

  throw new Error("Quello che si aspettava non è arrivato.");
}

async function treCase(
  use: (aia: Casa, borgo: Casa, colle: Casa, filo: FiloFinto) => Promise<void>,
): Promise<void> {
  await withTempDataDir(async (primo) => {
    await withTempDataDir(async (secondo) => {
      await withTempDataDir(async (terzo) => {
        const filo = new FiloFinto();
        const aia = await casaNuova(primo, "Aia", filo);
        const borgo = await casaNuova(secondo, "Borgo", filo);
        const colle = await casaNuova(terzo, "Colle", filo);

        try {
          await abita(aia, "anna");
          await abita(borgo, "bruno");
          await abita(borgo, "dino");
          await abita(colle, "carla");
          // Aia con Borgo, Aia con Colle. Borgo e Colle non si conoscono.
          await collega(aia, borgo);
          await collega(aia, colle);

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

const conv = (id: string, resto = ""): string =>
  `/api/v1/conversazioni/${encodeURIComponent(id)}${resto}`;
const membro = (id: string, chi: string, resto = ""): string =>
  conv(id, `/membri/${encodeURIComponent(chi)}${resto}`);

/** Anna crea «Cena di quartiere» con Bruno e Carla, e le due case lo sanno. */
async function gruppo(aia: Casa, borgo: Casa, colle: Casa): Promise<string> {
  const creato = await chiama(aia, "anna", "POST", "/api/v1/gruppi", {
    membri: [
      { casa: borgo.casa, username: "bruno" },
      { casa: colle.casa, username: "carla" },
    ],
    nome: "Cena di quartiere",
  });
  expect(creato.stato).toBe(200);
  const id = creato.corpo.conversazione!.id;

  for (const [casa, chi] of [
    [borgo, "bruno"],
    [colle, "carla"],
  ] as const) {
    await finche(
      () => chiama(casa, chi, "GET", conv(id)),
      (r) => r.stato === 200,
    );
  }

  return id;
}

const nomi = (vista: ConversazioneView | undefined): string[] =>
  (vista?.membri ?? []).map((m) => m.username).sort();

describe("un gruppo fra tre case, sulle rotte e sul protocollo", () => {
  it("nasce ad Aia, e a Borgo risulta anche Carla, che abita in una casa che Borgo non conosce", async () => {
    await treCase(async (aia, borgo, colle) => {
      const creato = await chiama(aia, "anna", "POST", "/api/v1/gruppi", {
        membri: [
          { casa: borgo.casa, username: "bruno" },
          { casa: colle.casa, username: "carla" },
        ],
        nome: "Cena di quartiere",
      });

      expect(creato.stato).toBe(200);
      const perAnna = creato.corpo.conversazione!;
      expect(perAnna).toMatchObject({
        nome: "Cena di quartiere",
        ordinataQui: true,
        tipo: "gruppo",
      });
      expect(nomi(perAnna)).toEqual(["anna", "bruno", "carla"]);
      expect(Object.values(perAnna.ruoli ?? {}).sort()).toEqual(["creatore", "membro", "membro"]);

      const perBruno = await finche(
        () => chiama(borgo, "bruno", "GET", "/api/v1/conversazioni"),
        (r) => (r.corpo.conversazioni ?? []).length === 1,
      );
      const vista = perBruno.corpo.conversazioni![0]!;
      expect(vista).toMatchObject({
        id: perAnna.id,
        nome: "Cena di quartiere",
        ordinataQui: false,
        tipo: "gruppo",
      });
      // Il difetto di M8: l'annuncio portava i destinatari di una casa sola, e
      // qui Carla non c'era.
      expect(nomi(vista)).toEqual(["anna", "bruno", "carla"]);
      expect(vista.membri.map((m) => m.id)).toContain(`remote:${colle.casa}:carla`);
      expect(vista.ruoli?.[`remote:${aia.casa}:anna`]).toBe("creatore");

      const perCarla = await finche(
        () => chiama(colle, "carla", "GET", conv(perAnna.id)),
        (r) => r.stato === 200,
      );
      expect(nomi(perCarla.corpo.conversazione)).toEqual(["anna", "bruno", "carla"]);
    });
  }, 60_000);

  it("sotto tre persone non è un gruppo, e senza nome nemmeno", async () => {
    await treCase(async (aia, borgo) => {
      const inDue = await chiama(aia, "anna", "POST", "/api/v1/gruppi", {
        membri: [{ casa: borgo.casa, username: "bruno" }],
        nome: "In due",
      });
      expect(inDue.stato).toBe(400);

      const conSeStessa = await chiama(aia, "anna", "POST", "/api/v1/gruppi", {
        membri: [{ casa: borgo.casa, username: "bruno" }, { username: "anna" }],
        nome: "In due e mezzo",
      });
      expect(conSeStessa).toMatchObject({ corpo: { code: "gruppo_troppo_piccolo" }, stato: 400 });

      const senzaNome = await chiama(aia, "anna", "POST", "/api/v1/gruppi", {
        membri: [
          { casa: borgo.casa, username: "bruno" },
          { casa: borgo.casa, username: "dino" },
        ],
        nome: "",
      });
      expect(senzaNome.stato).toBe(400);
    });
  }, 60_000);

  it("aggiunge chi amministra, e da un'altra casa lo si chiede a chi ordina", async () => {
    await treCase(async (aia, borgo, colle, filo) => {
      const id = await gruppo(aia, borgo, colle);
      const inizio = filo.domande.length;

      // Bruno è un membro semplice: la sua casa lo chiede ad Aia, e Aia dice di no.
      const negato = await chiama(borgo, "bruno", "POST", conv(id, "/membri"), {
        username: "dino",
      });
      expect(negato).toMatchObject({ corpo: { code: "solo_amministratori" }, stato: 403 });

      // Solo il creatore nomina: Bruno non si nomina da sé.
      const daSe = await chiama(borgo, "bruno", "PUT", membro(id, idDi(borgo, "bruno"), "/ruolo"), {
        ruolo: "amministratore",
      });
      expect(daSe).toMatchObject({ corpo: { code: "solo_il_creatore" }, stato: 403 });

      const nominato = await chiama(
        aia,
        "anna",
        "PUT",
        membro(id, `remote:${borgo.casa}:bruno`, "/ruolo"),
        { ruolo: "amministratore" },
      );
      expect(nominato.stato).toBe(200);
      expect(nominato.corpo.conversazione?.ruoli?.[`remote:${borgo.casa}:bruno`]).toBe(
        "amministratore",
      );

      const aggiunto = await chiama(borgo, "bruno", "POST", conv(id, "/membri"), {
        username: "dino",
      });
      expect(aggiunto.stato).toBe(200);
      expect(nomi(aggiunto.corpo.conversazione)).toEqual(["anna", "bruno", "carla", "dino"]);

      // E lo sanno tutti: chi ordina, e la casa che con Borgo non parla.
      expect(nomi((await chiama(aia, "anna", "GET", conv(id))).corpo.conversazione)).toEqual([
        "anna",
        "bruno",
        "carla",
        "dino",
      ]);
      await finche(
        () => chiama(colle, "carla", "GET", conv(id)),
        (r) => nomi(r.corpo.conversazione).includes("dino"),
      );
      expect((await chiama(borgo, "dino", "GET", conv(id))).stato).toBe(200);

      // Due volte non si entra.
      const diNuovo = await chiama(borgo, "bruno", "POST", conv(id, "/membri"), {
        username: "dino",
      });
      expect(diNuovo).toMatchObject({ corpo: { code: "gia_nel_gruppo" }, stato: 409 });

      // Tutto questo è passato dal protocollo, con le due operazioni nuove.
      const passate = filo.domande.slice(inizio);
      expect(new Set(passate.map((d) => d.tipo))).toEqual(new Set(["membri", "composizione"]));
      expect(
        passate.filter(
          (d) => (d.risposta as { codice?: string }).codice === "richiesta_sconosciuta",
        ),
      ).toEqual([]);
    });
  }, 60_000);

  it("chi è tolto non riceve più niente, in nessuna casa, e gli si dice perché", async () => {
    await treCase(async (aia, borgo, colle) => {
      const id = await gruppo(aia, borgo, colle);
      // Carla ha scritto qualcosa, e la sua casa lo custodisce.
      expect(
        (
          await chiama(colle, "carla", "POST", conv(id, "/archivio"), {
            voci: [
              { busta: "Vk9DRQ==", chiaveN: 1, createdAt: "2026-11-27T10:00:00.000Z", id: "m-1" },
            ],
          })
        ).stato,
      ).toBe(200);

      // Bruno non amministra: non toglie nessuno.
      const negato = await chiama(
        borgo,
        "bruno",
        "DELETE",
        membro(id, `remote:${colle.casa}:carla`),
      );
      expect(negato).toMatchObject({ corpo: { code: "solo_amministratori" }, stato: 403 });

      const tolta = await chiama(aia, "anna", "DELETE", membro(id, `remote:${colle.casa}:carla`));
      expect(tolta.stato).toBe(200);
      expect(nomi(tolta.corpo.conversazione)).toEqual(["anna", "bruno"]);

      // A casa sua Carla lo scopre, con la frase giusta, su ogni porta.
      const rifiuto = await finche(
        () => chiama(colle, "carla", "GET", conv(id)),
        (r) => r.stato !== 200,
      );
      expect(rifiuto).toMatchObject({ corpo: { code: "rimosso_dal_gruppo" }, stato: 403 });
      for (const porta of ["/cronologia", "/handshake", "/archivio/chiavi", "/group-info"]) {
        expect(await chiama(colle, "carla", "GET", conv(id, porta))).toMatchObject({
          corpo: { code: "rimosso_dal_gruppo" },
          stato: 403,
        });
      }
      expect(
        (await chiama(colle, "carla", "GET", "/api/v1/conversazioni")).corpo.conversazioni,
      ).toEqual([]);

      // E la casa che ordina non serve più la coda né lo stato alla sua casa,
      // nemmeno se li chiedesse lo stesso.
      expect(await colle.app.federationService.fetchHandshake(aia.casa, id)).toEqual({
        esito: "rifiutato",
      });
      expect(await colle.app.federationService.leggiStatoPresso(aia.casa, id, "mazzo")).toEqual({
        esito: "rifiutato",
      });
      expect(await colle.app.federationService.visitaArchivioPresso(aia.casa, id, ["x"])).toEqual({
        esito: "rifiutato",
      });

      // Quello che Carla aveva scritto resta leggibile a chi è rimasto: la sua
      // casa lo custodisce ancora, e sa chi c'è (ADR 0043).
      expect(
        await aia.app.federationService.visitaArchivioPresso(colle.casa, id, ["m-1"]),
      ).toMatchObject({ esito: "voci", voci: [{ id: "m-1" }] });

      // Anche Bruno la vede fuori.
      await finche(
        () => chiama(borgo, "bruno", "GET", conv(id)),
        (r) => nomi(r.corpo.conversazione).length === 2,
      );
    });
  }, 60_000);

  it("uscire è di chi esce: non chiede permesso, e attraversa", async () => {
    await treCase(async (aia, borgo, colle) => {
      const id = await gruppo(aia, borgo, colle);

      const uscita = await chiama(borgo, "bruno", "POST", conv(id, "/uscita"));
      expect(uscita.stato).toBe(204);

      expect(await chiama(borgo, "bruno", "GET", conv(id))).toMatchObject({
        corpo: { code: "rimosso_dal_gruppo" },
        stato: 403,
      });
      expect(nomi((await chiama(aia, "anna", "GET", conv(id))).corpo.conversazione)).toEqual([
        "anna",
        "carla",
      ]);
      await finche(
        () => chiama(colle, "carla", "GET", conv(id)),
        (r) => nomi(r.corpo.conversazione).length === 2,
      );

      // Un gruppo non si elimina: se ne esce.
      expect(await chiama(aia, "anna", "DELETE", conv(id))).toMatchObject({
        corpo: { code: "gruppo_non_si_elimina" },
      });
    });
  }, 60_000);

  it("con la casa che ordina spenta non si cambia chi c'è, e lo si dice", async () => {
    await treCase(async (aia, borgo, colle, filo) => {
      const id = await gruppo(aia, borgo, colle);

      filo.spegni(aia.casa);
      expect(await chiama(borgo, "bruno", "POST", conv(id, "/uscita"))).toMatchObject({
        corpo: { code: "casa_che_ordina_non_raggiungibile" },
        stato: 503,
      });
      // Bruno è ancora dentro: l'uscita non è avvenuta a metà.
      expect((await chiama(borgo, "bruno", "GET", conv(id))).stato).toBe(200);
    });
  }, 60_000);

  it("una casa non collegata non mette nessuno di qui in un gruppo", async () => {
    await treCase(async (aia, borgo, colle) => {
      // Borgo e Colle non si conoscono: Bruno crea un gruppo con Carla e Dino.
      const creato = await chiama(borgo, "bruno", "POST", "/api/v1/gruppi", {
        membri: [{ casa: colle.casa, username: "carla" }, { username: "dino" }],
        nome: "Senza invito",
      });
      expect(creato.stato).toBe(200);
      const id = creato.corpo.conversazione!.id;

      // A Borgo esiste: è un gesto di Bruno. A Colle non nasce niente.
      await new Promise((fatto) => setTimeout(fatto, 50));
      expect(
        (await chiama(colle, "carla", "GET", "/api/v1/conversazioni")).corpo.conversazioni,
      ).toEqual([]);
      expect(colle.app.messaggiService.casaPartecipa(borgo.casa)).toBe(false);
      expect((await chiama(colle, "carla", "GET", conv(id))).stato).toBe(403);
      expect(aia.casa).not.toBe(borgo.casa);
    });
  }, 60_000);
});

/** L'id con cui una casa nomina una persona sua. */
function idDi(casa: Casa, username: string): string {
  const id = casa.id[username];
  if (id === undefined) {
    throw new Error(`Nessuno con questo nome: ${username}`);
  }
  return id;
}
