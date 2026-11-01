import {
  appVisitorErrors,
  appVisitorGrantsSchema,
} from "@grasp-os/shared/app-visitors";
import type { AppVisitorGrants } from "@grasp-os/shared/app-visitors";
import { actorOf } from "@grasp-os/shared/audit";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { loadRelease } from "./app-releases.ts";
import { editableApp } from "./apps.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { appVisitorGrants } from "./db/core/schema.ts";
import { requireNotStaff } from "./sharing.ts";

// A visitor's calls of a published App's functions (app-visitors.ts for
// how a visitor signs in; app-functions.ts, `callVisitorFunction`, for the
// call). A visitor is never a person: their calls run as the App itself,
// under what its builders granted visitors, and nothing a member holds.
// How each can be attacked, and what stops it, each with a test in
// test/app-visitor-calls.test.ts:
//
// - Calling what wasn't granted. A version grants visitors nothing until
//   a builder grants functions of it by path (`setAppVisitorGrants`): only
//   the version's public queries and mutations, never an action, which is
//   what reaches resources, and never core's workflow or preference
//   queries, which answer for a member. A call names its function by the
//   release's own reference (resource, version, fingerprint), checked as
//   for a member.
// - Keeping a grant after it was taken away. The grant is read again
//   before the call and before each commit (the call's one `admit`), with
//   the session, the App's status and version, and the visitor's place on
//   the list. Granting fewer functions, making another version current,
//   unpublishing or taking the visitor off the list stops a call already
//   running, before it commits. Grants are per version: a new current
//   version grants nothing until granted again. Unpublishing also ends
//   every visitor's session.
// - Reaching another App's data, or a member's. The call runs on the
//   App's own store, as no member: an `appMembers` or `appBuilders` table
//   refuses it, and an `owner` table shows and takes only the visitor's
//   own rows (its principal is `visitor:<session>`, which no member's ID
//   is). Its receipts are keyed by that principal too, so one visitor's
//   idempotency key never answers another's call. Nothing is bound for
//   it: no other App, no business store, no connection, no Knowledge.
// - Escalating through the agent or a workflow. A visitor's call has no
//   resources (the model and templates included), starts no workflow and
//   stages no notification: whatever the App holds for its members, a
//   function that asks for any of them is refused, and its mutation
//   commits nothing.
// - Spending past a budget. With no model or connection bound, a
//   visitor's call spends no model budget and no member's. Calls are
//   counted per visitor (their session) and per App (all its visitors
//   together) by the App's host, before anything runs; the router limits
//   the endpoint per client address too.
// - Unseen. Every call admitted is audited as the visitor, with the
//   function granted and the version; a call refused for its grant is
//   audited too. Granting is audited as the builder, with the version.

/** The functions App `app`'s version `version` grants visitors, by path. */
export const grantedFunctions = async (
  env: Env,
  app: AppId,
  version: number
): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .select({ path: appVisitorGrants.function })
    .from(appVisitorGrants)
    .where(
      and(
        eq(appVisitorGrants.appId, app),
        eq(appVisitorGrants.version, version)
      )
    )
    .orderBy(asc(appVisitorGrants.function));
  return rows.map(({ path }) => path);
};

/** Whether App `app`'s version `version` grants visitors `path`. */
export const grantHeld = async (
  env: Env,
  app: AppId,
  version: number,
  path: string
): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ path: appVisitorGrants.function })
    .from(appVisitorGrants)
    .where(
      and(
        eq(appVisitorGrants.appId, app),
        eq(appVisitorGrants.version, version),
        eq(appVisitorGrants.function, path)
      )
    )
    .get();
  return row !== undefined;
};

/** What App `app` grants visitors now, for its builders. */
export const appVisitorGrantsOf = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppVisitorGrants> => {
  const found = await editableApp(env, by, app);
  return {
    version: found.currentVersion,
    functions:
      found.currentVersion === null
        ? []
        : await grantedFunctions(env, found.id, found.currentVersion),
  };
};

/**
 * Grants visitors `functions` of App `app`'s current version, the whole set
 * at once, for its builders: each a public query or mutation of that
 * version (`visitor.invalid` otherwise). A call already running is held
 * to the new set before it commits.
 */
export const setAppVisitorGrants = async (
  env: Env,
  by: Identity,
  app: unknown,
  functions: unknown
): Promise<AppVisitorGrants> => {
  requireNotStaff(by);
  const parsed = appVisitorGrantsSchema.safeParse(functions);
  if (!parsed.success) {
    throw appVisitorErrors.create("visitor.invalid");
  }
  const found = await editableApp(env, by, app);
  const version = found.currentVersion;
  if (version === null) {
    throw appVisitorErrors.create("visitor.invalid");
  }
  const release = await loadRelease(env, found.id, version);
  const wanted = [...new Set(parsed.data)].toSorted();
  for (const path of wanted) {
    const operation = Object.hasOwn(release.app.operations, path)
      ? release.app.operations[path]
      : undefined;
    if (
      operation === undefined ||
      operation.visibility !== "public" ||
      operation.kind === "action"
    ) {
      throw appVisitorErrors.create("visitor.invalid");
    }
  }
  const before = await grantedFunctions(env, found.id, version);
  const added = wanted.filter((path) => !before.includes(path));
  const removed = before.filter((path) => !wanted.includes(path));
  if (added.length === 0 && removed.length === 0) {
    return { version, functions: before };
  }
  const db = drizzle(env.DB);
  const now = new Date();
  await auditedBatch(env, db, [
    db
      .delete(appVisitorGrants)
      .where(
        and(
          eq(appVisitorGrants.appId, found.id),
          eq(appVisitorGrants.version, version)
        )
      ),
    ...wanted.map((path) =>
      db.insert(appVisitorGrants).values({
        appId: found.id,
        version,
        function: path,
        grantedBy: by.userId,
        grantedAt: now,
      })
    ),
    outboxed(db, {
      actor: actorOf(by),
      action: "app.visitor_grants_set",
      target: { type: "app", id: found.id },
      detail: {
        version,
        added: added.join(" "),
        removed: removed.join(" "),
      },
    }),
  ]);
  return { version, functions: await grantedFunctions(env, found.id, version) };
};
