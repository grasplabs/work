import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { functionErrors } from "@grasp-os/shared/functions";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { PermissionId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import {
  statisticErrors,
  statisticReadLimitsOf,
} from "@grasp-os/shared/statistics";

import { appHost } from "./durable-objects.ts";
import type {
  BindingCaller,
  ResourceAdapter,
  ServedBinding,
} from "./resource-adapter.ts";
import { platformGrantOf } from "./resource-platform.ts";
import {
  auditPlatformRead,
  platformReadOf,
  readPlatformStatistics,
} from "./statistics.ts";

// The platform's own read-only functions (`permission.grasp`, an App's
// `apps` under alias `grasp`): what an App reads of the platform's
// statistics (statistics.ts), as an admin bound it. Threat model, and how
// each is closed:
//
// - A declaration self-grants: it resolves only through an active binding
//   an admin approved (resource-bindings.ts), for exactly this declaration,
//   which the SDK makes only as the platform's own functions
//   (`graspFunctions`), and its binding must name one of the App's own
//   active permissions to read the platform's statistics, which `bind`
//   checks as the admin approves and on every request, and which the read
//   authorizes again as it reads.
// - A forged function: the function host lets through only a path the
//   declaration lists (function-host.ts, `allowedRequest`); this adapter
//   serves `statistics.read` alone, its query checked by the platform's
//   own schema (`statisticQuerySchema`) as it is read.
// - The wrong caller: every read acts for the invocation's authority, as
//   core resolved it (the page's person, the agent's delegate, the run's
//   person), never anything App code sends, and counts only Apps whose runs
//   that person may see (statistics.ts).
// - Flooding: reads are bounded per invocation (`counts`) and per App
//   minute (the App's host object, `claimStatisticMinute`). A read refused
//   past a bound is audited once a minute for the App.
//
// Every read is audited, allowed or refused.

/** The contract every `grasp` binding serves. */
const graspContract = "grasp.platform@1";

/** The one function the platform serves an App. */
const statisticsRead = "statistics.read";

/** A read's name in an invocation's counts. */
const countName = "grasp.statistics.read";

/** Seconds until the next UTC minute, when the App's minute starts again. */
const untilNextMinute = (): number =>
  60 - Math.floor((Date.now() % 60_000) / 1000);

/**
 * Counts one read of the invocation's against its bound, then against
 * the App's minute: `statistics.rate_limited` past either, counting
 * nothing for the minute when the call's own bound refused it.
 */
const claim = async (env: Env, caller: BindingCaller): Promise<void> => {
  const { perCall, perMinute } = statisticReadLimitsOf(
    env.STATISTICS_READ_LIMITS
  );
  // Without the invocation's counts (none of core's callers leaves them
  // out: `resourceBindingsFor` makes them), this request's own.
  const counts = caller.counts ?? new Map<string, number>();
  const used = counts.get(countName) ?? 0;
  if (used >= perCall) {
    throw statisticErrors.create("statistics.rate_limited", {
      perCall,
      perMinute,
      limit: "call",
    });
  }
  counts.set(countName, used + 1);
  await appHost(env, caller.app).claimStatisticMinute();
};

/**
 * `error`, a statistics refusal, in the function host's words: arguments
 * that don't fit (`permission.invalid_args`), a bound reached
 * (`permission.limit_reached`, which one, and for a minute's, when to try
 * again), an App the person may not see counted (`permission.item_not_found`)
 * or a person no longer a member (`permission.unavailable`). Anything else
 * as it is: the function host allows only its own words through.
 */
const inHostWords = (error: unknown): unknown => {
  // The App's minute is counted in its host object: its refusal comes back
  // over RPC, its code with it.
  const code =
    statisticErrors.codeOf(error) ??
    (isExpectedError(error) ? error.code : undefined);
  if (code === "statistics.invalid") {
    return functionErrors.create("permission.invalid_args");
  }
  if (code === "statistics.rate_limited") {
    const details: unknown = isExpectedError(error) ? error.details : undefined;
    const call =
      typeof details === "object" &&
      details !== null &&
      "limit" in details &&
      details.limit === "call";
    return functionErrors.create(
      "permission.limit_reached",
      call
        ? { limit: "call" }
        : { limit: "minute", retryAfterSeconds: untilNextMinute() }
    );
  }
  if (code === "app.not_found") {
    return functionErrors.create("permission.item_not_found");
  }
  if (code === "permission.person_inactive") {
    return functionErrors.create("permission.unavailable");
  }
  return error;
};

/**
 * Audits a read `query` refused past a bound, the App's first in its
 * minute (`limitedReadAuditDue`).
 */
const auditLimited = async (
  env: Env,
  caller: BindingCaller,
  query: unknown
): Promise<void> => {
  if (await appHost(env, caller.app).limitedReadAuditDue()) {
    await auditPlatformRead(
      env,
      caller.authority,
      platformReadOf(query),
      "statistics.rate_limited",
      caller.actor
    );
  }
};

/** Reads a platform measure, for `caller`, under the permission bound. */
const readFor = async (
  env: Env,
  caller: BindingCaller,
  query: unknown,
  permissionId: PermissionId
) => {
  try {
    await claim(env, caller);
  } catch (error) {
    await auditLimited(env, caller, query);
    throw error;
  }
  return await readPlatformStatistics(
    env,
    caller.authority,
    query,
    permissionId,
    new Date(),
    caller.actor
  );
};

/** The fingerprint of a `grasp` binding: its contract and permission. */
const fingerprintOf = async (permissionId: string): Promise<string> =>
  await sha256Hex(canonicalJson({ contract: graspContract, permissionId }));

/** A `grasp` binding's target, served: its reads, for each caller. */
const served = async (
  env: Env,
  permissionId: PermissionId
): Promise<ServedBinding> => ({
  contractId: graspContract,
  fingerprint: await fingerprintOf(permissionId),
  call: async (caller, { method, args }) => {
    const [path, query] = args;
    try {
      // The function host allows only a declared function through.
      if (method !== "call" || path !== statisticsRead) {
        throw permissionErrors.create("permission.denied");
      }
      return await readFor(env, caller, query, permissionId);
    } catch (error) {
      throw inHostWords(error);
    }
  },
});

export const graspAdapter: ResourceAdapter<"grasp"> = {
  bind: async (env, app, _declaration, target) => {
    const permissionId = permissionIdSchema.parse(target.permissionId);
    return (await platformGrantOf(env, app, permissionId, "statistics"))
      ? await served(env, permissionId)
      : undefined;
  },
};
