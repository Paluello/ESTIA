/**
 * I gruppi (M8): entrare, uscire, essere tolti, tornare.
 *
 * Tre dispositivi veri attraverso l'istanza finta ([`finte.ts`](./finte.ts)),
 * che dei gruppi riproduce ciò che conta: la fila che accetta un commit solo
 * all'epoch successiva, un Welcome solo al suo destinatario, il mazzo che non
 * torna indietro. Qui si prova che cosa succede **alle chiavi** — chi apre che
 * cosa, dopo che cosa — perché è lì che un gruppo mantiene o no quello che dice.
 */
import { describe, expect, it } from "vitest";

import { archivia, svolgi } from "./archivio.js";
import {
  allinea,
  apriConversazione,
  faiEntrare,
  leggi,
  manda,
  PresenzaEstranea,
} from "./conversazione.js";
import { CASA, depositoFinto, istanzaFinta, portachiaviFinto } from "./finte.js";
import {
  cambiaFoglie,
  chiaveDiRotazione,
  cifra,
  creaConversazione,
  decifra,
  epochDi,
  foglie,
  foglieDi,
  nuovaIdentita,
  serraturaArchivio,
  TroppeFoglie,
  type Membro,
} from "./gruppo.js";
import {
  aggiungiFoglie,
  apriCon,
  ChiaveDiUnAltro,
  cronologia,
  entra,
  invia,
  riprendi,
  sincronizza,
  togliFoglie,
  type Contesto,
  type Sessione,
} from "./sessione.js";

const CONV = "gruppo-1";
const ANNA: Membro = { casa: CASA, username: "anna" };
const BRUNO: Membro = { casa: CASA, username: "bruno" };
const CARLA: Membro = { casa: CASA, username: "carla" };
const DARIO: Membro = { casa: CASA, username: "dario" };

const id = (membro: Membro): string => `u-${membro.username}`;

interface Scena {
  istanza: ReturnType<typeof istanzaFinta>;
  anna: Contesto;
  bruno: Contesto;
  carla: Contesto;
  chiavi: Record<"anna" | "bruno" | "carla", Awaited<ReturnType<typeof portachiaviFinto>>>;
  sAnna: Sessione;
  sBruno: Sessione;
  sCarla: Sessione;
}

/** Entra dal Welcome che l'istanza consegna a quel contesto. */
async function entraDalWelcome(ctx: Contesto): Promise<Sessione> {
  const pagina = await ctx.istanza.handshakeDopo(CONV);
  for (const busta of pagina.handshake.filter((h) => h.tipo === "welcome").reverse()) {
    const sessione = await entra(ctx, CONV, busta);
    if (sessione !== undefined) {
      return sessione;
    }
  }
  throw new Error("Nessun Welcome per questo dispositivo.");
}

/** Anna crea il gruppo con Bruno e Carla: un commit solo, un Welcome per due. */
async function gruppoDiTre(): Promise<Scena> {
  const istanza = istanzaFinta();
  const chiavi = {
    anna: await portachiaviFinto("anna"),
    bruno: await portachiaviFinto("bruno"),
    carla: await portachiaviFinto("carla"),
  };
  istanza.ammetti("anna", chiavi.anna.chiaveDiFirma);
  istanza.ammetti("bruno", chiavi.bruno.chiaveDiFirma);
  istanza.ammetti("carla", chiavi.carla.chiaveDiFirma);

  const ctx = (chi: "anna" | "bruno" | "carla"): Contesto => ({
    deposito: depositoFinto(),
    io: chiavi[chi],
    istanza: istanza.per(`u-${chi}`),
  });
  const anna = ctx("anna");
  const bruno = ctx("bruno");
  const carla = ctx("carla");

  const sAnna = await apriCon(anna, CONV, [
    { destinatario: id(BRUNO), keyPackage: await chiavi.bruno.pubblica() },
    { destinatario: id(CARLA), keyPackage: await chiavi.carla.pubblica() },
  ]);

  return {
    anna,
    bruno,
    carla,
    chiavi,
    istanza,
    sAnna,
    sBruno: await entraDalWelcome(bruno),
    sCarla: await entraDalWelcome(carla),
  };
}

