import {
  isAppLayout,
  isAppTestSuite,
  workflowIdOf,
  workflowPaths,
} from "@grasp-os/compiler";
import { appLimits } from "@grasp-os/shared/app-limits";
import { versionErrors } from "@grasp-os/shared/app-releases";
import {
  appErrors,
  appVersionSchema,
  commitMessageSchema,
  fileChangesSchema,
  newAppSchema,
} from "@grasp-os/shared/apps";
import type {
  App,
  AppContents,
  CurrentExports,
  AppFiles,
  AppRole,
  AppVersion,
  CommittedVersion,
  FileDiff,
} from "@grasp-os/shared/apps";
import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId, BlueprintId, WorkflowId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { requireBuilder } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { screenPath } from "@grasp-os/shared/screens";
import { dataErrors } from "@grasp-os/shared/stores";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { WorkflowCalls } from "@grasp-os/shared/workflows";
import { waitUntil } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  appsFoundBy,
  requireAppRole,
  requireNotArchived,
} from "./app-access.ts";
import type { Person } from "./app-access.ts";
import { exportsIn } from "./app-exports.ts";
import {
  auditedBatch,
  outboxed,
  outboxedEventWhere,
  outboxedIfChanged,
  outboxedWhere,
  storedEvent,
} from "./audit-outbox.ts";
import type { Acting, Member } from "./auth/identity.ts";
import {
  appCandidateReports,
  appCandidates,
  appVersions,
  apps,
  auditOutbox,
  businessStores,
  sdkReleaseManifests,
  sdkResourceBindings,
} from "./db/core/schema.ts";
import { isTransientD1Error, isUniqueViolation } from "./db/d1.ts";
import { appMemoryPath, requireWithinLimit } from "./knowledge/memory-files.ts";
import { appBindingKinds, madeCurrent } from "./permissions.ts";
import { buildOnSave } from "./save-builds.ts";
import { recordVersionBuilds } from "./screen-builds.ts";
import { requireStoreSchemaActive } from "./store-backfill.ts";
import { liveStoreSql } from "./store-deletion.ts";
import {
  requireWorkflowTestsPass,
  workflowCallsIn,
  workflowIdsIn,
} from "./workflows/code.ts";
import {
  registerTriggers,
  registrationHolds,
  triggerRegistration,
  triggerSummary,
} from "./workflows/trigger-registry.ts";

// The App registry and each App's code. The registry and the versions are
// rows in the core database. A version's files are one object in R2 (EU),
// `apps/<app>/trees/<sha256>.json`: canonical JSON by path, stored under
// its own SHA-256, which the version row names. Reading a version is one
// read, checked against the hash.
//
// A tree is only ever written under its own hash and version rows never
// change, so a version's files stay exactly as committed whatever happens
// to the App later. The tree is stored before the row that names it, so a
// row never names a missing tree. A commit refused as a conflict can leave
// its tree named by no version: rare, and one version's size at most.
//
// Versions are linear: each commit is the latest version with its changes
// over it, as the next number. Two commits at once both try the same
// number, and the database keeps one; the other is refused as a conflict.

export type AppRow = typeof apps.$inferSelect;
export type VersionRow = typeof appVersions.$inferSelect;

/** A tree as `commitFiles` stores it. */
const storedTreeSchema = z.record(z.string(), z.string());

/** Most versions one `listVersions` call returns. */
const versionsPerPage = 100;

const treeKey = (app: AppId, tree: string): string =>
  `apps/${app}/trees/${tree}.json`;

/** A built-in blueprint's code (app-blueprints.ts), stored as a version's is. */
const blueprintTreeKey = (blueprint: BlueprintId, tree: string): string =>
  `blueprints/${blueprint}/trees/${tree}.json`;

/** The files stored under `key`, checked against the hash `tree`. */
const readTreeAt = async (
  env: Env,
  key: string,
  tree: string
): Promise<Map<string, string>> => {
  const object = await env.FILES.get(key);
  const text = await object?.text();
  if (text === undefined || (await sha256Hex(text)) !== tree) {
    throw new Error(`Tree ${key} is missing or damaged`);
  }
  return new Map(Object.entries(storedTreeSchema.parse(JSON.parse(text))));
};

/** A version's files, checked against the hash that names them. */
const readTree = async (
  env: Env,
  app: AppId,
  tree: string
): Promise<Map<string, string>> =>
  await readTreeAt(env, treeKey(app, tree), tree);

/**
 * A blueprint's files, checked against the hash that names them: a marked
 * one's are its version's, stored once under its App (versions are never
 * deleted, so neither are they); a built-in's are its own.
 */
export const blueprintFiles = async (
  env: Env,
  { id, appId, tree }: { id: BlueprintId; appId: AppId | null; tree: string }
): Promise<Map<string, string>> =>
  await readTreeAt(
    env,
    appId === null ? blueprintTreeKey(id, tree) : treeKey(appId, tree),
    tree
  );

export const toApp = (row: AppRow): App => ({
  id: appIdSchema.parse(row.id),
  name: row.name,
  description: row.description,
  owner: row.ownerId,
  blueprint: row.blueprint,
  currentVersion: row.currentVersion,
  pendingVersion: row.pendingVersion,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});

export const toVersion = (row: VersionRow): AppVersion => ({
  app: appIdSchema.parse(row.appId),
  version: row.version,
  parent: row.parent,
  tree: row.tree,
  files: row.files,
  author: row.authorId,
  message: row.message,
  createdAt: row.createdAt.toISOString(),
  proposedBy: row.proposedBy ?? null,
});

/** The audit entry of a change to `app` by `by`: identifiers only. */
export const changeEntry = (
  by: Pick<Acting, "userId" | "staff" | "actor">,
  action:
    | "app.created"
    | "app.committed"
    | "app.version.proposed"
    | "app.version.current"
    | "app.candidates.superseded"
    | "app.candidate.frozen"
    | "app.candidate.moved"
    | "app.candidate.claimed"
    | "app.blueprint.marked"
    | "app.blueprint.unmarked",
  app: AppId,
  detail: Record<string, AuditDetailValue>
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action,
  target: { type: "app", id: app },
  detail,
});

/** The App `input` names, which must exist. */
export const findApp = async (env: Env, input: unknown): Promise<App> => {
  const id = appIdSchema.safeParse(input);
  const row = id.success
    ? await drizzle(env.DB)
        .select()
        .from(apps)
        .where(eq(apps.id, id.data))
        .get()
    : undefined;
  if (!row) {
    throw appErrors.create("app.not_found");
  }
  return toApp(row);
};

/**
 * The App `input` names, for `by` with at least `needed` in it
 * (app-access.ts).
 */
export const appFor = async (
  env: Env,
  by: Person,
  input: unknown,
  needed: AppRole
): Promise<App> => {
  const app = await findApp(env, input);
  await requireAppRole(env, by, app, needed);
  return app;
};

/**
 * The App `input` names, for `by` with at least `needed` in it, to use:
 * open its screens, call it or start its runs. An archived App is
 * refused (`app.archived`), its builders' too (app-access.ts).
 */
