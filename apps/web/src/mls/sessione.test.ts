/**
 * La sessione: due dispositivi veri che si parlano attraverso un'istanza finta.
 *
 * L'istanza finta ([`finte.ts`](./finte.ts)) non è una scorciatoia — è una
 * riproduzione fedele delle rotte costruite lato server: il canale di handshake
 * che ordina per arrivo e consegna un Welcome solo al suo destinatario, il mazzo
 * con l'epoch che non torna indietro, l'archivio idempotente. Ciò che si prova
 * qui è **l'orchestrazione**: quando si applica un commit, in che ordine, e che
 * cosa si salva.
 */
import { describe, expect, it } from "vitest";

import { avvolgi, catenaNuova, catenaRuotata } from "./archivio.js";
import { CASA, depositoFinto, istanzaFinta, portachiaviFinto } from "./finte.js";
import { epochDi, membri, rientra, serraturaArchivio } from "./gruppo.js";
import {
  aggiungiMembro,
  apri,
  apriCon,
  ChiaveDiUnAltro,
  cronologia,
  DispositivoInAttesa,
  DiUnAltraConversazione,
  entra,
  invia,
  riprendi,
  rientraIn,
  ruotaArchivio,
  sincronizza,
  type Contesto,
  type Istanza,
} from "./sessione.js";

/** I nomi di chi c'è: `membri` porta anche la casa (ADR 0042 §0). */
const nomi = (stato: Parameters<typeof membri>[0]): string[] =>
  membri(stato)
    .map((m) => m.username)
    .sort();

function daBase64(s: string): Uint8Array {
  const grezzo = atob(s);
  const bytes = new Uint8Array(grezzo.length);
  for (let i = 0; i < grezzo.length; i++) {
    bytes[i] = grezzo.charCodeAt(i);
  }
  return bytes;
}

/**
 * L'id non è il nome, e la differenza qui non è cosmetica: l'istanza consegna un
 * Welcome confrontando il destinatario con l'**id** di chi legge. Tenerli
 * diversi nei test è ciò che rende visibile lo scambio dei due.
 */
const ID_ANNA = "u-anna";
const ID_BRUNO = "u-bruno";
const ID_CARLA = "u-carla";
const BRUNO = { casa: CASA, username: "bruno" };
const CARLA = { casa: CASA, username: "carla" };

/** Anna apre, Bruno entra dal suo Welcome. Due depositi, un'istanza sola. */
async function dueDispositivi(): Promise<{
  istanza: ReturnType<typeof istanzaFinta>;
  anna: Contesto;
  bruno: Contesto;
  sessioneAnna: Awaited<ReturnType<typeof apri>>;
  sessioneBruno: NonNullable<Awaited<ReturnType<typeof entra>>>;
  depositoAnna: ReturnType<typeof depositoFinto>;
}> {
  const istanza = istanzaFinta();
  const chiaviAnna = await portachiaviFinto("anna");
  const chiaviBruno = await portachiaviFinto("bruno");
  istanza.ammetti("anna", chiaviAnna.chiaveDiFirma);
  istanza.ammetti("bruno", chiaviBruno.chiaveDiFirma);

  const depositoAnna = depositoFinto();
  const anna: Contesto = {
    deposito: depositoAnna,
    io: chiaviAnna,
    istanza: istanza.per(ID_ANNA),
  };
  const bruno: Contesto = {
    deposito: depositoFinto(),
    io: chiaviBruno,
    istanza: istanza.per(ID_BRUNO),
  };

  const sessioneAnna = await apri(anna, "conv-1", await chiaviBruno.pubblica(), ID_BRUNO, BRUNO);

  const perBruno = await bruno.istanza.handshakeDopo("conv-1");
  const welcome = perBruno.handshake.find((h) => h.tipo === "welcome")!;
  const sessioneBruno = (await entra(bruno, "conv-1", welcome))!;

  return { anna, bruno, depositoAnna, istanza, sessioneAnna, sessioneBruno };
}

