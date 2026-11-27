import {
  avvisoViewSchema,
  creaSegnalazioneRequestSchema,
  decidiVerdettoRequestSchema,
  errorResponseSchema,
  replicaViewSchema,
  scriviReplicaRequestSchema,
  segnalazioneListSchema,
  segnalazioneViewSchema,
  verdettoListSchema,
  verdettoViewSchema,
  type AvvisoView,
  type CreaSegnalazioneRequest,
  type DecidiVerdettoRequest,
  type ReplicaView,
  type SegnalazioneView,
  type VerdettoView,
} from "@estia/contracts";
import type { FastifyInstance } from "fastify";

import { requireAuth, requireRole } from "../identity/auth.js";
import type { IdentityService } from "../identity/service.js";

import type { SegnalazioneRecord } from "./repository.js";
import type { SegnalazioniService } from "./service.js";

/**
 * Le segnalazioni, dal lato delle persone ([ADR 0047], [ADR 0049]).
 *
 * Tre cerchi, e nessuna rotta li mescola:
 *
 * - **chi segnala** scrive, rilegge e ritira le proprie;
 * - **chi modera** vede tutte quelle scritte qui, con chi le ha scritte,
 *   perché ne risponde, e scrive la replica di questa istanza;
 * - **chi amministra** decide il verdetto locale, che è l'unica cosa che si
 *   conserva di ciò che dicono le altre case.
 *
 * L'avviso su un'istanza remota lo può chiedere ogni membro: è ciò che vede
 * aprendo il profilo di qualcunə di là.
 */
export function registerSegnalazioniRoutes(
  app: FastifyInstance,
  services: {
    identity: IdentityService;
    segnalazioni: SegnalazioniService;
    /** Il nome dichiarato di un'istanza che questa casa conosce, per mostrarlo. */
    nomeDi: (publicKey: string) => string;
  },
): void {
  const asMember = requireAuth(services.identity);
  const asModeration = [asMember, requireRole("instance_admin", "instance_moderator")];
  const asAdmin = [asMember, requireRole("instance_admin")];

  const view = (record: SegnalazioneRecord, conAutore: boolean): SegnalazioneView => {
    const nomeIstanza = services.nomeDi(record.istanza);

    return {
      categoria: record.categoria,
      creataIl: record.creataIl,
      id: record.id,
      istanza: record.istanza,
      motivo: record.motivo,
      ...(nomeIstanza === "" || nomeIstanza === record.istanza ? {} : { nomeIstanza }),
      ...(conAutore ? { autore: record.autore } : {}),
    };
  };

  app.post<{ Body: CreaSegnalazioneRequest; Reply: SegnalazioneView }>(
    "/api/v1/segnalazioni",
    {
      preHandler: asMember,
      schema: {
        body: creaSegnalazioneRequestSchema,
        response: { 201: segnalazioneViewSchema, 400: errorResponseSchema },
        tags: ["segnalazioni"],
      },
    },
    async (request, reply) => {
      const record = services.segnalazioni.segnala(request.caller!.user, request.body);

      return reply.code(201).send(view(record, false));
    },
  );

  app.get<{ Reply: { segnalazioni: SegnalazioneView[] } }>(
    "/api/v1/segnalazioni/mie",
    {
      preHandler: asMember,
      schema: { response: { 200: segnalazioneListSchema }, tags: ["segnalazioni"] },
    },
    (request) => ({
      segnalazioni: services.segnalazioni
        .mie(request.caller!.user)
        .map((record) => view(record, false)),
    }),
  );

  app.get<{ Reply: { segnalazioni: SegnalazioneView[] } }>(
    "/api/v1/segnalazioni",
    {
      preHandler: asModeration,
      schema: { response: { 200: segnalazioneListSchema }, tags: ["segnalazioni"] },
    },
    (request) => ({
      segnalazioni: services.segnalazioni
        .tutte(request.caller!.user)
        .map((record) => view(record, true)),
    }),
  );

  // La replica prima di `:id`: è un indirizzo fisso, non una segnalazione.
  app.get<{ Reply: { replica: ReplicaView | null } }>(
    "/api/v1/segnalazioni/replica",
    {
      preHandler: asModeration,
      schema: { response: { 200: replicaViewSchema }, tags: ["segnalazioni"] },
    },
    () => ({ replica: services.segnalazioni.replica() ?? null }),
  );

  app.put<{ Body: { testo: string }; Reply: { replica: ReplicaView | null } }>(
    "/api/v1/segnalazioni/replica",
    {
      preHandler: asAdmin,
      schema: {
        body: scriviReplicaRequestSchema,
        response: { 200: replicaViewSchema, 400: errorResponseSchema },
        tags: ["segnalazioni"],
      },
    },
    (request) => ({
      replica: services.segnalazioni.scriviReplica(request.caller!.user, request.body.testo),
    }),
  );

  app.delete(
    "/api/v1/segnalazioni/replica",
    { preHandler: asAdmin, schema: { tags: ["segnalazioni"] } },
    async (_request, reply) => {
      services.segnalazioni.togliReplica();

      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/segnalazioni/:id",
    {
      preHandler: asMember,
      schema: { response: { 404: errorResponseSchema }, tags: ["segnalazioni"] },
    },
    async (request, reply) => {
      services.segnalazioni.ritira(request.caller!.user, request.params.id);

      return reply.code(204).send();
    },
  );

  app.get<{ Params: { chiave: string }; Reply: AvvisoView }>(
    "/api/v1/istanze/:chiave/avviso",
    {
      preHandler: asMember,
      schema: {
        response: { 200: avvisoViewSchema, 400: errorResponseSchema },
        tags: ["segnalazioni"],
      },
    },
    async (request) => {
      const amministra = request.caller!.user.role === "instance_admin";
      const avviso = await services.segnalazioni.avviso(request.params.chiave, amministra);
      const verdetto = amministra ? services.segnalazioni.verdetto(avviso.istanza) : undefined;

      return { ...avviso, ...(verdetto === undefined ? {} : { verdetto }) };
    },
  );

  app.get<{ Reply: { verdetti: VerdettoView[] } }>(
    "/api/v1/verdetti",
    {
      preHandler: asAdmin,
      schema: { response: { 200: verdettoListSchema }, tags: ["segnalazioni"] },
    },
    () => ({ verdetti: services.segnalazioni.verdetti() }),
  );

  app.put<{ Params: { chiave: string }; Body: DecidiVerdettoRequest; Reply: VerdettoView }>(
    "/api/v1/verdetti/:chiave",
    {
      preHandler: asAdmin,
      schema: {
        body: decidiVerdettoRequestSchema,
        response: { 200: verdettoViewSchema, 400: errorResponseSchema },
        tags: ["segnalazioni"],
      },
    },
    (request) =>
      services.segnalazioni.decidi(request.caller!.user, {
        ignora: request.body.ignora,
        istanza: request.params.chiave,
        nota: request.body.nota,
      }),
  );

  app.delete<{ Params: { chiave: string } }>(
    "/api/v1/verdetti/:chiave",
    { preHandler: asAdmin, schema: { tags: ["segnalazioni"] } },
    async (request, reply) => {
      services.segnalazioni.revoca(request.params.chiave);

      return reply.code(204).send();
    },
  );
}
