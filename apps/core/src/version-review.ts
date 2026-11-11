import { appCodeFiles } from "@grasp-os/compiler";
import {
  ownFiles,
  declaredPermission,
  declaredPermissions,
  descriptorFromText,
} from "@grasp-os/runtime/host";
import type {
  AppManifest,
  RowRule,
  WorkflowBindingExtras,
} from "@grasp-os/runtime/host";
import type {
  ReviewChange,
  TableRowRules,
  VersionReview,
} from "@grasp-os/shared/apps";
import { workspaceIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { definitionPlan } from "./app-definition.ts";
import {
  isSealed,
  loadRelease,
  sealedEvidence,
  versionManifest,
} from "./app-releases.ts";
import {
  appFor,
  findVersion,
  readStored,
  toVersion,
  versionFiles,
} from "./apps.ts";
import type { VersionRow } from "./apps.ts";
import type { Member } from "./auth/identity.ts";
import { sealedWorkflowPins } from "./bound-workflows.ts";
import {
  appWorkflowBindings,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { workspace } from "./durable-objects.ts";
import { permissionsOpenTo } from "./permissions-open.ts";
import { askedAgainBy } from "./permissions.ts";
import { takesFile } from "./workflows/start-files.ts";

// What a version changes, for the builder who reviews it before making
// it current: worked out here from the version and the App as they are
// now, never taken from whoever proposed it (the chat's agent, say), so a
// proposal can't describe itself as less than it is. Against the current
// version: who proposed it, its files and server code, its migrations,
// what the App asks for that no admin granted yet, what it holds, and
// which of that making it current would ask an admin for again. What it
// may reach is what it declares (its manifest), each binding approved for
// that declaration: no code is read to say what it calls.

/** The input of a bound workflow version's contract. */
const boundContractSchema = z.object({ input: z.json() });

/**
 * Whether any workflow version `proposed` of App `app` may bind once
 * current takes a file in its input, as that version's contract says:
 * what its release seals, sealed or not (bound-workflows.ts,
 * `sealedWorkflowPins`), so a binding the version records counts as it
 * will bind, and what the App binds now.
 */
const boundTakesFile = async (
  env: Env,
  app: AppId,
  proposed: { version: number },
  manifest: AppManifest
): Promise<boolean> => {
  let pins: readonly WorkflowBindingExtras[];
  if (await isSealed(env, app, proposed.version)) {
    ({ workflows: pins } = await loadRelease(env, app, proposed.version));
  } else {
    const { definition } = await readStored(
      await findVersion(env, app, proposed.version)
    );
    pins = await sealedWorkflowPins(env, app, manifest, definition);
  }
  // And what the App binds now under each alias the version declares: a
  // binding of the same contract made since its seal stays bound
  // (app-workflow-bindings.ts, `versionBindingChanges`).
  const declared = new Set(
    declaredPermissions(manifest, "workflows").map(({ alias }) => alias)
  );
  const active = await drizzle(env.DB)
    .select({
      alias: appWorkflowBindings.alias,
      workflowId: appWorkflowBindings.workflowResourceId,
      version: appWorkflowBindings.workflowResourceVersion,
    })
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.appId, app),
        eq(appWorkflowBindings.status, "active")
      )
    );
  const bound = [
    ...pins.map(({ pinned }) => pinned),
    ...active.filter(({ alias }) => declared.has(alias)),
  ];
  // One read for every distinct workflow version, however many bindings
  // name it: the pins and the active bindings often name the same ones.
  const pairs = [
    ...new Map(
      bound.map(({ workflowId, version }) => [
        `${workflowId}@${version}`,
        [workflowId, version] as const,
      ])
    ).values(),
  ];
  if (pairs.length === 0) {
    return false;
  }
  const rows = await drizzle(env.DB)
    .select({ contract: workflowResourceVersions.contract })
    .from(workflowResourceVersions)
    .where(
      sql`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(pairs)}) AS pair
        WHERE ${workflowResourceVersions.workflowResourceId} = json_extract(pair.value, '$[0]')
        AND ${workflowResourceVersions.version} = json_extract(pair.value, '$[1]'))`
    );
  for (const row of rows) {
    const parsed =
      row.contract === null
        ? undefined
        : boundContractSchema.safeParse(JSON.parse(row.contract));
    if (
      parsed?.success === true &&
      takesFile(descriptorFromText(JSON.stringify(parsed.data.input)))
    ) {
      return true;
    }
  }
  return false;
};

