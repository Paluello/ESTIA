/**
 * La sonda dello spike S6: che cosa la WebView sa fare, misurato dove gira.
 *
 * Usa il codice MLS del client web così com'è (`apps/web/src/mls`), con la
 * ciphersuite di ADR 0038 §5. Se qui qualcosa fallisce, fallisce l'ipotesi
 * «ts-mls nella WebView», non una sua imitazione.
 */
import { invoke } from "@tauri-apps/api/core";
import { decodeGroupState, encodeGroupState, type GroupState } from "ts-mls/clientState.js";

import {
  configurazione,
  cifra,
  creaConversazione,
  decifra,
  entraDaWelcome,
  aggiungi,
  leggiKeyPackage,
  type Porta,
} from "../../../../apps/web/src/mls/gruppo.ts";
import {
  esisteIdentita,
  preparaDispositivo,
  ripristinaDaPassphrase,
  salvaSottoPassphrase,
  type Anagrafe,
} from "../../../../apps/web/src/mls/dispositivo.ts";
import { cassettoInMemoria, cassettoTauri, deserializza, inTauri, serializza } from "./cassetto.ts";

export interface Voce {
  nome: string;
  esito: "ok" | "no" | "info";
  dettaglio: string;
  ms?: number;
}

export interface Risultato {
  quando: string;
  inTauri: boolean;
  voci: Voce[];
  riuscite: number;
  fallite: number;
}

const CASA = "c".repeat(64);

function daB64(s: string): Uint8Array<ArrayBuffer> {
  const g = atob(s);
  const o = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) o[i] = g.charCodeAt(i);
  return o;
}

const esadecimale = (b: Uint8Array, n = 8): string =>
  Array.from(b.slice(0, n), (x) => x.toString(16).padStart(2, "0")).join("");

/** Un'anagrafe finta, in memoria: tiene le chiavi di firma e i KeyPackage come l'istanza. */
function anagrafeFinta(
  username: string,
  registro: Map<string, Uint8Array[]>,
  scorte: Map<string, string[]>,
) {
  let backup: { encryptedBlob: string; salt: string; iterations: number } | undefined;
  const anagrafe: Anagrafe = {
    registra({ publicKey }) {
      const chiavi = registro.get(username) ?? [];
      chiavi.push(daB64(publicKey));
      registro.set(username, chiavi);
      return Promise.resolve({ deviceId: `${username}-1` });
    },
    pubblica(kp) {
      scorte.set(username, [...(scorte.get(username) ?? []), ...kp]);
      return Promise.resolve();
    },
    leggiBackup: () => Promise.resolve(backup),
    salvaBackup(b) {
      backup = b;
      return Promise.resolve();
    },
  };
  return anagrafe;
}

