/**
 * Chi può aprire una conversazione con chi, da un'altra casa
 * ([ADR 0030](../../../../docs/adr/0030-chi-puo-scrivere-a-chi.md) §1), sui
 * registri veri: i follow, i profili, e lo stato del rapporto fra le case.
 *
 * Che la regola venga **chiesta** lo prova `segnaposti.test.ts`; che sia
 * collegata in `buildApp`, `due-case-mls.test.ts`. Qui c'è che cosa risponde.
 */
import { withTempDataDir } from "@estia/testing";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../db/database.js";
import type { RemoteState } from "../federation/repository.js";
import { SqliteUserRepository } from "../identity/repository.js";
import { SqliteFollowRepository } from "../profile/follows.js";
import { SqliteProfileRepository, type Presence } from "../profile/repository.js";

import { chiPuoScrivere } from "./direttorio.js";
import { casaValida, idDiVoce, indirizzoValido, istanteValido, nomeValido } from "./forma.js";
import type { ChiPuoScrivere } from "./service.js";

const ORA = "2026-11-27T10:00:00.000Z";
const BORGO = "b0".repeat(32);
const CORTE = "c0".repeat(32);

interface Scena {
  regola: ChiPuoScrivere;
  follows: SqliteFollowRepository;
  marco: { id: string; username: string };
  rapporti: Map<string, RemoteState>;
  presenza: (presence: Presence) => void;
}

async function scena(use: (s: Scena) => void): Promise<void> {
  await withTempDataDir((dataDir) => {
    const database = openDatabase(dataDir);

    try {
      const users = new SqliteUserRepository(database);
      const follows = new SqliteFollowRepository(database);
      const profiles = new SqliteProfileRepository(database);
      const rapporti = new Map<string, RemoteState>();
      const marco = { id: "id-di-marco", username: "marco" };

      users.create({
        createdAt: ORA,
        deletedAt: null,
        displayName: "Marco",
        id: marco.id,
        passwordHash: "$argon2id$finto",
        role: "member",
        username: marco.username,
      });

      use({
        follows,
        marco,
        presenza: (presence) =>
          profiles.save({
            bio: "",
            openFollows: false,
            presence,
            updatedAt: ORA,
            userId: marco.id,
          }),
        rapporti,
        regola: chiPuoScrivere({ follows, profiles, statoDi: (casa) => rapporti.get(casa) }),
      });
    } finally {
      database.close();
    }

    return Promise.resolve();
  });
}

