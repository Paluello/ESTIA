// @vitest-environment jsdom
import { DEFAULT_UI_PREFERENCES, type AvvisoView, type UserRole } from "@estia/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { impostaLingua } from "../lingua.js";
import { AppProvider, type AppState } from "../state.js";
import { AvvisoIstanza } from "./AvvisoIstanza.js";

const X = "a".repeat(64);

function stato(role: UserRole): AppState {
  return {
    instance: {
      lingua: "it",
      memberCount: 3,
      name: "Via Roma",
      publicKey: "k",
      state: "configured",
    },
    modo: "istanza",
    refreshInstance: async () => {},
    refreshUser: async () => {},
    setModo: () => {},
    signIn: () => {},
    signOut: () => {},
    token: "t",
    user: {
      appearance: DEFAULT_UI_PREFERENCES,
      displayName: "Anna",
      id: "u",
      role,
      username: "anna",
    },
  };
}

function mostra(avviso: AvvisoView, role: UserRole = "member"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Promise.resolve(new Response(JSON.stringify(avviso), { status: 200 }))),
  );

  render(
    <MemoryRouter>
      <AppProvider value={stato(role)}>
        <AvvisoIstanza instanceKey={X} nomeIstanza="Le Vele" />
      </AppProvider>
    </MemoryRouter>,
  );
}

const VUOTO: AvvisoView = {
  ignorate: false,
  interpellate: 3,
  istanza: X,
  nonAutentica: [],
  nonGradita: [],
  replica: { stato: "non_disponibile" },
  senzaRisposta: 0,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  impostaLingua(undefined);
});

/**
 * La forma dell'avviso, che è tutta la sua neutralità ([ADR 0047], «Che cosa
 * l'interfaccia non deve dire»).
 */
describe("l'avviso su un'istanza", () => {
  it("conta le istanze, separa le categorie, mette la replica accanto e dice chi manca", async () => {
    mostra({
      ...VUOTO,
      nonAutentica: [
        { motivi: [{ mese: "2026-10", motivo: "bot" }], tramite: "Sampierdarena" },
        { motivi: [{ mese: "2026-11", motivo: "account finti" }], tramite: "Vanchiglia" },
      ],
      nonGradita: [{ motivi: [{ mese: "2026-11", motivo: "insulti" }], tramite: "Lingotto" }],
      replica: { mese: "2026-11", stato: "disponibile", testo: "Siamo persone vere." },
      senzaRisposta: 1,
    });

    expect(
      await screen.findByText(
        "Segnalata come non autentica da persone di 2 istanze, tramite Sampierdarena, Vanchiglia",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Non gradita a persone di 1 istanza, tramite Lingotto")).toBeTruthy();
    expect(screen.getByText("La replica di Le Vele")).toBeTruthy();
    expect(screen.getByText("Siamo persone vere.")).toBeTruthy();
    expect(
      screen.getByText("1 istanza collegata non ha risposto: questo avviso può essere incompleto."),
    ).toBeTruthy();
    // Nessun allarme: un avviso non è un verdetto.
    expect(document.querySelector("[role=alert]")).toBeNull();
  });

  it("dice che la replica non è disponibile, invece di tacerla", async () => {
    mostra({
      ...VUOTO,
      nonGradita: [{ motivi: [{ mese: "2026-11", motivo: "insulti" }], tramite: "Lingotto" }],
    });

    expect(
      await screen.findByText(
        "Replica non disponibile: la tua casa non è collegata a questa istanza, o non ha risposto.",
      ),
    ).toBeTruthy();
  });

  it("ignorate dall'admin: lo dice ai membri, e non mostra niente altro", async () => {
    mostra({ ...VUOTO, ignorate: true, interpellate: 0 });

    expect(
      await screen.findByText(
        "Chi amministra la tua casa ha scelto di non mostrare le segnalazioni su questa istanza.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Decidi per la tua casa" })).toBeNull();
  });

  it("chi amministra può decidere, un membro no", async () => {
    mostra(VUOTO, "instance_admin");

    expect(await screen.findByRole("button", { name: "Decidi per la tua casa" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Segnala questa istanza" })).toBeTruthy();
  });
});