export async function sonda(avanza: (testo: string) => void): Promise<Risultato> {
  const voci: Voce[] = [];
  const segna = (v: Voce): void => {
    voci.push(v);
    avanza(`${v.nome}…`);
  };
  async function passo<T>(
    nome: string,
    f: () => Promise<T>,
    dettaglio: (x: T) => string,
  ): Promise<T | undefined> {
    const t = performance.now();
    try {
      const x = await f();
      segna({ nome, esito: "ok", dettaglio: dettaglio(x), ms: Math.round(performance.now() - t) });
      return x;
    } catch (e) {
      segna({
        nome,
        esito: "no",
        dettaglio: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        ms: Math.round(performance.now() - t),
      });
      return undefined;
    }
  }

  // ── 1. L'ambiente della WebView ──────────────────────────────────────────
  segna({ nome: "Motore", esito: "info", dettaglio: navigator.userAgent });
  segna({ nome: "Origine", esito: "info", dettaglio: location.origin });
  segna({
    nome: "Contesto sicuro",
    esito: globalThis.isSecureContext ? "ok" : "no",
    dettaglio: `isSecureContext = ${String(globalThis.isSecureContext)}`,
  });
  segna({
    nome: "crypto.subtle",
    esito: globalThis.crypto?.subtle !== undefined ? "ok" : "no",
    dettaglio:
      globalThis.crypto?.subtle !== undefined ? "presente" : "ASSENTE: ts-mls non può funzionare",
  });

  // La CSP dell'app è quella dell'istanza: WebAssembly deve essere bloccato.
  // È il controllo negativo di S1, che rende valido il resto.
  try {
    await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    // Non è un fallimento da solo: WebKitGTK 2.52 non applica `script-src` a
    // WebAssembly. Che la CSP sia viva lo dice il controllo su `eval` qui sotto.
    segna({
      nome: "CSP su WebAssembly",
      esito: "info",
      dettaglio: "WebAssembly compila: questo motore non applica la CSP a WebAssembly",
    });
  } catch (e) {
    segna({
      nome: "CSP su WebAssembly",
      esito: "info",
      dettaglio: `bloccato (${e instanceof Error ? e.name : String(e)})`,
    });
  }

  // Il secondo controllo negativo: `eval` è vietato da `script-src 'self'` in
  // ogni motore. Se passa, la CSP non c'è; se WebAssembly passa e `eval` no, la
  // CSP c'è e il motore non la applica a WebAssembly.
  try {
    new Function("return 1")();
    segna({
      nome: "CSP viva (eval bloccato)",
      esito: "no",
      dettaglio: "new Function eseguita: la CSP non è applicata",
    });
  } catch (e) {
    segna({
      nome: "CSP viva (eval bloccato)",
      esito: "ok",
      dettaglio: e instanceof Error ? e.name : String(e),
    });
  }

  if (inTauri()) {
    await passo(
      "Lato nativo",
      () => invoke<Record<string, unknown>>("ambiente_nativo"),
      (x) => JSON.stringify(x),
    );
  }

  // ── 2. Le primitive WebCrypto che la ciphersuite usa ────────────────────
  const s = globalThis.crypto?.subtle;
  if (s !== undefined) {
    await passo(
      "ECDH P-256 (il KEM di HPKE)",
      async () => {
        const a = await s.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
        const b = await s.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
        return new Uint8Array(
          await s.deriveBits({ name: "ECDH", public: b.publicKey }, a.privateKey, 256),
        );
      },
      (x) => `${x.length} byte condivisi`,
    );
    await passo(
      "PBKDF2 600 000 iterazioni (backup sotto passphrase)",
      async () => {
        const base = await s.importKey("raw", new TextEncoder().encode("prova"), "PBKDF2", false, [
          "deriveBits",
        ]);
        return s.deriveBits(
          { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(16), iterations: 600000 },
          base,
          256,
        );
      },
      () => "derivata",
    );
  }

  // ── 3. MLS con il codice del client web ─────────────────────────────────
  const registro = new Map<string, Uint8Array[]>();
  const scorte = new Map<string, string[]>();
  const porta: Porta = {
    chiaviDiFirmaDi: (m) => Promise.resolve(registro.get(m.username) ?? []),
  };

  const cassettoAnna = inTauri() ? cassettoTauri("cassetto/") : cassettoInMemoria();
  const cassettoBruno = cassettoInMemoria();

  const precedente = inTauri()
    ? ((await cassettoAnna.leggi("sonda_ultima")) as { quando: string; firma: string } | undefined)
    : undefined;
  const identitaDiPrima = await esisteIdentita(cassettoAnna);
  segna({
    nome: "Identità MLS da un avvio precedente",
    esito: "info",
    dettaglio: precedente
      ? `sì: avvio del ${precedente.quando}, chiave di firma ${precedente.firma}…`
      : identitaDiPrima
        ? "sì, senza segno dell'avvio"
        : "no: primo avvio (o app reinstallata)",
  });

  const ctxAnna = {
    anagrafe: anagrafeFinta("anna", registro, scorte),
    cassetto: cassettoAnna,
    casa: CASA,
  };
  const ctxBruno = {
    anagrafe: anagrafeFinta("bruno", registro, scorte),
    cassetto: cassettoBruno,
    casa: CASA,
  };

  const anna = await passo(
    "Anna: preparaDispositivo (identità + 10 KeyPackage)",
    () => preparaDispositivo(ctxAnna, "anna"),
    (d) => d.deviceId,
  );
  const bruno = await passo(
    "Bruno: preparaDispositivo",
    () => preparaDispositivo(ctxBruno, "bruno"),
    (d) => d.deviceId,
  );

  const firmaAnna = registro.get("anna")?.at(-1);
  if (precedente && firmaAnna) {
    const stessa = precedente.firma === esadecimale(firmaAnna);
    segna({
      nome: "La chiave di firma è sopravvissuta al riavvio",
      esito: stessa ? "ok" : "no",
      dettaglio: stessa
        ? "stessa chiave dalla cassaforte"
        : "chiave diversa: il cassetto non ha tenuto",
    });
  }

  if (anna && bruno) {
    const kpBruno = leggiKeyPackage(daB64(scorte.get("bruno")![0]!));
    const statoA = await passo(
      "Anna crea la conversazione",
      async () => creaConversazione("conv-1", await anna.portachiavi.perNuovaFoglia(), porta),
      () => "epoch 0",
    );
    const add =
      statoA && kpBruno
        ? await passo(
            "Anna aggiunge Bruno (Commit + Welcome)",
            () => aggiungi(statoA, kpBruno, porta),
            (x) => `Welcome ${x.welcome.length} byte, epoch ${x.epoch}`,
          )
        : undefined;
    const idB = add ? await bruno.portachiavi.perWelcome(add.welcome) : undefined;
    const statoB =
      add && idB
        ? await passo(
            "Bruno entra dal Welcome",
            () => entraDaWelcome(add.welcome, idB, porta),
            () => "dentro",
          )
        : undefined;

    if (add && statoB) {
      const m1 = await passo(
        "Anna cifra",
        () => cifra(add.stato, "ciao Bruno"),
        (x) => `${x.busta.length} byte`,
      );
      const l1 = m1
        ? await passo(
            "Bruno decifra",
            () => decifra(statoB, m1.busta, porta),
            (x) => (x.kind === "messaggio" ? `"${x.testo}"` : x.kind),
          )
        : undefined;
      if (m1 && l1 && l1.kind === "messaggio") {
        const m2 = await passo(
          "Bruno risponde",
          () => cifra(l1.stato, "ciao Anna"),
          (x) => `${x.busta.length} byte`,
        );

        // Lo stato del gruppo di Anna fa il giro della cassaforte, come in
        // sessione.ts, e il messaggio di Bruno si legge con lo stato riaperto.
        const riaperto = await passo(
          "Lo stato del gruppo passa dalla cassaforte e torna",
          async () => {
            await cassettoAnna.scrivi("stato/conv-1", encodeGroupState(m1.stato));
            const letto = (await cassettoAnna.leggi("stato/conv-1")) as Uint8Array;
            const decodificato = decodeGroupState(letto, 0);
            if (decodificato === undefined) throw new Error("stato non decodificabile");
            return { ...(decodificato[0] as GroupState), clientConfig: configurazione(porta) };
          },
          () => "decodificato",
        );
        if (m2 && riaperto) {
          await passo(
            "Anna legge la risposta con lo stato riaperto",
            () => decifra(riaperto, m2.busta, porta),
            (x) => (x.kind === "messaggio" ? `"${x.testo}"` : x.kind),
          );
        }
      }
    }

    await passo(
      "Backup sotto passphrase (PBKDF2 + AES-GCM)",
      () => salvaSottoPassphrase(ctxAnna, "una frase lunga di prova"),
      () => "salvato",
    );
    await passo(
      "Ripristino dal backup su un dispositivo vuoto",
      async () => {
        const vuoto = cassettoInMemoria();
        await ripristinaDaPassphrase({ ...ctxAnna, cassetto: vuoto }, "una frase lunga di prova");
        return esisteIdentita(vuoto);
      },
      (x) => (x ? "identità ripristinata" : "vuoto"),
    );

    if (inTauri()) {
      await passo(
        "Sul disco il materiale è sigillato",
        async () => {
          const g = await cassettoTauri("cassetto/").grezzo("materiale_mls");
          if (g === null) throw new Error("nessun file");
          if (g.includes(esadecimale(new TextEncoder().encode('{"v"'), 4)))
            throw new Error("il file comincia in chiaro");
          return g;
        },
        (g) => g,
      );
      if (firmaAnna) {
        await cassettoAnna.scrivi("sonda_ultima", {
          quando: new Date().toISOString(),
          firma: esadecimale(firmaAnna),
        });
      }
    }
  }

  // La forma JSON del cassetto deve ricostruire i byte esatti.
  const prova = { a: new Uint8Array([0, 255, 7]), b: 12n };
  const tornata = deserializza(serializza(prova)) as typeof prova;
  segna({
    nome: "Serializzazione del cassetto",
    esito:
      tornata.a instanceof Uint8Array && tornata.a[1] === 255 && tornata.b === 12n ? "ok" : "no",
    dettaglio: "Uint8Array e bigint attraversano il JSON",
  });

  const fallite = voci.filter((v) => v.esito === "no").length;
  return {
    quando: new Date().toISOString(),
    inTauri: inTauri(),
    voci,
    riuscite: voci.filter((v) => v.esito === "ok").length,
    fallite,
  };
}