describe("aprire una conversazione", () => {
  it("mette sul canale un commit per tutti e un Welcome per chi entra", async () => {
    const { istanza } = await dueDispositivi();

    const sul = istanza.depositati();
    expect(sul.map((h) => h.tipo)).toEqual(["commit", "welcome"]);
    // L'ID di chi entra, non il suo nome: e' con quello che l'istanza consegna.
    expect(sul.find((h) => h.tipo === "welcome")?.destinatario).toBe(ID_BRUNO);
    // Un commit senza destinatario: va a tutti, ed e' la regola che l'istanza
    // fa rispettare rifiutando il contrario.
    expect(sul.find((h) => h.tipo === "commit")?.destinatario).toBeUndefined();
  });

  it("il Welcome lo vede chi entra, e nessun altro", async () => {
    // Se il destinatario fosse il nome invece dell'id, questo elenco sarebbe
    // vuoto per tutti — Bruno compreso — e la conversazione non partirebbe.
    const { bruno, istanza } = await dueDispositivi();

    const suoi = await bruno.istanza.handshakeDopo("conv-1");
    const altrui = await istanza.per(ID_CARLA).handshakeDopo("conv-1");

    expect(suoi.handshake.map((h) => h.tipo)).toEqual(["commit", "welcome"]);
    expect(altrui.handshake.map((h) => h.tipo)).toEqual(["commit"]);
  });

  it("i due si trovano nello stesso gruppo, alla stessa epoch", async () => {
    const { sessioneAnna, sessioneBruno } = await dueDispositivi();

    expect(nomi(sessioneAnna.stato)).toEqual(["anna", "bruno"]);
    expect(epochDi(sessioneBruno.stato)).toBe(epochDi(sessioneAnna.stato));
  });

  it("il mazzo finisce sull'istanza, avvolto sotto l'epoch corrente", async () => {
    const { anna, sessioneAnna } = await dueDispositivi();

    const avvolto = await anna.istanza.mazzo("conv-1");
    expect(avvolto?.epoch).toBe(epochDi(sessioneAnna.stato));
    expect(avvolto?.mazzo.length).toBeGreaterThan(0);
  });

  it("chi entra apre il mazzo che c'era già, e non ne crea uno nuovo", async () => {
    // Sovrascriverlo perderebbe la cronologia di tutti: è il caso che conta.
    const { sessioneAnna, sessioneBruno } = await dueDispositivi();

    const hex = (u: Uint8Array): string => Buffer.from(u).toString("hex");
    expect(sessioneBruno.catena?.map(hex)).toEqual(sessioneAnna.catena?.map(hex));
    expect(sessioneBruno.catena).toBeDefined();
  });

  it("un Welcome per una chiave che non abbiamo più non si apre, e lo dice", async () => {
    // È il browser svuotato: la chiave di firma torna dal backup, la scorta no.
    // Indovinare una chiave qui vorrebbe dire fallire più tardi e peggio.
    const istanza = istanzaFinta();
    const chiaviAnna = await portachiaviFinto("anna");
    const chiaviBruno = await portachiaviFinto("bruno");
    istanza.ammetti("anna", chiaviAnna.chiaveDiFirma);
    istanza.ammetti("bruno", chiaviBruno.chiaveDiFirma);

    const anna: Contesto = {
      deposito: depositoFinto(),
      io: chiaviAnna,
      istanza: istanza.per(ID_ANNA),
    };
    const bruno: Contesto = {
      deposito: depositoFinto(),
      io: chiaviBruno,
      istanza: istanza.per(ID_BRUNO),
    };
    await apri(anna, "conv-1", await chiaviBruno.pubblica(), ID_BRUNO, BRUNO);

    chiaviBruno.dimenticaLaScorta();
    const welcome = (await bruno.istanza.handshakeDopo("conv-1")).handshake.find(
      (h) => h.tipo === "welcome",
    )!;

    expect(await entra(bruno, "conv-1", welcome)).toBeUndefined();
  });
});

describe("scrivere e leggere (ADR 0043)", () => {
  it("Anna scrive, Bruno legge dalla cronologia", async () => {
    const { anna, bruno, sessioneAnna, sessioneBruno } = await dueDispositivi();

    await invia(anna, sessioneAnna, "ci vediamo alle 8", "m1", "2026-08-26T10:00:00.000Z");
    const pagina = await cronologia(bruno, sessioneBruno);

    expect(pagina.righe).toEqual([
      {
        createdAt: "2026-08-26T10:00:00.000Z",
        attestata: true,
        id: "m1",
        // `username@casa`, come lo dichiara la rotta vera: è ciò a cui la voce è legata.
        mittente: `anna@${CASA}`,
        stato: "letta",
        testo: "ci vediamo alle 8",
      },
    ]);
  });

  it("scrivere deposita soltanto nell'archivio: nessuna busta di trasporto parte", async () => {
    // Una busta applicativa consegnata in casa d'altri sarebbe la copia che
    // ADR 0043 vieta. Il canale di handshake resta com'era, e l'archivio ha
    // una voce sola.
    const { anna, istanza, sessioneAnna } = await dueDispositivi();
    const primaSulCanale = istanza.depositati().length;

    await invia(anna, sessioneAnna, "i preventivi del tetto", "m1", "2026-08-26T10:00:00.000Z");

    expect(istanza.depositati()).toHaveLength(primaSulCanale);
    expect(istanza.chiamate.depositaArchivio).toBe(1);
  });

  it("nell'archivio c'è la voce cifrata, non il testo", async () => {
    const { anna, sessioneAnna } = await dueDispositivi();

    await invia(anna, sessioneAnna, "i preventivi del tetto", "m1", "2026-08-26T10:00:00.000Z");

    const grezza = await anna.istanza.cronologia("conv-1");
    expect(grezza.righe[0]?.voce?.busta).toBeDefined();
    expect(grezza.righe[0]?.voce?.busta).not.toContain("preventivi");
  });

  it("scrivere non tocca lo stato del gruppo", async () => {
    // Senza trasporto, una riga non cambia l'albero: niente da salvare, e
    // niente che una scheda chiusa a metà possa lasciare a metà.
    const { anna, depositoAnna, sessioneAnna } = await dueDispositivi();

    const prima = depositoAnna.quanteScritture();
    await invia(anna, sessioneAnna, "una", "m1", "2026-08-26T10:00:00.000Z");

    expect(depositoAnna.quanteScritture()).toBe(prima);
  });
});

