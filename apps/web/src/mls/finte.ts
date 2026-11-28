/**
 * I doppi su cui girano i test MLS: un'istanza, un deposito, un portachiavi.
 *
 * Non sono una scorciatoia, sono una **riproduzione**, e la fedeltà è il loro
 * unico scopo: il canale di handshake che ordina per arrivo e consegna un
 * Welcome soltanto al suo destinatario, il mazzo con l'epoch che non torna
 * indietro, l'archivio idempotente.
 *
 * Stanno in un file loro perché ce n'è più d'uno che li usa, e tre copie di un
 * doppio sono tre fedeltà diverse. Una l'aveva già pagata: finché l'istanza
 * finta non filtrava il destinatario, il client poteva depositare l'username al
 * posto dell'id e i test passavano lo stesso — il Welcome non sarebbe arrivato
 * a nessuno, e il difetto era nel doppio, non nel codice provato.
 *
 * Questo file non entra nel bundle: nessun modulo dell'applicazione lo importa.
 */
import {
  identitaDaChiave,
  nuovaIdentita,
  sceltaPerWelcome,
  scriviIdentita,
  type IdentitaDispositivo,
  type Membro,
  type Portachiavi,
} from "./gruppo.js";
import type { Anagrafe, Cassetto } from "./dispositivo.js";
import type {
  BustaHandshake,
  CommitInSospeso,
  Deposito,
  Istanza,
  VoceArchivio,
} from "./sessione.js";
import type { KeyPackage } from "ts-mls";

/** Una busta sul canale, destinatario compreso: la rotta vera non lo restituisce. */
export type BustaDepositata = BustaHandshake & { destinatario?: string; conversazioneId: string };

/**
 * La casa dei doppi.
 *
 * Ogni credenziale ne porta una ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §0),
 * e i test che parlano di una casa sola usano questa senza nominarla. Chi vuole
 * provare due case le nomina tutte e due, che è il punto.
 */
export const CASA = "casa-di-prova";

export interface IstanzaFinta {
  /** Registra una chiave di firma come riconosciuta per quel membro. */
  ammetti: (username: string, chiaveDiFirma: Uint8Array, casa?: string) => void;
  /** Ciò che è stato depositato, per guardarlo dai test. */
  depositati: () => readonly BustaDepositata[];
  chiamate: { salvaMazzo: number; depositaArchivio: number };
  /**
   * Dice chi è, per MLS, la persona con quell'id. Senza, un id `u-anna` è
   * `anna` della casa dei doppi: è la convenzione dei test di una casa sola.
   */
  abita: (id: string, membro: Membro) => void;
  /** Il mazzo depositato, per guardarlo dai test. */
  mazzo: (conversazioneId: string) => { mazzo: string; epoch: number } | undefined;
  /**
   * Riscrive ciò che l'istanza dichiara accanto a una voce, come farebbe una
   * casa che mente: il testo cifrato resta quello.
   */
  falsifica: (
    conversazioneId: string,
    id: string,
    campi: { mittente?: string; createdAt?: string },
  ) => void;
  /** Il punto di rientro depositato, per guardarlo dai test. */
  puntoDiRientro: (conversazioneId: string) => { groupInfo: string; epoch: number } | undefined;
  /**
   * La vista che l'istanza dà a chi legge.
   *
   * Prende un **id**, non un nome: è con l'id che l'istanza vera decide chi
   * riceve un Welcome, e passare di qui è ciò che rende quel confine visibile.
   */
  per: (idDiChiLegge: string) => Istanza;
}