/**
 * The row rules of version `proposed`'s tables (`VersionReview.rowRules`),
 * as its schema's manifest holds them: what the store will enforce, read
 * from the version, never from what its proposer says of it. Null when
 * its manifest can't be read.
 */
const rowRulesOf = async (
  env: Env,
  app: AppId,
  proposed: { version: number; files: Readonly<Record<string, string>> }
): Promise<TableRowRules[] | null> => {
  let manifest: AppManifest;
  try {
    manifest = await versionManifest(
      env,
      app,
      proposed.version,
      proposed.files
    );
  } catch (error) {
    log.warn("version_review.manifest_unread", errorFields(error));
    return null;
  }
  return Object.entries(manifest.schema.tables)
    .filter(([, table]) => table.rules !== undefined)
    .map(([table, { rules, access }]) => {
      // Who changes its rows, as the store holds writes: its write rules;
      // without them its read rules, for a write mode that reaches every
      // row; under `owner` the owner (of the rows they can read, the
      // review says), and under `none` nobody.
      const writeRules = (): readonly RowRule[] | undefined => {
        if (access.write === "none") {
          return undefined;
        }
        if (access.write === "owner") {
          return rules?.read === undefined ? undefined : [{ kind: "owner" }];
        }
        return rules?.write ?? rules?.read;
      };
      const write = writeRules();
      return {
        table,
        read: rules?.read === undefined ? null : [...rules.read],
        write: write === undefined ? null : [...write],
      };
    });
};

/**
 * Whether version `proposed` may hand files people can read to the
 * workflows it binds (`VersionReview.handsFilesToWorkflows`): a boundary
 * its reviewer sees, whatever else changed. Null when its manifest can't
 * be read.
 */
const handsFilesOf = async (
  env: Env,
  app: AppId,
  proposed: { version: number; files: Readonly<Record<string, string>> }
): Promise<boolean | null> => {
  let manifest: AppManifest;
  try {
    manifest = await versionManifest(
      env,
      app,
      proposed.version,
      proposed.files
    );
  } catch (error) {
    log.warn("version_review.manifest_unread", errorFields(error));
    return null;
  }
  const readsFiles =
    declaredPermission(manifest, "files", "files")?.operations.includes(
      "read"
    ) === true;
  if (!readsFiles) {
    return false;
  }
  const workflows = declaredPermissions(manifest, "workflows");
  if (workflows.some(({ args }) => takesFile(args))) {
    return true;
  }
  // What a start hands is copied by the bound workflow's own input
  // (`handFiles`), whatever the App declares for its alias: read from
  // the version each alias is bound to once this version is current.
  return await boundTakesFile(env, app, proposed, manifest);
};

/**
 * Whether version `proposed` reads the organization's people
 * (`VersionReview.readsPeople`): every member's name, email and teams. Null
 * when its manifest can't be read.
 */
const readsPeopleOf = async (
  env: Env,
  app: AppId,
  proposed: { version: number; files: Readonly<Record<string, string>> }
): Promise<boolean | null> => {
  try {
    const manifest = await versionManifest(
      env,
      app,
      proposed.version,
      proposed.files
    );
    return declaredPermission(manifest, "people", "people") !== undefined;
  } catch (error) {
    log.warn("version_review.manifest_unread", errorFields(error));
    return null;
  }
};

/**
 * The explicit migrations of version `proposed` the current version
 * (`before`) doesn't have as they are (see `VersionReview.migrations`),
 * read from each version's App manifest, so wherever and however they
 * are declared or registered; every one when there is no current
 * version. A migration declared the same counts as modified when the
 * server code changed (`serverChanged`): its transform may run any of it.
 * Null when either manifest can't be read.
 */