describe("la cronologia", () => {
  it("si rilegge in ordine", async () => {
    const { anna, sessioneAnna } = await dueDispositivi();

    await invia(anna, sessioneAnna, "prima", "m1", "2026-08-26T10:00:00.000Z");
    await invia(anna, sessioneAnna, "seconda", "m2", "2026-08-26T10:01:00.000Z");

    const pagina = await cronologia(anna, sessioneAnna);
    expect(pagina.righe.map((r) => r.testo)).toEqual(["prima", "seconda"]);
  });

  it("una riga che non si apre torna senza testo, e non inventa una frase", async () => {
    const { anna, sessioneAnna } = await dueDispositivi();

    await anna.istanza.depositaArchivio("conv-1", [
      { busta: btoa("non si apre"), chiaveN: 1, createdAt: "2026-08-26T10:00:00.000Z", id: "x" },
    ]);

    const pagina = await cronologia(anna, sessioneAnna);
    expect(pagina.righe[0]).toMatchObject({ id: "x", stato: "non-si-apre" });
    expect(pagina.righe[0]?.testo).toBeUndefined();
  });

  it("una riga la cui casa non risponde si dice non disponibile, con chi e quando", async () => {
    const { anna, sessioneAnna } = await dueDispositivi();
    const lettore: Contesto = {
      ...anna,
      istanza: {
        ...anna.istanza,
        cronologia: () =>
          Promise.resolve({
            nonRispondono: ["casa-spenta"],
            righe: [
              {
                casa: "casa-spenta",
                createdAt: "2026-08-26T10:00:00.000Z",
                id: "m1",
                mittente: "matteo@casa-spenta",
                stato: "non-disponibile" as const,
              },
            ],
          }),
      },
    };

    const pagina = await cronologia(lettore, sessioneAnna);

    expect(pagina.nonRispondono).toEqual(["casa-spenta"]);
    expect(pagina.righe).toEqual([
      {
        createdAt: "2026-08-26T10:00:00.000Z",
        id: "m1",
        mittente: "matteo@casa-spenta",
        stato: "non-disponibile",
      },
    ]);
  });
});

describe("il rientro, dopo un browser svuotato (S3 via A)", () => {
  /** Bruno perde tutto: stato del gruppo e scorta. Resta la chiave di firma. */
  async function brunoSvuotato(): Promise<
    Awaited<ReturnType<typeof dueDispositivi>> & { brunoNuovo: Contesto }
  > {
    const scena = await dueDispositivi();
    const brunoNuovo: Contesto = { ...scena.bruno, deposito: depositoFinto() };
    return { ...scena, brunoNuovo };
  }

  it("si torna nel gruppo, ma senza catena finché nessuno riavvolge il mazzo", async () => {
    const { brunoNuovo } = await brunoSvuotato();

    const rientrata = await rientraIn(brunoNuovo, "conv-1");

    expect(rientrata).toBeDefined();
    expect(nomi(rientrata!.stato)).toEqual(["anna", "bruno"]);
    expect(rientrata!.catena).toBeUndefined();
  });

  it("senza catena non si scrive, e il mazzo non si tocca", async () => {
    const { brunoNuovo, istanza } = await brunoSvuotato();
    const rientrata = (await rientraIn(brunoNuovo, "conv-1"))!;
    const mazzoPrima = await brunoNuovo.istanza.mazzo("conv-1");
    const riavvolgimenti = istanza.chiamate.salvaMazzo;

    await expect(
      invia(brunoNuovo, rientrata, "nel vuoto", "m1", "2026-08-26T10:00:00.000Z"),
    ).rejects.toThrow(/non è ancora arrivata/);

    // Riprendere e sincronizzare non riavvolge un mazzo che non si conosce:
    // lo sostituirebbe, e con lui la cronologia di tutti.
    await riprendi(brunoNuovo, "conv-1");
    expect(istanza.chiamate.salvaMazzo).toBe(riavvolgimenti);
    expect(await brunoNuovo.istanza.mazzo("conv-1")).toEqual(mazzoPrima);
  });

  it("quando Anna applica il rientro e riavvolge, Bruno ritrova la cronologia", async () => {
    const { anna, brunoNuovo, sessioneAnna } = await brunoSvuotato();
    await invia(anna, sessioneAnna, "detto prima", "m1", "2026-08-26T10:00:00.000Z");

    await rientraIn(brunoNuovo, "conv-1");
    // Anna apre la conversazione: applica il commit di rientro e, avendo la
    // catena, riavvolge il mazzo sotto l'epoch nuova.
    await riprendi(anna, "conv-1");

    const ripresa = (await riprendi(brunoNuovo, "conv-1"))!;
    expect(ripresa.catena).toBeDefined();
    expect((await cronologia(brunoNuovo, ripresa)).righe.map((r) => r.testo)).toEqual([
      "detto prima",
    ]);
  });

  it("senza un punto di rientro non si rientra, e lo si dice", async () => {
    const { bruno } = await dueDispositivi();

    expect(await rientraIn(bruno, "conv-mai-nata")).toBeUndefined();
  });
});