/** Un'istanza in memoria che si comporta come quella vera. */
export function istanzaFinta(): IstanzaFinta {
  const chiavi = new Map<string, Uint8Array[]>();
  const handshake: BustaDepositata[] = [];
  const mazzi = new Map<string, { mazzo: string; epoch: number }>();
  const rientri = new Map<string, { groupInfo: string; epoch: number }>();
  const archivio = new Map<string, (VoceArchivio & { autoreId: string })[]>();
  const chiamate = { depositaArchivio: 0, salvaMazzo: 0 };
  const indirizzi = new Map<string, string>();
  const falsi = new Map<string, { mittente?: string; createdAt?: string }>();
  let seq = 0;

  /** `username@casa` di chi ha quell'id: è ciò che la rotta vera mette in `mittente`. */
  const indirizzoDi = (id: string): string =>
    indirizzi.get(id) ?? (id.startsWith("u-") ? `${id.slice(2)}@${CASA}` : id);
  /** L'ultima epoch in fila: un commit entra solo se è la successiva (ADR 0042 §3). */
  const ultimaEpoch = (conversazioneId: string): number =>
    handshake
      .filter((h) => h.conversazioneId === conversazioneId && h.tipo === "commit")
      .reduce((max, h) => Math.max(max, h.epoch), 0);

  return {
    ammetti(username, chiaveDiFirma, casa = CASA) {
      const chi = scriviIdentita({ casa, username });
      chiavi.set(chi, [...(chiavi.get(chi) ?? []), chiaveDiFirma]);
    },
    abita(id, membro) {
      indirizzi.set(id, scriviIdentita(membro));
    },
    chiamate,
    depositati: () => handshake,
    falsifica(conversazioneId, id, campi) {
      falsi.set(`${conversazioneId}/${id}`, campi);
    },
    mazzo: (conversazioneId) => mazzi.get(conversazioneId),
    puntoDiRientro: (conversazioneId) => rientri.get(conversazioneId),

    per: (idDiChiLegge) => ({
      // Come la rotta vera, in piccolo: le voci della conversazione dalla più
      // vecchia, tutte disponibili, e il mittente è chi le ha depositate. Le
      // case e le visite hanno le loro prove lato istanza.
      cronologia: (conversazioneId) =>
        Promise.resolve({
          nonRispondono: [],
          righe: [...(archivio.get(conversazioneId) ?? [])]
            .sort((a, b) =>
              a.createdAt === b.createdAt
                ? a.id.localeCompare(b.id)
                : a.createdAt.localeCompare(b.createdAt),
            )
            .map((v) => ({
              casa: CASA,
              createdAt: falsi.get(`${conversazioneId}/${v.id}`)?.createdAt ?? v.createdAt,
              id: v.id,
              mittente:
                falsi.get(`${conversazioneId}/${v.id}`)?.mittente ?? indirizzoDi(v.autoreId),
              stato: "disponibile" as const,
              voce: { busta: v.busta, chiaveN: v.chiaveN },
            })),
        }),

      puntoDiRientro: (conversazioneId) => Promise.resolve(rientri.get(conversazioneId)),

      // Un registro per casa, come quello vero: il nome da solo non è una
      // chiave di ricerca, e cercarlo sarebbe trovare l'omonimo dell'altra casa.
      chiaviDiFirmaDi: (membro) => Promise.resolve(chiavi.get(scriviIdentita(membro)) ?? []),

      depositaArchivio(conversazioneId, voci) {
        chiamate.depositaArchivio += 1;
        const attuali = [...(archivio.get(conversazioneId) ?? [])];
        // Come l'API: un retry deve avere stesso autore e contenuto, e un
        // conflitto annulla l'intero batch, non solo la voce contesa.
        for (const voce of voci) {
          const presente = attuali.find((v) => v.id === voce.id);
          if (presente !== undefined) {
            if (
              presente.autoreId !== idDiChiLegge ||
              presente.busta !== voce.busta ||
              presente.chiaveN !== voce.chiaveN ||
              presente.createdAt !== voce.createdAt
            ) {
              return Promise.reject(new Error("Conflitto nel deposito dell'archivio"));
            }
          } else {
            attuali.push({ ...voce, autoreId: idDiChiLegge });
          }
        }
        archivio.set(conversazioneId, attuali);
        return Promise.resolve();
      },

      depositaHandshake(conversazioneId, busta) {
        // Come la fila vera: un commit entra solo all'epoch successiva
        // all'ultima, e chi arriva secondo riceve un 409.
        if (busta.tipo === "commit" && busta.epoch !== ultimaEpoch(conversazioneId) + 1) {
          return Promise.reject(
            Object.assign(new Error("epoch_superata"), { code: "epoch_superata", status: 409 }),
          );
        }

        seq += 1;
        handshake.push({ ...busta, conversazioneId, id: String(seq) });
        return Promise.resolve();
      },
      handshakeDopo(conversazioneId, dopo) {
        // Ordine di ARRIVO, come `seq` lato istanza. E un Welcome lo vede solo
        // il suo destinatario: un commit non ne ha, e va a tutti.
        const da = dopo === undefined ? 0 : Number(dopo);
        return Promise.resolve({
          handshake: handshake.filter(
            (h) =>
              h.conversazioneId === conversazioneId &&
              Number(h.id) > da &&
              (h.destinatario === undefined || h.destinatario === idDiChiLegge),
          ),
        });
      },

      mazzo: (conversazioneId) => Promise.resolve(mazzi.get(conversazioneId)),

      salvaMazzo(conversazioneId, dati) {
        chiamate.salvaMazzo += 1;
        const attuale = mazzi.get(conversazioneId);
        // L'epoch non torna indietro, come lato istanza.
        if (attuale === undefined || attuale.epoch <= dati.epoch) {
          mazzi.set(conversazioneId, dati);
        }
        return Promise.resolve();
      },

      salvaPuntoDiRientro(conversazioneId, dati) {
        const attuale = rientri.get(conversazioneId);
        // Nemmeno questa torna indietro: un punto di rientro vecchio manderebbe
        // chi rientra verso un'epoch morta.
        if (attuale === undefined || attuale.epoch <= dati.epoch) {
          rientri.set(conversazioneId, dati);
        }
        return Promise.resolve();
      },
    }),
  };
}

