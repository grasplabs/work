/**
 * A client's quota policy, as its page shows it: the generation the console
 * sets (its `QUOTA_LIMITS` setting, which every deploy sets on core) beside
 * the generation core applies, read live from its core at
 * `quotaPolicyReportPath` (core's src/workflows/quota-report.ts).
 *
 * Core is the authority: it applies the highest generation it ever
 * recorded, and refuses a lower one or other limits under a recorded one.
 * So core applying another generation than the console set, once that was
 * deployed, means core refused the console's policy: drift. A core that
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
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import type { LowerableLimit } from "@grasp-os/shared/quota-policy";
import {
  quotaPolicyReportPath,
  quotaPolicyReportPurpose,
  quotaPolicyReportSchema,
} from "@grasp-os/shared/quota-policy-report";
import type { QuotaPolicyReport } from "@grasp-os/shared/quota-policy-report";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { and, eq } from "drizzle-orm";

import { consoleDatabase } from "../db/act.ts";
import { clients, settings } from "../db/schema.ts";
import { clientDomain, deploySecrets } from "../deploy/context.ts";
import { errorCode } from "../deploy/deploy.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import { within } from "../live-reads.ts";
import { isConfigPending } from "../rollout/targets.ts";
import { healthTimeoutMs, ifStored, routeOf } from "./grid.ts";

const encoder = new TextEncoder();

/** A policy by its generation and the limits it lowers. */
export interface QuotaGeneration {
  /** 0 for the platform's own, none set. */
  generation: number;
  lowered: Partial<Record<LowerableLimit, number>>;
}

/**
 * How core's policy compares with the console's:
 * - `in_sync`: core applies the generation the console set;
 * - `drifted`: core applies another, so it refused the console's;
 * - `pending`: the console's setting waits for the client's next deploy,
 *   so core can't have it yet;
 * - `unknown`: core couldn't be asked, or didn't answer.
 */
export type QuotaPolicyState = "in_sync" | "drifted" | "pending" | "unknown";

/** A client's quota policy, as its page shows it. */
export interface ClientQuotaPolicy {
  /** What the console sets; the platform's own (generation 0) when it sets none. */
  set: QuotaGeneration;
  /** What core applies, and when it recorded it; null when unknown. */
  inForce: QuotaPolicyReport | null;
  state: QuotaPolicyState;
}

/** What asking a client's core takes. */
export interface QuotaPolicyRequest {
  coreUrl: string;
  routerSecret: string;
  /** The client's core auth secret, the signing key's source. */
  authSecret: string;
  signal: AbortSignal;
}

/**
 * Client core's policy in force, signed for; null when its core didn't
 * give one (refused it, a release from before the report, or an answer
 * that isn't one). Throws when the request fails without an answer.
 */
export const quotaPolicyReportOf = async ({
  coreUrl,
  routerSecret,
  authSecret,
  signal,
}: QuotaPolicyRequest): Promise<QuotaPolicyReport | null> => {
  const body = JSON.stringify({ sentAt: new Date().toISOString() });
  const key = await hkdfHmacKey(authSecret, quotaPolicyReportPurpose, ["sign"]);
  const signature = toHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))
  );
  const response = await fetch(`${coreUrl}${quotaPolicyReportPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [routerSecretHeader]: routerSecret,
      [platformUpdateSignatureHeader]: signature,
    },
    body,
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  try {
    const parsed = quotaPolicyReportSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * The policy the console sets for a client: its `QUOTA_LIMITS` setting,
 * or the platform's own when it has none. A setting that doesn't parse is
 * never deployed (`checkDeployedConfig` refuses it), so it sets nothing.
 */
const setPolicyOf = (value: string | undefined): QuotaGeneration => {
  if (value === undefined) {
    return { generation: 0, lowered: {} };
  }
  try {
    const parsed = quotaLimitsSchema.safeParse(JSON.parse(value));
    return parsed.success
      ? { generation: parsed.data.generation, lowered: parsed.data.limits }
      : { generation: 0, lowered: {} };
  } catch {
    return { generation: 0, lowered: {} };
  }
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
  if (inForce.generation === set.generation) {
    return "in_sync";
  }
  // A change waiting for the next deploy, of this setting or another: the
  // deploy may still bring core the console's generation.
  return pending ? "pending" : "drifted";
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
  const db = consoleDatabase(env.DB);
  const [client] = await db
    .select({
      status: clients.status,
      configChangedAt: clients.configChangedAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    return null;
  }
  const [setting] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(eq(settings.clientId, clientId), eq(settings.key, "QUOTA_LIMITS"))
    );
  const set = setPolicyOf(setting?.value);
  const pending = await isConfigPending(db, clientId, client.configChangedAt);
  const domain = clientDomain(env);
  const inForce =
    client.status !== "active" || domain === null
      ? null
      : await within(
          healthTimeoutMs,
          async (signal) => {
            const secrets = await ifStored(
              async () => await deploySecrets(env)
            );
            if (secrets === null) {
              return null;
            }
            const route = await routeOf(
              env.ROUTER_HOSTS,
              secrets.routerKey,
              clientId,
              `${clientId}.${domain}`
            );
            if (typeof route === "string") {
              return null;
            }
            try {
              return await quotaPolicyReportOf({
                coreUrl: route.coreUrl,
                routerSecret: route.secret,
                authSecret: await clientAuthSecret(
                  secrets,
                  clientId,
                  route.generation
                ),
                signal,
              });
            } catch (error) {
              log.warn("quota_policy.unread", {
                clientId,
                error: errorCode(error),
              });
              return null;
            }
          },
          null
        );
  return { set, inForce, state: stateOf(set, inForce, pending) };
};
