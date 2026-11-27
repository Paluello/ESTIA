/**
 * Chi è verificato, provato con dispositivi veri e un registro finto
 * ([ADR 0050](../../../../docs/adr/0050-il-numero-di-sicurezza.md)).
 *
 * I dispositivi sono quelli di [`preparaDispositivo`](./dispositivo.ts), con
 * chiavi di firma MLS vere; il registro è una mappa, perché è la sola cosa che
 * qui si vuole poter manomettere.
 */
import { describe, expect, it } from "vitest";

import { chiavePubblicaDiFirma, dimentica, preparaDispositivo } from "./dispositivo.js";
import { anagrafeFinta, cassettoFinto, depositoFinto, type CassettoFinto } from "./finte.js";
import { scriviIdentita, type Membro } from "./gruppo.js";
import {
  cambiati,
  leggiSicurezza,
  segnaVerificato,
  togliVerifica,
  verificati,
  type Dipendenze,
  type Sicurezza,
} from "./sicurezza.js";

const AIA = "chiave-di-aia";
const BORGO = "chiave-di-borgo";

const ANNA: Membro = { casa: AIA, username: "anna" };
const BRUNO: Membro = { casa: BORGO, username: "bruno" };
const CARLA: Membro = { casa: AIA, username: "carla" };

/** Il registro delle chiavi di firma di tutte le case, in una mappa. */
function registroFinto(): {
  chiaviDiFirmaDi: Dipendenze["chiaviDiFirmaDi"];
  approva: (membro: Membro, chiave: Uint8Array) => void;
  revoca: (membro: Membro, chiave: Uint8Array) => void;
  spegni: (casa: string) => void;
  domande: () => string[];
} {
  const righe = new Map<string, Uint8Array[]>();
  const spente = new Set<string>();
  const domande: string[] = [];

  return {
    approva(membro, chiave) {
      const chi = scriviIdentita(membro);
      righe.set(chi, [...(righe.get(chi) ?? []), chiave]);
    },
    chiaviDiFirmaDi(membro) {
      domande.push(scriviIdentita(membro));
      return spente.has(membro.casa)
        ? Promise.reject(new Error("istanza_non_raggiungibile"))
        : Promise.resolve(righe.get(scriviIdentita(membro)) ?? []);
    },
    domande: () => domande,
    revoca(membro, chiave) {
      const chi = scriviIdentita(membro);
      righe.set(
        chi,
        (righe.get(chi) ?? []).filter((c) => c !== chiave),
      );
    },
    spegni: (casa) => spente.add(casa),
  };
}

type Registro = ReturnType<typeof registroFinto>;

/** Un dispositivo nuovo di `membro`, con la sua chiave di firma. Non ancora nel registro. */
async function dispositivo(
  membro: Membro,
): Promise<{ cassetto: CassettoFinto; chiave: Uint8Array }> {
  const cassetto = cassettoFinto();
  await preparaDispositivo(
    { anagrafe: anagrafeFinta(), casa: membro.casa, cassetto },
    membro.username,
  );
  const chiave = await chiavePubblicaDiFirma(cassetto);
  if (chiave === undefined) {
    throw new Error("Il dispositivo di prova non ha una chiave.");
  }
  return { cassetto, chiave };
}

/** Anna e Bruno, un dispositivo approvato a testa, in due case diverse. */
async function dueCase(): Promise<{
  registro: Registro;
  anna: Dipendenze;
  bruno: Dipendenze;
  chiaveDiAnna: Uint8Array;
  chiaveDiBruno: Uint8Array;
}> {
  const registro = registroFinto();
  const a = await dispositivo(ANNA);
  const b = await dispositivo(BRUNO);
  registro.approva(ANNA, a.chiave);
  registro.approva(BRUNO, b.chiave);

  return {
    anna: { cassetto: a.cassetto, chiaviDiFirmaDi: registro.chiaviDiFirmaDi },
    bruno: { cassetto: b.cassetto, chiaviDiFirmaDi: registro.chiaviDiFirmaDi },
    chiaveDiAnna: a.chiave,
    chiaveDiBruno: b.chiave,
    registro,
  };
}

