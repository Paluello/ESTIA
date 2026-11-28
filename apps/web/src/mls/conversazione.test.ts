/**
 * Quello che la schermata chiede.
 *
 * Il caso che conta di più è il secondo: un dispositivo che **non ha niente in
 * locale** e trova solo un Welcome sul canale. È la situazione di chiunque apra
 * una conversazione per la prima volta, e finché il Welcome non portava l'albero
 * con sé non funzionava — nei test glielo passavo io, che è il modo migliore per
 * non accorgersene.
 */
import { describe, expect, it, vi } from "vitest";

import { depositoFinto, istanzaFinta, portachiaviFinto } from "./finte.js";
import { annuncia, apriConversazione, leggi, manda, type Invito } from "./conversazione.js";
import type { Contesto } from "./sessione.js";
import type { KeyPackage } from "ts-mls";

const ID_ANNA = "u-anna";
const ID_BRUNO = "u-bruno";

/** Anna e Bruno su un'istanza sola, ciascuno con il suo deposito e le sue chiavi. */
async function dueCase(): Promise<{
  anna: Contesto;
  bruno: Contesto;
  pacchettoBruno: KeyPackage;
  invitaBruno: Invito;
}> {
  const istanza = istanzaFinta();
  const chiaviAnna = await portachiaviFinto("anna");
  const chiaviBruno = await portachiaviFinto("bruno");
  istanza.ammetti("anna", chiaviAnna.chiaveDiFirma);
  istanza.ammetti("bruno", chiaviBruno.chiaveDiFirma);
  const pacchettoBruno = await chiaviBruno.pubblica();

  return {
    anna: { deposito: depositoFinto(), io: chiaviAnna, istanza: istanza.per(ID_ANNA) },
    bruno: { deposito: depositoFinto(), io: chiaviBruno, istanza: istanza.per(ID_BRUNO) },
    invitaBruno: () => Promise.resolve({ idDiChiEntra: ID_BRUNO, keyPackage: pacchettoBruno }),
    pacchettoBruno,
  };
}

const QUI = { id: "conv-1", ordinataQui: true };
const ALTROVE = { id: "conv-1", ordinataQui: false };
const nessunInvito: Invito = () => Promise.reject(new Error("Non si doveva invitare nessuno"));

describe("aprire una conversazione", () => {
  it("chi sta nella casa che ordina crea il gruppo e invita", async () => {
    const { anna, invitaBruno } = await dueCase();

    const apertura = await apriConversazione(anna, QUI, invitaBruno);

    expect(apertura.kind).toBe("pronta");
  });

  it("un dispositivo senza niente in locale entra dal solo Welcome", async () => {
    const { anna, bruno, invitaBruno } = await dueCase();
    await apriConversazione(anna, QUI, invitaBruno);

    // Bruno non ha MAI aperto questa conversazione: deposito vuoto, e nessuno
    // gli passa l'albero. Deve bastargli il Welcome — e non deve invitare.
    expect((await apriConversazione(bruno, ALTROVE, nessunInvito)).kind).toBe("pronta");
  });

  it("riaprendo si riprende quella di prima, senza invitare di nuovo", async () => {
    const { anna, invitaBruno } = await dueCase();
    const invito = vi.fn(invitaBruno);

    await apriConversazione(anna, QUI, invito);
    await apriConversazione(anna, QUI, invito);

    expect(invito).toHaveBeenCalledTimes(1);
  });

  it("chi sta altrove e non ha ancora un Welcome aspetta, e non crea un secondo gruppo", async () => {
    // Un gruppo creato da due parti è una corsa che uno dei due perde (§3).
    const { bruno } = await dueCase();

    expect(await apriConversazione(bruno, ALTROVE, nessunInvito)).toEqual({ kind: "in-attesa" });
  });

  it("un browser svuotato rientra dal punto di rientro, invece di creare un altro gruppo", async () => {
    const { anna, bruno, invitaBruno } = await dueCase();
    await apriConversazione(anna, QUI, invitaBruno);
    await apriConversazione(bruno, ALTROVE, nessunInvito);

    // Anna perde lo stato del gruppo. La conversazione la ordina la sua casa,
    // ma il gruppo esiste già: creare un gruppo nuovo sarebbe spaccarlo.
    const annaSvuotata: Contesto = { ...anna, deposito: depositoFinto() };
    const invito = vi.fn(invitaBruno);
    const apertura = await apriConversazione(annaSvuotata, QUI, invito);

    expect(apertura.kind).toBe("pronta");
    expect(invito).not.toHaveBeenCalled();
  });
});