describe("la sincronizzazione degli handshake", () => {
  it("chi era via applica il commit che si è perso, e torna allineato", async () => {
    const { anna, bruno, istanza, sessioneAnna, sessioneBruno } = await dueDispositivi();

    // Carla entra mentre Bruno non guarda.
    const chiaviCarla = await portachiaviFinto("carla");
    istanza.ammetti("carla", chiaviCarla.chiaveDiFirma);
    const conCarla = await aggiungiMembro(
      anna,
      sessioneAnna,
      await chiaviCarla.pubblica(),
      ID_CARLA,
      CARLA,
    );

    const brunoAggiornato = await sincronizza(bruno, sessioneBruno);

    expect(epochDi(brunoAggiornato.stato)).toBe(epochDi(conCarla.stato));
    expect(nomi(brunoAggiornato.stato)).toEqual(["anna", "bruno", "carla"]);
  });

  it("sincronizzare due volte non riapplica niente", async () => {
    const { bruno, sessioneBruno } = await dueDispositivi();

    const prima = await sincronizza(bruno, sessioneBruno);
    const seconda = await sincronizza(bruno, prima);

    expect(epochDi(seconda.stato)).toBe(epochDi(prima.stato));
  });
});

describe("riprendere dopo aver chiuso la scheda", () => {
  it("lo stato salvato si rilegge, e il gruppo è quello di prima", async () => {
    const { anna, sessioneAnna } = await dueDispositivi();

    const ripresa = await riprendi(anna, "conv-1");

    expect(ripresa).toBeDefined();
    expect(nomi(ripresa!.stato)).toEqual(["anna", "bruno"]);
    expect(epochDi(ripresa!.stato)).toBe(epochDi(sessioneAnna.stato));
  });

  it("una conversazione mai aperta su questo dispositivo non si riprende", async () => {
    const { anna } = await dueDispositivi();

    expect(await riprendi(anna, "conv-mai-vista")).toBeUndefined();
  });

  it("lo stato si salva a ogni mutazione, non solo alla fine", async () => {
    const { anna, depositoAnna, istanza, sessioneAnna } = await dueDispositivi();

    const chiaviCarla = await portachiaviFinto("carla");
    istanza.ammetti("carla", chiaviCarla.chiaveDiFirma);

    const prima = depositoAnna.quanteScritture();
    await aggiungiMembro(anna, sessioneAnna, await chiaviCarla.pubblica(), ID_CARLA, CARLA);

    expect(depositoAnna.quanteScritture()).toBeGreaterThan(prima);
  });
});

describe("la rotazione dell'archivio", () => {
  it("aggiunge una chiave e riavvolge il mazzo", async () => {
    const { anna, sessioneAnna } = await dueDispositivi();

    const prima = await anna.istanza.mazzo("conv-1");
    const ruotata = await ruotaArchivio(anna, sessioneAnna);

    expect(ruotata.catena).toHaveLength((sessioneAnna.catena?.length ?? 0) + 1);
    expect((await anna.istanza.mazzo("conv-1"))?.mazzo).not.toBe(prima?.mazzo);
  });

  it("dopo la rotazione si scrive con la chiave nuova", async () => {
    const { anna, sessioneAnna } = await dueDispositivi();

    const ruotata = await ruotaArchivio(anna, sessioneAnna);
    await invia(anna, ruotata, "dopo l'uscita", "m1", "2026-08-26T10:00:00.000Z");

    expect((await anna.istanza.cronologia("conv-1")).righe[0]?.voce?.chiaveN).toBe(2);
  });
});

