import { isPageFile } from "@grasp-os/compiler";
import { definitionPath } from "@grasp-os/sdk/definition";
import type { AppDefinition } from "@grasp-os/sdk/definition";
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
  AppOverview,
  AppFiles,
  AppRole,
  AppVersion,
  ViewedApp,
  CommittedVersion,
  FileDiff,
} from "@grasp-os/shared/apps";
import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { storedProcessOf } from "@grasp-os/shared/business-processes";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId, BlueprintId, StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { requireBuilder } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { dataErrors } from "@grasp-os/shared/stores";
import { waitUntil } from "cloudflare:workers";
import { and, asc, desc, eq, isNull, lt, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { versionMadeCurrent } from "./access-revocations.ts";
import {
  appsBuiltBy,
  appsFoundBy,
  requireAppRole,
  requireNotArchived,
} from "./app-access.ts";
import type { Person } from "./app-access.ts";
import {
  definitionFiles,
  heldDefinition,
  withDefinitionCode,
} from "./app-definition.ts";
import { refuseWithoutLayout } from "./app-layout.ts";
import { refuseAppWorkflows } from "./app-no-workflows.ts";
import { refuseV1Server } from "./app-v1-server.ts";
import { queuedWebhookDeliveries } from "./app-webhook-queue.ts";
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
  appVersions,
  apps,
  auditOutbox,
  sdkReleaseManifests,
  sdkResourceBindings,
} from "./db/core/schema.ts";
import { isUniqueViolation, retriedBatch } from "./db/d1.ts";
import { appMemoryPath, requireWithinLimit } from "./knowledge/memory-files.ts";
import { madeCurrent } from "./permissions.ts";
import { buildOnSave } from "./save-builds.ts";
import {
  applyRulesAfterCommit,
  requireStoreSchemaActive,
  storeBindings,
} from "./store-backfill.ts";
import type { OwedRules } from "./store-backfill.ts";
import { liveStoreSql } from "./store-deletion.ts";

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
/** A version as this release writes it: never the previous release's `screens`. */
export type VersionRow = Omit<typeof appVersions.$inferSelect, "screens">;

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
export const readTree = async (
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
  responsible: row.responsibleId ?? row.ownerId,
  audience:
    row.audienceType === null || row.audienceId === null
      ? null
      : { type: row.audienceType, id: row.audienceId },
  blueprint: row.blueprint,
  currentVersion: row.currentVersion,
  pendingVersion: row.pendingVersion,
  status: row.status,
  link: row.link,
  process: storedProcessOf(row.process),
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
    | "app.version.published"
    | "app.version.publish_failed"
    | "app.blueprint.marked"
    | "app.blueprint.unmarked"
    | "app.blueprint.updated",
  app: AppId,
  detail: Record<string, AuditDetailValue>
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action,
  target: { type: "app", id: app },
  detail,
});

/**
 * The App `input` names, which must exist and not be removed: a removed
 * App (app-removal.ts) is answered as one that isn't there.
 */
export const findApp = async (env: Env, input: unknown): Promise<App> => {
  const id = appIdSchema.safeParse(input);
  const row = id.success
    ? await drizzle(env.DB)
        .select()
        .from(apps)
        .where(and(eq(apps.id, id.data), isNull(apps.removedAt)))
        .get()
    : undefined;
  if (!row) {
    throw appErrors.create("app.not_found");
  }
  return toApp(row);
};

/**
 * The version of App `app` that runs now: what a page's calls are
 * answered by. `version.not_sealed` while none is current.
 */