function pronto(sicurezza: Sicurezza): Extract<Sicurezza, { kind: "pronto" }> {
  if (sicurezza.kind !== "pronto") {
    throw new Error(`Atteso un numero, trovato «${sicurezza.kind}».`);
  }
  return sicurezza;
}

describe("il numero di una coppia", () => {
  it("è lo stesso dai due lati, calcolato su due dispositivi diversi", async () => {
    const { anna, bruno } = await dueCase();

    const daAnna = pronto(await leggiSicurezza(anna, ANNA, BRUNO));
    const daBruno = pronto(await leggiSicurezza(bruno, BRUNO, ANNA));

    expect(daAnna.numero).toMatch(/^\d{60}$/);
    expect(daAnna.numero).toBe(daBruno.numero);
    expect(daAnna.dispositivi).toEqual({ miei: 1, suoi: 1 });
  });

  it("non sa in quale conversazione lo si guarda: dipende dalle due persone e basta", async () => {
    // È la decisione del 2026-09-17: lo stesso numero nei messaggi privati e in
    // qualunque gruppo. Qui è vero per costruzione — nessun ingresso nomina una
    // conversazione — e la prova è che un terzo membro non lo sposta.
    const { anna, registro } = await dueCase();
    const prima = pronto(await leggiSicurezza(anna, ANNA, BRUNO)).numero;

    registro.approva(CARLA, (await dispositivo(CARLA)).chiave);

    expect(pronto(await leggiSicurezza(anna, ANNA, BRUNO)).numero).toBe(prima);
    expect(pronto(await leggiSicurezza(anna, ANNA, CARLA)).numero).not.toBe(prima);
  });

  it("non cambia a un accesso nuovo dallo stesso browser: stessa chiave, riga in più", async () => {
    const { anna, registro, chiaveDiBruno } = await dueCase();
    const prima = pronto(await leggiSicurezza(anna, ANNA, BRUNO));

    registro.approva(BRUNO, Uint8Array.from(chiaveDiBruno));

    const dopo = pronto(await leggiSicurezza(anna, ANNA, BRUNO));
    expect(dopo.numero).toBe(prima.numero);
    expect(dopo.dispositivi.suoi).toBe(1);
  });

  it("non c'è, se questo dispositivo non è fra quelli approvati", async () => {
    // Il secondo dispositivo di Anna aspetta ancora il sì di ADR 0040: gli
    // altri non lo vedono, e un numero calcolato qui non parlerebbe di lui.
    const { registro } = await dueCase();
    const secondo = await dispositivo(ANNA);

    const sicurezza = await leggiSicurezza(
      { cassetto: secondo.cassetto, chiaviDiFirmaDi: registro.chiaviDiFirmaDi },
      ANNA,
      BRUNO,
    );

    expect(sicurezza.kind).toBe("non-approvato");
  });

  it("non c'è, se l'altra persona non ha dispositivi approvati", async () => {
    const { anna } = await dueCase();

    expect(await leggiSicurezza(anna, ANNA, CARLA)).toEqual({
      kind: "senza-chiavi",
      stato: "non-verificato",
    });
  });

  it("un registro che non risponde è un errore, non un numero", async () => {
    const { anna, registro } = await dueCase();
    registro.spegni(BORGO);

    await expect(leggiSicurezza(anna, ANNA, BRUNO)).rejects.toThrow();
  });
});