const migrationsOf = async (
  env: Env,
  app: AppId,
  proposed: { version: number; files: Readonly<Record<string, string>> },
  before:
    | { version: number; files: Readonly<Record<string, string>> }
    | undefined,
  serverChanged: boolean
): Promise<VersionReview["migrations"]> => {
  let next: AppManifest;
  let previous: AppManifest | undefined;
  let evidence: Awaited<ReturnType<typeof sealedEvidence>>;
  try {
    next = await versionManifest(env, app, proposed.version, proposed.files);
    evidence = await sealedEvidence(env, app, proposed.version);
    previous =
      before === undefined
        ? undefined
        : await versionManifest(env, app, before.version, before.files);
  } catch (error) {
    log.warn("version_review.migrations_unread", errorFields(error));
    return null;
  }
  const had = previous?.migrations ?? {};
  const listed: NonNullable<VersionReview["migrations"]> = [];
  for (const declared of Object.values(next.migrations)) {
    const old = Object.hasOwn(had, declared.name)
      ? had[declared.name]
      : undefined;
    const { name, table } = declared;
    const found = evidence?.find(({ migration }) => migration === name);
    const checked = {
      fixtures: declared.fixtures.length,
      fixturesPassed: found === undefined ? null : found.passed,
    };
    if (old === undefined) {
      listed.push({ name, table, change: "added", ...checked });
    } else if (
      canonicalText(old) !== canonicalText(declared) ||
      serverChanged
    ) {
      listed.push({ name, table, change: "modified", ...checked });
    }
  }
  return listed;
};

/**
 * How an App's server code changed (`appCodeFiles`: what its seal
 * builds), from its files that did (`changes`)
 * and how many there were before and are now: added from none, removed
 * to none, modified otherwise; null when none changed.
 */
const serverChangeOf = (
  changes: readonly unknown[],
  before: number,
  now: number
): ReviewChange | null => {
  if (changes.length === 0) {
    return null;
  }
  if (before === 0) {
    return "added";
  }
  return now === 0 ? "removed" : "modified";
};

/** How `now` differs from `before`, or undefined when it doesn't. */
const changeOf = <T>(
  before: T | undefined,
  now: T | undefined,
  same: (one: T, other: T) => boolean
): ReviewChange | undefined => {
  if (before === undefined) {
    return now === undefined ? undefined : "added";
  }
  if (now === undefined) {
    return "removed";
  }
  return same(before, now) ? undefined : "modified";
};

/** The keys of both maps, sorted, with how each differs. */
const differences = <T>(
  before: ReadonlyMap<string, T>,
  now: ReadonlyMap<string, T>,
  same: (one: T, other: T) => boolean
): {
  name: string;
  change: ReviewChange;
  now: T | undefined;
  before: T | undefined;
}[] =>
  [...new Set([...before.keys(), ...now.keys()])].toSorted().flatMap((name) => {
    const change = changeOf(before.get(name), now.get(name), same);
    return change === undefined
      ? []
      : [{ name, change, now: now.get(name), before: before.get(name) }];
  });

/** The chat's agent that proposed `row`, with its chat's title for them. */
const proposerOf = async (
  env: Env,
  by: Member,
  { proposedBy }: VersionRow
): Promise<VersionReview["proposedBy"]> => {
  if (proposedBy === null) {
    return null;
  }
  const workspaceId = workspaceIdSchema.safeParse(proposedBy.workspaceId);
  const ownChat = by.userId === proposedBy.onBehalfOf;
  const chatTitle =
    ownChat && workspaceId.success
      ? await workspace(env, workspaceId.data).chatTitle(
          proposedBy.chatId,
          by.userId
        )
      : null;
  return { ...proposedBy, ownChat, chatTitle };
};

/**
 * Whether version `row`'s definition differs from the current version's
 * (`current`, none while none is), and what that does to the records
 * (`schema`, the store's plan). The definition is no file: a change of it
 * alone (two fields' IDs swapped, say) changes no code, yet moves the
 * records' values as the version is made current, so it counts as a
 * change of the server code.
 */
