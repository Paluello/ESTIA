// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  impostaLingua,
  impostaLinguaDellaCasa,
  linguaCorrente,
  linguaDellaCasa,
  t,
  tc,
} from "./lingua.js";

afterEach(() => {
  impostaLingua(undefined);
  impostaLinguaDellaCasa("it");
});

describe("la lingua dell'interfaccia (ADR 0046)", () => {
  it("parte da quella della Casa", () => {
    expect(linguaCorrente()).toBe(linguaDellaCasa());
  });

  it("segue la scelta, e la scrive sulla radice per il lettore di schermo", () => {
    impostaLingua("en");

    expect(linguaCorrente()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(t("aspetto.lingua.gruppo")).toBe("Language");
  });

  it("torna a quella della Casa senza scelta, o con una lingua che non c'è", () => {
    impostaLingua("en");
    impostaLingua("xx");

    expect(linguaCorrente()).toBe(linguaDellaCasa());
  });

  it("chi non ha scelto legge la lingua che l'istanza dichiara", () => {
    impostaLinguaDellaCasa("en");

    expect(linguaDellaCasa()).toBe("en");
    expect(linguaCorrente()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("la scelta della persona vince su quella della Casa (verifica 4)", () => {
    impostaLingua("en");
    impostaLinguaDellaCasa("it");

    expect(linguaCorrente()).toBe("en");
    expect(t("app.irraggiungibile.titolo")).toBe("Instance unreachable");
  });

  it("una lingua della Casa che il client non conosce lascia l'inglese", () => {
    impostaLinguaDellaCasa("xx");

    expect(linguaDellaCasa()).toBe("en");
    expect(linguaCorrente()).toBe("en");
  });

  it("mette un pezzo d'interfaccia al posto del segnaposto, nell'ordine della frase", () => {
    impostaLingua("it");
    render(<p>{tc("aspetto.lingua.casa.nota", { lingua: <strong>Italiano</strong> })}</p>);

    expect(screen.getByText("Italiano").tagName).toBe("STRONG");
    expect(screen.getByText("Italiano").parentElement?.textContent).toBe(
      "Italiano, scelta quando questa istanza è stata installata.",
    );
  });
});
