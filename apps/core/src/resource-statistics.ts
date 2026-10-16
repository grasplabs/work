import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId, PermissionId } from "@grasp-os/shared/ids";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import {
  statisticErrors,
  statisticLimitsOf,
} from "@grasp-os/shared/statistics";
import type { StatisticUse } from "@grasp-os/shared/statistics";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { permissions } from "./db/core/schema.ts";
import { appHost } from "./durable-objects.ts";
import type {
  BindingCaller,
  DeclarationOf,
  ResourceAdapter,
} from "./resource-adapter.ts";
import {
  auditPlatformRead,
  platformReadOf,
  readStatistics,
  recordStatistic,
} from "./statistics.ts";

// A statistics resource (resource-bindings.ts): the platform's statistics
// (statistics.ts) for an App's sealed functions, as an admin bound them.
// Threat model, and how each is closed:
//
// - A declaration self-grants: it resolves only through an active binding
//   an admin approved (resource-bindings.ts), for exactly this declaration.
//   Its own measures need no other grant: approving the binding is it.
// - The platform's measures without a grant: a declaration lists the ones
//   it reads (`platform`), the operation host refuses any other before
//   anything is read (operations.ts, `allowedRequest`), and its binding
//   must name one of the App's own active permissions to read them, which
//   `bind` checks as the admin approves and on every request, and which
//   `readStatistics` authorizes again as it reads. A binding of a
//   declaration that reads none names none, and one that names a
//   permission it doesn't read with serves nothing: what it names is
//   exactly what was reviewed.
// - The wrong caller: every read and point acts for the invocation's
//   authority, as core resolved it (the screen's person, the agent's
//   delegate, the run's person), never anything App code sends; a platform
//   read counts only Apps whose runs that person may see (statistics.ts).
// - Another App's measures: points land under, and reads of its own
//   measures read, only the App whose release calls (`caller.app`).
// - Flooding: points and reads are bounded per invocation (`counts`) and
//   per App minute (the App's host object, `claimStatisticMinute`), as an
//   App method's are; the day's rows as before. A platform read refused
//   past a bound is audited once a minute for the App.
// - A step run again: a run's points are kept by its step's attempt, and
//   added up once, when the attempt that completes the step does
//   (statistic-steps.ts).
//
// Its own measures are the App's own data, so their reads and points
// aren't audited, as an App method's aren't; every platform read is,
// allowed or refused.

/** The contract every statistics binding serves. */
const statisticsContract = "grasp.statistics@1";

/** Each use's name in an invocation's counts. */
const countNames: Readonly<Record<StatisticUse, string>> = {
  point: "statistics.point",
  read: "statistics.read",
};

/** Seconds until the next UTC minute, when the App's minute starts again. */
const untilNextMinute = (): number =>
  60 - Math.floor((Date.now() % 60_000) / 1000);

/**
 * Whether `permissionId` is App `app`'s own active permission to read the
 * platform's statistics, as it stands now.
 */
const platformGrantOf = async (
  env: Env,
  app: AppId,
  permissionId: PermissionId
): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      and(
        eq(permissions.id, permissionId),
        eq(permissions.subjectType, "app"),
        eq(permissions.subjectId, app),
        eq(permissions.objectType, "platform"),
        eq(permissions.status, "active"),
        isNull(permissions.chatId),
        sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value = 'statistics')`
      )
    )
    .get();
  return row !== undefined;
};

/**
 * The App's own active permissions to read the platform's statistics,
 * newest first, at most `limit`: what a binding of a declaration that
 * reads them may name.
 */
export const platformGrantsOf = async (
  env: Env,
  app: AppId,
  limit: number
): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      and(
        eq(permissions.subjectType, "app"),
        eq(permissions.subjectId, app),
        eq(permissions.objectType, "platform"),
        eq(permissions.status, "active"),
        isNull(permissions.chatId),
        sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value = 'statistics')`
      )
    )
    .orderBy(sql`${permissions.grantedAt} DESC`)
    .limit(limit);
  return rows.map(({ id }) => id);
};

/**
 * Counts one `use` of the invocation's against its bound, then against
 * the App's minute: `statistics.rate_limited` past either, counting
 * nothing for the minute when the call's own bound refused it.
 */
const claim = async (
  env: Env,
  caller: BindingCaller,
  use: StatisticUse
): Promise<void> => {
  const { perCall, perMinute } = statisticLimitsOf(
    use,
    use === "point" ? env.STATISTICS_POINT_LIMITS : env.STATISTICS_READ_LIMITS
  );
  const name = countNames[use];
  // Without the invocation's counts (none of core's callers leaves them
  // out: `resourceBindingsFor` makes them), this request's own.
  const counts = caller.counts ?? new Map<string, number>();
  const used = counts.get(name) ?? 0;
  if (used >= perCall) {
    throw statisticErrors.create("statistics.rate_limited", {
      use,
      perCall,
      perMinute,
      limit: "call",
    });
  }
  counts.set(name, used + 1);
  await appHost(env, caller.app).claimStatisticMinute(use);
};

