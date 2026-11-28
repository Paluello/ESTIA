import {
  casaViewSchema,
  chiaviDiFirmaViewSchema,
  keyPackageMlsViewSchema,
  keyPackagesMlsViewSchema,
  mieiKeyPackagesRequestSchema,
  type MieiKeyPackagesRequest,
  dispositiviResponseSchema,
  ingressoEmessoViewSchema,
  sfidaViewSchema,
  type SfidaView,
  type IngressoEmessoView,
  keyBackupViewSchema,
  publishKeyPackagesRequestSchema,
  registerDeviceKeyRequestSchema,
  registerDeviceKeyResponseSchema,
  saveKeyBackupRequestSchema,
  type CasaView,
  type ChiaviDiFirmaView,
  type KeyPackageMlsView,
  type KeyPackagesMlsView,
  type DeviceKeyView,
  type DispositiviResponse,
  type KeyBackupView,
  type PublishKeyPackagesRequest,
  type RegisterDeviceKeyRequest,
  type RegisterDeviceKeyResponse,
  type SaveKeyBackupRequest,
} from "@estia/contracts";
import type { FastifyInstance } from "fastify";

import { DomainError } from "../errors.js";
import { requireAuth } from "../identity/auth.js";
import type { IdentityService } from "../identity/service.js";
import type { FederationService } from "../federation/service.js";
import type { AccessoDispositivi } from "./accesso.js";
import type { DispositiviService } from "./service.js";

import { DISPOSITIVI_MAX_PER_PRELIEVO } from "./repository.js";
import { ALGORITMO_MLS } from "./service.js";

function nessunDispositivoMls(): DomainError {
  return new DomainError("no_device_available", 404);
}

