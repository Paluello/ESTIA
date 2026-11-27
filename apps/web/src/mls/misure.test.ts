/**
 * Le misure di M8 Fase 3 («Le misure che nessuno ha fatto»), che qui diventano
 * soglie.
 *
 * 1. **Quanto pesano `GroupInfo` e Welcome su un gruppo vero.** Il metodo è
 *    quello di [S5](../../../../docs/spike/S5-quanto-pesa-un-albero.md): un
 *    gruppo cresciuto una foglia alla volta con i moduli veri di `gruppo.ts`,
 *    misurato in **caratteri Base64**, perché è in caratteri che i tetti si
 *    applicano. S5 lo aveva fatto una volta e a mano; qui ogni esecuzione lo
 *    rifà, e se un aggiornamento di `ts-mls` gonfia l'albero lo si vede prima del
 *    campo. S5 non confrontava il `GroupInfo` con `MAX_GROUP_INFO_CHARS` e non
 *    guardava il tetto di lettura di una richiesta federata: lo fa questo file.
 * 2. **Quanto costa `validateCredential`.** Quante volte la chiama `ts-mls` e
 *    quante volte, di conseguenza, si chiede il registro, su cinquanta foglie.
 *
 * Il tempo non si misura in soglia: su una macchina carica diventerebbe un test
 * instabile. Si contano le cose, che non dipendono dalla macchina.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MAX_GROUP_INFO_CHARS } from "@estia/contracts";
import type * as TsMls from "ts-mls";
import type { ClientConfig } from "ts-mls/clientConfig.js";

import {
  MAX_BUSTA_BYTES,
  MAX_REQUEST_BYTES,
  MAX_REQUEST_BYTES_CON_BUSTA,
} from "../../../core-api/src/federation/protocol.js";

// `validateCredential` la chiama `ts-mls`, non noi: per contarne le chiamate si
// avvolge l'`authService` della configurazione al confine con la libreria.
// Il registro (`chiaviDiFirmaDi`) si conta invece sulla `Porta`, più sotto.
const chiamate = vi.hoisted(() => ({ validazioni: 0 }));

vi.mock("ts-mls", async (importOriginal) => {
  const vera = await importOriginal<typeof TsMls>();

  const contata = (config: ClientConfig): ClientConfig => {
    const originale = config.authService;

    return {
      ...config,
      authService: {
        validateCredential: (...argomenti) => {
          chiamate.validazioni += 1;

          return originale.validateCredential(...argomenti);
        },
      },
    };
  };

  return {
    ...vera,
    createCommit: ((...a: Parameters<typeof vera.createCommit>) => {
      const copia = [...a] as Parameters<typeof vera.createCommit>;
      const stato = copia[0].state;
      copia[0] = { ...copia[0], state: { ...stato, clientConfig: contata(stato.clientConfig) } };

      return vera.createCommit(...copia);
    }) as typeof vera.createCommit,
    joinGroup: ((...a: Parameters<typeof vera.joinGroup>) => {
      const copia = [...a] as Parameters<typeof vera.joinGroup>;
      const config = copia[7];
      if (config !== undefined) {
        copia[7] = contata(config);
      }

      return vera.joinGroup(...copia);
    }) as typeof vera.joinGroup,
    processMessage: ((...a: Parameters<typeof vera.processMessage>) => {
      const copia = [...a] as Parameters<typeof vera.processMessage>;
      const stato = copia[1];
      copia[1] = { ...stato, clientConfig: contata(stato.clientConfig) };

      return vera.processMessage(...copia);
    }) as typeof vera.processMessage,
  };
});

import {
  aggiungi,
  applicaHandshake,
  creaConversazione,
  entraDaWelcome,
  nuovaIdentita,
  puntoDiRientro,
  type IdentitaDispositivo,
  type Membro,
  type Porta,
} from "./gruppo.js";

const CASA = "casa-di-prova";
const chi = (username: string): Membro => ({ casa: CASA, username });

/** Caratteri della stringa Base64: l'unità in cui si applicano i tetti. */
const b64 = (bytes: Uint8Array): number => Buffer.from(bytes).toString("base64").length;

