/**
 * Asking a client's core for a report, as the grid asks for the onboarding
 * summary (onboarding.ts): through the router's route with the router
 * secret, signed with a key both derive from the client's auth secret for
 * that report alone. Core answers what the report's schema says.
 */
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { routerSecretHeader } from "@grasp-os/shared/router";
import type { z } from "zod";

import { clientDomain, deploySecrets, ifStored } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import { within } from "../live-reads.ts";
import type { CoreAddress } from "./core-address.ts";
import { healthTimeoutMs, routeOf } from "./grid.ts";

const encoder = new TextEncoder();

/** What asking a client's core takes. */
export interface CoreReportRequest {
  core: CoreAddress;
  routerSecret: string;
  /** The client's core auth secret, the signing key's source. */
  authSecret: string;
  signal: AbortSignal;
}

/**
 * What client core answers at `report.path`, signed for with a key derived
 * for `report.purpose` alone; null when its core didn't give it (refused
 * it, a release from before the report, or an answer that isn't one).
 * Throws when the request fails without an answer.
 */
export const signedCoreReport = async <T>(
  { core, routerSecret, authSecret, signal }: CoreReportRequest,
  report: { path: string; purpose: string; schema: z.ZodType<T> }
): Promise<T | null> => {
  const body = JSON.stringify({ sentAt: new Date().toISOString() });
  const key = await hkdfHmacKey(authSecret, report.purpose, ["sign"]);
  const signature = toHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))
  );
  const response = await core.fetch(`${core.origin}${report.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [routerSecretHeader]: routerSecret,
      [platformUpdateSignatureHeader]: signature,
    },
    body,
    signal,
    // A redirect is no answer from core: it's never followed, and reads as
    // unknown, so a signed request never goes anywhere else.
    redirect: "manual",
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  try {
    const parsed = report.schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Asks active client `clientId`'s core through the router's route, as
 * `ask` does, within the grid's deadline; null when it can't be asked
 * (no domain, a secret missing, no route) or doesn't answer, logged as
 * `<what>.unread`. Never throws for its core.
 */
export const askClientCore = async <T>(
  env: Env,
  clientId: string,
  what: string,
  ask: (request: CoreReportRequest) => Promise<T | null>
): Promise<T | null> => {
  const domain = clientDomain(env);
  if (domain === null) {
    return null;
  }
  return await within(
    healthTimeoutMs,
    async (signal) => {
      const secrets = await ifStored(async () => await deploySecrets(env));
      if (secrets === null) {
        return null;
      }
      const route = await routeOf(
        env.ROUTER_HOSTS,
        secrets.routerKey,
        clientId,
        `${clientId}.${domain}`,
        env.DISPATCHER
      );
      if (typeof route === "string") {
        return null;
      }
      try {
        return await ask({
          core: route.core,
          routerSecret: route.secret,
          authSecret: await clientAuthSecret(
            secrets,
            clientId,
            route.generation
          ),
          signal,
        });
      } catch (error) {
        log.warn(`${what}.unread`, { clientId, error: errorCode(error) });
        return null;
      }
    },
    null
  );
};
