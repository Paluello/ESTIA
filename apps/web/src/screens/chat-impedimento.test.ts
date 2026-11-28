/**
 * Le parole che una chat dice quando non si può usare.
 *
 * È il genere di cosa che nessun altro controllo vede: una frase inglese scritta
 * per chi programma passa typecheck, lint e build, e sbaglia soltanto addosso a
 * una persona. È già successo — «The user has no registered active devices.» è
 * quello che ha visto un membro provando a scrivere a un'amica.
 */
import { describe, expect, it } from "vitest";

import { ApiError } from "../api.js";
import { impedimentoDi, siPuoScrivere, spiegazioneDi } from "./chat-impedimento.js";

const senzaDispositivo = new ApiError(
  "no_device_available",
  "The user has no registered active devices.",
  404,
);

describe("che cosa impedisce una conversazione", () => {
  it("quando è tutto a posto, non impedisce niente e si scrive", () => {
    const impedimento = impedimentoDi({
      crittografiaDisponibile: true,
      nomeDestinatario: "Lucia",
    });

    expect(impedimento.kind).toBe("nessuno");
    expect(siPuoScrivere(impedimento)).toBe(true);
    expect(spiegazioneDi(impedimento)).toBeUndefined();
  });

  it("riconosce che il destinatario non ha ancora una chiave", () => {
    const impedimento = impedimentoDi({
      crittografiaDisponibile: true,
      erroreChiave: senzaDispositivo,
      nomeDestinatario: "Lucia",
    });

    expect(impedimento).toEqual({ kind: "destinatario-senza-dispositivo", nome: "Lucia" });
    expect(siPuoScrivere(impedimento)).toBe(false);
  });

  it("la connessione non sicura vince sul resto", () => {
    // Blocca anche la lettura, ed è l'unica cosa su cui chi guarda può agire da
    // solo: dirgli dell'altra persona sarebbe mandarlo a risolvere il problema
    // sbagliato.
    const impedimento = impedimentoDi({
      crittografiaDisponibile: false,
      erroreChiave: senzaDispositivo,
      nomeDestinatario: "Lucia",
    });

    expect(impedimento.kind).toBe("connessione-non-sicura");
  });

  it("un errore qualunque non diventa «non ha il dispositivo»", () => {
    // Si guarda il codice, non il testo: indovinare la causa da una frase è il
    // modo per dire una bugia precisa.
    const impedimento = impedimentoDi({
      crittografiaDisponibile: true,
      erroreChiave: new ApiError("forbidden", "Non sei membro di questa conversazione.", 403),
      nomeDestinatario: "Lucia",
    });

    expect(impedimento.kind).toBe("nessuno");
  });
});

describe("una casa spenta non è una persona senza dispositivo", () => {
  const casaSpenta = new ApiError(
    "istanza_non_raggiungibile",
    "La casa di questa persona non risponde.",
    503,
  );

  it("le distingue, perché sono due problemi diversi", () => {
    const impedimento = impedimentoDi({
      crittografiaDisponibile: true,
      erroreChiave: casaSpenta,
      nomeDestinatario: "Lucia",
    });

    expect(impedimento).toEqual({ kind: "casa-non-risponde", nome: "Lucia" });
  });

  it("non incolpa né te né le chiavi", () => {
    // È la frase che evita di mandare qualcuno a rifare un backup per un
    // router spento dall'altra parte.
    const spiegazione = spiegazioneDi({ kind: "casa-non-risponde", nome: "Lucia" })!;

    expect(spiegazione.testo).toContain("non è un problema delle chiavi");
  });

  it("non promette una consegna che non c'è più", () => {
    // Con ESTIA-E2E-v1 il messaggio restava in coda e partiva al ritorno della
    // casa. Con MLS e la custodia dell'autore non c'è una coda di consegna:
    // prometterlo sarebbe falso. Si dice che la conversazione riprende.
    const cosaFare = spiegazioneDi({ kind: "casa-non-risponde", nome: "Lucia" })!.cosaFare;
    expect(cosaFare).not.toContain("il messaggio parte");
    expect(cosaFare).toContain("riprende");
  });

  it("riconosce la casa che mette in fila la conversazione quando non risponde", () => {
    expect(
      impedimentoDi({
        crittografiaDisponibile: true,
        erroreChiave: new ApiError("casa_che_ordina_non_raggiungibile", "x", 503),
        nomeDestinatario: "Lucia",
      }),
    ).toEqual({ kind: "casa-non-risponde", nome: "Lucia" });
  });
});

