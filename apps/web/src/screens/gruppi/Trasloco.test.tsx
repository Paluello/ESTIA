// @vitest-environment jsdom
/**
 * Il trasloco come lo vede chi usa il gruppo
 * ([ADR 0042](../../../../../docs/adr/0042-come-mls-attraversa.md) §3): a chi
 * si offre il gesto, e **che cosa gli si dice prima**. Le frasi sono la cosa
 * provata: un trasloco che non dicesse i suoi due costi sarebbe un bottone
 * che lascia fuori qualcuno senza che nessuno l'abbia scelto.
 */
import type { ConversazioneView } from "@estia/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { impostaLingua } from "../../lingua.js";
import { AvvisoTrasloco } from "./Trasloco.js";

beforeAll(() => {
  impostaLingua("it");
  // jsdom non ha `showModal`: qui basta che il dialogo risulti aperto.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.removeAttribute("open");
  };
});

afterEach(cleanup);

const CASA = "b".repeat(64);
const QUEST_ANNO = new Date().getFullYear();

const GRUPPO = {
  createdAt: `${QUEST_ANNO}-01-10T10:00:00.000Z`,
  id: "vecchio",
  membri: [
    { displayName: "Anna", id: `remote:${"a".repeat(64)}:anna`, username: "anna" },
    { displayName: "Bruno", id: "u-bruno", username: "bruno" },
    { displayName: "Carla", id: "u-carla", username: "carla" },
  ],
  nome: "Cena di quartiere",
  nonLetti: 0,
  ordinataQui: false,
  ruoli: { "u-bruno": "amministratore" },
  tipo: "gruppo",
} as unknown as ConversazioneView;

function avviso(
  conversazione: Partial<ConversazioneView>,
  mie: string[] = ["vecchio"],
): { onApri: ReturnType<typeof vi.fn>; onTrasloca: ReturnType<typeof vi.fn> } {
  const onApri = vi.fn();
  const onTrasloca = vi.fn(() => Promise.resolve());

  render(
    <AvvisoTrasloco
      casa={CASA}
      conversazione={{ ...GRUPPO, ...conversazione }}
      mie={new Set(mie)}
      onApri={onApri}
      onTrasloca={onTrasloca}
    />,
  );

  return { onApri, onTrasloca };
}

const testo = (): string => document.body.textContent ?? "";

describe("il trasloco di un gruppo", () => {
  it("un gruppo la cui casa risponde non dice e non offre niente", () => {
    avviso({});
    expect(testo()).toBe("");
  });

  it("chi non amministra vede che la casa è persa, e non il gesto", () => {
    avviso({ casaPersaDal: `${QUEST_ANNO}-03-03T08:00:00.000Z`, puoTraslocare: false });

    expect(testo()).toContain("non risponde dal 3 marzo");
    expect(testo()).toContain("Lo può traslocare chi amministra il gruppo.");
    expect(screen.queryByRole("button", { name: "Trasloca il gruppo" })).toBeNull();
  });

  it("chi amministra trasloca solo dopo aver letto i due costi", async () => {
    const { onTrasloca } = avviso({
      casaPersaDal: `${QUEST_ANNO}-03-03T08:00:00.000Z`,
      puoTraslocare: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Trasloca il gruppo" }));
    expect(onTrasloca).not.toHaveBeenCalled();

    // Chi oggi non è raggiungibile resta fuori; il gruppo nuovo ha chiavi
    // nuove, e chi entra dopo non vede quello di prima; e due traslochi
    // insieme danno due gruppi.
    expect(testo()).toContain("Traslocare «Cena di quartiere»?");
    expect(testo()).toContain("non entra nel gruppo nuovo: andrà aggiunto a mano quando torna");
    expect(testo()).toContain("Il gruppo nuovo ha chiavi nuove");
    expect(testo()).toContain("chi entra dopo non lo vede");
    expect(testo()).toContain("nascono due gruppi");
    expect(testo()).toContain("da adesso si potrà solo leggere");

    fireEvent.click(screen.getByRole("button", { name: "Trasloca" }));
    await waitFor(() => expect(onTrasloca).toHaveBeenCalledTimes(1));
  });

  it("il gruppo di prima è marcato, porta a chi lo continua, e non offre un secondo trasloco", () => {
    const { onApri } = avviso(
      {
        casaPersaDal: `${QUEST_ANNO}-03-03T08:00:00.000Z`,
        congelata: true,
        puoTraslocare: true,
        successori: [
          { da: `bruno@${CASA}`, id: "di-bruno", il: `${QUEST_ANNO}-04-05T09:00:00.000Z` },
          { da: `dora@${"d".repeat(64)}`, id: "di-dora", il: `${QUEST_ANNO}-04-05T09:30:00.000Z` },
        ],
      },
      ["vecchio", "di-bruno"],
    );

    expect(testo()).toContain("Questo gruppo è congelato");
    expect(testo()).toContain("i gruppi che lo continuano sono 2");
    expect(testo()).toContain("Bruno l'ha traslocato il 5 aprile.");
    // Nel gruppo di Dora chi guarda non c'è: lo sa, e sa a chi chiedere.
    expect(testo()).toContain("dora l'ha traslocato il 5 aprile, ma tu non sei nel gruppo nuovo");
    expect(screen.queryByRole("button", { name: "Trasloca il gruppo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apri il gruppo di dora" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Apri il gruppo di Bruno" }));
    expect(onApri).toHaveBeenCalledWith("di-bruno");
  });

  it("il successore dice che cosa continua, con le parole dell'ADR", () => {
    const { onApri } = avviso({
      continua: {
        casaPersaDal: `${QUEST_ANNO}-03-03T08:00:00.000Z`,
        conversazioneId: "vecchio",
        da: `bruno@${CASA}`,
        epoch: 4,
        il: `${QUEST_ANNO}-04-05T09:00:00.000Z`,
        nome: "Cena di quartiere",
      },
      id: "nuovo",
      ordinataQui: true,
    });

    expect(testo()).toContain(
      "Questo gruppo continua «Cena di quartiere». La casa che lo gestiva non risponde dal 3 marzo. L'ha traslocato Bruno il 5 aprile.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Apri il gruppo di prima" }));
    expect(onApri).toHaveBeenCalledWith("vecchio");
  });
});