const definitionReviewOf = async (
  row: VersionRow,
  current: VersionRow | undefined
): Promise<{ changed: boolean; schema: VersionReview["schema"] }> => {
  const changed = row.definitionHash !== current?.definitionHash;
  if (!changed) {
    return { changed, schema: null };
  }
  const { definition } = await readStored(row);
  const held = current === undefined ? null : await readStored(current);
  return {
    changed,
    schema: definitionPlan(held?.definition ?? null, definition),
  };
};

/** What version `version` of App `app` changes, for its builders. */
export const reviewVersion = async (
  env: Env,
  by: Member,
  app: unknown,
  version: unknown
): Promise<VersionReview> => {
  const found = await appFor(env, by, app, "builder");
  const row = await findVersion(env, found.id, version);
  const files = ownFiles(await versionFiles(env, found.id, row.version));
  const { currentVersion: current } = found;
  // The current version itself changes nothing against itself.
  const currentRow =
    current === null ? undefined : await findVersion(env, found.id, current);
  const before =
    currentRow === undefined
      ? undefined
      : {
          version: currentRow.version,
          files: ownFiles(
            await versionFiles(env, found.id, currentRow.version)
          ),
        };
  const fileChanges = differences(
    new Map(Object.entries(before?.files ?? {})),
    new Map(Object.entries(files)),
    (one, other) => one === other
  );
  const serverChanges = differences(
    new Map(Object.entries(appCodeFiles(before?.files ?? {}))),
    new Map(Object.entries(appCodeFiles(files))),
    (one, other) => one === other
  );
  const { changed: definitionChanged, schema } = await definitionReviewOf(
    row,
    currentRow
  );
  const codeChange = serverChangeOf(
    serverChanges,
    Object.keys(appCodeFiles(before?.files ?? {})).length,
    Object.keys(appCodeFiles(files)).length
  );
  let definitionChange: ReviewChange | null = null;
  if (definitionChanged) {
    definitionChange = currentRow === undefined ? "added" : "modified";
  }
  const server = codeChange ?? definitionChange;
  const migrations = await migrationsOf(
    env,
    found.id,
    { version: row.version, files },
    before,
    server !== null ||
      definitionChanged ||
      fileChanges.some(
        ({ name }) =>
          name === "grasp.config.ts" ||
          name === "values.ts" ||
          name.startsWith("server/")
      )
  );
  // Asked for again only if not kept, as `madeCurrent` says: an App's
  // first version copied from a blueprint, made current for the first time.
  const keep = current === null && row.approved === 1;
  // What the App holds, and the workflows' grants to call its functions,
  // which trust its code alike (`madeCurrent`), as the permissions API
  // shows them to this reviewer.
  const [held, callers] = await Promise.all([
    permissionsOpenTo(env, by, { type: "app", appId: found.id }, "active"),
    permissionsOpenTo(env, by, undefined, "active", found.id),
  ]);
  return {
    version: toVersion(row),
    proposedBy: await proposerOf(env, by, row),
    current,
    files: fileChanges.map(({ name, change }) => ({ path: name, change })),
    server,
    serverFiles: serverChanges.map(({ name, change }) => ({
      path: name,
      change,
    })),
    migrations,
    schema,
    handsFilesToWorkflows: await handsFilesOf(env, found.id, {
      version: row.version,
      files,
    }),
    readsPeople: await readsPeopleOf(env, found.id, {
      version: row.version,
      files,
    }),
    rowRules: await rowRulesOf(env, found.id, {
      version: row.version,
      files,
    }),
    // As the permissions API shows them to this reviewer, no more.
    permissions: await permissionsOpenTo(
      env,
      by,
      { type: "app", appId: found.id },
      "requested"
    ),
    grants: held.map((permission) => ({
      permission,
      askedAgain: askedAgainBy(by, permission, keep),
    })),
    callers: callers.map((permission) => ({
      permission,
      askedAgain: askedAgainBy(by, permission, keep),
    })),
  };
};
