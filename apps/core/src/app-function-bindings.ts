import { functionBreak } from "@grasp-os/sdk/host";
import type { FunctionManifest } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import {
  findApp,
  findVersion,
  readStored,
  releaseFunctionsOf,
} from "./apps.ts";

// The workflows bound to an App's functions (GRA-1663): each an
// independent workflow's grant on one function, active or asked for
// again, by the stable ID
// the App's definition gives it (permissions.ts, an `app` object with its
// `function`). What a workflow's run calls through it is
// workflows/app-calls.ts's; this keeps an App's publish from breaking it.
//
// Threat model, and how each is closed:
//
// - A version that removes a function a workflow calls, or changes what
//   it takes or answers so the workflow's calls no longer fit, made
//   current by a publish, a rollback or any older version made current:
//   all go through `makeCurrent` (apps.ts), which checks every bound
//   function of the version against the one current now
//   (`requireBoundFunctionsServed`), by ID, and is refused, naming each
//   workflow and function, before anything changes. A rename keeps the
//   ID (`renameFunction`), so it passes; so do new functions and new
//   optional arguments.
// - An ID moved onto another function: a bound ID whose path changed to
//   the path the current version gives another ID, which the version
//   keeps elsewhere, swaps what the two IDs mean, and is refused as a
//   break, so what an admin granted by its name stays the function they
//   saw. A rename onto the path of a function with no ID is as rewriting
//   the function's code, which its builders may: the publish still
//   compares what it takes and answers. Before the grant lands, the
//   grant holds to the version of the App the admin reviewed
//   (permissions.ts, `grantPermission`).
// - A grant landing between that check and the switch: the statement
//   that makes the version current holds only while every binding grant (`boundSql`)
//   on the App's functions names one the version serves as checked
//   (`boundFunctionsServedSql`); otherwise it changes nothing and the
//   publish is refused.
// - A function ID that stands for nothing, or for another function: a
//   request and a grant name only an ID the App's current version gives
//   a function (`requireAppFunction`), and a version's definition gives
//   IDs to exactly the queries and mutations its code exports, a function
//   gone losing its (apps.ts, `storedVersion`). An ID comes back only to
//   its own path, from the current version, where the publish compares
//   what is there with its callers.
// - A grant requested before a version removed its function, granted
//   after, or as another version is made current: the grant checks the
//   function in the current version again, and lands only while the
//   version the admin reviewed is still current (permissions.ts,
//   `grantPermission`); a run's call resolves the ID in the current
//   release as it calls, and fails clearly
//   (`workflow.app_function_unavailable`) when nothing serves it.
// - An App removed while workflows are bound: its removal revokes every
//   grant on it (app-removal.ts), so a run's next call is refused
//   (`workflow.call_denied`), its receipt kept.

/** Most workflow-function pairs a refused publish names. */
const namedMax = 20;

/** A workflow's grant binding it to one of App `app`'s functions (`boundSql`). */
interface BoundFunction {
  readonly workflow: string;
  readonly name: string;
  readonly function: string;
}

/**
 * That a permission row `held` (its alias) binds a live workflow to one
 * of App `app`'s functions, as SQL: an active grant, or one asked for
 * again (requested, granted before) as another version was made current
 * by someone who couldn't grant (permissions.ts, `madeCurrent`), which
 * the workflow still counts on.
 */
const boundSql = (app: AppId, held: string): SQL =>
  sql`${sql.identifier(held)}.object_type = 'app'
    AND ${sql.identifier(held)}.object_id = ${app}
    AND ${sql.identifier(held)}.resource IS NOT NULL
    AND ${sql.identifier(held)}.subject_type = 'workflow'
    AND (${sql.identifier(held)}.status = 'active'
      OR (${sql.identifier(held)}.status = 'requested'
        AND ${sql.identifier(held)}.granted_by IS NOT NULL))
    AND EXISTS (SELECT 1 FROM workflow_resources AS live
      WHERE live.id = ${sql.identifier(held)}.subject_id
        AND live.deleted_at IS NULL)`;

/** The live workflows' grants binding them to App `app`'s functions. */
const boundFunctionsOf = async (
  env: Env,
  app: AppId
): Promise<BoundFunction[]> =>
  await drizzle(env.DB).all<BoundFunction>(
    sql`SELECT held.subject_id AS workflow, live.name AS name,
        held.resource AS function
      FROM permissions AS held
      JOIN workflow_resources AS live ON live.id = held.subject_id
      WHERE ${boundSql(app, "held")}
      ORDER BY live.name, held.resource`
  );

/** The public functions `release` serves by stable ID. */
const servedOf = async (
  env: Env,
  release: Release
): Promise<ReadonlyMap<string, FunctionManifest>> => {
  const served = new Map<string, FunctionManifest>();
  for (const [id, path] of await releaseFunctionsOf(env, release)) {
    const operation = Object.hasOwn(release.app.operations, path)
      ? release.app.operations[path]
      : undefined;
    if (operation?.visibility === "public") {
      served.set(id, operation);
    }
  }
  return served;
};

/** What a version serves by ID, and the ID it gives each path. */
interface Served {
  readonly byId: ReadonlyMap<string, FunctionManifest>;
  readonly idAt: ReadonlyMap<string, string>;
}