describe("il punto da cui si rientra", () => {
  it("finisce sull'istanza a ogni epoch, ed è la condizione del rientro autonomo", async () => {
    const { anna, istanza, sessioneAnna } = await dueDispositivi();

    expect(istanza.puntoDiRientro("conv-1")?.epoch).toBe(epochDi(sessioneAnna.stato));

    // E serve davvero: da quei byte si torna nel gruppo senza che nessun altro
    // sia online — che è tutta la ragione per cui si depositano.
    const punto = istanza.puntoDiRientro("conv-1")!.groupInfo;
    const tornata = await rientra(daBase64(punto), await anna.io.perNuovaFoglia(), anna.istanza);

    expect(nomi(tornata.stato)).toContain("anna");
    // La chiave di firma è la stessa, quindi la foglia si sostituisce: il gruppo
    // resta a due, e il dispositivo perduto non è più membro.
    expect(membri(tornata.stato)).toHaveLength(2);
  });

  it("lo aggiorna anche chi si limita ad applicare il commit di un altro", async () => {
    // Se lo depositasse solo chi committa, una scheda chiusa un attimo troppo
    // presto lascerebbe indietro il punto di rientro di tutti.
    const { anna, bruno, istanza, sessioneAnna, sessioneBruno } = await dueDispositivi();

    const chiaviCarla = await portachiaviFinto("carla");
    istanza.ammetti("carla", chiaviCarla.chiaveDiFirma);
    const conCarla = await aggiungiMembro(
      anna,
      sessioneAnna,
      await chiaviCarla.pubblica(),
      ID_CARLA,
      CARLA,
    );

    const dopoIlCommit = istanza.puntoDiRientro("conv-1")?.epoch;
    await sincronizza(bruno, sessioneBruno);

    expect(dopoIlCommit).toBe(epochDi(conCarla.stato));
    expect(istanza.puntoDiRientro("conv-1")?.epoch).toBe(epochDi(conCarla.stato));
  });
});

/* ---------- ciò che il nucleo faceva già, e il web no (PR #48) ---------- */

const hex = (u: Uint8Array): string => Buffer.from(u).toString("hex");

/** Un guasto che non dice com'è andata: la rete caduta, la scheda chiusa. */
const caduta = (): Error => new Error("la rete è caduta");

describe("lo stato si salva commit per commit, prima del cursore", () => {
  it("un giro interrotto a metà non lascia il cursore più avanti dello stato", async () => {
    const { anna, bruno, istanza, sessioneAnna, sessioneBruno } = await dueDispositivi();

    // Due commit mentre Bruno non guarda: entra Carla, poi entra Dario.
    const chiaviCarla = await portachiaviFinto("carla");
    const chiaviDario = await portachiaviFinto("dario");
    istanza.ammetti("carla", chiaviCarla.chiaveDiFirma);
    istanza.ammetti("dario", chiaviDario.chiaveDiFirma);
    const conCarla = await aggiungiMembro(
      anna,
      sessioneAnna,
      await chiaviCarla.pubblica(),
      ID_CARLA,
      CARLA,
    );
    const conDario = await aggiungiMembro(anna, conCarla, await chiaviDario.pubblica(), "u-dario", {
      casa: CASA,
      username: "dario",
    });

    // La fila arriva a Bruno una busta per pagina, e la seconda pagina non
    // arriva: è la rete che cade a metà del giro.
    let pagine = 0;
    const aPezzi: Istanza = {
      ...bruno.istanza,
      async handshakeDopo(conversazioneId, dopo) {
        pagine += 1;
        if (pagine > 1) {
          throw caduta();
        }
        const tutta = await bruno.istanza.handshakeDopo(conversazioneId, dopo);
        const prima = tutta.handshake.slice(0, 1);
        return { handshake: prima, ...(prima[0] === undefined ? {} : { prossimo: prima[0].id }) };
      },
    };
    await expect(sincronizza({ ...bruno, istanza: aPezzi }, sessioneBruno)).rejects.toThrow(
      "la rete è caduta",
    );

    // La scheda si riapre: si riparte da ciò che il deposito ha tenuto. Se il
    // cursore fosse andato avanti senza lo stato, il primo commit non
    // tornerebbe più e il secondo non si applicherebbe.
    const ripresa = await riprendi(bruno, "conv-1");
    expect(ripresa && epochDi(ripresa.stato)).toBe(epochDi(conDario.stato));
    expect(ripresa && nomi(ripresa.stato)).toEqual(["anna", "bruno", "carla", "dario"]);
  });
});

