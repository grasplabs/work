/**
 * The kickoff from the admin (GRA-1099, `@grasp-os/shared/admin-kickoff`,
 * which lists what can go wrong): a Grasp admin brings in a company's
 * first conversation with its sponsor, and the sponsor's answers to what
 * it left open, from that organization's Steps. The admin asks the
 * company's own core, as it asks for the admin snapshot
 * (src/clients/admin.ts): through the router's route with the router
 * secret, signed with the key both derive from that client's auth secret
 * for this purpose alone, naming the staff member Access let in, whom
 * core's audit log records. Core reads the transcript and keeps it as the
 * staff page in the company's Grasp did, so what it brought seeds the
 * company's first interviews the same way.
 *
 * The admin keeps nothing of it: not the transcript, nor what core
 * answers, which says which of the ten things it brought and the
 * questions it left, never what was said.
 */
import {
  adminKickoffAskSchema,
  adminKickoffPath,
  adminKickoffPurpose,
  adminKickoffViewSchema,
} from "@grasp-os/shared/admin-kickoff";
import type {
  AdminKickoffRequest,
  AdminKickoffView,
} from "@grasp-os/shared/admin-kickoff";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { toHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { deploySecrets } from "../deploy/context.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import type { CoreAddress } from "./core-address.ts";
import { clientGrid, ifStored, routeOf } from "./grid.ts";

/**
 * How long the company's core may take: reading a long conversation takes
 * its model up to two minutes, and a Word file the extractor first.
 */
export const kickoffTimeoutMs = 180_000;

/** What staff ask of the kickoff, for one organization. */
export const kickoffInputSchema = z.object({
  clientId: z.string().min(1).max(63),
  ask: adminKickoffAskSchema,
});

/**
 * Why the kickoff wasn't brought in or read, as the page words it:
 * - `not_deployed`: the company has no core to ask yet;
 * - `shut_out`: the company keeps Grasp's staff out now (no staff window,
 *   or it ended staff access);
 * - `refused`: its core turned the request away;
 * - one of core's own kickoff codes, for a transcript it can't take;
 * - `not_answered`: the request failed or took too long.
 */
export type KickoffRefusal =
  | "not_deployed"
  | "shut_out"
  | "refused"
  | "kickoff.too_short"
  | "kickoff.too_long"
  | "kickoff.unreadable"
  | "kickoff.not_read"
  | "kickoff.invalid"
  | "kickoff.purged"
  | "not_answered";

/** What the page gets back. */
export type KickoffAnswer =
  | { kickoff: AdminKickoffView; refused: null }
  | { kickoff: null; refused: KickoffRefusal };

const refusal = (refused: KickoffRefusal): KickoffAnswer => ({
  kickoff: null,
  refused,
});

/** Core's own codes the page says in its words. */
const kickoffCodes: ReadonlySet<string> = new Set([
  "kickoff.too_short",
  "kickoff.too_long",
  "kickoff.unreadable",
  "kickoff.not_read",
  "kickoff.invalid",
  "kickoff.purged",
]);

const isKickoffCode = (code: string): code is KickoffRefusal =>
  kickoffCodes.has(code);

const encoder = new TextEncoder();

/** Where client `clientId`'s core is, and the secret to sign for it with; null when it can't be asked. */
const clientCore = async (
  env: Env,
  clientId: string
): Promise<{
  address: CoreAddress;
  routerSecret: string;
  authSecret: string;
} | null> => {
  const grid = await clientGrid(env);
  const row = grid.find(
    ({ id, status }) => id === clientId && status === "active"
  );
  const secrets = await ifStored(
    async (): Promise<DeploySecrets> => await deploySecrets(env)
  );
  if (row === undefined || secrets === null) {
    return null;
  }
  const route = await routeOf(
    env.ROUTER_HOSTS,
    secrets.routerKey,
    row.id,
    row.hostname,
    env.DISPATCHER
  );
  if (route === "no_route" || route === "unknown") {
    return null;
  }
  return {
    address: route.core,
    routerSecret: route.secret,
    authSecret: await clientAuthSecret(secrets, row.id, route.generation),
  };
};

/** Core's error code in an answer that isn't OK, if it gave one. */
const codeOf = async (response: Response): Promise<string | null> => {
  try {
    const body: unknown = await response.json();
    const parsed = z.object({ code: z.string() }).safeParse(body);
    return parsed.success ? parsed.data.code : null;
  } catch {
    return null;
  }
};

/** Why core refused, in the page's terms, from its status and code. */
const refusalOf = (status: number, code: string | null): KickoffRefusal => {
  if (code === "onboarding.staff_only") {
    return "shut_out";
  }
  if (code !== null && isKickoffCode(code)) {
    return code;
  }
  return status === 401 || status === 403 ? "refused" : "not_answered";
};

/**
 * What `staff` asked of client `clientId`'s kickoff, as its core answered:
 * the kickoff after it, or why not. Never throws for an answer that
 * didn't come.
 */
export const askKickoff = async (
  env: Env,
  staff: Pick<Staff, "email">,
  input: z.input<typeof kickoffInputSchema>
): Promise<KickoffAnswer> => {
  const { clientId, ask } = kickoffInputSchema.parse(input);
  const core = await clientCore(env, clientId);
  if (core === null) {
    return refusal("not_deployed");
  }
  const request: AdminKickoffRequest = {
    sentAt: new Date().toISOString(),
    staff: { email: staff.email },
    ask,
  };
  const body = JSON.stringify(request);
  const key = await hkdfHmacKey(core.authSecret, adminKickoffPurpose, ["sign"]);
  const signature = toHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))
  );
  const limit = deadline(kickoffTimeoutMs);
  try {
    return await Promise.race([
      (async (): Promise<KickoffAnswer> => {
        const response = await core.address.fetch(
          `${core.address.origin}${adminKickoffPath}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [routerSecretHeader]: core.routerSecret,
              [platformUpdateSignatureHeader]: signature,
            },
            body,
            // Never followed: a redirect would send the signed body, the
            // transcript and the router secret wherever it points. A 3xx
            // isn't ok, so it reads as not answered.
            redirect: "manual",
            signal: limit.signal,
          }
        );
        if (!response.ok) {
          return refusal(refusalOf(response.status, await codeOf(response)));
        }
        const kickoff = adminKickoffViewSchema.safeParse(
          await response.json().catch(() => null)
        );
        return kickoff.success
          ? { kickoff: kickoff.data, refused: null }
          : refusal("not_answered");
      })(),
      whenAborted(limit.signal),
    ]);
  } catch {
    log.warn("admin.kickoff_unanswered", {
      clientId,
      kind: ask.kind,
      error: limit.stopped() === "timeout" ? "timeout" : "no_answer",
    });
    return refusal("not_answered");
  } finally {
    limit.clear();
  }
};