describe("chi può aprire una conversazione con qualcuno di qui", () => {
  it("una casa mai vista no, qualunque nome dichiari e comunque sia il profilo", async () => {
    await scena(({ regola, marco, presenza }) => {
      presenza("presente_pubblico");

      expect(regola.puoAprire(BORGO, "matteo", marco)).toBe(false);
    });
  });

  it("una casa collegata sì, se la persona di qui ha scelto di esserci in rete", async () => {
    await scena(({ regola, marco, presenza, rapporti }) => {
      rapporti.set(BORGO, "collegata");

      // Senza profilo si è `non_presente`: è il default, e vale un no.
      expect(regola.puoAprire(BORGO, "matteo", marco)).toBe(false);

      presenza("non_presente");
      expect(regola.puoAprire(BORGO, "matteo", marco)).toBe(false);

      presenza("presente_privato");
      expect(regola.puoAprire(BORGO, "matteo", marco)).toBe(true);
      presenza("presente_pubblico");
      expect(regola.puoAprire(BORGO, "matteo", marco)).toBe(true);

      // Il collegamento è di Borgo, non di chiunque.
      expect(regola.puoAprire(CORTE, "matteo", marco)).toBe(false);
    });
  });

  it("una richiesta di collegamento, mandata o ricevuta, non è un collegamento", async () => {
    await scena(({ regola, marco, presenza, rapporti }) => {
      presenza("presente_pubblico");

      for (const stato of ["richiesta_inviata", "richiesta_ricevuta"] as const) {
        rapporti.set(BORGO, stato);
        expect({ puo: regola.puoAprire(BORGO, "matteo", marco), stato }).toEqual({
          puo: false,
          stato,
        });
      }
    });
  });

  it("chi Marco segue, o chi Marco ha accettato che lo segua, sì — anche da una casa non collegata, anche se Marco non è in rete", async () => {
    await scena(({ regola, follows, marco }) => {
      follows.addFollowing({
        at: ORA,
        instance: BORGO,
        state: "accettato",
        userId: marco.id,
        username: "matteo",
      });
      follows.addFollower({
        at: ORA,
        instance: CORTE,
        state: "accettato",
        userId: marco.id,
        username: "carla",
      });

      expect(regola.puoAprire(BORGO, "matteo", marco)).toBe(true);
      expect(regola.puoAprire(CORTE, "carla", marco)).toBe(true);

      // È il permesso di quella persona da quella casa, e di nessun altro:
      // un altro nome della stessa casa, o lo stesso nome da un'altra casa, no.
      expect(regola.puoAprire(BORGO, "un-altro", marco)).toBe(false);
      expect(regola.puoAprire(CORTE, "matteo", marco)).toBe(false);
    });
  });

  it("un follow ancora in attesa non basta", async () => {
    await scena(({ regola, follows, marco }) => {
      follows.addFollower({
        at: ORA,
        instance: BORGO,
        state: "in_attesa",
        userId: marco.id,
        username: "matteo",
      });
      follows.addFollowing({
        at: ORA,
        instance: BORGO,
        state: "in_attesa",
        userId: marco.id,
        username: "matteo",
      });

      expect(regola.puoAprire(BORGO, "matteo", marco)).toBe(false);
    });
  });

  it("una casa bloccata no, nemmeno con un follow accettato", async () => {
    await scena(({ regola, follows, marco, presenza, rapporti }) => {
      presenza("presente_pubblico");
      follows.addFollowing({
        at: ORA,
        instance: BORGO,
        state: "accettato",
        userId: marco.id,
        username: "matteo",
      });
      rapporti.set(BORGO, "bloccata");

      expect(regola.puoAprire(BORGO, "matteo", marco)).toBe(false);
    });
  });
});

describe("la forma dei campi che attraversano", () => {
  it("un nome è un nome utente di ESTIA", () => {
    expect(["anna", "anna.rossi", "a-b_c", "a1b"].map(nomeValido)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(
      ["", "ab", "Anna", "anna rossi", "anna@casa", ".anna", "anna\n"].map(nomeValido),
    ).toEqual([false, false, false, false, false, false, false]);
  });

  it("una casa è una chiave ed25519 in esadecimale minuscolo", () => {
    expect(casaValida(BORGO)).toBe(true);
    expect([BORGO.toUpperCase(), BORGO.slice(2), `${BORGO}00`, "casa"].map(casaValida)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("un indirizzo è nome@casa, e nient'altro", () => {
    expect(indirizzoValido(`anna@${BORGO}`)).toBe(true);
    expect(
      [`@${BORGO}`, "anna", `anna@${BORGO}@${BORGO}`, `anna @${BORGO}`].map(indirizzoValido),
    ).toEqual([false, false, false, false]);
  });

  it("un id di voce non ha spazi né segni strani, e un istante è un istante vero in UTC", () => {
    expect(["m-1", "0b7c1f0e-5a53-4c0c-9d0e-5f6f3c1a2b3c", "a.b:c_d"].map(idDiVoce)).toEqual([
      true,
      true,
      true,
    ]);
    expect(["", "m 1", "m/1", "x".repeat(121), "m\u0000"].map(idDiVoce)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(
      ["2026-11-27T10:00:00.000Z", "2026-11-27T10:00:00Z", "2024-02-29T00:00:00.000Z"].map(
        istanteValido,
      ),
    ).toEqual([true, true, true]);
    expect(
      ["2026-02-30T10:00:00.000Z", "2026-11-27", "2026-11-27T25:00:00.000Z", "adesso"].map(
        istanteValido,
      ),
    ).toEqual([false, false, false, false]);
  });
});