const nomi = (sessione: Sessione): string[] =>
  foglie(sessione.stato)
    .map((f) => f.membro.username)
    .sort();

const testi = async (ctx: Contesto, sessione: Sessione): Promise<(string | undefined)[]> =>
  (await cronologia(ctx, sessione)).righe.map((r) => r.testo);

describe("un gruppo nasce con tutti dentro", () => {
  it("un commit, un Welcome per ciascuno, e tutti leggono", async () => {
    const { istanza, anna, bruno, carla, sAnna, sBruno, sCarla } = await gruppoDiTre();

    expect(istanza.depositati().map((h) => [h.tipo, h.epoch, h.destinatario])).toEqual([
      ["commit", 1, undefined],
      ["welcome", 1, id(BRUNO)],
      ["welcome", 1, id(CARLA)],
    ]);
    expect(nomi(sAnna)).toEqual(["anna", "bruno", "carla"]);
    expect(sBruno.catena).toBeDefined();
    expect(sCarla.catena).toBeDefined();

    await invia(anna, sAnna, "benvenuti", "m1", "2026-11-27T10:00:00.000Z");

    expect(await testi(bruno, sBruno)).toEqual(["benvenuti"]);
    expect(await testi(carla, sCarla)).toEqual(["benvenuti"]);
  });

  it("chi entra dopo legge anche quello che è stato scritto prima: è detto, non nascosto", async () => {
    const { istanza, anna, sAnna } = await gruppoDiTre();
    await invia(anna, sAnna, "prima di Dario", "m1", "2026-11-27T10:00:00.000Z");

    const chiaviDario = await portachiaviFinto("dario");
    istanza.ammetti("dario", chiaviDario.chiaveDiFirma);
    const dario: Contesto = {
      deposito: depositoFinto(),
      io: chiaviDario,
      istanza: istanza.per(id(DARIO)),
    };

    await faiEntrare(anna, sAnna, { id: id(DARIO), membro: DARIO }, [await chiaviDario.pubblica()]);
    const sDario = await entraDalWelcome(dario);

    // La catena è una sola per tutta la conversazione: chi entra la riceve
    // intera. È per questo che l'ingresso è un momento dichiarato a chi c'è.
    expect(await testi(dario, sDario)).toEqual(["prima di Dario"]);
  });
});