/**
 * `error`, a statistics refusal, in the operation host's words: arguments
 * that don't fit (`resource.invalid_args`), a bound reached
 * (`resource.limit_reached`, which one, and for a minute's, when to try
 * again), an App the person may not see counted (`resource.item_not_found`)
 * or a person no longer a member (`resource.unavailable`). Anything else
 * as it is: the operation host allows only its own words through.
 */
const inHostWords = (error: unknown): unknown => {
  // The App's minute is counted in its host object: its refusal comes back
  // over RPC, its code with it.
  const code =
    statisticErrors.codeOf(error) ??
    (isExpectedError(error) ? error.code : undefined);
  if (code === "statistics.invalid") {
    return operationErrors.create("resource.invalid_args");
  }
  if (code === "statistics.too_many") {
    return operationErrors.create("resource.limit_reached", { limit: "day" });
  }
  if (code === "statistics.rate_limited") {
    const details: unknown = isExpectedError(error) ? error.details : undefined;
    const call =
      typeof details === "object" &&
      details !== null &&
      "limit" in details &&
      details.limit === "call";
    return operationErrors.create(
      "resource.limit_reached",
      call
        ? { limit: "call" }
        : { limit: "minute", retryAfterSeconds: untilNextMinute() }
    );
  }
  if (code === "app.not_found") {
    return operationErrors.create("resource.item_not_found");
  }
  if (code === "permission.person_inactive") {
    return operationErrors.create("resource.unavailable");
  }
  return error;
};

/**
 * Audits a platform read `query` refused past a bound, the App's first in
 * its minute (`limitedReadAuditDue`): a read of its own measures isn't.
 */
const auditLimited = async (
  env: Env,
  caller: BindingCaller,
  query: unknown
): Promise<void> => {
  const read = platformReadOf(query);
  if (
    read !== undefined &&
    (await appHost(env, caller.app).limitedReadAuditDue())
  ) {
    await auditPlatformRead(
      env,
      caller.authority,
      read,
      "statistics.rate_limited",
      caller.actor
    );
  }
};

/** Records one point, for `caller`, of the App's own measure. */
const recordFor = async (
  env: Env,
  caller: BindingCaller,
  point: unknown
): Promise<null> => {
  await claim(env, caller, "point");
  const { step } = caller;
  // A run's step adds up what it kept once it completes, so it is told
  // before anything is kept; nothing is kept for an attempt let go of.
  step?.recording();
  caller.requireHolds?.();
  await recordStatistic(env, caller.app, point, {
    step:
      step === undefined ? undefined : { key: step.key, attempt: step.attempt },
  });
  return null;
};

/** Reads a measure, for `caller`, under the platform permission bound. */
const readFor = async (
  env: Env,
  caller: BindingCaller,
  query: unknown,
  platform: PermissionId | undefined
) => {
  try {
    await claim(env, caller, "read");
  } catch (error) {
    await auditLimited(env, caller, query);
    throw error;
  }
  return await readStatistics(
    env,
    caller.authority,
    query,
    platform,
    new Date(),
    caller.actor
  );
};

/** The fingerprint of a statistics binding: its contract and permission. */
const fingerprintOf = async (permissionId: string | null): Promise<string> =>
  await sha256Hex(
    canonicalJson({ contract: statisticsContract, permissionId })
  );

/**
 * Whether `target` may serve `declaration` for App `app` now: a permission
 * exactly when the declaration reads the platform's measures, and then the
 * App's own active one to read them.
 */
const servable = async (
  env: Env,
  app: AppId,
  declaration: DeclarationOf<"statistics">,
  permissionId: string | undefined
): Promise<boolean> => {
  if (declaration.platform.length === 0) {
    return permissionId === undefined;
  }
  const parsed = permissionIdSchema.safeParse(permissionId);
  return parsed.success && (await platformGrantOf(env, app, parsed.data));
};

/**
 * A statistics binding's target, served: what it reads the platform's
 * measures under, if anything, and its requests, for each caller.
 */
const served = async (env: Env, permissionId: PermissionId | undefined) => ({
  contractId: statisticsContract,
  fingerprint: await fingerprintOf(permissionId ?? null),
  call: async (
    caller: BindingCaller,
    { method, args }: { method: string; args: readonly unknown[] }
  ): Promise<unknown> => {
    const [first] = args;
    try {
      if (method === "record") {
        return await recordFor(env, caller, first);
      }
      if (method === "read") {
        return await readFor(env, caller, first, permissionId);
      }
      // The operation host allows only a declared operation through.
      throw permissionErrors.create("permission.denied");
    } catch (error) {
      throw inHostWords(error);
    }
  },
});

export const statisticsAdapter: ResourceAdapter<"statistics"> = {
  bind: async (env, app, declaration, target) =>
    (await servable(env, app, declaration, target.permissionId))
      ? await served(
          env,
          target.permissionId === undefined
            ? undefined
            : permissionIdSchema.parse(target.permissionId)
        )
      : undefined,
};