/** Il registro con le domande contate, come quello di `gruppo.test.ts`. */
function registroCheConta(): Porta & {
  ammetti: (membro: Membro, identita: IdentitaDispositivo) => void;
  domande: () => number;
  perPersona: () => Map<string, number>;
} {
  const chiavi = new Map<string, Uint8Array[]>();
  const conteggio = new Map<string, number>();
  let domande = 0;
  const nome = (m: Membro): string => `${m.username}@${m.casa}`;

  return {
    ammetti(membro, identita) {
      chiavi.set(nome(membro), [
        ...(chiavi.get(nome(membro)) ?? []),
        identita.publicPackage.leafNode.signaturePublicKey,
      ]);
    },
    chiaviDiFirmaDi(membro) {
      domande += 1;
      conteggio.set(nome(membro), (conteggio.get(nome(membro)) ?? 0) + 1);

      return Promise.resolve(chiavi.get(nome(membro)) ?? []);
    },
    domande: () => domande,
    perPersona: () => conteggio,
  };
}

const TAPPE = [2, 10, 25, 50] as const;
const FOGLIE = 50;

interface Misura {
  foglie: number;
  welcome: number;
  commit: number;
  groupInfo: number;
}

interface Costo {
  /** Chiamate a `validateCredential`. */
  validazioni: number;
  /** Domande al registro. */
  domande: number;
  /** Il massimo di domande per una stessa persona. */
  massimoPerPersona: number;
  persone: number;
}