describe("togliere qualcuno (criterio 3 di M8)", () => {
  it("escono tutte le sue foglie, e chi resta ottiene la stessa chiave nuova senza scambiarsela", async () => {
    const { anna, bruno, sAnna, sBruno } = await gruppoDiTre();

    const dopo = await togliFoglie(anna, sAnna, CARLA);

    expect(nomi(dopo)).toEqual(["anna", "bruno"]);
    expect(dopo.catena).toHaveLength(2);

    // Bruno applica il commit e deriva la chiave da solo, dall'epoch che la
    // rimozione ha creato: non la legge dal mazzo, la calcola.
    const brunoDopo = await sincronizza(bruno, sBruno);
    expect(brunoDopo.catena).toEqual(dopo.catena);
  });

  it("chi è stato tolto rilegge quello che aveva già, e non apre quello che viene dopo", async () => {
    const { istanza, anna, bruno, carla, sAnna, sBruno, sCarla } = await gruppoDiTre();
    await invia(anna, sAnna, "quando c'era Carla", "m1", "2026-11-27T10:00:00.000Z");

    const dopo = await togliFoglie(anna, sAnna, CARLA);
    await invia(anna, dopo, "senza Carla", "m2", "2026-11-27T11:00:00.000Z");

    // Bruno, che resta, legge tutto.
    expect(await testi(bruno, await sincronizza(bruno, sBruno))).toEqual([
      "quando c'era Carla",
      "senza Carla",
    ]);

    // Carla ha ancora la catena di prima — quelle chiavi le ha avute, e lì la
    // crittografia non può niente: il passato lo rilegge. Il seguito no.
    expect(await testi(carla, sCarla)).toEqual(["quando c'era Carla", undefined]);

    // E non può procurarsi la chiave nuova: il mazzo è avvolto sotto un'epoch
    // di cui non ha il segreto.
    const mazzo = istanza.mazzo(CONV);
    expect(mazzo?.epoch).toBe(epochDi(dopo.stato));
    const serraturaDiCarla = await serraturaArchivio(sCarla.stato);
    expect(() => svolgi(mazzo?.mazzo ?? "", serraturaDiCarla)).toThrow();

    // Quando applica il commit che la toglie, il suo dispositivo lo sa.
    const carlaDopo = await sincronizza(carla, sCarla);
    expect(carlaDopo.tolto).toBe(true);
    expect(carlaDopo.catena).toBeUndefined();
    await expect(
      invia(carla, carlaDopo, "ci sono ancora?", "m3", "2026-11-27T12:00:00.000Z"),
    ).rejects.toThrow();
    expect((await riprendi(carla, CONV))?.tolto).toBe(true);
  });

  it("chi è stato tolto non decifra un messaggio dell'epoch successiva, nemmeno applicando il commit che lo toglie", async () => {
    const { anna, bruno, carla, sAnna, sBruno, sCarla } = await gruppoDiTre();

    const dopo = await togliFoglie(anna, sAnna, CARLA);
    const brunoDopo = await sincronizza(bruno, sBruno);
    const { busta } = await cifra(dopo.stato, "solo per chi resta");

    // Chi resta la apre.
    expect(await decifra(brunoDopo.stato, busta, bruno.istanza)).toMatchObject({
      kind: "messaggio",
      testo: "solo per chi resta",
    });

    // Carla no: né con lo stato che aveva, né con quello che le resta dopo
    // aver applicato il commit che la toglie.
    const carlaDopo = await sincronizza(carla, sCarla);
    expect((await decifra(sCarla.stato, busta, carla.istanza)).kind).toBe("illeggibile");
    expect((await decifra(carlaDopo.stato, busta, carla.istanza)).kind).toBe("illeggibile");

    // È la ragione per cui `ts-mls` è alla 1.6.4 ([S7](../../../../docs/spike/S7-openmls-e-ts-mls.md)):
    // nella 1.6.2 un commit con una sola Remove usciva senza UpdatePath, e chi
    // veniva tolto calcolava da sé i segreti dell'epoch dopo. Da quei segreti
    // escono la serratura del mazzo e la chiave nuova della catena: se Carla
    // li ottenesse, toglierla non le toglierebbe niente.
    const vere = [await serraturaArchivio(dopo.stato), await chiaveDiRotazione(dopo.stato)];
    for (const stato of [sCarla.stato, carlaDopo.stato]) {
      expect(await serraturaArchivio(stato)).not.toEqual(vere[0]);
      expect(await chiaveDiRotazione(stato)).not.toEqual(vere[1]);
    }
    expect(dopo.catena?.at(-1)).toEqual(vere[1]);
  });

  it("non parte nessun commit se non c'è niente da togliere", async () => {
    const { istanza, anna, sAnna } = await gruppoDiTre();
    const prima = istanza.depositati().length;

    const dopo = await togliFoglie(anna, sAnna, DARIO);

    expect(istanza.depositati()).toHaveLength(prima);
    expect(dopo.catena).toHaveLength(1);
  });

  it("due cambi dalla stessa epoch: il secondo si rimette in pari e riprova", async () => {
    const { istanza, anna, bruno, sAnna, sBruno } = await gruppoDiTre();
    const chiaviDario = await portachiaviFinto("dario");
    istanza.ammetti("dario", chiaviDario.chiaveDiFirma);

    // Tutti e due partono dall'epoch 1. Bruno arriva primo.
    const brunoDopo = await aggiungiFoglie(bruno, sBruno, DARIO, [
      { destinatario: id(DARIO), keyPackage: await chiaviDario.pubblica() },
    ]);
    expect(epochDi(brunoDopo.stato)).toBe(2);

    // Anna non lo sa ancora: `togliFoglie` si mette in pari prima di provare.
    const annaDopo = await togliFoglie(anna, sAnna, CARLA);

    expect(epochDi(annaDopo.stato)).toBe(3);
    expect(nomi(annaDopo)).toEqual(["anna", "bruno", "dario"]);
    expect(
      istanza
        .depositati()
        .filter((h) => h.tipo === "commit")
        .map((h) => h.epoch),
    ).toEqual([1, 2, 3]);
  });
});