export const currentVersionOf = async (
  env: Env,
  app: AppId
): Promise<number> => {
  const { currentVersion } = await findApp(env, app);
  if (currentVersion === null) {
    throw versionErrors.create("version.not_sealed");
  }
  return currentVersion;
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
 * open its pages, call it or start its runs. An archived App is
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
export const checkPaths = (
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
  before: string | undefined,
  after: string | undefined
): void => {
  const grew =
    after !== undefined &&
    (before === undefined || after.length > before.length);
  if (grew) {
    requireWithinLimit("AGENTS.md", after);
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

/**
 * The definitions a change of App `app` can't rename a field of: the
 * version people use (`current`), and the files the change starts from
 * (`started`: the latest commit, or a draft's base), which may have run
 * and been rolled back from.
 */
export const heldDefinitions = async (
  env: Env,
  app: AppId,
  current: number | null,
  started: ReadonlyMap<string, string>
): Promise<(AppDefinition | null)[]> => [
  heldDefinition(started),
  current === null
    ? null
    : heldDefinition(
        new Map(Object.entries(await versionFiles(env, app, current)))
      ),
];

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
    responsibleId: null,
    audienceType: null,
    audienceId: null,
    process: null,
    blueprint: blueprint ?? null,
    currentVersion: null,
    pendingVersion: null,
    status: "draft",
    statusChangedAt: null,
    statusChangedBy: null,
    createdAt: new Date(),
    link: null,
    removedAt: null,
    removedBy: null,
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
/**
 * The Apps `by` has a role in, oldest first, each with that role
 * (`appsBuiltBy` decides the builders, as `requireAppRole` does for one).
 */
export const listApps = async (env: Env, by: Member): Promise<ViewedApp[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(apps)
    .where(appsFoundBy(env, by))
    .orderBy(asc(apps.createdAt), asc(apps.id));
  const found = rows.map(toApp);
  const builds = await appsBuiltBy(
    env,
    by,
    found.map(({ id }) => id)
  );
  return found.map((app) => ({
    ...app,
    role: builds.has(app.id) ? "builder" : "user",
  }));
};

/** The App `app` names, for anyone with a role in it, with that role. */
export const getApp = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<ViewedApp> => {
  const found = await findApp(env, app);
  const role = await requireAppRole(env, by, found, "user");
  return { ...found, role };
};

/** Whether an App's files have pages: file routes under `src/routes/`. */
export const hasPages = (files: ReadonlyMap<string, string>): boolean =>
  [...files.keys()].some((path) => isPageFile(path));

/** The pages of an App's current version. */
export const appContents = async (
  env: Env,
  by: Person,
  app: unknown
): Promise<AppContents> => {
  const { id, currentVersion } = await appFor(env, by, app, "user");
  if (currentVersion === null) {
    return { version: null, pages: false };
  }
  const files = new Map(
    Object.entries(await versionFiles(env, id, currentVersion))
  );
  return {
    version: currentVersion,
    pages: hasPages(files),
  };
};

/**
 * The Apps `by` has a role in, as `listApps` gives them, each with what
 * `appContents` says of it: one query, from its current version's row
 * (`app_versions.pages`), so no files are read.
 */
export const listAppOverviews = async (
  env: Env,
  by: Member
): Promise<AppOverview[]> => {
  const rows = await drizzle(env.DB)
    .select({
      app: apps,
      pages: appVersions.pages,
    })
    .from(apps)
    .leftJoin(
      appVersions,
      and(
        eq(appVersions.appId, apps.id),
        eq(appVersions.version, apps.currentVersion)
      )
    )
    .where(appsFoundBy(env, by))
    .orderBy(asc(apps.createdAt), asc(apps.id));
  const found = rows.map((row) => ({ ...row, app: toApp(row.app) }));
  const builds = await appsBuiltBy(
    env,
    by,
    found.map(({ app }) => app.id)
  );
  return found.map(({ app, pages }) => ({
    app: { ...app, role: builds.has(app.id) ? "builder" : "user" },
    // None without a current version, whose row the join doesn't find.
    contents: {
      version: app.currentVersion,
      pages: pages ?? false,
    },
  }));
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
  input: unknown,
  /** The App's name, for the empty definition of its first files. */
  name: string,
  /** The definitions of its versions a rename can't change (`heldDefinitions`). */
  held: readonly (AppDefinition | null)[] = []
): [string, string | null][] => {
  const changes = Object.entries(
    appErrors.parse("app.invalid", fileChangesSchema, input)
  );
  const before = sizeOf(files);
  const agentsBefore = files.get(appMemoryPath);
  const defined = files.has(definitionPath);
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
  // The config and schema as the definition generates them, whatever the
  // changes held of them, before the App's limits are checked on them;
  // and the definition a first write gets. Answered as changes too, so a
  // draft saves the files it was checked with.
  const submitted = new Map(
    [...definitionFiles].map((path) => [path, files.get(path)])
  );
  withDefinitionCode(files, name, defined, held);
  checkLimits(files, before);
  checkPaths(files.keys(), added);
  checkMemory(agentsBefore, files.get(appMemoryPath));
  const generated = [...definitionFiles].flatMap((path): [string, string][] => {
    const content = files.get(path);
    return content === undefined || content === submitted.get(path)
      ? []
      : [[path, content]];
  });
  return [
    ...changes.filter(
      ([path]) => !generated.some(([changed]) => changed === path)
    ),
    ...generated,
  ];
};

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
  const { id: appId, name, currentVersion } = await editableApp(env, by, app);
  const text = appErrors.parse("app.invalid", commitMessageSchema, message);
  const { latest, files } = await latestFiles(env, appId);
  const held = await heldDefinitions(env, appId, currentVersion, files);
  applyChanges(env, files, input, name, held);
  const { tree, json } = await versionTree(files);
  if (tree === latest?.tree) {
    throw appErrors.create("app.nothing_to_commit");
  }
  refuseV1Server(files.keys());
  refuseAppWorkflows(files.keys());
  refuseWithoutLayout(files.keys());
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
    pages: hasPages(files),
    proposedBy: null,
    status: null,
    publishedManifestHash: null,
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
  const builds = await buildOnSave(
    env,
    {
      app: appId,
      version: row.version,
      files: saved,
    },
    { profile: "production" }
  );
  // The pages open on the App hear of it (spec 11.5): their pages show
  // a new version ready, and switch to it (pages-rpc.ts, `watchVersion`).
  waitUntil(versionMadeCurrent(env, appId));
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
 * by `by` (the chat's agent, acting for its person, `by.via`, or the
 * person themselves, the chat named in its audit then) with
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
  /** The chat whose draft it is, which its audit names. */
  fromChat?: string
): Promise<AppVersion> => {
  const { id: appId } = await editableApp(env, by, app);
  const text = appErrors.parse("app.invalid", commitMessageSchema, message);
  const { tree, json } = await versionTree(files);
  const latest =
    parent === null ? undefined : await findVersion(env, appId, parent);
  if (tree === latest?.tree) {
    throw appErrors.create("app.nothing_to_commit");
  }
  refuseV1Server(files.keys());
  refuseAppWorkflows(files.keys());
  refuseWithoutLayout(files.keys());
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
    pages: hasPages(files),
    proposedBy: by.via ?? null,
    status: null,
    publishedManifestHash: null,
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
          ...(fromChat === undefined ? {} : { chat: fromChat }),
        }),
        sql`NOT ${archivedNow(appId)}`
      ),
    ] as const;
    const results: readonly unknown[] = await auditedBatch(env, db, write);
    // The delete's rows: what an archive took back.
    undone = results.at(1);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw appErrors.create("app.conflict");
    }
    throw error;
  }
  if (Array.isArray(undone) && undone.length > 0) {
    throw appErrors.create("app.archived");
  }
  // The pages open on the App hear of it, as of a commit: a chat's
  // preview showing the App's latest version takes it.
  waitUntil(versionMadeCurrent(env, appId));
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

