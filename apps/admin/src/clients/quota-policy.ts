/**
 * A client's quota policy, as its page shows it: the generation the admin
 * sets (its `QUOTA_LIMITS` setting, which every deploy sets on core) beside
 * the generation core applies, read live from its core at
 * `quotaPolicyReportPath` (core's src/workflows/quota-report.ts).
 *
 * Core is the authority: it applies the highest generation it ever
 * recorded, and refuses a lower one or other limits under a recorded one.
 * So core applying another generation than the admin set, once that was
 * deployed, means core refused the admin's policy: drift. A core that
 * can't be asked, or doesn't answer, is unknown, never in sync.
 *
 * Asked as the grid asks for the onboarding summary (onboarding.ts):
 * through the router's route with the router secret, signed with the key
 * both derive from the client's auth secret, here for this purpose alone.
 * Core answers numbers only.
 */
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import {
  quotaLimitsHash,
  quotaLimitsSchema,
} from "@grasp-os/shared/quota-policy";
import type { LowerableLimit } from "@grasp-os/shared/quota-policy";
import {
  quotaPolicyReportPath,
  quotaPolicyReportPurpose,
  quotaPolicyReportSchema,
} from "@grasp-os/shared/quota-policy-report";
import type { QuotaPolicyReport } from "@grasp-os/shared/quota-policy-report";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import { clients, settings } from "../db/schema.ts";
import { clientDomain, deploySecrets, ifStored } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import { within } from "../live-reads.ts";
import { isConfigPending } from "../rollout/targets.ts";
import type { CoreAddress } from "./core-address.ts";
import { healthTimeoutMs, routeOf } from "./grid.ts";

const encoder = new TextEncoder();

/** A policy by its generation and the limits it lowers. */
export interface QuotaGeneration {
  /** 0 for the platform's own, none set. */
  generation: number;
  lowered: Partial<Record<LowerableLimit, number>>;
  /** The hash of its limits (`quotaLimitsHash`); null for the platform's own. */
  limitsHash: string | null;
}

/**
 * How core's policy compares with the admin's:
 * - `in_sync`: core applies the generation the admin set, with its limits;
 * - `drifted`: core applies another generation, or other limits under the
 *   same one, so it refused the admin's;
 * - `pending`: the admin's setting waits for the client's next deploy,
 *   so core can't have it yet;
 * - `unknown`: core couldn't be asked, or didn't answer.
 */
export type QuotaPolicyState = "in_sync" | "drifted" | "pending" | "unknown";

/** A client's quota policy, as its page shows it. */
export interface ClientQuotaPolicy {
  /** What the admin sets; the platform's own (generation 0) when it sets none. */
  set: QuotaGeneration;
  /** What core applies, and when it recorded it; null when unknown. */
  inForce: QuotaPolicyReport | null;
  state: QuotaPolicyState;
}

/** What asking a client's core takes. */
export interface QuotaPolicyRequest {
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
  { core, routerSecret, authSecret, signal }: QuotaPolicyRequest,
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

/** Client core's policy in force, signed for (`signedCoreReport`). */
export const quotaPolicyReportOf = async (
  request: QuotaPolicyRequest
): Promise<QuotaPolicyReport | null> =>
  await signedCoreReport(request, {
    path: quotaPolicyReportPath,
    purpose: quotaPolicyReportPurpose,
    schema: quotaPolicyReportSchema,
  });

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
  ask: (request: QuotaPolicyRequest) => Promise<T | null>
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

/**
 * The policy the admin sets for a client: its `QUOTA_LIMITS` setting,
 * or the platform's own when it has none. A setting that doesn't parse is
 * never deployed (`checkDeployedConfig` refuses it), so it sets nothing.
 */
const setPolicyOf = async (
  value: string | undefined
): Promise<QuotaGeneration> => {
  const platform: QuotaGeneration = {
    generation: 0,
    lowered: {},
    limitsHash: null,
  };
  if (value === undefined) {
    return platform;
  }
  let json: unknown = undefined;
  try {
    json = JSON.parse(value);
  } catch {
    return platform;
  }
  const parsed = quotaLimitsSchema.safeParse(json);
  return parsed.success
    ? {
        generation: parsed.data.generation,
        lowered: parsed.data.limits,
        limitsHash: await quotaLimitsHash(parsed.data.limits),
      }
    : platform;
};

/** How `inForce` compares with `set`, as `QuotaPolicyState` says. */
const stateOf = (
  set: QuotaGeneration,
  inForce: QuotaPolicyReport | null,
  pending: boolean
): QuotaPolicyState => {
  if (inForce === null) {
    return "unknown";
  }
  // The same generation with other limits is another policy: core kept
  // the limits it recorded first and refused the admin's.
  if (
    inForce.generation === set.generation &&
    inForce.limitsHash === set.limitsHash
  ) {
    return "in_sync";
  }
  // A change of the setting waiting for the next deploy may still bring
  // core the admin's generation; under the one it has, the deploy brings
  // nothing, as core refuses other limits for a generation it recorded.
  return pending && inForce.generation !== set.generation
    ? "pending"
    : "drifted";
};

/**
 * Client `clientId`'s quota policy, its core asked within the grid's
 * deadline; null when there's no such client. Never throws for its core:
 * one that can't be asked or doesn't answer is unknown.
 */
export const clientQuotaPolicy = async (
  env: Env,
  clientId: string
): Promise<ClientQuotaPolicy | null> => {
  const db = adminDatabase(env.DB);
  const [client] = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    return null;
  }
  const [setting] = await db
    .select({ value: settings.value, updatedAt: settings.updatedAt })
    .from(settings)
    .where(
      and(eq(settings.clientId, clientId), eq(settings.key, "QUOTA_LIMITS"))
    );
  const set = await setPolicyOf(setting?.value);
  // Only a change of this setting waits to reach core: another setting's
  // change waiting for its deploy says nothing of the policy.
  const pending = await isConfigPending(
    db,
    clientId,
    setting?.updatedAt ?? null
  );
  const inForce =
    client.status === "active"
      ? await askClientCore(env, clientId, "quota_policy", quotaPolicyReportOf)
      : null;
  return { set, inForce, state: stateOf(set, inForce, pending) };
};
