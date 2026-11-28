/**
 * Chi può fare che cosa in un gruppo, e come l'albero si mette accanto alle
 * persone. Sono le risposte da cui la schermata decide che cosa **offrire**:
 * un gesto offerto e poi rifiutato dall'istanza è lo stato che sembra pronto
 * e non lo è (euristica 5).
 */
import type { ConversazioneView } from "@estia/contracts";
import { describe, expect, it } from "vitest";

import {
  assentiFra,
  comeInput,
  composizioneDi,
  creaQui,
  gestiSu,
  gestisce,
  idAtteso,
  haUnTrasloco,
  mancaPerCreare,
  nomeDaIndirizzo,
  nomeNellEvento,
  nomina,
  statoTrasloco,
} from "./logica.js";

const CASA = "a".repeat(64);
const BORGO = "b".repeat(64);
const CARLA_ID = `remote:${BORGO}:carla`;

const gruppo = (ruoli: Record<string, "creatore" | "amministratore" | "membro">, qui = true) =>
  ({
    createdAt: "2026-11-27T10:00:00.000Z",
    id: "g1",
    membri: [
      { displayName: "Anna", id: "u-anna", username: "anna" },
      { displayName: "", id: "u-bruno", username: "bruno" },
      { displayName: "Carla", id: CARLA_ID, username: "carla" },
    ],
    nome: "Orto",
    nonLetti: 0,
    ordinataQui: qui,
    rimossi: [`dario@${BORGO}`, "senza-casa"],
    ruoli,
    tipo: "gruppo",
  }) as unknown as ConversazioneView;

const NORMALE = gruppo({ [CARLA_ID]: "membro", "u-anna": "creatore", "u-bruno": "amministratore" });
/** Il creatore è uscito: restano un amministratore e un membro. */
const ORFANO = gruppo({ [CARLA_ID]: "membro", "u-bruno": "amministratore" });