describe("riammettere, e i dispositivi di una persona", () => {
  it("chi torna entra con una foglia nuova, e la vecchia esce nello stesso commit", async () => {
    const { istanza, anna, carla, chiavi, sAnna } = await gruppoDiTre();
    const commitPrima = istanza.depositati().filter((h) => h.tipo === "commit").length;
    const vecchia = foglieDi(sAnna.stato, CARLA).map((f) => f.indice);

    // Carla ha svuotato il browser: una chiave nuova, registrata.
    const nuove = await portachiaviFinto("carla");
    istanza.ammetti("carla", nuove.chiaveDiFirma);

    const dopo = await faiEntrare(anna, sAnna, { id: id(CARLA), membro: CARLA }, [
      await nuove.pubblica(),
    ]);

    expect(istanza.depositati().filter((h) => h.tipo === "commit")).toHaveLength(commitPrima + 1);
    const sue = foglieDi(dopo.stato, CARLA);
    expect(sue).toHaveLength(1);
    expect(sue[0]?.chiaveDiFirma).toEqual(nuove.chiaveDiFirma);
    expect(vecchia).toHaveLength(1);
    // La foglia vecchia è uscita: la catena ha una chiave in più, che il
    // dispositivo di prima non ottiene.
    expect(dopo.catena).toHaveLength(2);

    const nuovaCarla: Contesto = { ...carla, deposito: depositoFinto(), io: nuove };
    const sNuova = await entraDalWelcome(nuovaCarla);
    expect(sNuova.catena).toEqual(dopo.catena);
    expect(chiavi.carla.chiaveDiFirma).not.toEqual(nuove.chiaveDiFirma);
  });

  it("chi è stato tolto resta fuori finché qualcuno non lo fa rientrare, e allora entra dall'invito nuovo", async () => {
    const { istanza, anna, carla, chiavi, sAnna, sCarla } = await gruppoDiTre();
    const mai = (): Promise<never> => Promise.reject(new Error("Non si doveva invitare nessuno"));
    const tolta = await togliFoglie(anna, sAnna, CARLA);
    await sincronizza(carla, sCarla);

    // Il suo dispositivo ha lo stato di prima, e sul canale c'è ancora
    // l'invito di allora. Nessuno dei due la riporta dentro, e non rientra da
    // sola dal punto di rientro: lì non partirebbe nessun commit.
    const commitPrima = istanza.depositati().filter((h) => h.tipo === "commit").length;
    expect(await apriConversazione(carla, { id: CONV, ordinataQui: true }, mai)).toEqual({
      kind: "tolto",
    });
    expect(istanza.depositati().filter((h) => h.tipo === "commit")).toHaveLength(commitPrima);

    await faiEntrare(anna, tolta, { id: id(CARLA), membro: CARLA }, [
      await chiavi.carla.pubblica(),
    ]);

    const tornata = await apriConversazione(carla, { id: CONV, ordinataQui: true }, mai);
    if (tornata.kind !== "pronta") {
      throw new Error("Carla doveva rientrare dall'invito nuovo");
    }
    expect(epochDi(tornata.sessione.stato)).toBe(3);
    expect(tornata.sessione.catena).toHaveLength(2);

    // Anche da un browser svuotato: dei due inviti prende il più recente.
    const daCapo = await apriConversazione(
      { ...carla, deposito: depositoFinto() },
      { id: CONV, ordinataQui: true },
      mai,
    );
    expect(daCapo.kind === "pronta" && epochDi(daCapo.sessione.stato)).toBe(3);
  });

  it("un secondo dispositivo è una seconda foglia, e si toglie da solo", async () => {
    const { istanza, anna, sAnna } = await gruppoDiTre();
    const telefono = await portachiaviFinto("bruno");
    istanza.ammetti("bruno", telefono.chiaveDiFirma);

    const conDue = await aggiungiFoglie(anna, sAnna, BRUNO, [
      { destinatario: id(BRUNO), keyPackage: await telefono.pubblica() },
    ]);
    expect(foglieDi(conDue.stato, BRUNO)).toHaveLength(2);
    // Nessuno è uscito: la catena resta quella.
    expect(conDue.catena).toHaveLength(1);

    const senzaTelefono = await togliFoglie(anna, conDue, BRUNO, {
      soloChiavi: [telefono.chiaveDiFirma],
    });
    expect(foglieDi(senzaTelefono.stato, BRUNO)).toHaveLength(1);
    expect(foglieDi(senzaTelefono.stato, BRUNO)[0]?.chiaveDiFirma).not.toEqual(
      telefono.chiaveDiFirma,
    );
    expect(senzaTelefono.catena).toHaveLength(2);
  });

  it("una chiave d'ingresso che nomina un altro non fa entrare nessuno", async () => {
    const { istanza, anna, chiavi, sAnna } = await gruppoDiTre();
    const prima = istanza.depositati().length;

    await expect(
      aggiungiFoglie(anna, sAnna, DARIO, [
        { destinatario: id(DARIO), keyPackage: await chiavi.bruno.pubblica() },
      ]),
    ).rejects.toBeInstanceOf(ChiaveDiUnAltro);
    expect(istanza.depositati()).toHaveLength(prima);
  });

  it("non ci si toglie da soli, e l'albero ha un tetto di cinquanta foglie", async () => {
    const { anna, sAnna, istanza } = await gruppoDiTre();
    await expect(togliFoglie(anna, sAnna, ANNA)).rejects.toThrow();

    const porta = istanza.per(id(ANNA));
    const io = await nuovaIdentita(ANNA);
    const solo = await creaConversazione("pieno", io, porta);
    const tanti = await Promise.all(
      Array.from({ length: 50 }, async () => (await nuovaIdentita(BRUNO)).publicPackage),
    );

    // Si rifiuta prima di costruire il commit: cinquantuno con chi crea.
    await expect(cambiaFoglie(solo, { entrano: tanti, escono: [] }, porta)).rejects.toBeInstanceOf(
      TroppeFoglie,
    );
  });
});