describe("la conversazione che si sta aprendo", () => {
  it("chi aspetta l'invito lo sa, e non può scrivere", () => {
    const impedimento = impedimentoDi({
      crittografiaDisponibile: true,
      inAttesa: true,
      nomeDestinatario: "Lucia",
    });

    expect(impedimento).toEqual({ kind: "in-attesa", nome: "Lucia" });
    expect(siPuoScrivere(impedimento)).toBe(false);
  });

  it("un dispositivo appena entrato non scrive finché la cronologia non si apre", () => {
    // Una riga chiusa con una chiave che nessun altro ha sarebbe un messaggio
    // che nessuno legge, mostrato come mandato: il campo si spegne (euristica 5).
    const impedimento = impedimentoDi({
      crittografiaDisponibile: true,
      nomeDestinatario: "Lucia",
      senzaCronologia: true,
    });

    expect(impedimento).toEqual({ kind: "cronologia-in-arrivo", nome: "Lucia" });
    expect(siPuoScrivere(impedimento)).toBe(false);
    expect(spiegazioneDi(impedimento)!.cosaFare).toContain("Lucia");
  });

  it("un errore vero vince sull'attesa: prima si dice che la casa non risponde", () => {
    expect(
      impedimentoDi({
        crittografiaDisponibile: true,
        erroreChiave: new ApiError("istanza_non_raggiungibile", "x", 503),
        inAttesa: true,
        nomeDestinatario: "Lucia",
      }).kind,
    ).toBe("casa-non-risponde");
  });
});

describe("le parole che si leggono", () => {
  it("dicono il nome della persona, non un codice", () => {
    const spiegazione = spiegazioneDi({
      kind: "destinatario-senza-dispositivo",
      nome: "Lucia",
    })!;

    expect(spiegazione.titolo).toContain("Lucia");
    expect(spiegazione.segnaposto).toContain("Lucia");
  });

  it("non lasciano mai un vicolo cieco: c'è sempre una prossima mossa", () => {
    // Euristica 3 e 9: causa e prossima mossa, mai un codice grezzo come esito.
    for (const impedimento of [
      { kind: "connessione-non-sicura" } as const,
      { kind: "destinatario-senza-dispositivo", nome: "Lucia" } as const,
      { kind: "casa-non-risponde", nome: "Lucia" } as const,
    ]) {
      const spiegazione = spiegazioneDi(impedimento)!;
      expect(spiegazione.cosaFare.length).toBeGreaterThan(0);
      expect(spiegazione.testo.length).toBeGreaterThan(0);
    }
  });

  it("dicono a chi entra da una connessione non sicura che nessuno può scrivergli", () => {
    // È la metà che mancava, ed è quella che rende una persona invisibile senza
    // che lo sappia: sa di non poter scrivere, non sa di non poter ricevere.
    const spiegazione = spiegazioneDi({ kind: "connessione-non-sicura" })!;

    expect(spiegazione.testo).toContain("nessuno può scriverti");
  });

  it("non parlano di chiavi pubbliche, dispositivi registrati e altre parole del protocollo", () => {
    // Euristica 2: parole di chi usa l'istanza, non del protocollo.
    const tutte = [
      spiegazioneDi({ kind: "connessione-non-sicura" })!,
      spiegazioneDi({ kind: "destinatario-senza-dispositivo", nome: "Lucia" })!,
      spiegazioneDi({ kind: "casa-non-risponde", nome: "Lucia" })!,
    ];

    for (const spiegazione of tutte) {
      const testo = `${spiegazione.titolo} ${spiegazione.testo} ${spiegazione.cosaFare}`;
      for (const parola of ["KeyPackage", "chiave pubblica", "registrat", "WebCrypto", "E2E"]) {
        expect(testo).not.toContain(parola);
      }
    }
  });
});