describe("il giro completo che la schermata fa", () => {
  it("porta una riga da Anna a Bruno, con la risposta dentro la voce", async () => {
    const { anna, bruno, invitaBruno } = await dueCase();

    const perAnna = await apriConversazione(anna, QUI, invitaBruno);
    const perBruno = await apriConversazione(bruno, ALTROVE, nessunInvito);
    if (perAnna.kind !== "pronta" || perBruno.kind !== "pronta") {
      throw new Error("Le due sessioni dovevano essere pronte");
    }

    await manda(
      anna,
      perAnna.sessione,
      { testo: "ci vediamo alle 8" },
      "m1",
      "2026-08-26T10:00:00.000Z",
    );
    await manda(
      bruno,
      perBruno.sessione,
      { risponde: "m1", testo: "va bene" },
      "m2",
      "2026-08-26T10:01:00.000Z",
    );

    const letta = await leggi(bruno, perBruno.sessione);

    expect(letta.righe.map((r) => [r.id, r.testo, r.risponde])).toEqual([
      ["m1", "ci vediamo alle 8", undefined],
      ["m2", "va bene", "m1"],
    ]);
    expect(letta.nonRispondono).toEqual([]);
  });

  it("una voce aperta ma in una forma che non conosce non si mostra come testo", async () => {
    const { anna, invitaBruno } = await dueCase();
    const apertura = await apriConversazione(anna, QUI, invitaBruno);
    if (apertura.kind !== "pronta") {
      throw new Error("La sessione doveva essere pronta");
    }

    // Una voce cifrata correttamente ma non nella forma versionata: arriva da
    // un client di un'altra versione, o da uno sbagliato.
    const { invia } = await import("./sessione.js");
    await invia(anna, apertura.sessione, "testo nudo", "m1", "2026-08-26T10:00:00.000Z");

    const letta = await leggi(anna, apertura.sessione);
    expect(letta.righe[0]).toMatchObject({ id: "m1", stato: "non-si-apre" });
    expect(letta.righe[0]?.testo).toBeUndefined();
  });

  it("ciò che succede al gruppo si legge come un evento, non come una frase", async () => {
    const { anna, bruno, invitaBruno } = await dueCase();
    const apertura = await apriConversazione(anna, QUI, invitaBruno);
    const diBruno = await apriConversazione(bruno, ALTROVE, nessunInvito);
    if (apertura.kind !== "pronta" || diBruno.kind !== "pronta") {
      throw new Error("Le sessioni dovevano essere pronte");
    }

    await annuncia(
      anna,
      apertura.sessione,
      { chi: "carla@casa-di-prova", tipo: "ingresso" },
      "e1",
      "2026-08-26T10:00:00.000Z",
    );

    const letta = await leggi(bruno, diBruno.sessione);
    // Lo dice Anna, sigillato come una sua riga: è lei che l'ha fatta entrare.
    expect(letta.righe).toEqual([
      {
        attestata: true,
        createdAt: "2026-08-26T10:00:00.000Z",
        evento: { chi: "carla@casa-di-prova", tipo: "ingresso" },
        id: "e1",
        mittente: "anna@casa-di-prova",
        stato: "letta",
        testo: "",
      },
    ]);
  });

  it("in un gruppo crea solo chi deve: gli altri della stessa casa aspettano", async () => {
    const { anna, bruno, invitaBruno } = await dueCase();

    // Bruno sta nella casa che ordina, ma il gruppo non l'ha creato lui.
    expect(await apriConversazione(bruno, { ...QUI, creaQui: false }, nessunInvito)).toEqual({
      kind: "in-attesa",
    });

    // Anna sì, e invita tutti quelli che hanno una chiave: qui uno.
    const invitaTutti: Invito = async () => [await invitaBruno()].flat();
    expect((await apriConversazione(anna, { ...QUI, creaQui: true }, invitaTutti)).kind).toBe(
      "pronta",
    );
    expect((await apriConversazione(bruno, { ...QUI, creaQui: false }, nessunInvito)).kind).toBe(
      "pronta",
    );
  });
});

describe("un gruppo congelato (ADR 0042 §3, «Il trasloco»)", () => {
  /** La casa che ordinava è persa: la coda, il mazzo e il punto di rientro stavano lì. */
  const senzaChiOrdina = (ctx: Contesto): Contesto => {
    const persa = (): Promise<never> =>
      Promise.reject(new Error("La casa che ordina non risponde"));
    return {
      ...ctx,
      istanza: { ...ctx.istanza, handshakeDopo: persa, mazzo: persa, puntoDiRientro: persa },
    };
  };

  it("si riapre con ciò che il dispositivo aveva tenuto, senza chiedere niente a chi lo ordinava", async () => {
    const { anna, bruno, invitaBruno } = await dueCase();
    const perAnna = await apriConversazione(anna, QUI, invitaBruno);
    const perBruno = await apriConversazione(bruno, ALTROVE, nessunInvito);
    if (perAnna.kind !== "pronta" || perBruno.kind !== "pronta") {
      throw new Error("Le sessioni dovevano essere pronte");
    }
    await manda(anna, perAnna.sessione, { testo: "prima" }, "m1", "2026-08-26T10:00:00.000Z");

    // Come dopo aver ricaricato la pagina: in mano c'è solo il deposito.
    const dopo = senzaChiOrdina(bruno);
    await expect(apriConversazione(dopo, ALTROVE, nessunInvito)).rejects.toThrow(
      "La casa che ordina non risponde",
    );

    const riaperta = await apriConversazione(dopo, { ...ALTROVE, congelata: true }, nessunInvito);
    if (riaperta.kind !== "pronta") {
      throw new Error("Il gruppo congelato doveva riaprirsi");
    }
    expect(riaperta.sessione.catena).toEqual(perBruno.sessione.catena);

    const letta = await leggi(dopo, riaperta.sessione, undefined, undefined, { congelata: true });
    expect(letta.righe.map((r) => [r.stato, r.testo])).toEqual([["letta", "prima"]]);
  });

  it("un dispositivo che nel gruppo non c'era non lo apre, e non prova a entrarci", async () => {
    const { anna, bruno, invitaBruno } = await dueCase();
    await apriConversazione(anna, QUI, invitaBruno);

    // Bruno non l'ha mai aperto da qui: un Welcome ci sarebbe, ma il gruppo è
    // fermo e chi arriva dopo lo vede come lo vede un estraneo.
    expect(
      await apriConversazione(senzaChiOrdina(bruno), { ...ALTROVE, congelata: true }, nessunInvito),
    ).toEqual({ kind: "in-attesa" });
  });
});
