// @vitest-environment jsdom
/**
 * Il numero di sicurezza come lo vede la persona: il pannello, il «verificato»
 * e l'avviso ([ADR 0050](../../../../../docs/adr/0050-il-numero-di-sicurezza.md)).
 *
 * Il calcolo è vero e le chiavi sono finte; il registro è una mappa che il test
 * può cambiare, cioè la sola parte che in produzione appartiene a qualcun altro.
 */
import type { AuthorView } from "@estia/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from "vitest";

import { cassettoFinto } from "../../mls/finte.js";
import { scriviIdentita, type Membro } from "../../mls/gruppo.js";
import { inGruppi, numeroDiSicurezza } from "../../mls/numero-di-sicurezza.js";
import { apriNumeroDiSicurezza } from "./apri.js";
import { membroDi } from "./membri.js";
import type { Ambiente } from "./PannelloSicurezza.js";
import { SicurezzaVista } from "./SicurezzaConversazione.js";

const CASA = "chiave-di-aia";
const BORGO = "chiave-di-borgo";

const chiave = (n: number): Uint8Array =>
  Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (n * 31 + i * 7) & 0xff));

const IO: AuthorView = { displayName: "Anna", id: "u-anna", username: "anna" };
const BRUNO: AuthorView = { displayName: "Bruno", id: `remote:${BORGO}:bruno`, username: "bruno" };
const CARLA: AuthorView = { displayName: "Carla", id: "u-carla", username: "carla" };

const ANNA_M: Membro = { casa: CASA, username: "anna" };
const BRUNO_M: Membro = { casa: BORGO, username: "bruno" };

beforeAll(() => {
  // jsdom non ha `showModal`: qui basta che il dialogo risulti aperto.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.removeAttribute("open");
  };
});

afterEach(cleanup);

function mondo(): {
  ambiente: () => Promise<Ambiente>;
  registro: Map<string, Uint8Array[]>;
  avvisi: {
    errore: Mock<(causa: unknown, ripiego: string) => void>;
    successo: Mock<(testo: string) => void>;
  };
} {
  const cassetto = cassettoFinto();
  const registro = new Map<string, Uint8Array[]>([
    [scriviIdentita(ANNA_M), [chiave(1)]],
    [scriviIdentita(BRUNO_M), [chiave(2)]],
    [scriviIdentita({ casa: CASA, username: "carla" }), [chiave(5)]],
  ]);

  // La chiave di questo dispositivo, nella forma in cui il bootstrap la lascia.
  void cassetto.scrivi("materiale_mls", {
    casa: CASA,
    chiaviDiFirma: { publicKey: chiave(1), signKey: new Uint8Array(32) },
    scorta: [],
    username: "anna",
    v: 2,
  });

  return {
    ambiente: () =>
      Promise.resolve({
        dip: {
          cassetto,
          chiaviDiFirmaDi: (membro) => Promise.resolve(registro.get(scriviIdentita(membro)) ?? []),
        },
        io: ANNA_M,
      }),
    avvisi: {
      errore: vi.fn<(causa: unknown, ripiego: string) => void>(),
      successo: vi.fn<(testo: string) => void>(),
    },
    registro,
  };
}

function monta(
  m: ReturnType<typeof mondo>,
  conversazione: { id: string; tipo: "diretta" | "gruppo"; membri: AuthorView[] },
): void {
  render(
    <MemoryRouter>
      <SicurezzaVista
        ambiente={m.ambiente}
        avvisi={m.avvisi}
        conversazione={conversazione}
        ioId={IO.id}
      />
    </MemoryRouter>,
  );
}

const DIRETTA = { id: "c-1", membri: [IO, BRUNO], tipo: "diretta" as const };
const GRUPPO = { id: "c-2", membri: [IO, BRUNO, CARLA], tipo: "gruppo" as const };

async function numeroMostrato(): Promise<string> {
  const blocco = await screen.findByTestId("numero-di-sicurezza");
  return (blocco.textContent ?? "").replace(/\s/g, "");
}