describe("l'albero accanto ai membri", () => {
  const membri = (...chi: Membro[]): { id: string; membro: Membro }[] =>
    chi.map((membro) => ({ id: id(membro), membro }));

  it("la casa che ordina toglie la foglia di chi è uscito, e la catena ruota", async () => {
    const { anna, sAnna } = await gruppoDiTre();

    // Carla è uscita: per la casa non è più fra i membri, ma la sua foglia non
    // ha potuto toglierla da sé.
    const esito = await allinea(anna, sAnna, {
      autorevole: true,
      membri: membri(ANNA, BRUNO),
      rimossi: [CARLA],
    });

    expect(esito.confronto).toEqual({ assenti: [], estranei: [] });
    expect(nomi(esito.sessione)).toEqual(["anna", "bruno"]);
    expect(esito.sessione.catena).toHaveLength(2);
  });

  it("altrove si toglie soltanto chi risulta tolto; uno sconosciuto si dice, e finché c'è non si scrive", async () => {
    const { bruno, sBruno } = await gruppoDiTre();

    // La casa di Bruno non ordina, e della sua composizione Carla non fa
    // parte: può essere appena entrata. Non la si toglie.
    const dubbio = await allinea(bruno, sBruno, {
      autorevole: false,
      membri: membri(ANNA, BRUNO),
      rimossi: [],
    });
    expect(dubbio.confronto.estranei).toEqual([CARLA]);
    expect(nomi(dubbio.sessione)).toEqual(["anna", "bruno", "carla"]);

    await expect(
      manda(bruno, dubbio.sessione, { testo: "ciao" }, "m1", "2026-11-27T10:00:00.000Z", [
        ANNA,
        BRUNO,
      ]),
    ).rejects.toBeInstanceOf(PresenzaEstranea);

    // Quando la notizia che è stata tolta arriva, la toglie anche lui.
    const certo = await allinea(bruno, dubbio.sessione, {
      autorevole: false,
      membri: membri(ANNA, BRUNO),
      rimossi: [CARLA],
    });
    expect(certo.confronto.estranei).toEqual([]);
    await manda(bruno, certo.sessione, { testo: "ciao" }, "m1", "2026-11-27T10:00:00.000Z", [
      ANNA,
      BRUNO,
    ]);
  });

  it("chi è fra i membri e non ha una foglia risulta assente, e `leggi` lo riporta", async () => {
    const { anna, sAnna } = await gruppoDiTre();

    const lettura = await leggi(anna, sAnna, undefined, {
      autorevole: true,
      membri: membri(ANNA, BRUNO, CARLA, DARIO),
      rimossi: [],
    });

    expect(lettura.confronto).toEqual({ assenti: [DARIO], estranei: [] });
  });
});

