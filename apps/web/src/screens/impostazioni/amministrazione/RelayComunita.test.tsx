// @vitest-environment jsdom
import type { CommunityRelaysView } from "@estia/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { api } from "../../../api.js";
import { impostaLinguaDellaCasa } from "../../../lingua.js";

import { RelayComunita } from "./RelayComunita.js";

/**
 * ADR 0045 §«Che cosa vede chi»: il nome di chi gestisce il relay va detto
 * all'amministratore **prima** che adotti, e senza quel nome non si adotta.
 */

const VUOTA: CommunityRelaysView = {
  attivi: true,
  massimo: 8,
  relays: [],
  ripiegoSuN0: false,
  suggeriti: [],
  portaAperta: { viaRelay: false },
};

beforeAll(() => {
  impostaLinguaDellaCasa("it");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RelayComunita", () => {
  it("non adotta senza il nome di chi gestisce, e lo nomina prima di adottare", async () => {
    vi.spyOn(api, "communityRelays").mockResolvedValue(VUOTA);
    const adotta = vi.spyOn(api, "adoptCommunityRelay").mockResolvedValue({
      ...VUOTA,
      relays: [
        {
          adottatoIl: "2026-11-28T00:00:00.000Z",
          gestore: "Luca",
          url: "https://relay.circolo.example/",
        },
      ],
    });

    render(<RelayComunita token="t" />);
    fireEvent.change(await screen.findByLabelText("Indirizzo del relay"), {
      target: { value: "https://relay.circolo.example/" },
    });

    const pulsante = screen.getByRole("button", { name: "Adotta" });
    expect(pulsante).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("Chi lo gestisce"), { target: { value: "Luca" } });
    expect(screen.getByText(/Luca potrà vedere quali Case parlano con la tua/)).toBeTruthy();
    expect(pulsante).toHaveProperty("disabled", false);

    fireEvent.click(pulsante);
    expect(await screen.findByText("Gestito da Luca · da controllare")).toBeTruthy();
    expect(adotta).toHaveBeenCalledWith("t", {
      gestore: "Luca",
      url: "https://relay.circolo.example/",
    });
  });

  it("dice quando la Casa è tornata su n0 perché nessun adottato risponde", async () => {
    vi.spyOn(api, "communityRelays").mockResolvedValue({
      ...VUOTA,
      inUso: "https://euc1-1.relay.n0.iroh.link./",
      relays: [
        {
          adottatoIl: "2026-11-28T00:00:00.000Z",
          gestore: "Luca",
          risponde: false,
          url: "https://relay.circolo.example/",
        },
      ],
      ripiegoSuN0: true,
    });

    render(<RelayComunita token="t" />);
    expect(await screen.findByText(/Nessuno dei relay adottati risponde/)).toBeTruthy();
    expect(screen.getByText("Gestito da Luca · non risponde")).toBeTruthy();
  });

  it("mostra il relay suggerito da una Casa collegata, e lo adotta solo con un gesto", async () => {
    vi.spyOn(api, "communityRelays").mockResolvedValue({
      ...VUOTA,
      suggeriti: [
        { casa: "Casa di Marco", gestore: "Luca", url: "https://relay.circolo.example/" },
      ],
    });
    const adotta = vi.spyOn(api, "adoptCommunityRelay").mockResolvedValue(VUOTA);

    render(<RelayComunita token="t" />);
    expect(await screen.findByText(/Casa di Marco usa questo relay/)).toBeTruthy();
    expect(screen.getByText(/Luca potrà vedere quali Case parlano con la tua/)).toBeTruthy();
    expect(adotta).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Adotta il relay di Luca" }));
    expect(await screen.findByText(/Relay adottato/)).toBeTruthy();
    expect(adotta).toHaveBeenCalledWith("t", {
      gestore: "Luca",
      url: "https://relay.circolo.example/",
    });
  });

  it("offre la porta aperta solo se una Casa passa dal relay, e dice quale porta", async () => {
    vi.spyOn(api, "communityRelays").mockResolvedValue(VUOTA);
    render(<RelayComunita token="t" />);
    expect(await screen.findByText(/Nessun relay adottato/)).toBeTruthy();
    expect(screen.queryByText("La porta aperta, se vuoi")).toBeNull();
    cleanup();

    vi.spyOn(api, "communityRelays").mockResolvedValue({
      ...VUOTA,
      portaAperta: { inUso: true, porta: 41641, viaRelay: true },
    });
    render(<RelayComunita token="t" />);
    expect(await screen.findByText(/inoltra la porta UDP 41641/)).toBeTruthy();
    cleanup();

    vi.spyOn(api, "communityRelays").mockResolvedValue({
      ...VUOTA,
      portaAperta: { inUso: false, porta: 41641, rifiutata: "in uso", viaRelay: true },
    });
    render(<RelayComunita token="t" />);
    expect(await screen.findByText(/La porta UDP 41641 è occupata/)).toBeTruthy();
  });
});
