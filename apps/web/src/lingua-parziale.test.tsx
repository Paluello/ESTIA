// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type * as Lingua from "./lingua.js";
import type * as Schermata from "./screens/Login.js";
import type * as Stato from "./state.js";
import type { AppState } from "./state.js";

// Verifica 5 di ADR 0046: una lingua che traduce una frase sola. Qui l'italiano
// della tabella è sostituito da un file di prova con dentro soltanto «Entra».
vi.mock("../../../packages/lingue/dist/frasi/it.json", () => ({
  default: { "lingua.nome": "Italiano", "accesso.entra": "Entra" },
}));

const STATO: AppState = {
  instance: {
    lingua: "it",
    memberCount: 3,
    name: "Casa Rossi",
    publicKey: "chiave",
    state: "configured",
  },
  modo: "istanza",
  refreshInstance: async () => {},
  refreshUser: async () => {},
  setModo: () => {},
  signIn: () => {},
  signOut: () => {},
  token: undefined,
  user: undefined,
};

// La preparazione dei test ha già letto la tabella vera: la si rilegge da capo,
// con il file di prova al posto dell'italiano.
let lingua: typeof Lingua;
let Login: typeof Schermata.Login;
let AppProvider: typeof Stato.AppProvider;

beforeAll(async () => {
  vi.resetModules();
  lingua = await import("./lingua.js");
  ({ Login } = await import("./screens/Login.js"));
  ({ AppProvider } = await import("./state.js"));
  lingua.impostaLinguaDellaCasa("it");
});

afterEach(() => {
  cleanup();
});

describe("una lingua parziale (ADR 0046 §7)", () => {
  it("la frase tradotta si legge tradotta, le altre in inglese", () => {
    expect(lingua.linguaCorrente()).toBe("it");
    expect(lingua.t("accesso.entra")).toBe("Entra");
    expect(lingua.t("comune.nome_utente")).toBe("Username");
  });

  it("nessuna schermata mostra una chiave", () => {
    render(
      <MemoryRouter>
        <AppProvider value={STATO}>
          <Login />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Entra" })).toBeTruthy();
    expect(screen.getByLabelText("Username")).toBeTruthy();
    // Una chiave è fatta di parole minuscole separate da punti: `accesso.entra`.
    expect(document.body.textContent).not.toMatch(/\b[a-z_]+\.[a-z_]+(\.[a-z_]+)*\b/);
  });
});
