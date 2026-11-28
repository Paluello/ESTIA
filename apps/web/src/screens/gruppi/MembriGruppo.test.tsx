// @vitest-environment jsdom
/**
 * Le persone di un gruppo come le vede chi lo usa: che cosa gli si offre, e
 * **che cosa gli si dice** prima dei tre gesti che cambiano chi legge.
 *
 * Le frasi sono la cosa provata. Un gruppo cifrato che dicesse «non potrà più
 * leggere» di chi viene tolto direbbe una cosa falsa — quello che ha già letto
 * l'ha letto — e nessun typecheck se ne accorgerebbe.
 */
import type { ConversazioneView } from "@estia/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { impostaLingua } from "../../lingua.js";
import { MembriGruppo, type GestiDelGruppo } from "./MembriGruppo.js";

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

const GRUPPO = {
  createdAt: "2026-11-27T10:00:00.000Z",
  id: "g1",
  membri: [
    { displayName: "Anna", id: "u-anna", username: "anna" },
    { displayName: "Bruno", id: "u-bruno", username: "bruno" },
    { displayName: "Carla", id: "u-carla", username: "carla" },
  ],
  nome: "Orto",
  nonLetti: 0,
  ordinataQui: true,
  ruoli: { "u-anna": "creatore", "u-bruno": "amministratore", "u-carla": "membro" },
  tipo: "gruppo",
} as unknown as ConversazioneView;

function pannello(
  ioId: string,
  opzioni: { assenti?: string[]; iniziale?: "elenco" | "conferma-esci" } = {},
): GestiDelGruppo {
  const gesti: GestiDelGruppo = {
    aggiungi: vi.fn(() => Promise.resolve()),
    cambiaRuolo: vi.fn(() => Promise.resolve()),
    esci: vi.fn(() => Promise.resolve()),
    faiEntrare: vi.fn(() => Promise.resolve()),
    togli: vi.fn(() => Promise.resolve()),
  };

  render(
    <MembriGruppo
      aperto
      assenti={new Set(opzioni.assenti ?? [])}
      casa="casa"
      conversazione={GRUPPO}
      gesti={gesti}
      iniziale={opzioni.iniziale ?? "elenco"}
      ioId={ioId}
      onChiudi={() => undefined}
    />,
  );

  return gesti;
}

describe("le persone di un gruppo", () => {
  it("togliere dice che cosa succede davvero, e non promette quello che non può", async () => {
    const gesti = pannello("u-anna");

    fireEvent.click(screen.getByRole("button", { name: /Carla/u }));
    fireEvent.click(screen.getByRole("button", { name: "Togli dal gruppo" }));

    const testo = document.body.textContent ?? "";
    expect(testo).toContain("Carla non riceverà più i messaggi nuovi di questo gruppo");
    expect(testo).toContain("togliere una persona non le toglie ciò che ha già visto");
    expect(testo).not.toMatch(/non potrà più leggere/iu);
    expect(gesti.togli).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Togli" }));
    await waitFor(() => expect(gesti.togli).toHaveBeenCalledWith(GRUPPO.membri[2]));
  });

  it("si può cambiare idea: Annulla sta accanto a Togli, e non toglie nessuno", () => {
    const gesti = pannello("u-anna");

    fireEvent.click(screen.getByRole("button", { name: /Carla/u }));
    fireEvent.click(screen.getByRole("button", { name: "Togli dal gruppo" }));
    fireEvent.click(screen.getByRole("button", { name: "Annulla" }));

    expect(gesti.togli).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Togli dal gruppo" })).toBeTruthy();
  });

  it("a chi non amministra non si offre né di aggiungere né di togliere, ma di uscire sì", () => {
    pannello("u-carla");

    expect(screen.queryByRole("button", { name: "Aggiungi una persona" })).toBeNull();
    // Le righe degli altri non sono pulsanti: non c'è niente che possa farci.
    expect(screen.queryByRole("button", { name: /Bruno/u })).toBeNull();
    expect(screen.getByRole("button", { name: "Esci dal gruppo" })).toBeTruthy();
  });

  it("un amministratore toglie, ma gli incarichi li dà solo chi ha creato il gruppo", () => {
    pannello("u-bruno");

    fireEvent.click(screen.getByRole("button", { name: /Carla/u }));

    expect(screen.getByRole("button", { name: "Togli dal gruppo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Nomina amministratore" })).toBeNull();
    // E il creatore non si tocca: la sua riga non si apre.
    fireEvent.click(screen.getByRole("button", { name: "Indietro" }));
    expect(screen.queryByRole("button", { name: /Anna/u })).toBeNull();
  });

  it("chi non è ancora dentro si vede, e chi amministra lo fa entrare sapendo che leggerà il passato", async () => {
    const gesti = pannello("u-anna", { assenti: ["u-carla"] });

    expect(document.body.textContent).toContain("Non è ancora dentro: per ora non legge niente");

    fireEvent.click(screen.getByRole("button", { name: /Carla/u }));
    expect(document.body.textContent).toContain("leggerà anche quello che è già stato scritto");

    fireEvent.click(screen.getByRole("button", { name: "Fai entrare nel gruppo" }));
    await waitFor(() => expect(gesti.faiEntrare).toHaveBeenCalledWith(GRUPPO.membri[2]));
  });

  it("uscire dice che non si riceveranno più i messaggi nuovi, e chiede conferma", async () => {
    const gesti = pannello("u-carla", { iniziale: "conferma-esci" });

    expect(document.body.textContent).toContain("Non riceverai più i messaggi nuovi");
    expect(gesti.esci).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Esci" }));
    await waitFor(() => expect(gesti.esci).toHaveBeenCalled());
  });
});