export function registerDispositiviRoutes(
  app: FastifyInstance,
  services: {
    dispositivi: DispositiviService;
    identity: IdentityService;
    /** La chiave di questa casa (ADR 0042 §0), nota anche a rete spenta. */
    casa: string;
    federation?: FederationService | undefined;
    /** L'accesso del Dispositivo (ADR 0044 §5). Assente, la rotta del QR non esiste. */
    accesso?: AccessoDispositivi | undefined;
    /** La chiave di rete della Casa adesso, e il ticket dove la scoperta non c'è. */
    rete?: () => { chiave: string; ticket?: string } | undefined;
  },
): void {
  const asMember = requireAuth(services.identity);

  /**
   * Un codice d'ingresso per un'app nuova, e il QR che lo porta (ADR 0044 §5).
   *
   * Lo chiede un membro già dentro — dal browser in casa o da un'app già
   * ammessa — e vale per lui: l'app che lo presenta diventa un suo
   * dispositivo. Entrare nella Casa non è entrare nelle conversazioni: quello
   * resta il sì di ADR 0040.
   */
  const accesso = services.accesso;
  const rete = services.rete;

  if (accesso !== undefined && rete !== undefined) {
    app.post<{ Reply: IngressoEmessoView }>(
      "/api/v1/dispositivi/ingressi",
      {
        preHandler: asMember,
        // Un codice è 128 bit di caso e scade in dieci minuti: il limite serve
        // a non riempire la tabella, non a difendere il codice.
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: { response: { 200: ingressoEmessoViewSchema } },
      },
      async (request) => {
        const casa = rete();

        if (casa === undefined) {
          throw new DomainError("rete_spenta", 409);
        }

        return accesso.emetti(request.caller!.user.id, casa);
      },
    );
  }

  /**
   * Una sfida per la prova di possesso della chiave (ADR 0040): la firma chi
   * ripresenta una chiave già approvata, cioè chi rientra con la frase segreta.
   */
  app.post<{ Reply: SfidaView }>(
    "/api/v1/dispositivi/sfida",
    {
      preHandler: asMember,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { response: { 200: sfidaViewSchema } },
    },
    async (request) => services.dispositivi.sfida(request.caller!.sessionId),
  );

  /** Registra la chiave pubblica del dispositivo per la sessione attiva. */
  app.post<{
    Body: RegisterDeviceKeyRequest;
    Reply: RegisterDeviceKeyResponse;
  }>(
    "/api/v1/dispositivi/chiave",
    {
      preHandler: asMember,
      schema: {
        body: registerDeviceKeyRequestSchema,
        response: {
          200: registerDeviceKeyResponseSchema,
        },
      },
    },
    async (request) => {
      const caller = request.caller!;
      const device = services.dispositivi.registerKey(
        caller.user.id,
        caller.sessionId,
        request.body,
      );
      return { device };
    },
  );

  /** Restituisce la chiave del dispositivo per la sessione corrente. */
  app.get<{
    Reply: { device: DeviceKeyView | null };
  }>(
    "/api/v1/dispositivi/chiave/me",
    {
      preHandler: asMember,
    },
    async (request) => {
      const caller = request.caller!;
      const device = services.dispositivi.getCurrentDevice(caller.sessionId) ?? null;
      return { device };
    },
  );

  /**
   * I dispositivi di chi chiede, **quelli in attesa compresi**.
   *
   * E' da qui che una richiesta di autorizzazione si vede
   * ([ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)).
   * Porta la chiave pubblica perche' il codice da confrontare lo calcola il
   * client: e' l'unico modo perche' quel confronto voglia dire qualcosa.
   */
  app.get<{ Reply: DispositiviResponse }>(
    "/api/v1/dispositivi",
    {
      preHandler: asMember,
      schema: { response: { 200: dispositiviResponseSchema } },
    },
    async (request) => ({
      dispositivi: services.dispositivi.listUserDevices(request.caller!.user.id),
    }),
  );

  /** Dice di si' a un dispositivo che aspetta. Solo un dispositivo approvato puo'. */
  app.post<{ Params: { deviceId: string }; Reply: RegisterDeviceKeyResponse }>(
    "/api/v1/dispositivi/:deviceId/approva",
    {
      preHandler: asMember,
      schema: {
        params: {
          type: "object",
          required: ["deviceId"],
          properties: { deviceId: { type: "string" } },
        },
        response: { 200: registerDeviceKeyResponseSchema },
      },
    },
    async (request) => {
      const caller = request.caller!;
      return {
        device: services.dispositivi.approva(
          caller.user.id,
          caller.sessionId,
          request.params.deviceId,
        ),
      };
    },
  );

  /**
   * Dice di no, e lo dice fino in fondo: il dispositivo perde la chiave **e** la
   * sessione. Un «no» che lo lasciasse collegato sarebbe una domanda che
   * ricompare, e chi la rivede la terza volta la accetta per farla smettere.
   */
  app.post<{ Params: { deviceId: string }; Reply: { ok: true } }>(
    "/api/v1/dispositivi/:deviceId/rifiuta",
    {
      preHandler: asMember,
      schema: {
        params: {
          type: "object",
          required: ["deviceId"],
          properties: { deviceId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["ok"],
            properties: { ok: { type: "boolean", const: true } },
          },
        },
      },
    },
    async (request) => {
      const caller = request.caller!;
      const { sessionId } = services.dispositivi.rifiuta(
        caller.user.id,
        caller.sessionId,
        request.params.deviceId,
      );
      services.identity.revokeSession(caller.user.id, sessionId);
      return { ok: true };
    },
  );

  /** Pubblica un lotto di KeyPackage monouso per il dispositivo della sessione attiva. */
  app.post<{
    Body: PublishKeyPackagesRequest;
    Reply: { count: number };
  }>(
    "/api/v1/dispositivi/key-packages",
    {
      preHandler: asMember,
      schema: {
        body: publishKeyPackagesRequestSchema,
        response: {
          200: {
            type: "object",
            required: ["count"],
            properties: { count: { type: "integer" } },
          },
        },
      },
    },
    async (request) => {
      const caller = request.caller!;
      return services.dispositivi.publishKeyPackages(
        caller.user.id,
        caller.sessionId,
        request.body,
      );
    },
  );

  /**
   * I KeyPackage di altri dispositivi propri, per chiave di firma: con questi
   * un dispositivo già approvato fa entrare nelle conversazioni quello appena
   * approvato ([ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)).
   */
  app.post<{ Body: MieiKeyPackagesRequest; Reply: KeyPackagesMlsView }>(
    "/api/v1/dispositivi/miei/key-packages",
    {
      preHandler: asMember,
      // Uno per conversazione aperta: largo, ma non senza fondo.
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        body: mieiKeyPackagesRequestSchema,
        response: { 200: keyPackagesMlsViewSchema },
      },
    },
    async (request) => {
      const caller = request.caller!;
      return {
        keyPackages: services.dispositivi.claimMieiKeyPackages(
          caller.user.id,
          caller.sessionId,
          request.body.chiaviDiFirma,
        ),
      };
    },
  );

  /**
   * Le chiavi di firma che l'istanza riconosce per un membro.
   *
   * E' il registro su cui poggia l'`AuthenticationService` di MLS
   * ([ADR 0038](../../../../docs/adr/0038-mls-si-adotta-e-si-comincia-dal-web.md)):
   * lo spike [S4](../../../../docs/spike/S4-autenticare-chi-entra.md) ha
   * misurato che senza, chiunque ottenga un `GroupInfo` entra come chi vuole.
   *
   * Porta le chiavi e nient'altro, e non le revocate.
   */
  /**
   * La chiave di questa casa, che ogni credenziale MLS porta con sé
   * ([ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §0).
   *
   * Si risponde anche a rete spenta, ed è il motivo per cui la chiave si deriva
   * invece di leggerla dal socket: una credenziale che cambiasse il giorno in
   * cui si accende la rete vorrebbe dire rifare tutti gli alberi.
   */
  app.get<{ Reply: CasaView }>(
    "/api/v1/mls/casa",
    { preHandler: asMember, schema: { response: { 200: casaViewSchema } } },
    async () => ({ casa: services.casa }),
  );

  /**
   * Il prelievo, per casa: dalla propria il database, dalle altre la domanda
   * `chiavi`. Distingue «non ha un dispositivo MLS» (404) da «la sua casa non
   * risponde» (503): la prima cosa si risolve quando quella persona apre ESTIA,
   * la seconda quando la sua casa si riaccende.
   */
  const preleva = async (
    casa: string,
    username: string,
    chiede: string,
    tutti: boolean,
  ): Promise<KeyPackageMlsView[]> => {
    if (casa === services.casa) {
      const presi = tutti
        ? services.dispositivi.claimKeyPackagesPerNome(username)
        : [services.dispositivi.claimKeyPackagePerNome(username)].filter(
            (p): p is KeyPackageMlsView => p !== null,
          );
      if (presi.length === 0) {
        throw nessunDispositivoMls();
      }

      return presi;
    }

    if (services.federation === undefined) {
      throw new DomainError("rete_non_attiva", 503);
    }

    const esito = await services.federation.fetchChiavi(
      casa,
      { nome: username, prova: "prova-chiavi" },
      { algoritmo: ALGORITMO_MLS, da: chiede, destinatario: username, ...(tutti ? { tutti } : {}) },
    );

    if (esito.esito === "irraggiungibile") {
      throw new DomainError("istanza_non_raggiungibile", 503);
    }

    // Una casa che risponde più del chiesto non ne fa entrare di più.
    const presi = (esito.esito === "chiavi" ? esito.packages : [])
      .slice(0, tutti ? DISPOSITIVI_MAX_PER_PRELIEVO : 1)
      .map((p) => ({ deviceId: p.id, keyPackage: p.blob }));
    if (presi.length === 0) {
      throw nessunDispositivoMls();
    }

    return presi;
  };

  const paramsDelPrelievo = {
    type: "object",
    required: ["casa", "username"],
    properties: { casa: { type: "string" }, username: { type: "string" } },
  } as const;

  /**
   * Preleva un `KeyPackage` **MLS** di un membro, di qualunque casa: uno solo,
   * del suo dispositivo più recente con scorta. Resta per chi non sa ancora
   * delle foglie per dispositivo; il prelievo per persona è quello sotto.
   */
  app.get<{ Params: { casa: string; username: string }; Reply: KeyPackageMlsView }>(
    "/api/v1/mls/key-package/:casa/:username",
    {
      preHandler: asMember,
      // Ogni prelievo consuma un KeyPackage di qualcun altro: senza tetto, un
      // membro solo svuoterebbe la scorta di tutti.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { params: paramsDelPrelievo, response: { 200: keyPackageMlsViewSchema } },
    },
    async (request) => {
      const { casa, username } = request.params;
      const [primo] = await preleva(casa, username, request.caller!.user.username, false);

      return primo!;
    },
  );

  /**
   * Un `KeyPackage` **MLS** per ciascun dispositivo di un membro, di qualunque
   * casa: è così che una persona entra in una conversazione con il telefono e
   * con il PC insieme ([ADR 0040](../../../../docs/adr/0040-un-membro-ha-piu-di-un-dispositivo.md)).
   */
  app.get<{ Params: { casa: string; username: string }; Reply: KeyPackagesMlsView }>(
    "/api/v1/mls/key-packages/:casa/:username",
    {
      preHandler: asMember,
      // Consuma fino a dieci KeyPackage altrui per volta: il tetto è più
      // stretto di quello del prelievo singolo.
      config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
      schema: { params: paramsDelPrelievo, response: { 200: keyPackagesMlsViewSchema } },
    },
    async (request) => {
      const { casa, username } = request.params;

      return {
        keyPackages: await preleva(casa, username, request.caller!.user.username, true),
      };
    },
  );

  /**
   * Il registro delle chiavi di firma di un membro, **di qualunque casa**.
   *
   * È la regola di instradamento di [ADR 0042](../../../../docs/adr/0042-come-mls-attraversa.md) §0,
   * messa dove il client la può usare senza conoscere la rete: casa mia →
   * registro locale; casa d'altri → la domanda `chiavi-di-firma` a quella casa.
   *
   * **Una casa che non risponde non è un membro senza chiavi**, e le due cose
   * non si confondono qui: la prima è un 503 che dice di riprovare, la seconda
   * un elenco vuoto. Chi valida un albero deve poterle distinguere, o
   * rifiuterebbe qualcuno perché il suo NAS dorme.
   */
  app.get<{ Params: { casa: string; username: string }; Reply: ChiaviDiFirmaView }>(
    "/api/v1/mls/chiavi/:casa/:username",
    {
      preHandler: asMember,
      schema: {
        params: {
          type: "object",
          required: ["casa", "username"],
          properties: { casa: { type: "string" }, username: { type: "string" } },
        },
        response: { 200: chiaviDiFirmaViewSchema },
      },
    },
    async (request) => {
      const { casa, username } = request.params;

      if (casa === services.casa) {
        return services.dispositivi.chiaviDiFirmaDi(username);
      }

      if (services.federation === undefined) {
        throw new DomainError("rete_non_attiva", 503);
      }

      const esito = await services.federation.fetchChiaviDiFirma(casa, username);

      if (esito.esito === "irraggiungibile") {
        throw new DomainError("istanza_non_raggiungibile", 503);
      }

      return { chiavi: esito.esito === "chiavi" ? esito.chiavi : [] };
    },
  );

  app.get<{ Params: { username: string }; Reply: ChiaviDiFirmaView }>(
    "/api/v1/dispositivi/di/:username/chiavi",
    {
      preHandler: asMember,
      schema: {
        params: {
          type: "object",
          required: ["username"],
          properties: { username: { type: "string" } },
        },
        response: { 200: chiaviDiFirmaViewSchema },
      },
    },
    async (request) => services.dispositivi.chiaviDiFirmaDi(request.params.username),
  );

  /** Salva o aggiorna il backup cifrato delle chiavi personali. */
  app.put<{
    Body: SaveKeyBackupRequest;
    Reply: KeyBackupView;
  }>(
    "/api/v1/dispositivi/backup",
    {
      preHandler: asMember,
      schema: {
        body: saveKeyBackupRequestSchema,
        response: {
          200: keyBackupViewSchema,
        },
      },
    },
    async (request) => {
      const caller = request.caller!;
      return services.dispositivi.saveBackup(caller.user.id, request.body);
    },
  );

  /** Recupera il backup cifrato delle chiavi personali. */
  app.get<{
    Reply: KeyBackupView;
  }>(
    "/api/v1/dispositivi/backup",
    {
      preHandler: asMember,
      schema: {
        response: {
          200: keyBackupViewSchema,
        },
      },
    },
    async (request) => {
      const caller = request.caller!;
      const backup = services.dispositivi.getBackup(caller.user.id);
      if (!backup) {
        throw new DomainError("backup_not_found", 404);
      }
      return backup;
    },
  );
}
