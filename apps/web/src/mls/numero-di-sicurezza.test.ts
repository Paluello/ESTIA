/**
 * Il numero di sicurezza, provato per ciò che deve garantire
 * ([ADR 0050](../../../../docs/adr/0050-il-numero-di-sicurezza.md)).
 *
 * Tre gruppi di prove, e ognuno blocca una cosa diversa:
 *
 * 1. **Il nucleo è quello di Signal**, non una sua imitazione: gli ingressi di
 *    libsignal danno l'uscita di libsignal.
 * 2. **La formula di ESTIA non si muove**: vettori fissi, ricalcolati a parte
 *    con un'implementazione indipendente (Python, `hashlib`). Se uno di questi
 *    cambia, ogni verifica già fatta sul campo smette di valere — non è un test
 *    da aggiornare, è una versione nuova della formula.
 * 3. **Le proprietà per cui il confronto vuol dire qualcosa**: uguale dai due
 *    lati, diverso se cambia una chiave, diverso al nuovo dispositivo.
 */
import { describe, expect, it } from "vitest";

import {
  chiaveLogica,
  cifreDi,
  improntaDi,
  improntaSignal,
  inGruppi,
  numeroDiSicurezza,
  type Parte,
} from "./numero-di-sicurezza.js";

const daHex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const te = new TextEncoder();

/** Tre chiavi finte della forma di una P-256 non compressa: 65 byte, `04` in testa. */
const K1 = daHex(
  "04262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8df",
);
const K2 = daHex(
  "04454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe",
);
const K3 = daHex(
  "04646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d",
);

const anna: Parte = { chiavi: [K1], membro: { casa: "casa-aia", username: "anna" } };
const bruno: Parte = { chiavi: [K2], membro: { casa: "casa-borgo", username: "bruno" } };

describe("il nucleo è il safety number di Signal", () => {
  // `fingerprint_test_v1` in libsignal, rust/protocol/src/fingerprint.rs
  // (`testVectorsVersion1` in Java): chiavi, identificativi, 5200 giri.
  const ALICE = daHex("0506863bc66d02b40d27b8d49ca7c09e9239236f9d7d25d6fcca5ce13c7064d868");
  const BOB = daHex("05f781b6fb32fed9ba1cf2de978d4d5da28dc34046ae814402b5c0dbd96fda907b");

  it("dà l'impronta di libsignal per gli ingressi di libsignal", () => {
    const alice = improntaSignal(te.encode("+14152222222"), ALICE, 5200);
    const bob = improntaSignal(te.encode("+14153333333"), BOB, 5200);

    // I primi 32 byte, come stanno nel fingerprint «scannable» del vettore.
    expect(Buffer.from(alice.slice(0, 32)).toString("hex")).toBe(
      "1e301a0353dce3dbe7684cb8336e85136cdc0ee96219494ada305d62a7bd61df",
    );
    expect(Buffer.from(bob.slice(0, 32)).toString("hex")).toBe(
      "d62cbf73a11592015b6b9f1682ac306fea3aaf3885b84d12bca631e9d4fb3a4d",
    );
  });

  it("dà le sessanta cifre di libsignal, le due metà in ordine crescente", () => {
    const alice = cifreDi(improntaSignal(te.encode("+14152222222"), ALICE, 5200));
    const bob = cifreDi(improntaSignal(te.encode("+14153333333"), BOB, 5200));

    expect(alice < bob ? alice + bob : bob + alice).toBe(
      "300354477692869396892869876765458257569162576843440918079131",
    );
  });
});