export interface DepositoFinto extends Deposito {
  quanteScritture: () => number;
}

export function depositoFinto(): DepositoFinto {
  const stati = new Map<string, Uint8Array>();
  const cursori = new Map<string, string>();
  const mazzi = new Map<string, string>();
  const sospesi = new Map<string, CommitInSospeso>();
  let scritture = 0;

  return {
    leggi: (id) => Promise.resolve(stati.get(id)),
    leggiCursore: (id) => Promise.resolve(cursori.get(id)),
    leggiMazzo: (id) => Promise.resolve(mazzi.get(id)),
    leggiSospeso: (id) => Promise.resolve(sospesi.get(id)),
    quanteScritture: () => scritture,
    scrivi(id, stato) {
      scritture += 1;
      stati.set(id, stato);
      return Promise.resolve();
    },
    scriviCursore(id, cursore) {
      cursori.set(id, cursore);
      return Promise.resolve();
    },
    scriviMazzo(id, mazzo) {
      mazzi.set(id, mazzo);
      return Promise.resolve();
    },
    scriviSospeso(id, sospeso) {
      if (sospeso === undefined) {
        sospesi.delete(id);
      } else {
        sospesi.set(id, sospeso);
      }
      return Promise.resolve();
    },
    svuota() {
      stati.clear();
      cursori.clear();
      mazzi.clear();
      sospesi.clear();
      return Promise.resolve();
    },
  };
}

export interface PortachiaviFinto extends Portachiavi {
  /** La chiave di firma del dispositivo: quella che l'istanza registra. */
  chiaveDiFirma: Uint8Array;
  /** Mette in scorta un `KeyPackage` e lo restituisce, come farebbe la pubblicazione. */
  pubblica: () => Promise<KeyPackage>;
  /** Butta via la scorta, come un browser svuotato. La chiave di firma resta. */
  dimenticaLaScorta: () => void;
}

/**
 * Il portachiavi di un dispositivo: una chiave di firma, e una scorta.
 *
 * La scorta esiste perché un `KeyPackage` è monouso e l'istanza lo consuma
 * quando qualcuno lo preleva. `perNuovaFoglia` **non** attinge alla scorta: la
 * chiave che finisce nell'albero non dev'essere anche prelevabile da fuori, o
 * verrebbe usata due volte.
 */