describe("i gruppi", () => {
  const tolto = new ApiError("rimosso_dal_gruppo", "Removed.", 403);

  it("chi è stato tolto lo legge, da qualunque parte arrivi la notizia", () => {
    const dallIstanza = impedimentoDi({
      crittografiaDisponibile: true,
      erroreChiave: tolto,
      nomeDestinatario: "Lucia",
    });
    const dalGruppoCifrato = impedimentoDi({
      crittografiaDisponibile: true,
      nomeDestinatario: "Lucia",
      tolto: true,
    });

    expect(dallIstanza).toEqual({ kind: "tolto-dal-gruppo" });
    expect(dalGruppoCifrato).toEqual({ kind: "tolto-dal-gruppo" });
    expect(siPuoScrivere(dallIstanza)).toBe(false);

    const spiegazione = spiegazioneDi(dallIstanza)!;
    expect(spiegazione.testo).toContain("Non ricevi più i suoi messaggi nuovi");
    // Una prossima mossa c'è sempre (euristica 3).
    expect(spiegazione.cosaFare).toContain("chi amministra il gruppo");
  });

  it("un dispositivo di qualcuno che non è fra le persone spegne la scrittura, e dice di chi è", () => {
    const impedimento = impedimentoDi({
      crittografiaDisponibile: true,
      estranei: ["@dario"],
      gruppo: true,
      nomeDestinatario: "Lucia",
    });

    expect(impedimento).toEqual({ kind: "presenza-estranea", nomi: "@dario" });
    expect(siPuoScrivere(impedimento)).toBe(false);

    const spiegazione = spiegazioneDi(impedimento)!;
    expect(spiegazione.testo).toContain("@dario");
    expect(spiegazione.testo).toContain("può leggere");
    expect(spiegazione.cosaFare.length).toBeGreaterThan(0);
  });

  it("nessun estraneo, nessun impedimento", () => {
    expect(
      impedimentoDi({
        crittografiaDisponibile: true,
        estranei: [],
        gruppo: true,
        nomeDestinatario: "Lucia",
      }).kind,
    ).toBe("nessuno");
  });

  it("l'attesa di un gruppo nomina chi l'ha creato, e non dice «dalla sua casa»", () => {
    const impedimento = impedimentoDi({
      crittografiaDisponibile: true,
      gruppo: true,
      inAttesa: true,
      nomeDestinatario: "Anna",
    });

    expect(impedimento).toEqual({ kind: "gruppo-in-attesa", nome: "Anna" });
    const spiegazione = spiegazioneDi(impedimento)!;
    expect(spiegazione.testo).toContain("Anna");
    expect(spiegazione.testo).not.toContain("dalla sua casa");
  });

  it("un gruppo traslocato spegne la scrittura e non fa aspettare nessuno", () => {
    // Di un gruppo congelato sono vere anche le altre due cose — la casa che
    // lo ordinava non risponde, e nessun invito arriverà — ma nessuna delle
    // due è da aspettare: si dice che è congelato, e dove andare.
    const impedimento = impedimentoDi({
      congelata: true,
      crittografiaDisponibile: true,
      erroreChiave: new ApiError("casa_che_ordina_non_raggiungibile", "Off.", 503),
      gruppo: true,
      inAttesa: true,
      nomeDestinatario: "Anna",
    });

    expect(impedimento).toEqual({ kind: "gruppo-congelato" });
    expect(siPuoScrivere(impedimento)).toBe(false);
    const spiegazione = spiegazioneDi(impedimento)!;
    expect(spiegazione.testo).toContain("si legge ancora");
    expect(spiegazione.cosaFare).toContain("gruppo nuovo");

    // Chi nel frattempo è stato tolto lo legge comunque per primo.
    expect(
      impedimentoDi({
        congelata: true,
        crittografiaDisponibile: true,
        nomeDestinatario: "Anna",
        tolto: true,
      }).kind,
    ).toBe("tolto-dal-gruppo");
  });
});

describe("un dispositivo che aspetta il sì", () => {
  it("lo dice con le sue parole, invece di un errore qualunque, e spegne la scrittura", async () => {
    // È l'errore vero della sessione: chi aspetta non crea e non rientra.
    const { DispositivoInAttesa } = await import("../mls/sessione.js");
    const impedimento = impedimentoDi({
      crittografiaDisponibile: true,
      erroreChiave: new DispositivoInAttesa(),
      nomeDestinatario: "Lucia",
    });

    expect(impedimento).toEqual({ kind: "dispositivo-in-attesa" });
    expect(siPuoScrivere(impedimento)).toBe(false);
    const spiegazione = spiegazioneDi(impedimento)!;
    expect(spiegazione.titolo).toContain("aspetta");
    expect(spiegazione.cosaFare).toContain("di' di sì");
    // Non nomina l'altra persona: la mossa è tua, su un altro dispositivo.
    expect(spiegazione.testo).not.toContain("Lucia");
  });

  it("la connessione non sicura vince anche su questo", () => {
    expect(
      impedimentoDi({
        crittografiaDisponibile: false,
        erroreChiave: { code: "dispositivo_in_attesa" },
        nomeDestinatario: "Lucia",
      }).kind,
    ).toBe("connessione-non-sicura");
  });
});