describe("segnare verificato", () => {
  it("nessuno è verificato finché qualcuno non confronta", async () => {
    const { anna } = await dueCase();

    expect(pronto(await leggiSicurezza(anna, ANNA, BRUNO)).stato).toBe("non-verificato");
    expect((await verificati(anna.cassetto)).size).toBe(0);
  });

  it("resta, con la data, ed è della persona e non della conversazione", async () => {
    const { anna } = await dueCase();
    const letto = pronto(await leggiSicurezza(anna, ANNA, BRUNO));

    await segnaVerificato(
      { adesso: () => new Date("2026-11-27T10:00:00.000Z"), cassetto: anna.cassetto },
      BRUNO,
      letto.impronta,
    );

    const dopo = pronto(await leggiSicurezza(anna, ANNA, BRUNO));
    expect(dopo.stato).toBe("verificato");
    expect(dopo.verificatoIl).toBe("2026-11-27T10:00:00.000Z");
    // La chiave del ricordo è `bruno@<casa>`: nessun id di conversazione.
    expect([...(await verificati(anna.cassetto)).keys()]).toEqual([scriviIdentita(BRUNO)]);
  });

  it("vale per quella persona di quella casa, non per un omonimo", async () => {
    const { anna, registro } = await dueCase();
    const omonimo: Membro = { casa: AIA, username: "bruno" };
    registro.approva(omonimo, (await dispositivo(omonimo)).chiave);

    await segnaVerificato(anna, BRUNO, pronto(await leggiSicurezza(anna, ANNA, BRUNO)).impronta);

    expect(pronto(await leggiSicurezza(anna, ANNA, omonimo)).stato).toBe("non-verificato");
  });

  it("si può togliere", async () => {
    const { anna } = await dueCase();
    await segnaVerificato(anna, BRUNO, pronto(await leggiSicurezza(anna, ANNA, BRUNO)).impronta);

    await togliVerifica(anna.cassetto, BRUNO);

    expect(pronto(await leggiSicurezza(anna, ANNA, BRUNO)).stato).toBe("non-verificato");
  });

  it("l'uscita la porta via insieme alla chiave", async () => {
    // Stesso posto e stessa vita della chiave di firma: chi entra dopo sullo
    // stesso browser non eredita la fiducia di chi è uscito.
    const { anna } = await dueCase();
    await segnaVerificato(anna, BRUNO, pronto(await leggiSicurezza(anna, ANNA, BRUNO)).impronta);

    await dimentica(anna.cassetto, depositoFinto());

    expect((await verificati(anna.cassetto)).size).toBe(0);
  });
});