/** How the files `after` differ from `before`, by path. */
export const diffFiles = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): FileDiff[] => {
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
  return diffFiles(before, after);
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

/**
 * Holds while `version` of `app` is published (app-publish.ts), as the
 * statement runs: it passed publishing, and the release it tested, by its
 * manifest's hash, is still stored. A release deleted, by whatever
 * release of core, or sealed again, is published again before it runs.
 * The database's own trigger asks the same (migration 0223).
 */
export const publishedSql = (app: AppId, version: number) =>
  sql`EXISTS (SELECT 1 FROM app_versions AS published
    WHERE published.app_id = ${app} AND published.version = ${version}
      AND EXISTS (SELECT 1 FROM sdk_release_manifests AS tested
        WHERE tested.app_id = published.app_id
          AND tested.version = published.version
          AND tested.manifest_hash = published.published_manifest_hash))`;

/** Whether `version` of `app` is published now (`publishedSql`). */
export const isPublished = async (
  env: Env,
  app: AppId,
  version: number
): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ published: number }>(
    sql`SELECT (${publishedSql(app, version)}) AS published`
  );
  return row?.published === 1;
};

/**
 * Makes a published version the one that runs (app-publish.ts): the
 * pending one after review, or any other, such as an earlier one to roll
 * back. Only over `basedOn`, the version current when its publish began
 * (null for none), and only while the version is still published, in
 * the statement that makes it current. A version runs only from its
 * release, read back from storage here first, every byte
 * checked, so neither a rollback nor a publish switches to bytes changed
 * since they were sealed. Its tests ran as it was published, never again
 * here. The pending version is cleared once it is current. Made current
 * by someone who couldn't grant them, the version is unapproved and the
 * App's permissions that change things for the person using it are asked
 * for again (`madeCurrent`), but for an App's first version copied from a
 * blueprint, the first time: version 1 existed and was immutable when the
 * admin granted its requests.
 */