describe("un commit proprio resta in sospeso finché la fila non l'ha preso", () => {
  /** Un deposito che cade alla prossima scrittura dello stato, una volta sola. */
  function cheCadeSalvando(ctx: Contesto): Contesto {
    let caduto = false;
    return {
      ...ctx,
      deposito: {
        ...ctx.deposito,
        scrivi(id, stato) {
          if (!caduto) {
            caduto = true;
            return Promise.reject(caduta());
          }
          return ctx.deposito.scrivi(id, stato);
        },
      },
    };
  }

  it("la scheda si chiude fra il deposito e il salvataggio: al giro dopo il lavoro si finisce", async () => {
    const { anna, istanza, sessioneAnna } = await dueDispositivi();
    const chiaviCarla = await portachiaviFinto("carla");
    istanza.ammetti("carla", chiaviCarla.chiaveDiFirma);
    const carla: Contesto = {
      deposito: depositoFinto(),
      io: chiaviCarla,
      istanza: istanza.per(ID_CARLA),
    };

    await expect(
      aggiungiMembro(
        cheCadeSalvando(anna),
        sessioneAnna,
        await chiaviCarla.pubblica(),
        ID_CARLA,
        CARLA,
      ),
    ).rejects.toThrow("la rete è caduta");

    // Il commit è in fila, ma l'invito non è partito e lo stato non è salvato.
    expect(istanza.depositati().filter((h) => h.tipo === "commit")).toHaveLength(2);
    expect(istanza.depositati().some((h) => h.destinatario === ID_CARLA)).toBe(false);
    expect(await anna.deposito.leggiSospeso("conv-1")).toBeDefined();

    // La scheda si riapre.
    const ripresa = (await riprendi(anna, "conv-1"))!;

    expect(epochDi(ripresa.stato)).toBe(2);
    expect(nomi(ripresa.stato)).toEqual(["anna", "bruno", "carla"]);
    expect(ripresa.catena?.map(hex)).toEqual(sessioneAnna.catena?.map(hex));
    // Il mazzo è riavvolto sotto l'epoch nuova, e l'invito è partito: Carla entra e legge.
    expect(istanza.mazzo("conv-1")?.epoch).toBe(2);
    const invito = (await carla.istanza.handshakeDopo("conv-1")).handshake.find(
      (h) => h.tipo === "welcome",
    )!;
    const sessioneCarla = (await entra(carla, "conv-1", invito))!;
    expect(sessioneCarla.catena?.map(hex)).toEqual(sessioneAnna.catena?.map(hex));
    expect(await anna.deposito.leggiSospeso("conv-1")).toBeUndefined();
  });

  it("vale anche per chi crea: il gruppo che la fila ha preso non si perde", async () => {
    const istanza = istanzaFinta();
    const chiaviAnna = await portachiaviFinto("anna");
    const chiaviBruno = await portachiaviFinto("bruno");
    istanza.ammetti("anna", chiaviAnna.chiaveDiFirma);
    istanza.ammetti("bruno", chiaviBruno.chiaveDiFirma);
    const anna: Contesto = {
      deposito: depositoFinto(),
      io: chiaviAnna,
      istanza: istanza.per(ID_ANNA),
    };
    const bruno: Contesto = {
      deposito: depositoFinto(),
      io: chiaviBruno,
      istanza: istanza.per(ID_BRUNO),
    };

    await expect(
      apri(cheCadeSalvando(anna), "conv-1", await chiaviBruno.pubblica(), ID_BRUNO, BRUNO),
    ).rejects.toThrow("la rete è caduta");
    expect(istanza.depositati().map((h) => h.tipo)).toEqual(["commit"]);

    const ripresa = (await riprendi(anna, "conv-1"))!;

    expect(nomi(ripresa.stato)).toEqual(["anna", "bruno"]);
    expect(ripresa.catena).toHaveLength(1);
    expect(istanza.depositati().map((h) => h.tipo)).toEqual(["commit", "welcome"]);
    const invito = (await bruno.istanza.handshakeDopo("conv-1")).handshake.find(
      (h) => h.tipo === "welcome",
    )!;
    expect((await entra(bruno, "conv-1", invito))?.catena?.map(hex)).toEqual(
      ripresa.catena?.map(hex),
    );
    expect(await anna.deposito.leggiSospeso("conv-1")).toBeUndefined();
  });

  it("un commit che la fila non ha mai visto si butta, e lo stato resta dov'era", async () => {
    const { anna, istanza, sessioneAnna } = await dueDispositivi();
    const chiaviCarla = await portachiaviFinto("carla");
    istanza.ammetti("carla", chiaviCarla.chiaveDiFirma);

    // Il deposito non arriva: non è un 409, quindi non si sa com'è andata.
    const sorda: Contesto = {
      ...anna,
      istanza: { ...anna.istanza, depositaHandshake: () => Promise.reject(caduta()) },
    };
    await expect(
      aggiungiMembro(sorda, sessioneAnna, await chiaviCarla.pubblica(), ID_CARLA, CARLA),
    ).rejects.toThrow("la rete è caduta");
    expect(await anna.deposito.leggiSospeso("conv-1")).toBeDefined();

    const dopo = await sincronizza(anna, sessioneAnna);

    expect(epochDi(dopo.stato)).toBe(1);
    expect(nomi(dopo.stato)).toEqual(["anna", "bruno"]);
    expect(await anna.deposito.leggiSospeso("conv-1")).toBeUndefined();

    // E si può riprovare.
    const conCarla = await aggiungiMembro(
      anna,
      dopo,
      await chiaviCarla.pubblica(),
      ID_CARLA,
      CARLA,
    );
    expect(nomi(conCarla.stato)).toEqual(["anna", "bruno", "carla"]);
  });

  it("se un altro ha preso quell'epoch, quello in sospeso non vale più", async () => {
    const { anna, bruno, istanza, sessioneAnna, sessioneBruno } = await dueDispositivi();
    const chiaviCarla = await portachiaviFinto("carla");
    const chiaviDario = await portachiaviFinto("dario");
    istanza.ammetti("carla", chiaviCarla.chiaveDiFirma);
    istanza.ammetti("dario", chiaviDario.chiaveDiFirma);

    const sorda: Contesto = {
      ...anna,
      istanza: { ...anna.istanza, depositaHandshake: () => Promise.reject(caduta()) },
    };
    await expect(
      aggiungiMembro(sorda, sessioneAnna, await chiaviCarla.pubblica(), ID_CARLA, CARLA),
    ).rejects.toThrow("la rete è caduta");

    // Nel frattempo Bruno fa entrare Dario, alla stessa epoch.
    await aggiungiMembro(bruno, sessioneBruno, await chiaviDario.pubblica(), "u-dario", {
      casa: CASA,
      username: "dario",
    });

    const dopo = (await riprendi(anna, "conv-1"))!;

    expect(nomi(dopo.stato)).toEqual(["anna", "bruno", "dario"]);
    expect(await anna.deposito.leggiSospeso("conv-1")).toBeUndefined();
    expect(istanza.depositati().some((h) => h.destinatario === ID_CARLA)).toBe(false);
  });

  it("un 409 toglie la nota subito: la fila ha detto di no", async () => {
    const { anna, sessioneAnna, istanza } = await dueDispositivi();
    const chiaviCarla = await portachiaviFinto("carla");
    istanza.ammetti("carla", chiaviCarla.chiaveDiFirma);

    const rifiuta: Contesto = {
      ...anna,
      istanza: {
        ...anna.istanza,
        depositaHandshake: () =>
          Promise.reject(Object.assign(new Error("epoch_superata"), { status: 409 })),
      },
    };
    await expect(
      aggiungiMembro(rifiuta, sessioneAnna, await chiaviCarla.pubblica(), ID_CARLA, CARLA),
    ).rejects.toThrow("epoch_superata");

    expect(await anna.deposito.leggiSospeso("conv-1")).toBeUndefined();
  });
});