export const usableApp = async (
  env: Env,
  by: Person,
  input: unknown,
  needed: AppRole = "user"
): Promise<App> => {
  const app = await appFor(env, by, input, needed);
  requireNotArchived(app);
  return app;
};

/**
 * The App `input` names, for one of its builders to change: its code, its
 * versions, whom it is shared with, its bindings, its builds. An archived
 * App is read-only (`app.archived`), until a builder restores it.
 */
export const editableApp = async (
  env: Env,
  by: Person,
  input: unknown
): Promise<App> => {
  const app = await appFor(env, by, input, "builder");
  requireNotArchived(app);
  return app;
};

/**
 * That App `app` is archived when the statement runs, as SQL: for a write
 * an earlier `editableApp` let in, so an archive committed since stops it
 * (app-status.ts).
 */
const archivedNow = (app: string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${apps} WHERE ${apps.id} = ${app} AND ${apps.status} = 'archived')`;

/** The number of an App's latest version; null while it has none. */
export const latestVersion = async (
  env: Env,
  app: AppId
): Promise<number | null> => {
  const row = await drizzle(env.DB)
    .select({ version: appVersions.version })
    .from(appVersions)
    .where(eq(appVersions.appId, app))
    .orderBy(desc(appVersions.version))
    .limit(1)
    .get();
  return row?.version ?? null;
};

/**
 * The version of `app` over `parent` whose files are `tree` and that build
 * job `job` of chat `chatId` proposed, if there is one: what the job
 * recorded it was about to commit, found committed (build-jobs.ts). Never
 * another commit of the same files, from the same chat or not.
 */
export const proposedByJob = async (
  env: Env,
  app: string,
  { parent, tree }: { parent: number | null; tree: string },
  { chatId, jobId }: { chatId: string; jobId: string }
): Promise<number | undefined> => {
  const version = (parent ?? 0) + 1;
  const row = await drizzle(env.DB)
    .select({ tree: appVersions.tree, proposedBy: appVersions.proposedBy })
    .from(appVersions)
    .where(and(eq(appVersions.appId, app), eq(appVersions.version, version)))
    .get();
  return row?.tree === tree &&
    row.proposedBy?.chatId === chatId &&
    row.proposedBy.jobId === jobId
    ? version
    : undefined;
};

/** One of an App's versions, which must exist. */
export const findVersion = async (
  env: Env,
  app: AppId,
  input: unknown
): Promise<VersionRow> => {
  const version = appVersionSchema.safeParse(input);
  const row = version.success
    ? await drizzle(env.DB)
        .select()
        .from(appVersions)
        .where(
          and(eq(appVersions.appId, app), eq(appVersions.version, version.data))
        )
        .get()
    : undefined;
  if (!row) {
    throw appErrors.create("app.version_not_found");
  }
  return row;
};

interface Size {
  files: number;
  /** Characters in all files together. */
  length: number;
}

const sizeOf = (files: ReadonlyMap<string, string>): Size => {
  let length = 0;
  for (const content of files.values()) {
    length += content.length;
  }
  return { files: files.size, length };
};

/** An App's latest version, if it has one, and its files. */
const latestFiles = async (env: Env, app: AppId) => {
  const latest = await drizzle(env.DB)
    .select()
    .from(appVersions)
    .where(eq(appVersions.appId, app))
    .orderBy(desc(appVersions.version))
    .limit(1)
    .get();
  const files = latest
    ? await readTree(env, app, latest.tree)
    : new Map<string, string>();
  return { latest, files };
};

/**
 * `app.invalid` if two paths can't both exist on a disk: a file and a
 * folder of the same name (`a` and `a/b.ts`), or names of files or folders
 * that differ only in case (`App.ts` and `app.ts`, `components/` and
 * `Components/`), which a case-insensitive file system, and whoever reads
 * the code, can't tell apart. Only collisions with a path this write
 * `added` count, as with the limits: an App whose files already collide
 * can still be changed, and fixed.
 */
const checkPaths = (
  paths: Iterable<string>,
  added: ReadonlySet<string>
): void => {
  // Every name a path takes, as a file or a folder, by its lowercase form:
  // the first spelling, and the path that took it. Paths that were there
  // before come first, so a clash names the one the write adds.
  const taken = new Map<
    string,
    { spelling: string; file: boolean; path: string }
  >();
  const issues = new Set<string>();
  const ordered = [...paths].toSorted(
    (a, b) => Number(added.has(a)) - Number(added.has(b)) || (a < b ? -1 : 1)
  );
  for (const path of ordered) {
    const segments = path.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const spelling = segments.slice(0, depth).join("/");
      const file = depth === segments.length;
      const first = taken.get(spelling.toLowerCase());
      if (first === undefined) {
        taken.set(spelling.toLowerCase(), { spelling, file, path });
      } else if (
        (first.spelling !== spelling || first.file || file) &&
        added.has(path)
      ) {
        issues.add(
          first.file === file
            ? `${path}: Differs only in case from ${first.path}`
            : `${path}: A file and a folder of the same name, with ${first.path}`
        );
      }
    }
  }
  if (issues.size > 0) {
    throw appErrors.create("app.invalid", { issues: [...issues] });
  }
};

/**
 * `app.too_large` if `files` are over an App's limits. With `before`, a
 * draft's size before a write, only if they also grew: a draft that is
 * over them (from before they were lowered) can still shrink. A version
 * is always within them, so it always fits a build.
 */
const checkLimits = (
  files: ReadonlyMap<string, string>,
  before?: Size
): void => {
  const after = sizeOf(files);
  const over =
    after.files > appLimits.files || after.length > appLimits.totalLength;
  const grows =
    before === undefined ||
    after.files > before.files ||
    after.length > before.length;
  if (over && grows) {
    throw appErrors.create("app.too_large", {
      files: after.files,
      maxFiles: appLimits.files,
      length: after.length,
      maxLength: appLimits.totalLength,
    });
  }
};

/**
 * `knowledge.memory_too_large` if the App's AGENTS.md, which agents
 * working on the App have in their context (knowledge/memory.ts), is over
 * its limit, and only if it also grew, as with `checkLimits`.
 */
const checkMemory = (
  env: Env,
  before: string | undefined,
  after: string | undefined
): void => {
  const grew =
    after !== undefined &&
    (before === undefined || after.length > before.length);
  if (grew) {
    requireWithinLimit(env, "AGENTS.md", after);
  }
};

/** A version's files as stored: canonical JSON, and its SHA-256. */
interface Tree {
  tree: string;
  json: string;
}

/**
 * `files` as a version's tree, or `app.too_large` if they are over an
 * App's limits: a version always fits them.
 */
export const versionTree = async (
  files: ReadonlyMap<string, string>
): Promise<Tree> => {
  checkLimits(files);
  const json = canonicalJson(Object.fromEntries(files));
  return { tree: await sha256Hex(json), json };
};

/**
 * The hash of `files`' code: their tree without AGENTS.md, which an App's
 * agents write as they learn and nothing builds or runs. Two versions of
 * the same code have the same hash, whatever their AGENTS.md: what the
 * release vouches for in a built-in blueprint (app-blueprints.ts).
 */
export const codeIdentity = async (
  files: ReadonlyMap<string, string>
): Promise<string> => {
  const code = new Map(files);
  code.delete(appMemoryPath);
  return await sha256Hex(canonicalJson(Object.fromEntries(code)));
};

/** Stores a tree under its hash, before any version row names it. */
export const storeTree = async (
  env: Env,
  app: AppId,
  { tree, json }: Tree
): Promise<void> => {
  // R2 checks the upload against its hash, so what's stored is what's named.
  await env.FILES.put(treeKey(app, tree), json, { sha256: tree });
};

/** Stores a blueprint's tree under its hash, before its row names it. */
export const storeBlueprintTree = async (
  env: Env,
  blueprint: BlueprintId,
  { tree, json }: Tree
): Promise<void> => {
  await env.FILES.put(blueprintTreeKey(blueprint, tree), json, {
    sha256: tree,
  });
};

/**
 * Deletes every tree stored for `blueprint` but `kept`, the one its row
 * names: the trees of its earlier releases, which nothing reads once the
 * row has moved on (Apps created from it hold their own copies).
 */
export const deleteOtherBlueprintTrees = async (
  env: Env,
  blueprint: BlueprintId,
  kept: string
): Promise<void> => {
  const keptKey = blueprintTreeKey(blueprint, kept);
  const prefix = `blueprints/${blueprint}/trees/`;
  let cursor: string | undefined = undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    const listed: R2Objects = await env.FILES.list({ prefix, cursor });
    const others = listed.objects
      .map(({ key }) => key)
      .filter((key) => key !== keptKey);
    if (others.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await env.FILES.delete(others);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
};

/** The files of one of an App's versions. For the runtime and the compiler. */
export const versionFiles = async (
  env: Env,
  app: AppId,
  version: unknown
): Promise<AppFiles> => {
  const row = await findVersion(env, app, version);
  return Object.fromEntries(await readTree(env, app, row.tree));
};

/** Creates an App, with no versions yet. */
export const createApp = async (
  env: Env,
  by: Acting,
  input: unknown,
  /** Admits the write, called right before it is committed: throws to refuse it. */
  admit?: () => Promise<void>
): Promise<App> => {
  requireBuilder(by);
  const { name, description, blueprint } = appErrors.parse(
    "app.invalid",
    newAppSchema,
    input
  );
  const row: AppRow = {
    id: crypto.randomUUID(),
    name,
    description,
    ownerId: by.userId,
    blueprint: blueprint ?? null,
    currentVersion: null,
    pendingVersion: null,
    status: "draft",
    statusChangedAt: null,
    statusChangedBy: null,
    createdAt: new Date(),
  };
  const app = toApp(row);
  const db = drizzle(env.DB);
  // Admitted last, with nothing slow left before the write.
  await admit?.();
  await auditedBatch(env, db, [
    db.insert(apps).values(row),
    outboxed(
      db,
      changeEntry(by, "app.created", app.id, { blueprint: row.blueprint })
    ),
  ]);
  return app;
};

/** The Apps `by` has a role in (app-access.ts), oldest first. */
export const listApps = async (env: Env, by: Member): Promise<App[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(apps)
    .where(appsFoundBy(env, by))
    .orderBy(asc(apps.createdAt), asc(apps.id));
  return rows.map(toApp);
};

export const getApp = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<App> => await appFor(env, by, app, "user");

/** The names `nameOf` finds in `paths`, in their order. */
const namesIn = (
  paths: string[],
  nameOf: (path: string) => string | undefined
): string[] =>
  paths.flatMap((path) => {
    const name = nameOf(path);
    return name === undefined ? [] : [name];
  });

/**
 * The IDs of the workflows in a version's files, sorted: what its row
 * keeps (`app_versions.workflows`) when it is committed.
 */
export const workflowsIn = (files: ReadonlyMap<string, string>): string[] =>
  namesIn([...files.keys()].toSorted(), workflowIdOf);

/** The names of the screens in an App's files (`screens/<name>.tsx`), sorted. */
export const screensIn = (files: ReadonlyMap<string, string>): string[] =>
  namesIn(
    [...files.keys()].toSorted(),
    (path) => screenPath.exec(path)?.groups?.name
  );

/**
 * What a version's workflow calls of the App's bindings, as its row keeps
 * it (`app_versions.workflow_calls`, written from `workflowCallsIn` as the
 * version is committed): what its review shows (version-review.ts) and
 * what its runs are held to (workflows/host.ts). `undefined` when the row
 * keeps no entry for the workflow: nothing is read from its files instead.
 */
export const keptCallsOf = (
  workflowCalls: Record<string, WorkflowCalls>,
  workflow: WorkflowId
): WorkflowCalls | undefined =>
  Object.hasOwn(workflowCalls, workflow) ? workflowCalls[workflow] : undefined;

/**
 * What a run of `workflow` in version `version` of `app` is held to
 * (`keptCallsOf`). A version whose row keeps no entry for it doesn't run:
 * the run fails with `workflow.calls_not_kept`.
 */
export const callsFor = async (
  env: Env,
  {
    app,
    version,
    workflow,
  }: { app: AppId; version: number; workflow: WorkflowId }
): Promise<WorkflowCalls> => {
  const { workflowCalls } = await findVersion(env, app, version);
  const kept = keptCallsOf(workflowCalls, workflow);
  if (kept === undefined) {
    throw workflowErrors.create("workflow.calls_not_kept");
  }
  // A row kept before kinds, models or keys were: none of them, so every
  // reviewed step is refused as running another way (`stepRunsAs`), every
  // model call as asking a model its review doesn't show (`modelReviewed`)
  // and every keyed name (`stepReviewed`), each audited.
  return {
    ...kept,
    kinds: Object.hasOwn(kept, "kinds") ? kept.kinds : {},
    models: Object.hasOwn(kept, "models") ? kept.models : {},
    keyed: Object.hasOwn(kept, "keyed") ? kept.keyed : [],
  };
};

/** The screens and workflows of an App's current version. */
export const appContents = async (
  env: Env,
  by: Person,
  app: unknown
): Promise<AppContents> => {
  const { id, currentVersion } = await appFor(env, by, app, "user");
  if (currentVersion === null) {
    return { version: null, screens: [], workflows: [] };
  }
  const files = new Map(
    Object.entries(await versionFiles(env, id, currentVersion))
  );
  return {
    version: currentVersion,
    screens: screensIn(files),
    workflows: workflowsIn(files),
  };
};

/**
 * What an App's current version exports to other Apps, for anyone with a
 * role in it, people and the agent alike: read from its row alone, no
 * files.
 */
export const appExports = async (
  env: Env,
  by: Person,
  app: unknown
): Promise<CurrentExports> => {
  const { id, currentVersion } = await appFor(env, by, app, "user");
  if (currentVersion === null) {
    return { version: null, exports: {} };
  }
  const row = await findVersion(env, id, currentVersion);
  return { version: currentVersion, exports: row.exports };
};

/** An App's files at `version`, or at its latest version without one. */
export const readFiles = async (
  env: Env,
  by: Member,
  app: unknown,
  version?: unknown
): Promise<AppFiles> => {
  const { id: appId } = await appFor(env, by, app, "builder");
  if (version !== undefined) {
    return await versionFiles(env, appId, version);
  }
  const { files } = await latestFiles(env, appId);
  return Object.fromEntries(files);
};

/**
 * Applies changes (`FileChanges`: new content by path, or null to delete a
 * file) to an App's `files`, its latest version's or a chat's draft of it
 * (agent-builds.ts), refused as a whole when they would be over the App's
 * limits, hold paths that can't both exist, or an AGENTS.md over its
 * limit. The changes, checked.
 */
export const applyChanges = (
  env: Env,
  files: Map<string, string>,
  input: unknown
): [string, string | null][] => {
  const changes = Object.entries(
    appErrors.parse("app.invalid", fileChangesSchema, input)
  );
  const before = sizeOf(files);
  const agentsBefore = files.get(appMemoryPath);
  const added = new Set(
    changes.flatMap(([path, content]) =>
      content === null || files.has(path) ? [] : [path]
    )
  );
  for (const [path, content] of changes) {
    if (content === null) {
      files.delete(path);
    } else {
      files.set(path, content);
    }
  }
  checkLimits(files, before);
  checkPaths(files.keys(), added);
  checkMemory(env, agentsBefore, files.get(appMemoryPath));
  return changes;
};

/**
 * Ends every candidate of `app` for a version before `version` that is
 * still being checked as superseded, for `by`'s commit of `version`: the
 * statements, with their audit event, for the commit's batch.
 */
const supersededBy = (
  db: DrizzleD1Database,
  by: Identity,
  app: AppId,
  version: number
) =>
  [
    db
      .update(appCandidates)
      .set({
        state: "superseded",
        outcome: "app.committed",
        lease: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appCandidates.appId, app),
          lt(appCandidates.version, version),
          // Not a verified one: its checks are done, and it may be on its
          // way to current right now, its store switched already. A base
          // that moved is `makeCurrent`'s to refuse (app-candidates.ts,
          // `rejectStale`).
          inArray(appCandidates.state, [
            "frozen",
            "checking",
            "building",
            "verifying",
          ])
        )
      ),
    outboxedIfChanged(
      db,
      changeEntry(by, "app.candidates.superseded", app, { by: version })
    ),
  ] as const;

/**
 * Commits changes (new content by path, or null to delete a file) over an
 * App's latest version as its next version, by `by` with `message`.
 * Refused as a whole when the version would be over the App's limits. A
 * version committed meanwhile takes the number: `app.conflict`, and
 * nothing of this commit is kept.
 */
export const commitFiles = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown,
  message: unknown
): Promise<CommittedVersion> => {
  const { id: appId } = await editableApp(env, by, app);
  const text = appErrors.parse("app.invalid", commitMessageSchema, message);
  const { latest, files } = await latestFiles(env, appId);
  applyChanges(env, files, input);
  const { tree, json } = await versionTree(files);
  if (tree === latest?.tree) {
    throw appErrors.create("app.nothing_to_commit");
  }
  const exported = exportsIn(files);
  const workflowCalls = workflowCallsIn(Object.fromEntries(files));
  const workflowBindings = await appBindingKinds(env, appId);
  await storeTree(env, appId, { tree, json });

  const row: VersionRow = {
    appId,
    version: (latest?.version ?? 0) + 1,
    parent: latest?.version ?? null,
    tree,
    code: await codeIdentity(files),
    files: files.size,
    authorId: by.userId,
    message: text,
    createdAt: new Date(),
    approved: null,
    workflows: workflowsIn(files),
    workflowCalls,
    exports: exported,
    proposedBy: null,
    workflowBindings,
  };
  const db = drizzle(env.DB);
  let undone: unknown[];
  try {
    // Taken back in the same batch should the App have been archived
    // since `editableApp` let the commit in: nothing of it stays, and
    // nothing is audited.
    [, undone] = await auditedBatch(env, db, [
      db.insert(appVersions).values(row),
      db
        .delete(appVersions)
        .where(
          and(
            eq(appVersions.appId, appId),
            eq(appVersions.version, row.version),
            archivedNow(appId)
          )
        )
        .returning({ version: appVersions.version }),
      outboxedWhere(
        db,
        changeEntry(by, "app.committed", appId, {
          version: row.version,
          parent: row.parent,
          tree,
          files: row.files,
        }),
        sql`NOT ${archivedNow(appId)}`
      ),
      // A person's newer edit supersedes the open candidates of the
      // versions before it (spec 22.1): whatever runs one finds it ended
      // at its next move, and none is made current (app-candidates.ts).
      ...supersededBy(db, by, appId, row.version),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw appErrors.create("app.conflict");
    }
    throw error;
  }
  if (undone.length > 0) {
    throw appErrors.create("app.archived");
  }
  // Committed: now built, so the version opens without building, and
  // whoever saved hears what doesn't build (save-builds.ts). Built from
  // the files as the version reads back, paths in order, so a build says
  // the same here as at its first use.
  const saved = storedTreeSchema.parse(JSON.parse(json));
  const builds = await buildOnSave(env, {
    app: appId,
    version: row.version,
    files: saved,
    bindings: workflowBindings,
  });
  // What its screens build to, for what waits on an admin
  // (screen-builds.ts), in the background: only once they built just now,
  // so from the cache.
  // A build that failed, or didn't finish in its wait, isn't started again
  // here: it is recorded once it is made current, opened or reviewed.
  if (builds.screens.status === "ok") {
    waitUntil(recordVersionBuilds(env, appId, row.version, saved));
  }
  return { ...toVersion(row), builds };
};

/** A chat's draft of an App (agent-builds.ts), as a commit takes it. */
export interface DraftChanges {
  /** The version it began over; null for an App that had none. */
  base: number | null;
  /** New content by path, or null to delete a file. */
  changes: Record<string, string | null>;
}

/** A draft's files: its base version's, with its changes over them. */
export const draftFiles = async (
  env: Env,
  app: AppId,
  { base, changes }: DraftChanges
): Promise<Map<string, string>> => {
  const files = new Map(
    base === null ? [] : Object.entries(await versionFiles(env, app, base))
  );
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) {
      files.delete(path);
    } else {
      files.set(path, content);
    }
  }
  return files;
};

/** The files a draft commits, and the version they follow. */
export interface DraftOverLatest {
  parent: number | null;
  files: Map<string, string>;
}

/**
 * A chat's draft over the App's latest version: its changes over its base
 * while that is still the latest; otherwise over the latest, only if no
 * version since changed a path the draft changes (to other content):
 * `app.conflict` naming them, when one did. So a draft never undoes what
 * a builder committed after it began.
 */
export const draftOverLatest = async (
  env: Env,
  app: AppId,
  { base, changes }: DraftChanges
): Promise<DraftOverLatest> => {
  const { latest, files } = await latestFiles(env, app);
  const parent = latest?.version ?? null;
  if (parent !== base) {
    const baseRow =
      base === null ? undefined : await findVersion(env, app, base);
    const before =
      baseRow === undefined
        ? new Map<string, string>()
        : await readTree(env, app, baseRow.tree);
    const clashes = Object.entries(changes).flatMap(([path, content]) =>
      before.get(path) !== files.get(path) &&
      (content ?? undefined) !== files.get(path)
        ? [`${path}: Changed in a version committed since this draft began`]
        : []
    );
    if (clashes.length > 0) {
      throw appErrors.create("app.conflict", { issues: clashes.toSorted() });
    }
  }
  const added = new Set(
    Object.entries(changes).flatMap(([path, content]) =>
      content === null || files.has(path) ? [] : [path]
    )
  );
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) {
      files.delete(path);
    } else {
      files.set(path, content);
    }
  }
  // What builders committed since may clash with what the draft adds.
  checkPaths(files.keys(), added);
  return { parent, files };
};

/**
 * Commits a chat's draft (`draftOverLatest`) as the App's next version,
 * by `by` (the chat's agent, acting for its person, `by.via`) with
 * `message`, and puts it up for review, in one batch: it is never
 * committed without being proposed. Its files were built as they were
 * checked. A version committed meanwhile takes the number: `app.conflict`.
 */
export const proposeDraft = async (
  env: Env,
  by: Acting,
  app: unknown,
  { parent, files }: DraftOverLatest,
  message: unknown,
  /** Admits the write, called right before it is committed: throws to refuse it. */
  admit?: () => Promise<void>,
  /**
   * Statements the write's own transaction opens and closes with: one the
   * database refuses fails the whole write (a build job's lease, build-
   * admission.ts).
   */
  fence?: { open: BatchItem<"sqlite">; close: BatchItem<"sqlite"> }
): Promise<AppVersion> => {
  const { id: appId } = await editableApp(env, by, app);
  const text = appErrors.parse("app.invalid", commitMessageSchema, message);
  const { tree, json } = await versionTree(files);
  const latest =
    parent === null ? undefined : await findVersion(env, appId, parent);
  if (tree === latest?.tree) {
    throw appErrors.create("app.nothing_to_commit");
  }
  const exported = exportsIn(files);
  const workflowCalls = workflowCallsIn(Object.fromEntries(files));
  const workflowBindings = await appBindingKinds(env, appId);
  await storeTree(env, appId, { tree, json });
  const row: VersionRow = {
    appId,
    version: (parent ?? 0) + 1,
    parent,
    tree,
    code: await codeIdentity(files),
    files: files.size,
    authorId: by.userId,
    message: text,
    createdAt: new Date(),
    approved: null,
    workflows: workflowsIn(files),
    workflowCalls,
    exports: exported,
    proposedBy: by.via ?? null,
    workflowBindings,
  };
  const db = drizzle(env.DB);
  let undone: unknown;
  try {
    // Admitted last, with nothing slow left before the write.
    await admit?.();
    // Taken back in the same batch should the App have been archived since
    // `editableApp` let the draft in, as in `commitFiles`: no version, no
    // pending version, nothing audited.
    const write = [
      db.insert(appVersions).values(row),
      db
        .delete(appVersions)
        .where(
          and(
            eq(appVersions.appId, appId),
            eq(appVersions.version, row.version),
            archivedNow(appId)
          )
        )
        .returning({ version: appVersions.version }),
      outboxedWhere(
        db,
        changeEntry(by, "app.committed", appId, {
          version: row.version,
          parent,
          tree,
          files: row.files,
        }),
        sql`NOT ${archivedNow(appId)}`
      ),
      db
        .update(apps)
        .set({ pendingVersion: row.version })
        .where(and(eq(apps.id, appId), ne(apps.status, "archived"))),
      outboxedWhere(
        db,
        changeEntry(by, "app.version.proposed", appId, {
          version: row.version,
        }),
        sql`NOT ${archivedNow(appId)}`
      ),
    ] as const;
    const results: readonly unknown[] = await (fence === undefined
      ? auditedBatch(env, db, write)
      : auditedBatch(env, db, [fence.open, ...write, fence.close]));
    // The delete's rows: what an archive took back.
    undone = results.at(fence === undefined ? 1 : 2);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw appErrors.create("app.conflict");
    }
    throw error;
  }
  if (Array.isArray(undone) && undone.length > 0) {
    throw appErrors.create("app.archived");
  }
  return toVersion(row);
};

/** An App's versions, newest first, a page at a time. */
export const listVersions = async (
  env: Env,
  by: Member,
  app: unknown,
  before?: unknown
): Promise<AppVersion[]> => {
  const { id } = await appFor(env, by, app, "builder");
  const until =
    before === undefined
      ? undefined
      : appErrors.parse("app.invalid", appVersionSchema, before);
  const rows = await drizzle(env.DB)
    .select()
    .from(appVersions)
    .where(
      and(
        eq(appVersions.appId, id),
        until === undefined ? undefined : lt(appVersions.version, until)
      )
    )
    .orderBy(desc(appVersions.version))
    .limit(versionsPerPage);
  return rows.map(toVersion);
};

export const getVersion = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<AppVersion> => {
  const { id: appId } = await appFor(env, by, app, "builder");
  return toVersion(await findVersion(env, appId, version));
};

/** How the files of version `to` differ from those of `from`, by path. */
export const diffVersions = async (
  env: Env,
  by: Identity,
  app: unknown,
  from: unknown,
  to: unknown
): Promise<FileDiff[]> => {
  const { id: appId } = await appFor(env, by, app, "builder");
  const treeOf = async (version: unknown) => {
    const { tree } = await findVersion(env, appId, version);
    return await readTree(env, appId, tree);
  };
  const [before, after] = await Promise.all([treeOf(from), treeOf(to)]);
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  return paths.flatMap((path): FileDiff[] => {
    const old = before.get(path);
    const now = after.get(path);
    if (old === undefined) {
      return now === undefined ? [] : [{ path, change: "added", after: now }];
    }
    if (now === undefined) {
      return [{ path, change: "deleted", before: old }];
    }
    return old === now
      ? []
      : [{ path, change: "modified", before: old, after: now }];
  });
};

/** Puts a version up for review. The current version can't be. */
export const proposeVersion = async (
  env: Env,
  by: Acting,
  app: unknown,
  version: unknown
): Promise<App> => {
  const found = await editableApp(env, by, app);
  const appId = found.id;
  const { version: number } = await findVersion(env, appId, version);
  const db = drizzle(env.DB);
  const [[proposed]] = await auditedBatch(env, db, [
    db
      .update(apps)
      .set({ pendingVersion: number })
      .where(
        and(
          eq(apps.id, appId),
          // Archived since `editableApp` let it in: read-only now.
          ne(apps.status, "archived"),
          sql`${apps.pendingVersion} IS NOT ${number}`,
          sql`${apps.currentVersion} IS NOT ${number}`
        )
      )
      .returning(),
    outboxedIfChanged(
      db,
      changeEntry(by, "app.version.proposed", appId, { version: number })
    ),
  ]);
  if (!proposed) {
    // Pending or current already, or archived meanwhile: nothing changed,
    // nothing is recorded.
    const now = await findApp(env, appId);
    if (now.status === "archived") {
      throw appErrors.create("app.archived");
    }
    return now;
  }
  return toApp(proposed);
};

/**
 * Holds while `version` of `app` has a sealed release that isn't revoked
 * (app-releases.ts, release-retention.ts), and whose bound store, if any,
 * is neither deleted nor being deleted (data-stores.ts), as the statement
 * runs: a deletion marks the store closing first, in a statement of its
 * own that requires no current version to bind it, so of a deletion and
 * an activation of a version bound to the store, one wins.
 */
const runnableReleaseSql = (app: AppId, version: number) =>
  sql`EXISTS (SELECT 1 FROM sdk_release_manifests
    WHERE app_id = ${app} AND version = ${version} AND revoked_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM sdk_resource_bindings AS bound
      WHERE bound.resource_id = ${app} AND bound.resource_version = ${version}
        AND bound.kind = 'store'
        AND NOT ${liveStoreSql(sql`bound.target_id`, Date.now())})`;

/**
 * Refuses `version` of `app` unless it has a sealed release that isn't
 * revoked, on a store that isn't deleted: `version.not_sealed`,
 * `version.revoked` or `data.store_unavailable`.
 */
const requireRunnableRelease = async (
  env: Env,
  app: AppId,
  version: number
): Promise<void> => {
  const row = await drizzle(env.DB)
    .select({ revokedAt: sdkReleaseManifests.revokedAt })
    .from(sdkReleaseManifests)
    .where(
      and(
        eq(sdkReleaseManifests.appId, app),
        eq(sdkReleaseManifests.version, version)
      )
    )
    .get();
  if (row === undefined) {
    throw versionErrors.create("version.not_sealed");
  }
  if (row.revokedAt !== null) {
    throw versionErrors.create("version.revoked");
  }
  const goneStore = await drizzle(env.DB)
    .select({ store: sdkResourceBindings.targetId })
    .from(sdkResourceBindings)
    .where(
      and(
        eq(sdkResourceBindings.resourceId, app),
        eq(sdkResourceBindings.resourceVersion, version),
        eq(sdkResourceBindings.kind, "store"),
        sql`NOT ${liveStoreSql(sql`${sdkResourceBindings.targetId}`, Date.now())}`
      )
    )
    .get();
  if (goneStore !== undefined) {
    throw dataErrors.create("data.store_unavailable");
  }
};

/** Most tries of the batch that makes a version current. */
const currentBatchTries = 3;

/**
 * `batch`, tried again when D1 fails for a moment (`isTransientD1Error`),
 * up to `currentBatchTries`; any other failure is thrown at once. Making a
 * version current compares and sets, so a try that committed though its
 * answer was lost only makes the next change nothing: the caller tells
 * that from losing to someone else by its own event (`setCurrentVersion`).
 */
const retriedBatch = async <Result>(
  batch: () => Promise<Result>
): Promise<Result> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // One try after the other.
      // oxlint-disable-next-line no-await-in-loop -- see above
      return await batch();
    } catch (error) {
      if (attempt >= currentBatchTries || !isTransientD1Error(error)) {
        throw error;
      }
    }
  }
};

/**
 * Makes `version` of `app` the one that runs, for one of its builders,
 * through a candidate (app-candidates.ts) frozen over the version current
 * now, or over `expected` when given: verified (`verifyVersion`), then
 * made current (`makeCurrent`). Nothing is sealed here: a version of spec
 * 8's layout is refused unless its release is (`activateVersion` seals
 * it, app-activation.ts).
 */
export const setCurrentVersion = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown,
  expected?: unknown
): Promise<App> => {
  // Imported here, not at the top: candidates reach back into this module.
  const { activateThroughCandidate } = await import("./app-candidates.ts");
  return await activateThroughCandidate(env, by, app, version, { expected });
};

/**
 * Runs the gates a version must pass before it is made current, those
 * whose answer doesn't change once given for its files: a candidate's
 * verifying stage (app-candidates.ts), which records the report that
 * `setCurrentVersion` then requires. A version of spec 8's layout must
 * have a runnable release, migrations that passed their fixtures, a store
 * whose contract holds its schema (or a ready explicit migration to it),
 * and passing App tests; every version, AI steps through declared models
 * only and passing workflow tests.
 */
export const verifyVersion = async (
  env: Env,
  appId: AppId,
  number: number,
  files: Record<string, string>
): Promise<VerifiedObservations> => {
  const layout = isAppLayout(files);
  if (layout) {
    await requireRunnableRelease(env, appId, number);
    // Its migrations passed on their fixtures as it was sealed, even where
    // the store had nothing to transform; asked before its store, whose
    // backfill such a migration fails, so the refusal names the fixture.
    // Imported here for the same reason as the tests' runner below.
    const { requireMigrationEvidence } =
      await import("./migration-evidence.ts");
    await requireMigrationEvidence(env, appId, number);
    // Its store's contract holds its schema, or it waits; a ready explicit
    // migration passes here and takes over as the version is made current.
    await requireStoreSchemaActive(env, appId, number);
    // Its App tests, on fixture stores of their own (app-tests.ts),
    // whoever makes it current. Imported here, not at the top: the
    // runner reaches releases and the operation host, which reach back
    // into this module for App lookups.
    const { requireAppTestsPass } = await import("./app-tests.ts");
    await requireAppTestsPass(env, appId, number, files);
  }
  // Its workflows' AI steps go only through models its release declares
  // (app-activation.ts): for every candidate, however it was frozen, so
  // one verified here is never made current without it. Imported here:
  // activation reaches back into this module.
  const { requireDeclaredModels } = await import("./app-activation.ts");
  await requireDeclaredModels(env, appId, number, files);
  await requireWorkflowTestsPass(env, appId, number, files);
  // What the gates selected to run, each with no failure, or they had
  // refused. The runners' own lists of what they ran aren't returned.
  return {
    appTests: layout
      ? Object.keys(files).filter(isAppTestSuite).toSorted()
      : [],
    workflowTests: workflowIdsIn(files)
      .filter((id) => Object.hasOwn(files, workflowPaths(id).tests))
      .toSorted(),
  };
};

/**
 * What `verifyVersion` selected to run, all passing: the App test suites
 * by path and the workflows with tests by ID, as the version's files list
 * them. Not a record of what each runner executed.
 */
export interface VerifiedObservations {
  readonly appTests: readonly string[];
  readonly workflowTests: readonly string[];
}

/**
 * Whether `version` of `app` could run if made current now: a version of
 * spec 8's layout only with a release that is sealed, not revoked, and
 * on a store that lives (`runnableReleaseSql`, as making it current asks);
 * one of the earlier layout, which runs from its files, always.
 */
export const releaseRunnable = async (
  env: Env,
  app: AppId,
  version: number
): Promise<boolean> => {
  if (!isAppLayout(await versionFiles(env, app, version))) {
    return true;
  }
  const row = await drizzle(env.DB).get<{ runnable: number }>(
    sql`SELECT (${runnableReleaseSql(app, version)}) AS runnable`
  );
  return row?.runnable === 1;
};

/**
 * The candidate a version is made current from (app-candidates.ts):
 * verified, with the report `reportHash` names, and based on the version
 * current until now (null for none).
 */
export interface VerifiedCandidate {
  readonly id: string;
  readonly reportHash: string;
  readonly basedOn: number | null;
  /**
   * The release its report names, for a version of spec 8's layout: its
   * manifest's hash and the digest of the artifacts read back
   * (`artifactDigest`). Read back again as it is made current.
   */
  readonly release: {
    readonly manifestHash: string;
    readonly artifactDigest: string;
  } | null;
}

/**
 * Holds while `candidate` is verified for `version` of `app`, with its
 * report stored under the hash it pins, as the statement runs: so a
 * candidate superseded, ended or reported otherwise since it was read
 * makes nothing current.
 */
const verifiedCandidateSql = (
  app: AppId,
  version: number,
  candidate: VerifiedCandidate
) =>
  sql`EXISTS (SELECT 1 FROM ${appCandidates} AS candidate
    JOIN ${appCandidateReports} AS report
      ON report.candidate_id = candidate.id AND report.hash = candidate.report_hash
    WHERE candidate.id = ${candidate.id} AND candidate.app_id = ${app}
      AND candidate.version = ${version} AND candidate.state = 'verified'
      AND candidate.report_hash = ${candidate.reportHash})`;

/**
 * Refuses `candidate` unless it is still verified with the report it
 * pins: superseded by a person's commit (`app.candidate_superseded`), or
 * ended or reported otherwise since it was read (`app.conflict`). Asked
 * before anything is switched for it, as the store's contract is; the
 * statement that makes it current asks again (`verifiedCandidateSql`).
 */
const requireCandidateVerified = async (
  env: Env,
  candidate: VerifiedCandidate
): Promise<void> => {
  const row = await drizzle(env.DB)
    .select({
      state: appCandidates.state,
      reportHash: appCandidates.reportHash,
    })
    .from(appCandidates)
    .where(eq(appCandidates.id, candidate.id))
    .get();
  if (row?.state === "superseded") {
    throw appErrors.create("app.candidate_superseded");
  }
  if (row?.state !== "verified" || row.reportHash !== candidate.reportHash) {
    throw appErrors.create("app.conflict");
  }
};

/**
 * Holds while the sealed manifest stored for `version` of `app` is the
 * one the candidate's report names, as the statement runs.
 */
const releaseAsReportedSql = (
  app: AppId,
  version: number,
  candidate: VerifiedCandidate
) =>
  candidate.release === null
    ? sql`0`
    : sql`EXISTS (SELECT 1 FROM sdk_release_manifests
    WHERE app_id = ${app} AND version = ${version}
      AND manifest_hash = ${candidate.release.manifestHash})`;

/**
 * Refuses `candidate` unless the release of `version` of `app`, read back
 * from storage now, is the one its report names: the same manifest and
 * the same artifacts (`app.candidate_release_changed`), or an artifact
 * missing or changed (`version.artifact_corrupt`).
 */
const requireReleaseAsReported = async (
  env: Env,
  app: AppId,
  version: number,
  candidate: VerifiedCandidate
): Promise<void> => {
  if (candidate.release === null) {
    throw appErrors.create("app.candidate_release_changed");
  }
  // Imported here, not at the top: releases reach back into this module.
  const { artifactDigest, readBackRelease } = await import("./app-releases.ts");
  const { manifest, hash } = await readBackRelease(env, app, version);
  if (
    hash !== candidate.release.manifestHash ||
    (await artifactDigest(manifest)) !== candidate.release.artifactDigest
  ) {
    throw appErrors.create("app.candidate_release_changed");
  }
};

/**
 * Makes a version the one that runs, from its verified candidate
 * (app-candidates.ts): the pending one after review, or any other, such
 * as an earlier one to roll back. Only over the version the candidate was
 * based on, and only while the candidate is verified with its report, in
 * the statement that makes it current, which also marks the candidate
 * active. The pending version is
 * cleared once it is current. Made current by someone who couldn't grant
 * them, the version is unapproved and the App's permissions that change
 * things for the person using it are asked for again (`madeCurrent`), but
 * for an App's first version copied from a blueprint, the first time:
 * version 1 existed and was immutable when the admin granted its
 * requests.
 */
export const makeCurrent = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown,
  candidate: VerifiedCandidate
): Promise<App> => {
  const found = await appFor(env, by, app, "builder");
  const appId = found.id;
  const { version: number, approved } = await findVersion(env, appId, version);
  if (found.currentVersion === number) {
    return found;
  }
  // Verified over the version current then: any other since is a change
  // the verification never saw.
  if (found.currentVersion !== candidate.basedOn) {
    throw appErrors.create("app.conflict");
  }
  const files = await versionFiles(env, appId, number);
  // A version of spec 8's layout runs only from its release: activation
  // seals it first (app-candidates.ts), and nothing makes one current
  // unsealed or revoked: checked here for a clear refusal, and again as
  // the version is made current, so neither a revocation nor the
  // retention sweep's deletion lands in between. Its tests passed as its
  // candidate was verified (`verifyVersion`), on the same files.
  const sealedLayout = isAppLayout(files);
  let sampleGate: SQL | undefined;
  if (sealedLayout) {
    await requireRunnableRelease(env, appId, number);
    const { noFailedSampleSql, requireMigrationEvidence } =
      await import("./migration-evidence.ts");
    await requireMigrationEvidence(env, appId, number);
    // And again as the version is made current, below.
    sampleGate = noFailedSampleSql(appId, number);
    await requireStoreSchemaActive(env, appId, number);
  }
  const triggers = await triggerRegistration(env, appId, number, files);
  const previous = found.currentVersion;
  const event = createAuditEvent(
    changeEntry(by, "app.version.current", appId, {
      version: number,
      previous,
      candidate: candidate.id,
      ...triggerSummary(triggers),
    }),
    "core"
  );
  const db = drizzle(env.DB);
  if (sealedLayout) {
    // Last before the batch: a ready explicit migration's store switches
    // to its contract now (store-backfill.ts), after every gate above, so
    // no refused gate leaves the version still current locked out of its
    // store. The store and D1 share no transaction: the batch is retried
    // here if it fails, and a version found current after all is answered
    // as such. Only a batch that keeps failing leaves the store switched
    // ahead of D1, until making it current is asked again.
    //
    // A failed sample of its migrations is looked for once more first:
    // the switch is where it is decided, since a store switched over
    // supersedes the schema the version still current writes under, and
    // refusing the version after it would only lock that one out of its
    // store. Nothing a sample could fail on is left by then: the store
    // switches only from ready, with no record left to transform (work
    // queued again refuses it as `migration.pending`), and a sample of a
    // ready store reads nothing, so it is `empty` and clears. A failure
    // landing after this look read its records before the store was
    // ready, and the backfill has since transformed and validated every
    // one. Where nothing switched now (no ready migration, or a store a
    // lost batch switched before), the change still refuses one
    // (`sampleGate`).
    const { requireMigrationEvidence } =
      await import("./migration-evidence.ts");
    await requireMigrationEvidence(env, appId, number);
    // Its candidate still verified, superseded by no commit meanwhile:
    // asked here, before the store switches, so a candidate refused below
    // never leaves the version current locked out of its store.
    await requireCandidateVerified(env, candidate);
    // Its release read back from storage once more, bypassing the cache of
    // verified releases (`readBackRelease`): the report was written when
    // the candidate was verified, and a verified candidate never expires,
    // so an artifact changed in storage since must refuse it here.
    await requireReleaseAsReported(env, appId, number, candidate);
    if (
      await requireStoreSchemaActive(env, appId, number, { activate: true })
    ) {
      sampleGate = undefined;
    }
  }
  // Only over the current version read above, so the event's `previous`
  // is the version this replaced, and only while what its triggers were
  // worked out from still holds (trigger-registry.ts). The event is stored
  // only if this batch made it current, and what follows it only then.
  const [[changed]] = await retriedBatch(
    async () =>
      await auditedBatch(env, db, [
        db
          .update(apps)
          .set({
            currentVersion: number,
            pendingVersion: sql`CASE WHEN ${apps.pendingVersion} = ${number} THEN NULL ELSE ${apps.pendingVersion} END`,
          })
          .where(
            and(
              eq(apps.id, appId),
              sql`${apps.currentVersion} IS ${previous}`,
              // Archived since `editableApp` let it in: read-only now.
              ne(apps.status, "archived"),
              registrationHolds(appId, triggers),
              sealedLayout ? runnableReleaseSql(appId, number) : undefined,
              sealedLayout
                ? releaseAsReportedSql(appId, number, candidate)
                : undefined,
              sampleGate,
              verifiedCandidateSql(appId, number, candidate)
            )
          )
          .returning(),
        outboxedEventWhere(db, event, sql`changes() > 0`),
        // The candidate it was made current from is active from now on,
        // and the activation's claim on it ends (app-candidates.ts).
        db
          .update(appCandidates)
          .set({
            state: "active",
            lease: null,
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(appCandidates.id, candidate.id),
              eq(appCandidates.state, "verified"),
              storedEvent(event.id)
            )
          ),
        ...madeCurrent(env, by, {
          app: appId,
          version: number,
          previous,
          changed: storedEvent(event.id),
          // A copy's first version, approved as it was created from the
          // blueprint (app-blueprints.ts), made current for the first time.
          keep: previous === null && approved === 1,
        }),
        ...registerTriggers(db, appId, number, triggers, storedEvent(event.id)),
        // The store the arriving version's release binds now serves its
        // definition, and one the leaving version's bound and the arriving
        // one's doesn't serves none (each subquery finds no binding): core's
        // inventory follows (data-stores.ts).
        db
          .update(businessStores)
          .set({
            activeSchemaVersion: sql`(SELECT bound.target_version FROM sdk_resource_bindings AS bound
          WHERE bound.resource_id = ${appId} AND bound.resource_version = ${number}
            AND bound.kind = 'store' AND bound.target_id = ${businessStores.id})`,
            activeSchemaHash: sql`(SELECT bound.schema_hash FROM sdk_resource_bindings AS bound
          WHERE bound.resource_id = ${appId} AND bound.resource_version = ${number}
            AND bound.kind = 'store' AND bound.target_id = ${businessStores.id})`,
            activeOperationManifestHash: sql`(SELECT definition.operation_manifest_hash
          FROM sdk_resource_bindings AS bound
          JOIN business_store_versions AS definition
            ON definition.store_id = bound.target_id AND definition.version = bound.target_version
          WHERE bound.resource_id = ${appId} AND bound.resource_version = ${number}
            AND bound.kind = 'store' AND bound.target_id = ${businessStores.id})`,
          })
          .where(
            and(
              sql`${businessStores.id} IN (SELECT target_id FROM sdk_resource_bindings
            WHERE resource_id = ${appId} AND resource_version IN (${number}, ${previous ?? number})
              AND kind = 'store')`,
              storedEvent(event.id)
            )
          ),
        // The sealed releases of the version leaving and the one arriving
        // were current until now: their retention counts from here
        // (release-retention.ts), not from the sweep's last look.
        db
          .update(sdkReleaseManifests)
          .set({ lastCurrentAt: new Date() })
          .where(
            and(
              eq(sdkReleaseManifests.appId, appId),
              inArray(sdkReleaseManifests.version, [
                number,
                previous ?? number,
              ]),
              storedEvent(event.id)
            )
          ),
      ])
  );
  if (!changed) {
    // Only this call's batch stores its event, and only if it made the
    // version current: found stored, an earlier try committed and its
    // answer was lost. The version current by someone else's hand (or
    // over changed triggers) is a conflict, even if it is this version.
    // Once the outbox has drained the event, a lost answer is answered as
    // a conflict too, and asking again finds the version current.
    const ours = await db
      .select({ id: auditOutbox.id })
      .from(auditOutbox)
      .where(eq(auditOutbox.id, event.id))
      .get();
    if (ours !== undefined) {
      return await editableApp(env, by, appId);
    }
    requireNotArchived(await findApp(env, appId));
    if (sealedLayout) {
      // Revoked or deleted since it was checked, or a sample of its
      // migrations failed since, where the change still checked that (its
      // store didn't switch): refused as such.
      await requireRunnableRelease(env, appId, number);
      if (sampleGate !== undefined) {
        const { requireMigrationEvidence } =
          await import("./migration-evidence.ts");
        await requireMigrationEvidence(env, appId, number);
      }
    }
    // A verified candidate is never superseded (`supersededBy`), so what
    // is left is a conflict: the base moved, or the candidate ended.
    throw appErrors.create("app.conflict");
  }
  // What its screens build to with this release's kit, which may not be
  // the one it was committed under, and with the references they import,
  // read back from its release, checked above (screen-builds.ts): in the
  // background, never something making it current waits on. Bounded by
  // the build wait; what doesn't get recorded now is when it is opened or
  // reviewed.
  waitUntil(
    recordVersionBuilds(env, appId, number, files, {
      // Imported here, not at the top: the references reach releases,
      // which reach back into this module for App lookups.
      withReferences: async (built) => {
        const { withScreenReferences } = await import("./screen-references.ts");
        return await withScreenReferences(env, appId, number, built);
      },
    })
  );
  return toApp(changed);
};