describe("i vettori di ESTIA", () => {
  it("la metà di una persona con un dispositivo", () => {
    expect(improntaDi(anna)).toBe("733486787863755005672156483565");
    expect(improntaDi(bruno)).toBe("788743789105236207587007469612");
  });

  it("il numero della coppia", () => {
    expect(numeroDiSicurezza(anna, bruno)).toBe(
      "733486787863755005672156483565788743789105236207587007469612",
    );
  });

  it("la metà di una persona con due dispositivi", () => {
    expect(improntaDi({ ...anna, chiavi: [K1, K3] })).toBe("704316109781076991684436900175");
  });

  it("la stessa chiave in un'altra casa è un'altra persona", () => {
    // `anna` di Aia e `anna` di Borgo con la stessa chiave non sono la stessa
    // identità (ADR 0042 §0), e il numero lo deve dire.
    expect(improntaDi({ chiavi: [K1], membro: { casa: "casa-borgo", username: "anna" } })).toBe(
      "383548449629179640041237109353",
    );
  });

  it("l'insieme delle chiavi ha una forma sola: quante, e ciascuna con la sua lunghezza", () => {
    const logica = chiaveLogica([K3, K1]);

    expect(logica.length).toBe(2 + (2 + 65) * 2);
    expect([...logica.slice(0, 4)]).toEqual([0, 2, 0, 65]);
    // K1 viene prima di K3 in ordine di byte, qualunque sia l'ordine d'arrivo.
    expect([...logica.slice(4, 69)]).toEqual([...K1]);
    expect([...logica.slice(69, 71)]).toEqual([0, 65]);
    expect([...logica.slice(71)]).toEqual([...K3]);
  });
});

describe("le proprietà per cui confrontarlo vuol dire qualcosa", () => {
  it("è lo stesso dai due lati", () => {
    // Anna lo calcola come (io = anna, altro = bruno), Bruno al contrario, su
    // due macchine: se non coincidesse non ci sarebbe niente da confrontare.
    expect(numeroDiSicurezza(anna, bruno)).toBe(numeroDiSicurezza(bruno, anna));
  });

  it("sono sessanta cifre, in dodici gruppi da cinque, zeri compresi", () => {
    const numero = numeroDiSicurezza(anna, bruno);

    expect(numero).toMatch(/^\d{60}$/);
    expect(inGruppi(numero)).toHaveLength(12);
    expect(inGruppi(numero).every((gruppo) => /^\d{5}$/.test(gruppo))).toBe(true);
    // Un gruppo che vale meno di 10 000 tiene i suoi zeri davanti.
    expect(cifreDi(new Uint8Array(64))).toBe("0".repeat(30));
  });

  it("cambia se l'istanza sostituisce la chiave di una persona", () => {
    // È S4 §3: chi tiene il registro mette una chiave sua al posto di quella di
    // Anna. Bruno calcola su quella, Anna sulla propria: i numeri non coincidono.
    const vistaDaBruno = numeroDiSicurezza(bruno, { ...anna, chiavi: [K3] });
    const vistaDaAnna = numeroDiSicurezza(anna, bruno);

    expect(vistaDaBruno).not.toBe(vistaDaAnna);
  });

  it("cambia se l'istanza AGGIUNGE una chiave a una persona, mostrandola solo all'altra", () => {
    const vistaDaBruno = numeroDiSicurezza(bruno, { ...anna, chiavi: [K1, K3] });
    const vistaDaAnna = numeroDiSicurezza(anna, bruno);

    expect(vistaDaBruno).not.toBe(vistaDaAnna);
  });

  it("cambia quando una persona aggiunge un dispositivo, e cambia soltanto la sua metà", () => {
    const prima = numeroDiSicurezza(anna, bruno);
    const annaConDue: Parte = { ...anna, chiavi: [K1, K3] };
    const dopo = numeroDiSicurezza(annaConDue, bruno);

    expect(dopo).not.toBe(prima);
    expect(improntaDi(annaConDue)).not.toBe(improntaDi(anna));
    // La metà di Bruno è rimasta dov'era: è ciò che permette di dire «è
    // cambiata Anna» e non «è cambiato qualcosa».
    expect(dopo).toContain(improntaDi(bruno));
  });

  it("non dipende dall'ordine in cui il registro elenca le chiavi", () => {
    expect(improntaDi({ ...anna, chiavi: [K3, K1] })).toBe(
      improntaDi({ ...anna, chiavi: [K1, K3] }),
    );
  });

  it("non cambia se il registro ripete la stessa chiave", () => {
    // Il registro ha una riga per sessione, e due sessioni dello stesso
    // browser portano la stessa chiave di firma: non è un dispositivo in più.
    expect(improntaDi({ ...anna, chiavi: [K1, K1] })).toBe(improntaDi(anna));
    expect(improntaDi({ ...anna, chiavi: [K3, K1, K3] })).toBe(
      improntaDi({ ...anna, chiavi: [K1, K3] }),
    );
  });

  it("non dà un numero a chi non ha chiavi", () => {
    expect(() => improntaDi({ ...anna, chiavi: [] })).toThrow();
  });
});