describe("un dispositivo che aspetta il sì non crea e non rientra", () => {
  it("non crea: la sua chiave nel registro non c'è", async () => {
    const istanza = istanzaFinta();
    const chiaviAnna = await portachiaviFinto("anna");
    const chiaviBruno = await portachiaviFinto("bruno");
    // Anna **non** è ammessa: il suo dispositivo aspetta ancora il sì.
    istanza.ammetti("bruno", chiaviBruno.chiaveDiFirma);
    const anna: Contesto = {
      deposito: depositoFinto(),
      io: chiaviAnna,
      istanza: istanza.per(ID_ANNA),
    };

    await expect(
      apri(anna, "conv-1", await chiaviBruno.pubblica(), ID_BRUNO, BRUNO),
    ).rejects.toBeInstanceOf(DispositivoInAttesa);

    expect(istanza.depositati()).toHaveLength(0);
    expect(await anna.deposito.leggi("conv-1")).toBeUndefined();
  });

  it("non rientra: il suo commit lo rifiuterebbero tutti, e fermerebbe la fila", async () => {
    const { istanza } = await dueDispositivi();
    const prima = istanza.depositati().length;

    // Un secondo dispositivo di Anna, che nessuno ha ancora approvato.
    const nuovo: Contesto = {
      deposito: depositoFinto(),
      io: await portachiaviFinto("anna"),
      istanza: istanza.per(ID_ANNA),
    };

    await expect(rientraIn(nuovo, "conv-1")).rejects.toBeInstanceOf(DispositivoInAttesa);

    expect(istanza.depositati()).toHaveLength(prima);
    expect(await nuovo.deposito.leggi("conv-1")).toBeUndefined();
  });
});