describe("il pannello del numero di sicurezza", () => {
  it("in una conversazione diretta mostra il numero della coppia, in dodici gruppi", async () => {
    const m = mondo();
    monta(m, DIRETTA);

    apriNumeroDiSicurezza();

    const atteso = numeroDiSicurezza(
      { chiavi: [chiave(1)], membro: ANNA_M },
      { chiavi: [chiave(2)], membro: BRUNO_M },
    );
    expect(await numeroMostrato()).toBe(atteso);
    expect(screen.getByTestId("numero-di-sicurezza").children).toHaveLength(12);
    expect(screen.getByText(inGruppi(atteso)[0] ?? "", { exact: false })).toBeTruthy();
    // Dice con chi, e su quale canale confrontarlo: sta sulla schermata.
    expect(screen.getByText(/di persona o al telefono/)).toBeTruthy();
  });

  it("in un gruppo si arriva a ciascun membro, e il numero è quello dei messaggi privati", async () => {
    const diretta = mondo();
    monta(diretta, DIRETTA);
    apriNumeroDiSicurezza();
    const nelPrivato = await numeroMostrato();
    cleanup();

    const m = mondo();
    monta(m, GRUPPO);
    apriNumeroDiSicurezza();

    // Prima l'elenco: un gruppo non ha un numero suo.
    expect(await screen.findByText("Carla")).toBeTruthy();
    expect(screen.queryByTestId("numero-di-sicurezza")).toBeNull();

    fireEvent.click(screen.getByText("Bruno"));
    expect(await numeroMostrato()).toBe(nelPrivato);

    fireEvent.click(screen.getByText("Indietro"));
    fireEvent.click(await screen.findByText("Carla"));
    await waitFor(async () => {
      expect(await numeroMostrato()).not.toBe(nelPrivato);
    });
  });

  it("segnare verificato resta, e vale anche guardando la stessa persona da un gruppo", async () => {
    const m = mondo();
    monta(m, DIRETTA);
    apriNumeroDiSicurezza();

    fireEvent.click(await screen.findByText("Coincidono: segna come verificato"));

    expect(await screen.findByText("Verificato")).toBeTruthy();
    expect(m.avvisi.successo).toHaveBeenCalledWith("Segnato come verificato.");
    cleanup();

    monta(m, GRUPPO);
    apriNumeroDiSicurezza();
    // Nell'elenco del gruppo Bruno porta già il segno, Carla no.
    expect(await screen.findByText("Verificato")).toBeTruthy();
    expect(screen.getAllByText("Verificato")).toHaveLength(1);
  });

  it("la verifica si toglie dallo stesso posto in cui si è messa", async () => {
    const m = mondo();
    monta(m, DIRETTA);
    apriNumeroDiSicurezza();
    fireEvent.click(await screen.findByText("Coincidono: segna come verificato"));

    fireEvent.click(await screen.findByText("Togli la verifica"));

    expect(await screen.findByText("Coincidono: segna come verificato")).toBeTruthy();
    expect(screen.queryByText("Verificato")).toBeNull();
  });

  it("dice perché non c'è un numero, se l'altra persona non ha dispositivi", async () => {
    const m = mondo();
    m.registro.set(scriviIdentita(BRUNO_M), []);
    monta(m, DIRETTA);

    apriNumeroDiSicurezza();

    expect(await screen.findByText(/Bruno non ha un dispositivo approvato/)).toBeTruthy();
    expect(screen.queryByTestId("numero-di-sicurezza")).toBeNull();
  });

  it("dice che cosa fare, se è questo dispositivo a non essere approvato", async () => {
    const m = mondo();
    m.registro.set(scriviIdentita(ANNA_M), [chiave(9)]);
    monta(m, DIRETTA);

    apriNumeroDiSicurezza();

    expect(await screen.findByText(/non è ancora fra quelli approvati/)).toBeTruthy();
    expect(screen.getByText("Apri le chiavi delle chat").getAttribute("href")).toBe(
      "/impostazioni/chat",
    );
  });

  it("se il registro non risponde lo dice, e offre di riprovare", async () => {
    const m = mondo();
    let spenta = true;
    const vero = m.ambiente;
    m.ambiente = async () => {
      const ambiente = await vero();
      return {
        ...ambiente,
        dip: {
          ...ambiente.dip,
          chiaviDiFirmaDi: (membro) =>
            spenta && membro.casa === BORGO
              ? Promise.reject(new Error("istanza_non_raggiungibile"))
              : ambiente.dip.chiaviDiFirmaDi(membro),
        },
      };
    };
    monta(m, DIRETTA);
    apriNumeroDiSicurezza();

    expect((await screen.findByRole("alert")).textContent).toContain("la casa di Bruno");

    spenta = false;
    fireEvent.click(screen.getByText("Riprova"));
    expect(await numeroMostrato()).toMatch(/^\d{60}$/);
  });
});

describe("l'avviso in cima alla conversazione", () => {
  it("non c'è per chi non è mai stato verificato, anche se le sue chiavi cambiano", async () => {
    const m = mondo();
    m.registro.set(scriviIdentita(BRUNO_M), [chiave(2), chiave(3)]);
    monta(m, DIRETTA);

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("compare quando un verificato aggiunge un dispositivo, e porta al confronto", async () => {
    const m = mondo();
    monta(m, DIRETTA);
    apriNumeroDiSicurezza();
    const prima = await numeroMostrato();
    fireEvent.click(await screen.findByText("Coincidono: segna come verificato"));
    await screen.findByText("Verificato");
    cleanup();

    // Bruno approva un secondo dispositivo. Alla prossima apertura:
    m.registro.set(scriviIdentita(BRUNO_M), [chiave(2), chiave(3)]);
    monta(m, DIRETTA);

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain("È cambiato il numero di sicurezza di Bruno");

    fireEvent.click(screen.getByText("Confronta di nuovo"));

    expect(await numeroMostrato()).not.toBe(prima);
    expect(screen.getByText("Il numero di Bruno è cambiato")).toBeTruthy();
    expect(screen.getByText("Cambiato")).toBeTruthy();

    // Confrontato di nuovo, l'avviso se ne va: non resta acceso per abitudine.
    fireEvent.click(screen.getByText("Coincidono: segna come verificato"));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("in un gruppo nomina chi è cambiato, e soltanto lui", async () => {
    const m = mondo();
    for (const autore of [BRUNO, CARLA]) {
      monta(m, { id: "c-x", membri: [IO, autore], tipo: "diretta" });
      apriNumeroDiSicurezza();
      fireEvent.click(await screen.findByText("Coincidono: segna come verificato"));
      await screen.findByText("Verificato");
      cleanup();
    }

    m.registro.set(scriviIdentita(membroDi(CARLA, CASA)), [chiave(6)]);
    monta(m, GRUPPO);

    const avviso = await screen.findByRole("alert");
    expect(avviso.textContent).toContain("di Carla");
    expect(avviso.textContent).not.toContain("Bruno");
  });
});
