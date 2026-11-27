// @vitest-environment jsdom
import type { InstancePublicView } from "@estia/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { impostaLingua } from "../lingua.js";
import { AppProvider, type AppState } from "../state.js";
import { quandoPerEsteso } from "../tempo.js";
import { Login } from "./Login.js";

const ISTANZA: InstancePublicView = {
  lingua: "it",
  memberCount: 3,
  name: "Casa Rossi",
  publicKey: "chiave",
  state: "configured",
};

const STATO: AppState = {
  instance: ISTANZA,
  modo: "istanza",
  refreshInstance: async () => {},
  refreshUser: async () => {},
  setModo: () => {},
  signIn: () => {},
  signOut: () => {},
  token: undefined,
  user: undefined,
};

function entraConLaPasswordSbagliata(): void {
  // L'istanza manda il codice; il `message` è solo la riserva (ADR 0046 §3).
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ code: "invalid_credentials", message: "riserva dell'istanza" }),
          { status: 401 },
        ),
      ),
    ),
  );

  render(
    <MemoryRouter>
      <AppProvider value={STATO}>
        <Login />
      </AppProvider>
    </MemoryRouter>,
  );

  const campo = (selettore: string): Element => document.querySelector(selettore) ?? document.body;
  fireEvent.change(campo("input[autocomplete=username]"), { target: { value: "sara" } });
  fireEvent.change(campo("input[type=password]"), { target: { value: "sbagliata" } });
  fireEvent.submit(campo("form"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  impostaLingua(undefined);
});

/**
 * Verifica 4 di ADR 0046, il caso di Sara: Marco ha installato la Casa in
 * italiano, Sara ha scelto l'inglese. Un errore provocato dal server e una
 * data si leggono nella lingua di Sara, non in quella della Casa.
 */
describe("il caso di Sara (ADR 0046)", () => {
  it("chi non ha scelto legge l'errore del server nella lingua della Casa", async () => {
    entraConLaPasswordSbagliata();

    expect(await screen.findByText("Nome utente o password non validi.")).toBeTruthy();
  });

  it("chi ha scelto l'inglese legge l'errore del server in inglese", async () => {
    impostaLingua("en");
    entraConLaPasswordSbagliata();

    expect(await screen.findByText("Username or password is not valid.")).toBeTruthy();
    expect(screen.queryByText("riserva dell'istanza")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("e così una data", () => {
    const istante = "2026-11-18T09:30:00Z";

    expect(quandoPerEsteso(istante)).toMatch(/novembre/);

    impostaLingua("en");
    expect(quandoPerEsteso(istante)).toMatch(/November/);
  });
});