describe("un KeyPackage che nomina un'altra persona non fa entrare nessuno", () => {
  it("alla creazione", async () => {
    const istanza = istanzaFinta();
    const chiaviAnna = await portachiaviFinto("anna");
    const chiaviCarla = await portachiaviFinto("carla");
    istanza.ammetti("anna", chiaviAnna.chiaveDiFirma);
    istanza.ammetti("carla", chiaviCarla.chiaveDiFirma);
    const anna: Contesto = {
      deposito: depositoFinto(),
      io: chiaviAnna,
      istanza: istanza.per(ID_ANNA),
    };

    // Anna vuole Bruno, e la casa le manda la chiave di Carla.
    await expect(
      apriCon(anna, "conv-1", [
        { destinatario: ID_BRUNO, keyPackage: await chiaviCarla.pubblica(), membro: BRUNO },
      ]),
    ).rejects.toBeInstanceOf(ChiaveDiUnAltro);

    expect(istanza.depositati()).toHaveLength(0);
    expect(await anna.deposito.leggi("conv-1")).toBeUndefined();
    expect(await anna.deposito.leggiSospeso("conv-1")).toBeUndefined();
  });

  it("e quando entra in una conversazione che esiste", async () => {
    const { anna, istanza, sessioneAnna } = await dueDispositivi();
    const prima = istanza.depositati().length;
    const chiaviDario = await portachiaviFinto("dario");
    istanza.ammetti("dario", chiaviDario.chiaveDiFirma);

    await expect(
      aggiungiMembro(anna, sessioneAnna, await chiaviDario.pubblica(), ID_CARLA, CARLA),
    ).rejects.toBeInstanceOf(ChiaveDiUnAltro);

    expect(istanza.depositati()).toHaveLength(prima);
  });
});

describe("un invito per un'altra conversazione non si apre", () => {
  it("un Welcome di un altro gruppo, trovato su questo canale, si rifiuta e non salva niente", async () => {
    const istanza = istanzaFinta();
    const chiaviAnna = await portachiaviFinto("anna");
    const chiaviBruno = await portachiaviFinto("bruno");
    istanza.ammetti("anna", chiaviAnna.chiaveDiFirma);
    istanza.ammetti("bruno", chiaviBruno.chiaveDiFirma);
    const anna: Contesto = {
      deposito: depositoFinto(),
      io: chiaviAnna,
      istanza: istanza.per(ID_ANNA),
    };
    const bruno: Contesto = {
      deposito: depositoFinto(),
      io: chiaviBruno,
      istanza: istanza.per(ID_BRUNO),
    };

    // Il gruppo vero è di `conv-2`; il suo invito viene presentato a Bruno come
    // se stesse sul canale di `conv-1`.
    await apri(anna, "conv-2", await chiaviBruno.pubblica(), ID_BRUNO, BRUNO);
    const altrui = istanza.depositati().find((h) => h.tipo === "welcome")!;

    await expect(entra(bruno, "conv-1", altrui)).rejects.toBeInstanceOf(DiUnAltraConversazione);

    expect(await bruno.deposito.leggi("conv-1")).toBeUndefined();
    expect(await bruno.deposito.leggiCursore("conv-1")).toBeUndefined();
    // Dal suo canale, lo stesso invito si apre.
    expect(await entra(bruno, "conv-2", altrui)).toBeDefined();
  });
});

describe("riprendendo, il mazzo si accetta solo se estende la catena già nota", () => {
  it("un mazzo con un'altra catena non sostituisce quella che il dispositivo conosce", async () => {
    const { anna, bruno, sessioneAnna, sessioneBruno } = await dueDispositivi();

    // Alla stessa epoch, e sotto la serratura giusta: lo può fare un membro,
    // per errore o apposta. La catena dentro però non è quella di prima.
    await anna.istanza.salvaMazzo("conv-1", {
      epoch: epochDi(sessioneAnna.stato),
      mazzo: avvolgi(catenaNuova(), await serraturaArchivio(sessioneAnna.stato)),
    });

    const ripresa = (await riprendi(bruno, "conv-1"))!;

    expect(ripresa.catena?.map(hex)).toEqual(sessioneBruno.catena?.map(hex));
  });

  it("uno con la stessa catena e una chiave in più si adotta", async () => {
    const { anna, bruno, sessioneAnna, sessioneBruno } = await dueDispositivi();
    const piuLunga = catenaRuotata(sessioneAnna.catena!);

    await anna.istanza.salvaMazzo("conv-1", {
      epoch: epochDi(sessioneAnna.stato),
      mazzo: avvolgi(piuLunga, await serraturaArchivio(sessioneAnna.stato)),
    });

    const ripresa = (await riprendi(bruno, "conv-1"))!;

    expect(ripresa.catena?.map(hex)).toEqual(piuLunga.map(hex));
    expect(ripresa.catena?.slice(0, 1).map(hex)).toEqual(sessioneBruno.catena?.map(hex));
  });
});
