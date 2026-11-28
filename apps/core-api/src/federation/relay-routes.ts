import {
  adoptCommunityRelaySchema,
  communityRelaysViewSchema,
  errorResponseSchema,
  removeCommunityRelaySchema,
  type AdoptCommunityRelay,
  type CommunityRelaysView,
  type RemoveCommunityRelay,
} from "@estia/contracts";
import type { FastifyInstance } from "fastify";

import type { SettingsRepository } from "../backup/settings.js";
import { requireAuth, requireRole } from "../identity/auth.js";
import type { IdentityService } from "../identity/service.js";

import { adoptRelay, removeRelay, type RelayWatch } from "./relays.js";

/**
 * I relay della comunità dal pannello (ADR 0045 §3): solo chi amministra, e
 * ogni modifica rifà subito il controllo, così che la risposta dica già se il
 * relay appena adottato risponde e quale relay è in uso.
 */
export function registerRelayRoutes(
  app: FastifyInstance,
  services: {
    identity: IdentityService;
    settings: SettingsRepository;
    relayWatch: RelayWatch;
    now: () => Date;
  },
): void {
  const guard = [requireAuth(services.identity), requireRole("instance_admin")];

  app.get<{ Reply: CommunityRelaysView }>(
    "/api/v1/admin/network/relays",
    {
      preHandler: guard,
      schema: { response: { 200: communityRelaysViewSchema }, tags: ["admin"] },
    },
    async () => services.relayWatch.view(),
  );

  app.post<{ Body: AdoptCommunityRelay; Reply: CommunityRelaysView }>(
    "/api/v1/admin/network/relays",
    {
      // Ogni adozione fa partire una domanda verso l'indirizzo scritto.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      preHandler: guard,
      schema: {
        body: adoptCommunityRelaySchema,
        response: {
          200: communityRelaysViewSchema,
          400: errorResponseSchema,
          409: errorResponseSchema,
        },
        tags: ["admin"],
      },
    },
    async (request) => {
      adoptRelay(services.settings, request.body, services.now());
      await services.relayWatch.check();

      return services.relayWatch.view();
    },
  );

  app.post<{ Body: RemoveCommunityRelay; Reply: CommunityRelaysView }>(
    "/api/v1/admin/network/relays/remove",
    {
      preHandler: guard,
      schema: {
        body: removeCommunityRelaySchema,
        response: { 200: communityRelaysViewSchema, 404: errorResponseSchema },
        tags: ["admin"],
      },
    },
    async (request) => {
      removeRelay(services.settings, request.body.url, services.now());
      await services.relayWatch.check();

      return services.relayWatch.view();
    },
  );
}
