import { describe, expect, it } from "vitest";

import { deserializza, serializza } from "./adattatori-app.js";

describe("i byte attraversano il JSON della cassaforte", () => {
  it("Uint8Array e bigint tornano com'erano, anche annidati", () => {
    const valore = {
      chiave: new Uint8Array([0, 1, 2, 254, 255]),
      epoca: 12n,
      scorta: [new Uint8Array(70000).fill(7), { x: 1 }],
      testo: "ciao",
    };
    const ritorno = deserializza(serializza(valore)) as typeof valore;
    expect(ritorno.chiave).toEqual(valore.chiave);
    expect(ritorno.chiave).toBeInstanceOf(Uint8Array);
    expect(ritorno.epoca).toBe(12n);
    expect(ritorno.scorta[0]).toEqual(valore.scorta[0]);
    expect(ritorno.scorta[1]).toEqual({ x: 1 });
    expect(ritorno.testo).toBe("ciao");
  });

  it("un oggetto con altre chiavi accanto a $u8 non si scambia per byte", () => {
    const valore = { $u8: "AA==", altro: true };
    expect(deserializza(serializza(valore))).toEqual(valore);
  });
});