export const makeCurrent = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown,
  basedOn: number | null
): Promise<App> => {
  const found = await appFor(env, by, app, "builder");
  const appId = found.id;
  const { version: number, approved } = await findVersion(env, appId, version);
  if (found.currentVersion === number) {
    return found;
  }
  // Published over the version current then: any other since is a change
  // its publish never saw.
  if (found.currentVersion !== basedOn) {
    throw appErrors.create("app.conflict");
  }
  if (!(await isPublished(env, appId, number))) {
    throw versionErrors.create("version.unpublished");
  }
  // Nothing makes a version current unsealed or revoked: checked here for
  // a clear refusal, and again as the version is made current, so neither
  // a revocation nor the retention sweep's deletion lands in between.
  await requireRunnableRelease(env, appId, number);
  // Imported here, not at the top: releases reach back into this module.
  const { readBackRelease } = await import("./app-releases.ts");
  await readBackRelease(env, appId, number);
  await requireStoreSchemaActive(env, appId, number);
  const previous = found.currentVersion;
  const event = createAuditEvent(
    changeEntry(by, "app.version.current", appId, {
      version: number,
      previous,
    }),
    "core"
  );
  const db = drizzle(env.DB);
  // The rules its store owes from its activation below until the batch
  // is done, under this call's own ID.
  const owed: OwedRules = { id: crypto.randomUUID(), kind: "app" };
  // Last before the batch (with it, below): a ready explicit
  // migration's store switches to its contract, and a change that checks records (a narrowing,
  // a field required) is applied (store-backfill.ts), after every gate
  // above, so no refused gate leaves the version still current locked
  // out of its store. That goes first because applying can still be
  // refused (a write since the dry run), and the batch can't be taken
  // back once it is in; a batch that isn't ours (a lost compare and
  // set, one that keeps failing) leaves the version current refused its
  // writes where the change left it behind, never reading more. A
  // changed access mode or row rule waits for the batch: whatever its
  // outcome, the store then takes the rules of the version D1 has
  // current (`applyRulesAfterCommit`), so none is in force that D1
  // never made current. The store and D1 share no transaction: the
  // batch is retried here if it fails, and a version found current after
  // all is answered as such.
  const bound = await storeBindings(env, appId, number);
  const owing: StoreId[] = bound.map(({ storeId }) => storeId);
  // Only over the current version read above, so the event's `previous`
  // is the version this replaced. The event is stored only if this batch
  // made it current, and what follows it only then.
  const batch = async () =>
    await retriedBatch(
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
                runnableReleaseSql(appId, number),
                publishedSql(appId, number)
              )
            )
            .returning(),
          outboxedEventWhere(db, event, sql`changes() > 0`),
          ...madeCurrent(env, by, {
            app: appId,
            version: number,
            previous,
            changed: storedEvent(event.id),
            // A copy's first version, approved as it was created from the
            // blueprint (app-blueprints.ts), made current for the first time.
            keep: previous === null && approved === 1,
          }),
          // Its webhooks told of the version, with the change or not at all.
          ...queuedWebhookDeliveries(
            db,
            {
              app: appId,
              event: "changed",
              dedupe: `changed:${event.id}`,
              version: number,
            },
            storedEvent(event.id)
          ),
        ])
    );
  let made: Awaited<ReturnType<typeof batch>>;
  // The store's activation (`requireStoreSchemaActive`, the last step
  // before the batch) and the batch share one ending: refused, failed or
  // committed, the rules of the version D1 has current are applied and
  // what the store owed is settled, so a refusal never leaves the store
  // holding other activations back (`migration.busy`).
  try {
    await requireStoreSchemaActive(env, appId, number, { activate: owed });
    made = await batch();
  } finally {
    await applyRulesAfterCommit(env, owed, appId, owing);
  }
  const [[changed]] = made;
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
      // The try whose answer was lost may have told no page either.
      waitUntil(versionMadeCurrent(env, appId));
      return await editableApp(env, by, appId);
    }
    requireNotArchived(await findApp(env, appId));
    // Revoked or deleted since it was checked: refused as such.
    await requireRunnableRelease(env, appId, number);
    // Unpublished since it was checked: its release deleted by the sweep.
    if (!(await isPublished(env, appId, number))) {
      throw versionErrors.create("version.unpublished");
    }
    // What is left is a conflict: the base moved.
    throw appErrors.create("app.conflict");
  }
  // The pages open on the App hear of it (spec 11.5): their pages show
  // a new version ready, and switch to it (pages-rpc.ts, `watchVersion`).
  waitUntil(versionMadeCurrent(env, appId));
  return toApp(changed);
};