describe("una voce è legata a chi l'ha scritta, dove e quando (ADR 0052 §1)", () => {
  it("una casa che cambia il mittente o la data ottiene una voce che non si apre", async () => {
    const { istanza, anna, bruno, sAnna, sBruno } = await gruppoDiTre();
    await invia(anna, sAnna, "l'ho scritto io", "m1", "2026-11-27T10:00:00.000Z");
    await invia(anna, sAnna, "alle dieci", "m2", "2026-11-27T10:00:01.000Z");

    expect((await cronologia(bruno, sBruno)).righe.map((r) => [r.stato, r.attestata])).toEqual([
      ["letta", true],
      ["letta", true],
    ]);

    istanza.falsifica(CONV, "m1", { mittente: `bruno@${CASA}` });
    istanza.falsifica(CONV, "m2", { createdAt: "2026-11-28T10:00:01.000Z" });

    expect((await cronologia(bruno, sBruno)).righe.map((r) => [r.id, r.stato, r.testo])).toEqual([
      ["m1", "non-si-apre", undefined],
      ["m2", "non-si-apre", undefined],
    ]);
  });

  it("la stessa busta spostata in un'altra voce non si apre", async () => {
    const { anna, bruno, sAnna, sBruno } = await gruppoDiTre();
    await invia(anna, sAnna, "una volta sola", "m1", "2026-11-27T10:00:00.000Z");
    const [riga] = (await anna.istanza.cronologia(CONV)).righe;

    // La stessa busta, ridepositata con un altro id: è un'altra voce.
    await anna.istanza.depositaArchivio(CONV, [
      {
        busta: riga?.voce?.busta ?? "",
        chiaveN: 1,
        createdAt: "2026-11-27T10:00:00.000Z",
        id: "m1-copia",
      },
    ]);

    expect((await cronologia(bruno, sBruno)).righe.map((r) => [r.id, r.stato])).toEqual([
      ["m1", "letta"],
      ["m1-copia", "non-si-apre"],
    ]);
  });

  it("una voce di prima del legame si apre, e dice che chi e quando non sono attestati", async () => {
    const { anna, bruno, sAnna, sBruno } = await gruppoDiTre();
    const vecchia = archivia(sAnna.catena ?? [], "di prima");
    await anna.istanza.depositaArchivio(CONV, [
      { ...vecchia, createdAt: "2026-11-01T10:00:00.000Z", id: "m0" },
    ]);

    expect(
      (await cronologia(bruno, sBruno)).righe.map((r) => [r.stato, r.testo, r.attestata]),
    ).toEqual([["letta", "di prima", false]]);
  });
});