describe("quanto pesa un albero, sul gruppo vero (S5, rifatto)", () => {
  const misure: Misura[] = [];

  // Un solo gruppo cresciuto, condiviso: cinquanta commit sono il costo del test.
  const scena: {
    porta?: ReturnType<typeof registroCheConta>;
    nuovo?: IdentitaDispositivo;
    welcomeUltimo?: Uint8Array;
    commitUltimo?: Uint8Array;
    penultimo?: { identita: IdentitaDispositivo; welcome: Uint8Array };
    statoCreatore?: Awaited<ReturnType<typeof creaConversazione>>;
  } = {};

  beforeAll(async () => {
    const porta = registroCheConta();
    const creatore = await nuovaIdentita(chi("m0"));
    porta.ammetti(chi("m0"), creatore);

    let stato = await creaConversazione("conv-misure", creatore, porta);

    for (let foglie = 2; foglie <= FOGLIE; foglie += 1) {
      const identita = await nuovaIdentita(chi(`m${String(foglie - 1)}`));
      porta.ammetti(chi(`m${String(foglie - 1)}`), identita);

      const esito = await aggiungi(stato, identita.publicPackage, porta);
      stato = esito.stato;

      if (foglie === FOGLIE - 1) {
        scena.penultimo = { identita, welcome: esito.welcome };
      }
      if (foglie === FOGLIE) {
        scena.nuovo = identita;
        scena.welcomeUltimo = esito.welcome;
        scena.commitUltimo = esito.commit;
      }
      if ((TAPPE as readonly number[]).includes(foglie)) {
        misure.push({
          commit: b64(esito.commit),
          foglie,
          groupInfo: b64(await puntoDiRientro(stato)),
          welcome: b64(esito.welcome),
        });
      }
    }

    scena.porta = porta;
    scena.statoCreatore = stato;
  }, 120_000);

  const tappa = (foglie: number): Misura => {
    const m = misure.find((x) => x.foglie === foglie);
    if (m === undefined) {
      throw new Error(`manca la tappa ${String(foglie)}`);
    }

    return m;
  };

  it("misura le quattro tappe", () => {
    expect(misure.map((m) => m.foglie)).toEqual([...TAPPE]);
    console.info(`MISURE (caratteri base64): ${JSON.stringify(misure)}`);
  });

  it("il Welcome cresce in modo lineare, ~369 caratteri base64 per foglia", () => {
    const prima = tappa(2);
    const ultima = tappa(50);

    // S5: ~349 caratteri base64 per foglia; oggi 368,8 (la credenziale porta la casa).
    const pendenza = (ultima.welcome - prima.welcome) / (ultima.foglie - prima.foglie);
    console.info(`PENDENZA Welcome: ${pendenza.toFixed(1)} caratteri b64 per foglia`);
    expect(pendenza).toBeGreaterThan(340);
    expect(pendenza).toBeLessThan(400);

    // Lineare: i punti intermedi stanno vicini alla retta fra gli estremi.
    for (const m of misure) {
      const attesa = prima.welcome + pendenza * (m.foglie - prima.foglie);
      expect(Math.abs(m.welcome - attesa) / attesa).toBeLessThan(0.05);
    }
  });

  it("a cinquanta foglie Welcome e GroupInfo pesano ~19 mila caratteri", () => {
    const m = tappa(50);

    // S5 (2026-08-28): Welcome 17 932, GroupInfo 17 792. Oggi, misurati qui:
    // 18 956 e 18 816, circa il 6% in più, perché dopo S5 la credenziale porta
    // anche la casa (ADR 0042 §0, `<username>@<casa>`) e ogni foglia pesa di
    // più. Le firme ECDSA sono DER e variano di qualche byte da una generazione
    // all'altra: una banda e non il numero esatto.
    expect(m.welcome).toBeGreaterThan(18_500);
    expect(m.welcome).toBeLessThan(19_400);
    expect(m.groupInfo).toBeGreaterThan(18_400);
    expect(m.groupInfo).toBeLessThan(19_300);
  });

  it("il commit non cresce con l'albero", () => {
    for (const m of misure) {
      expect(m.commit).toBeGreaterThan(600);
      expect(m.commit).toBeLessThan(900);
    }
  });

  it("il GroupInfo sta sotto MAX_GROUP_INFO_CHARS con margine di 10x a ogni tappa", () => {
    for (const m of misure) {
      expect(m.groupInfo).toBeLessThan(MAX_GROUP_INFO_CHARS / 10);
    }
  });

  it("il Welcome sta sotto il tetto di una busta federata con margine di 3x", () => {
    for (const m of misure) {
      expect(m.welcome * 3).toBeLessThan(MAX_BUSTA_BYTES);
    }
  });

  it("il tetto di lettura della richiesta è la busta più il controllo, e il Welcome ci sta", () => {
    // Derivato, non scelto (protocol.ts).
    expect(MAX_REQUEST_BYTES_CON_BUSTA).toBe(MAX_BUSTA_BYTES + MAX_REQUEST_BYTES);

    const m = tappa(50);
    expect(m.welcome + MAX_REQUEST_BYTES).toBeLessThan(MAX_REQUEST_BYTES_CON_BUSTA);
    // Il tetto di controllo da solo non basta: è la ragione per cui esiste.
    expect(m.welcome).toBeGreaterThan(MAX_REQUEST_BYTES);
  });

  it("il primo tetto, estrapolando la pendenza, sta fra 150 e 250 foglie", () => {
    const prima = tappa(2);
    const ultima = tappa(50);
    const pendenza = (ultima.welcome - prima.welcome) / (ultima.foglie - prima.foglie);
    const foglieAlTetto = prima.foglie + (MAX_BUSTA_BYTES - prima.welcome) / pendenza;
    console.info(`FOGLIE al tetto della busta: ${foglieAlTetto.toFixed(0)}`);

    expect(foglieAlTetto).toBeGreaterThan(150);
    expect(foglieAlTetto).toBeLessThan(250);
  });

  describe("quanto costa validateCredential su cinquanta foglie", () => {
    async function misura(nome: string, azione: () => Promise<unknown>): Promise<Costo> {
      const porta = scena.porta;
      if (porta === undefined) {
        throw new Error("scena mancante");
      }
      const v0 = chiamate.validazioni;
      const d0 = porta.domande();
      const prima = new Map(porta.perPersona());
      await azione();

      let massimo = 0;
      let persone = 0;
      for (const [chiave, n] of porta.perPersona()) {
        const delta = n - (prima.get(chiave) ?? 0);
        if (delta > 0) {
          persone += 1;
        }
        massimo = Math.max(massimo, delta);
      }
      const costo = {
        domande: porta.domande() - d0,
        massimoPerPersona: massimo,
        persone,
        validazioni: chiamate.validazioni - v0,
      };
      console.info(`COSTO ${nome}: ${JSON.stringify(costo)}`);

      return costo;
    }

    it("chi entra dal Welcome: una domanda per persona, non per chiamata", async () => {
      const { nuovo, welcomeUltimo, porta } = scena;
      if (nuovo === undefined || welcomeUltimo === undefined || porta === undefined) {
        throw new Error("scena mancante");
      }

      const costo = await misura("entra a 50 foglie", () =>
        entraDaWelcome(welcomeUltimo, nuovo, porta),
      );

      expect(costo.validazioni).toBeGreaterThanOrEqual(FOGLIE);
      expect(costo.massimoPerPersona).toBe(1);
      expect(costo.domande).toBe(costo.persone);
      expect(costo.domande).toBeLessThanOrEqual(FOGLIE);
    });

    it("chi applica il commit che aggiunge la cinquantesima foglia", async () => {
      const { penultimo, commitUltimo, porta } = scena;
      if (penultimo === undefined || commitUltimo === undefined || porta === undefined) {
        throw new Error("scena mancante");
      }
      const stato = await entraDaWelcome(penultimo.welcome, penultimo.identita, porta);

      const costo = await misura("applica commit a 50 foglie", () =>
        applicaHandshake(stato, commitUltimo, porta),
      );

      expect(costo.massimoPerPersona).toBe(1);
      expect(costo.domande).toBe(costo.persone);
      expect(costo.domande).toBeLessThanOrEqual(FOGLIE);
    });

    it("venticinque persone con due dispositivi: venticinque domande, non cinquanta", async () => {
      // ADR 0040: una foglia è un dispositivo. Cinquanta foglie di venticinque
      // persone sono la stessa tabella, e il registro si chiede per persona.
      const porta = registroCheConta();
      const prime = await nuovaIdentita(chi("p0"));
      porta.ammetti(chi("p0"), prime);
      let stato = await creaConversazione("conv-doppi", prime, porta);

      let ultima: { identita: IdentitaDispositivo; welcome: Uint8Array } | undefined;
      for (let foglia = 1; foglia < FOGLIE; foglia += 1) {
        const persona = chi(`p${String(foglia % 25)}`);
        const identita = await nuovaIdentita(persona);
        porta.ammetti(persona, identita);
        const esito = await aggiungi(stato, identita.publicPackage, porta);
        stato = esito.stato;
        ultima = { identita, welcome: esito.welcome };
      }
      if (ultima === undefined) {
        throw new Error("gruppo non costruito");
      }

      const prima = porta.domande();
      const v0 = chiamate.validazioni;
      await entraDaWelcome(ultima.welcome, ultima.identita, porta);
      console.info(
        `COSTO 25 persone x 2 dispositivi: ${JSON.stringify({
          domande: porta.domande() - prima,
          validazioni: chiamate.validazioni - v0,
        })}`,
      );

      expect(chiamate.validazioni - v0).toBeGreaterThanOrEqual(FOGLIE);
      expect(porta.domande() - prima).toBe(25);
      expect([...porta.perPersona().values()].length).toBe(25);
    });

    it("chi fa entrare la cinquantunesima foglia", async () => {
      const { statoCreatore, porta } = scena;
      if (statoCreatore === undefined || porta === undefined) {
        throw new Error("scena mancante");
      }
      const extra = await nuovaIdentita(chi("m50"));
      porta.ammetti(chi("m50"), extra);

      const costo = await misura("aggiunge la 51a foglia", () =>
        aggiungi(statoCreatore, extra.publicPackage, porta),
      );

      expect(costo.massimoPerPersona).toBe(1);
      expect(costo.domande).toBe(costo.persone);
      expect(costo.domande).toBeLessThanOrEqual(FOGLIE + 1);
    });
  });
});