export async function portachiaviFinto(
  username: string,
  casa: string = CASA,
): Promise<PortachiaviFinto> {
  const membro: Membro = { casa, username };
  const prima = await nuovaIdentita(membro);
  const chiavi = {
    publicKey: prima.publicPackage.leafNode.signaturePublicKey,
    signKey: prima.privatePackage.signaturePrivateKey,
  };
  let scorta: IdentitaDispositivo[] = [];

  return {
    chiaveDiFirma: chiavi.publicKey,
    dimenticaLaScorta() {
      scorta = [];
    },
    perNuovaFoglia: () => identitaDaChiave(membro, chiavi),
    perWelcome: (welcome) => sceltaPerWelcome(welcome, scorta),
    async pubblica() {
      const pacchetto = await identitaDaChiave(membro, chiavi);
      scorta.push(pacchetto);
      return pacchetto.publicPackage;
    },
  };
}

export interface CassettoFinto extends Cassetto {
  /** Che cosa c'è dentro, per guardarlo dai test. */
  quante: () => number;
}

export function cassettoFinto(): CassettoFinto {
  const roba = new Map<string, unknown>();

  return {
    leggi: (chiave) => Promise.resolve(roba.get(chiave)),
    quante: () => roba.size,
    scrivi(chiave, valore) {
      roba.set(chiave, valore);
      return Promise.resolve();
    },
    svuota() {
      roba.clear();
      return Promise.resolve();
    },
  };
}

export interface AnagrafeFinta extends Anagrafe {
  /** La riga di `device_keys` corrente, come la vedrebbe il registro. */
  registrata: () => { publicKey: string; algorithm: string } | undefined;
  /** Quanti `KeyPackage` non ancora prelevati ha il dispositivo corrente. */
  scortaDi: (deviceId: string) => number;
  /**
   * Preleva e **consuma** un `KeyPackage`, come `claimKeyPackageForUser`.
   * `undefined` quando la scorta è finita: è ciò che vede chi prova a scrivere
   * a un dispositivo senza più chiavi.
   */
  preleva: (deviceId: string) => string | undefined;
  /** Un accesso nuovo: sessione nuova, quindi riga di `device_keys` nuova. */
  nuovoAccesso: () => void;
  deviceId: () => string;
}

/**
 * L'anagrafe in memoria: `device_keys`, i `KeyPackage` e il backup.
 *
 * Riproduce le due cose che contano davvero del server: una riga di dispositivo
 * **per sessione**, e un `KeyPackage` che si consuma quando qualcuno lo preleva.
 */
export function anagrafeFinta(): AnagrafeFinta {
  const pacchetti = new Map<string, string[]>();
  let corrente = "dev-1";
  let seq = 1;
  let registrata: { publicKey: string; algorithm: string } | undefined;
  let backup:
    { encryptedBlob: string; algorithm: string; salt: string; iterations: number } | undefined;

  return {
    deviceId: () => corrente,

    leggiBackup: () =>
      Promise.resolve(
        backup === undefined
          ? undefined
          : {
              encryptedBlob: backup.encryptedBlob,
              iterations: backup.iterations,
              salt: backup.salt,
            },
      ),

    nuovoAccesso() {
      seq += 1;
      corrente = `dev-${String(seq)}`;
    },

    preleva(deviceId) {
      const suoi = pacchetti.get(deviceId) ?? [];
      return suoi.shift();
    },

    pubblica(keyPackages) {
      pacchetti.set(corrente, [...(pacchetti.get(corrente) ?? []), ...keyPackages]);
      return Promise.resolve();
    },

    registra(chiave) {
      registrata = { algorithm: chiave.algorithm, publicKey: chiave.publicKey };
      if (chiave.keyPackages !== undefined) {
        pacchetti.set(corrente, [...(pacchetti.get(corrente) ?? []), ...chiave.keyPackages]);
      }
      return Promise.resolve({ deviceId: corrente });
    },

    registrata: () => registrata,

    salvaBackup(nuovo) {
      backup = nuovo;
      return Promise.resolve();
    },

    scortaDi: (deviceId) => (pacchetti.get(deviceId) ?? []).length,
  };
}