describe("quando il numero di un verificato cambia", () => {
  it("un dispositivo nuovo dell'altro cambia il numero, e la verifica lo dice", async () => {
    const { anna, bruno, registro } = await dueCase();
    const prima = pronto(await leggiSicurezza(anna, ANNA, BRUNO));
    await segnaVerificato(anna, BRUNO, prima.impronta);

    // Bruno approva un secondo dispositivo, con una chiave sua.
    const telefono = await dispositivo(BRUNO);
    registro.approva(BRUNO, telefono.chiave);

    const dopo = pronto(await leggiSicurezza(anna, ANNA, BRUNO));
    expect(dopo.numero).not.toBe(prima.numero);
    expect(dopo.stato).toBe("cambiato");
    expect(dopo.dispositivi.suoi).toBe(2);
    expect(await cambiati(anna, [BRUNO])).toEqual([BRUNO]);

    // I due lati sono ancora d'accordo sul numero nuovo, da tutti i dispositivi
    // di Bruno: è quello che permette di confrontarlo di nuovo.
    const daBruno = pronto(await leggiSicurezza(bruno, BRUNO, ANNA));
    const dalTelefono = pronto(
      await leggiSicurezza(
        { cassetto: telefono.cassetto, chiaviDiFirmaDi: registro.chiaviDiFirmaDi },
        BRUNO,
        ANNA,
      ),
    );
    expect(daBruno.numero).toBe(dopo.numero);
    expect(dalTelefono.numero).toBe(dopo.numero);
  });

  it("una chiave sostituita da chi tiene il registro si vede allo stesso modo", async () => {
    const { anna, registro, chiaveDiBruno } = await dueCase();
    await segnaVerificato(anna, BRUNO, pronto(await leggiSicurezza(anna, ANNA, BRUNO)).impronta);

    registro.revoca(BRUNO, chiaveDiBruno);
    registro.approva(BRUNO, (await dispositivo(BRUNO)).chiave);

    expect(pronto(await leggiSicurezza(anna, ANNA, BRUNO)).stato).toBe("cambiato");
  });

  it("confrontato di nuovo, torna verificato sul numero nuovo", async () => {
    const { anna, registro } = await dueCase();
    await segnaVerificato(anna, BRUNO, pronto(await leggiSicurezza(anna, ANNA, BRUNO)).impronta);
    registro.approva(BRUNO, (await dispositivo(BRUNO)).chiave);

    await segnaVerificato(anna, BRUNO, pronto(await leggiSicurezza(anna, ANNA, BRUNO)).impronta);

    expect(pronto(await leggiSicurezza(anna, ANNA, BRUNO)).stato).toBe("verificato");
    expect(await cambiati(anna, [BRUNO])).toEqual([]);
  });

  it("un dispositivo nuovo MIO cambia il numero ma non accusa nessuno", async () => {
    // Il numero intero cambia, e Bruno — se mi aveva verificata — riceve
    // l'avviso. Io no: le chiavi di Bruno sono quelle che avevo confrontato.
    const { anna, bruno, registro } = await dueCase();
    const prima = pronto(await leggiSicurezza(anna, ANNA, BRUNO));
    await segnaVerificato(anna, BRUNO, prima.impronta);
    await segnaVerificato(bruno, ANNA, pronto(await leggiSicurezza(bruno, BRUNO, ANNA)).impronta);

    registro.approva(ANNA, (await dispositivo(ANNA)).chiave);

    const dopo = pronto(await leggiSicurezza(anna, ANNA, BRUNO));
    expect(dopo.numero).not.toBe(prima.numero);
    expect(dopo.stato).toBe("verificato");
    expect(dopo.dispositivi.miei).toBe(2);
    expect(pronto(await leggiSicurezza(bruno, BRUNO, ANNA)).stato).toBe("cambiato");
  });

  it("se il verificato resta senza dispositivi è un cambio, non un silenzio", async () => {
    const { anna, registro, chiaveDiBruno } = await dueCase();
    await segnaVerificato(anna, BRUNO, pronto(await leggiSicurezza(anna, ANNA, BRUNO)).impronta);

    registro.revoca(BRUNO, chiaveDiBruno);

    expect((await leggiSicurezza(anna, ANNA, BRUNO)).kind).toBe("senza-chiavi");
    expect(await leggiSicurezza(anna, ANNA, BRUNO)).toMatchObject({ stato: "cambiato" });
    expect(await cambiati(anna, [BRUNO])).toEqual([BRUNO]);
  });

  it("l'avviso guarda soltanto chi è verificato, e non chiede il registro per gli altri", async () => {
    const { anna, registro } = await dueCase();
    registro.approva(CARLA, (await dispositivo(CARLA)).chiave);
    await segnaVerificato(anna, BRUNO, pronto(await leggiSicurezza(anna, ANNA, BRUNO)).impronta);
    const finQui = registro.domande().length;

    expect(await cambiati(anna, [BRUNO, CARLA])).toEqual([]);
    expect(registro.domande().slice(finQui)).toEqual([scriviIdentita(BRUNO)]);
  });

  it("una casa che non risponde non è un cambio", async () => {
    // Avvisare a ogni casa spenta insegnerebbe a ignorare l'avviso.
    const { anna, registro } = await dueCase();
    await segnaVerificato(anna, BRUNO, pronto(await leggiSicurezza(anna, ANNA, BRUNO)).impronta);

    registro.spegni(BORGO);

    expect(await cambiati(anna, [BRUNO])).toEqual([]);
  });
});