/**
 * What App `app`'s current version `version` serves, to compare a new
 * one with; undefined when it can't be read (sealed in a format this
 * release doesn't load, or revoked): then a bound function only has to
 * be there.
 */
const currentServed = async (
  env: Env,
  app: AppId,
  version: number | null
): Promise<Served | undefined> => {
  if (version === null) {
    return undefined;
  }
  try {
    const release = await loadRelease(env, app, version);
    const ids = await releaseFunctionsOf(env, release);
    return {
      byId: await servedOf(env, release),
      idAt: new Map([...ids].map(([id, path]) => [path, id])),
    };
  } catch (error) {
    if (isExpectedError(error)) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Refuses making `next` App `app`'s current version over `previous` (the
 * version current now, null for none) while a workflow is bound to a
 * function `next` doesn't serve, or serves so the workflow's calls no
 * longer fit (`functionBreak`): `version.functions_in_use`, naming each
 * workflow and function. Answers the IDs of the functions `next` serves
 * as checked, for the statement that makes it current
 * (`boundFunctionsServedSql`).
 */
export const requireBoundFunctionsServed = async (
  env: Env,
  app: AppId,
  previous: number | null,
  next: Release
): Promise<string[]> => {
  const after = await servedOf(env, next);
  const bound = await boundFunctionsOf(env, app);
  // Worked out whatever is bound now: the IDs answered are all a grant
  // landing before the switch may name (`boundFunctionsServedSql`).
  const before = await currentServed(env, app, previous);
  const broken = new Map<string, string>();
  for (const [id, operation] of after) {
    const was = before?.byId.get(id);
    if (was === undefined) {
      continue;
    }
    // A rename moves a function to a new path. One onto the path of
    // another function with an ID, which `next` keeps elsewhere, moves
    // the ID onto that function: the two IDs swap meaning. (A rollback
    // past a rename takes the path back from a function `next` doesn't
    // have; a path with no ID is no other function a workflow holds.)
    const other = before?.idAt.get(operation.path);
    const repointed =
      was.path !== operation.path &&
      other !== undefined &&
      other !== id &&
      after.has(other);
    const reason = repointed
      ? `is the App's other function \`${operation.path}\` now, not \`${was.path}\` renamed`
      : functionBreak(was, operation);
    if (reason !== undefined) {
      broken.set(id, reason);
    }
  }
  const issues = bound.flatMap(({ workflow, name, function: id }) => {
    const served = after.get(id);
    const reason = served === undefined ? "is gone" : broken.get(id);
    const path = before?.byId.get(id)?.path ?? served?.path ?? `function ${id}`;
    return reason === undefined
      ? []
      : [
          `The workflow \`${name}\` (${workflow}) calls \`${path}\`, which ${reason} in this version.`,
        ];
  });
  if (issues.length > 0) {
    throw versionErrors.create("version.functions_in_use", {
      issues: issues.slice(0, namedMax),
    });
  }
  return [...after.keys()].filter((id) => !broken.has(id));
};

/**
 * That every live workflow's binding grant (`boundSql`) on App `app`'s functions names
 * one of `served`, as SQL: what the statement making a version current
 * holds to, so a grant landing after `requireBoundFunctionsServed` read
 * them keeps it from switching.
 */
export const boundFunctionsServedSql = (
  app: AppId,
  served: readonly string[]
): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM permissions AS bound
    WHERE ${boundSql(app, "bound")}
      AND bound.resource NOT IN (SELECT value FROM json_each(${JSON.stringify(served)})))`;

/** A refusal of a permission's function, saying why. */
const functionIssue = (message: string) =>
  permissionErrors.create("permission.invalid", {
    issues: [`object.function: ${message}`],
  });

/**
 * Refuses a workflow's permission on function `id` of App `app` unless
 * the App's current version gives a query or mutation that ID: no grant
 * names an ID that stands for nothing, nor an action, which reaches
 * outside systems (workflows/app-calls.ts) (`permission.invalid`).
 */
export const requireAppFunction = async (
  env: Env,
  app: AppId,
  id: string
): Promise<void> => {
  const { currentVersion } = await findApp(env, app);
  if (currentVersion === null) {
    throw functionIssue("The App has no current version, so no functions yet.");
  }
  const served = await servedOf(
    env,
    await loadRelease(env, app, currentVersion)
  );
  const operation = served.get(id);
  if (operation === undefined) {
    throw functionIssue("The App's current version gives no function this ID.");
  }
  if (operation.kind === "action") {
    throw functionIssue(
      "A workflow calls an App's queries and mutations, never its actions."
    );
  }
};

/**
 * The paths App `app`'s current version gives its functions, by ID: the
 * readable hint a permission on one of them carries (permissions-open.ts).
 * None for an App with no current version, or one whose definition can't
 * be read.
 */
export const currentFunctionNames = async (
  env: Env,
  app: AppId
): Promise<ReadonlyMap<string, string>> => {
  try {
    const { currentVersion } = await findApp(env, app);
    if (currentVersion === null) {
      return new Map();
    }
    const { definition } = await readStored(
      await findVersion(env, app, currentVersion)
    );
    return new Map(
      (definition.functions ?? []).map(({ id, name }) => [id, name])
    );
  } catch (error) {
    if (isExpectedError(error)) {
      return new Map();
    }
    throw error;
  }
};
