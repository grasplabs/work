import type { FunctionManifest } from "@grasp-os/sdk/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Permissions } from "@grasp-os/workflow-schema/format";

import { loadRelease } from "./app-releases.ts";
import { releaseFunctionsOf, usableApp } from "./apps.ts";
import type { Acting } from "./auth/identity.ts";

// What a workflow's App permissions (`permissions.apps`, GRA-1663) name,
// as each App's current version has it, for whoever saves or publishes
// the workflow: the queries and mutations it gives a stable ID.
// Publication refuses a function an App doesn't give (anymore), and the
// typed check types a call's result by what the function returns.
//
// Read as that person, through their role in the App (`usableApp`): an
// App they can't use gives them no function at all, so the document's
// check says nothing of an App they can't see but that its function
// isn't one they may name. Whether a run may call it is decided per call,
// on the workflow's own grant (workflows/app-calls.ts). Nothing here
// names a build's members: those are the document's own hints, so a build
// is the definition's alone.

/**
 * The public queries and mutations App `app`'s current version gives
 * stable IDs, by ID, as `by` may use the App: none for anyone without a
 * role in it (or nobody, a blueprint's check), an ID that isn't an App's,
 * an App with no current version, or one whose release can't be read.
 */
const callableFunctionsOf = async (
  env: Env,
  by: Acting | undefined,
  app: string
): Promise<ReadonlyMap<string, FunctionManifest>> => {
  if (by === undefined) {
    return new Map();
  }
  try {
    const { id, currentVersion } = await usableApp(env, by, app);
    if (currentVersion === null) {
      return new Map();
    }
    const release = await loadRelease(env, id, currentVersion);
    const callable = new Map<string, FunctionManifest>();
    for (const [fn, path] of await releaseFunctionsOf(env, release)) {
      const operation = Object.hasOwn(release.app.operations, path)
        ? release.app.operations[path]
        : undefined;
      if (operation?.visibility === "public" && operation.kind !== "action") {
        callable.set(fn, operation);
      }
    }
    return callable;
  } catch (error) {
    if (isExpectedError(error)) {
      return new Map();
    }
    throw error;
  }
};

/** Whether `value` is a JSON object, as parsed. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `source`, a workflow's document as text, with each App function's path
 * hint (`permissions.apps.<alias>.functions.<id>`) as the App's current
 * version names that function, for `by`: so after a rename, the next save
 * shows, and the next build calls, the function by its new name, while
 * what is called stays its ID. The text as given when nothing changed, or
 * when it isn't a document with App permissions. When a name changed, the
 * document is written again as `JSON.stringify` writes it, two spaces
 * deep: drafts are written by the canvas and the chat, never kept for
 * their layout, and JSON keeps every value (a number as it reads back),
 * so only the layout of hand-typed text changes, and only on a rename.
 */
export const withCurrentFunctionNames = async (
  env: Env,
  by: Acting,
  source: string
): Promise<string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return source;
  }
  const apps =
    isObject(parsed) && isObject(parsed.permissions)
      ? parsed.permissions.apps
      : undefined;
  if (!isObject(apps)) {
    return source;
  }
  let renamed = false;
  for (const permission of Object.values(apps)) {
    const functions = isObject(permission) ? permission.functions : undefined;
    if (
      !isObject(permission) ||
      typeof permission.app !== "string" ||
      !isObject(functions)
    ) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a few Apps, one at a time
    const callable = await callableFunctionsOf(env, by, permission.app);
    for (const [id, operation] of callable) {
      if (Object.hasOwn(functions, id) && functions[id] !== operation.path) {
        functions[id] = operation.path;
        renamed = true;
      }
    }
  }
  return renamed ? JSON.stringify(parsed, null, 2) : source;
};

/** Each App permission's callable functions, by its alias, as `by` may use them. */
export const permittedFunctionsOf = async (
  env: Env,
  by: Acting | undefined,
  apps: Permissions["apps"]
): Promise<ReadonlyMap<string, ReadonlyMap<string, FunctionManifest>>> =>
  new Map(
    await Promise.all(
      Object.entries(apps ?? {}).map(
        async ([alias, { app }]) =>
          [alias, await callableFunctionsOf(env, by, app)] as const
      )
    )
  );