describe("chi fa che cosa", () => {
  it("aggiungono e tolgono il creatore e gli amministratori; i membri no", () => {
    expect(["u-anna", "u-bruno", CARLA_ID].map((id) => gestisce(NORMALE, id))).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("gli amministratori li nomina il creatore; se è uscito, chi amministra", () => {
    expect(nomina(NORMALE, "u-anna")).toBe(true);
    expect(nomina(NORMALE, "u-bruno")).toBe(false);
    expect(nomina(ORFANO, "u-bruno")).toBe(true);
    expect(nomina(ORFANO, CARLA_ID)).toBe(false);
  });

  it("su di sé e sul creatore non si offre niente: da sé si esce, e il creatore non si toglie", () => {
    const niente = { nominare: false, revocare: false, togliere: false };
    expect(gestiSu(NORMALE, "u-anna", "u-anna")).toEqual(niente);
    expect(gestiSu(NORMALE, "u-bruno", "u-anna")).toEqual(niente);
    expect(gestiSu(NORMALE, CARLA_ID, "u-bruno")).toEqual(niente);
  });

  it("il creatore toglie, nomina e revoca; un amministratore toglie soltanto", () => {
    expect(gestiSu(NORMALE, "u-anna", CARLA_ID)).toEqual({
      nominare: true,
      revocare: false,
      togliere: true,
    });
    expect(gestiSu(NORMALE, "u-anna", "u-bruno")).toEqual({
      nominare: false,
      revocare: true,
      togliere: true,
    });
    expect(gestiSu(NORMALE, "u-bruno", CARLA_ID)).toEqual({
      nominare: false,
      revocare: false,
      togliere: true,
    });
  });

  it("il gruppo cifrato lo crea chi ha creato il gruppo, dalla casa che ordina", () => {
    expect(creaQui(NORMALE, "u-anna")).toBe(true);
    // Stessa casa, ma non l'ha creato lui: aspetta, o sarebbero in due a crearlo.
    expect(creaQui(NORMALE, "u-bruno")).toBe(false);
    expect(creaQui(gruppo({ "u-anna": "creatore" }, false), "u-anna")).toBe(false);
    // Il creatore è uscito prima di aprirlo: tocca a chi amministra.
    expect(creaQui(ORFANO, "u-bruno")).toBe(true);
    // Una conversazione a due la crea chiunque stia nella casa che ordina.
    expect(creaQui({ ...NORMALE, tipo: "diretta" }, "u-bruno")).toBe(true);
  });
});

describe("le persone, dette come le dice MLS", () => {
  it("ogni membro con la sua casa, e i rimossi soltanto se hanno un indirizzo", () => {
    expect(composizioneDi(NORMALE, CASA)).toEqual({
      autorevole: true,
      membri: [
        { id: "u-anna", membro: { casa: CASA, username: "anna" } },
        { id: "u-bruno", membro: { casa: CASA, username: "bruno" } },
        { id: CARLA_ID, membro: { casa: BORGO, username: "carla" } },
      ],
      rimossi: [{ casa: BORGO, username: "dario" }],
    });
    expect(composizioneDi(gruppo({}, false), CASA).autorevole).toBe(false);
    // In una conversazione a due non si toglie nessuno da soli, nemmeno dalla casa che ordina.
    expect(composizioneDi({ ...NORMALE, tipo: "diretta" }, CASA).autorevole).toBe(false);
  });

  it("chi non ha ancora una foglia si ritrova per id", () => {
    const assenti = assentiFra(NORMALE, CASA, {
      assenti: [{ casa: BORGO, username: "carla" }],
      estranei: [],
    });
    expect([...assenti]).toEqual([CARLA_ID]);
    expect(assentiFra(NORMALE, CASA, undefined).size).toBe(0);
  });

  it("una persona cercata si scrive con la casa solo se abita altrove, e si ritrova fra i membri", () => {
    expect(comeInput({ username: "bruno" }, CASA)).toEqual({ username: "bruno" });
    expect(comeInput({ instanceKey: CASA, username: "bruno" }, CASA)).toEqual({
      username: "bruno",
    });
    expect(comeInput({ instanceKey: BORGO, username: "carla" }, CASA)).toEqual({
      casa: BORGO,
      username: "carla",
    });

    expect(idAtteso({ username: "bruno" }, NORMALE.membri, CASA)).toBe("u-bruno");
    expect(idAtteso({ instanceKey: BORGO, username: "carla" }, NORMALE.membri, CASA)).toBe(
      CARLA_ID,
    );
    // `carla` di qui non è `carla` di Borgo.
    expect(idAtteso({ username: "carla" }, NORMALE.membri, CASA)).toBeUndefined();
  });

  it("un evento nomina chi c'è con il suo nome, e chi non c'è più con il nome utente", () => {
    expect(nomeNellEvento({ chi: `carla@${BORGO}`, tipo: "ingresso" }, NORMALE, CASA)).toBe(
      "Carla",
    );
    expect(nomeNellEvento({ chi: `dario@${BORGO}`, tipo: "rimozione" }, NORMALE, CASA)).toBe(
      "dario",
    );
  });
});

describe("creare un gruppo", () => {
  it("dice che cosa manca, una cosa alla volta", () => {
    expect(mancaPerCreare("  ", 5)).toBe("nome");
    expect(mancaPerCreare("Orto", 1)).toBe("persone");
    expect(mancaPerCreare("Orto", 2)).toBeUndefined();
    expect(mancaPerCreare("Orto", 49)).toBeUndefined();
    expect(mancaPerCreare("Orto", 50)).toBe("troppe");
  });
});

describe("il trasloco (ADR 0042 §3)", () => {
  const mie = new Set(["g1", "g2"]);
  const IL = "2026-11-28T10:00:00.000Z";

  it("un gruppo qualunque non ha niente da dire", () => {
    const stato = statoTrasloco(NORMALE, mie);
    expect(stato).toEqual({ congelato: false, successori: [] });
    expect(haUnTrasloco(stato)).toBe(false);
  });

  it("il gesto c'è solo quando la casa è persa, e solo per chi può", () => {
    const persa = { ...NORMALE, casaPersaDal: IL, congelata: false };
    expect(statoTrasloco({ ...persa, puoTraslocare: true }, mie).persa).toEqual({
      dal: IL,
      puoi: true,
    });
    // Chi non amministra vede che la casa è persa, e non il gesto.
    expect(statoTrasloco({ ...persa, puoTraslocare: false }, mie).persa).toEqual({
      dal: IL,
      puoi: false,
    });
    expect(statoTrasloco({ ...NORMALE, puoTraslocare: false }, mie).persa).toBeUndefined();
  });

  it("un gruppo traslocato porta ai suoi successori — a tutti e due, se sono due — e non offre più il gesto", () => {
    const stato = statoTrasloco(
      {
        ...NORMALE,
        casaPersaDal: IL,
        congelata: true,
        puoTraslocare: true,
        successori: [
          { da: `bruno@${CASA}`, id: "g2", il: IL },
          { da: `carla@${BORGO}`, id: "g3", il: IL },
        ],
      },
      mie,
    );

    expect(stato.congelato).toBe(true);
    expect(stato.persa).toBeUndefined();
    // Nel secondo chi guarda non c'è: lo vede, e non ha dove andare.
    expect(stato.successori.map((s) => [s.id, s.mio])).toEqual([
      ["g2", true],
      ["g3", false],
    ]);
  });

  it("in un gruppo congelato nessuno aggiunge, toglie o nomina", () => {
    const congelato = { ...NORMALE, congelata: true };
    expect(gestisce(congelato, "u-anna")).toBe(false);
    expect(nomina(congelato, "u-anna")).toBe(false);
    expect(gestiSu(congelato, "u-anna", CARLA_ID)).toEqual({
      nominare: false,
      revocare: false,
      togliere: false,
    });
  });

  it("un successore dichiara che cosa continua, e chi l'ha traslocato ha un nome", () => {
    const continua = {
      casaPersaDal: "2026-10-01T10:00:00.000Z",
      conversazioneId: "g0",
      da: `bruno@${CASA}`,
      epoch: 4,
      il: IL,
      nome: "Orto",
    };
    const stato = statoTrasloco({ ...NORMALE, continua }, mie);
    // Il gruppo di prima non è fra le conversazioni di chi guarda: non si apre.
    expect(stato.continua).toEqual({ ...continua, apribile: false });
    expect(statoTrasloco({ ...NORMALE, continua }, new Set(["g0"])).continua?.apribile).toBe(true);

    // Bruno non si è dato un nome: vale il nome utente. Chi non è fra i membri idem.
    expect(nomeDaIndirizzo(`bruno@${CASA}`, NORMALE, CASA)).toBe("bruno");
    expect(nomeDaIndirizzo(`carla@${BORGO}`, NORMALE, CASA)).toBe("Carla");
    expect(nomeDaIndirizzo(`dario@${BORGO}`, NORMALE, CASA)).toBe("dario");
  });
});
