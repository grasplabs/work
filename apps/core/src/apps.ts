import { isPageFile } from "@grasp-os/compiler";
import {
  definitionSources,
  definitionText,
  emptyDefinition,
  readDefinition,
  isFunctionPath,
  withExportedFunctions,
} from "@grasp-os/runtime/definition";
import type { AppDefinition } from "@grasp-os/runtime/definition";
import { isUnderGeneratedServerFolder, ownFiles } from "@grasp-os/runtime/host";
import { appLimits } from "@grasp-os/shared/app-limits";
import { versionErrors } from "@grasp-os/shared/app-releases";
import {
  appErrors,
  appVersionSchema,
  fileChangesSchema,
  newAppSchema,
} from "@grasp-os/shared/apps";
import type {
  App,
  AppContents,
  AppOverview,
  AppFiles,
  AppVersion,
  ViewedApp,
  FileDiff,
} from "@grasp-os/shared/apps";
import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { storedProcessOf } from "@grasp-os/shared/business-processes";
import { draftErrors } from "@grasp-os/shared/drafts";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId, BlueprintId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { requireBuilder } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { dataErrors } from "@grasp-os/shared/stores";
import type { MemberRole } from "@grasp-os/shared/subject-members";
import { waitUntil } from "cloudflare:workers";
import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { versionMadeCurrent } from "./access-revocations.ts";
import {
  appsBuiltBy,
  appsFoundBy,
  requireAppRole,
  requireNotArchived,
  stillBuiltBy,
} from "./app-access.ts";
import type { Person } from "./app-access.ts";
import {
  generatedPaths,
  functionIdsOf,
  schemaIdsOf,
  withGeneratedCode,
} from "./app-definition.ts";
import { refuseAppWorkflows } from "./app-no-workflows.ts";
import type { Release } from "./app-releases.ts";
import { queuedWebhookDeliveries } from "./app-webhook-queue.ts";
import {
  auditedBatch,
  outboxed,
  outboxedEventWhere,
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
import { nextLabel, subjectEntry } from "./drafts.ts";
import type { DraftKind, DraftState } from "./drafts.ts";
import { appMemoryPath, requireWithinLimit } from "./knowledge/memory-files.ts";
import type { SchemaIds } from "./schema-changes.ts";
import { liveStoreSql } from "./store-deletion.ts";

// The App registry and each App's code. The registry and the versions are
// rows in the core database. A version is its code and its definition. Its
// files, code only, are one object in R2 (EU),
// `apps/<app>/trees/<sha256>.json`: canonical JSON by path, stored under
// its own SHA-256, which the version row names. Reading a version is one
// read, checked against the hash. Its definition, what the App is as data
// (@grasp-os/runtime's definition-types.ts: its tables, with the stable IDs its
// store matches them by, and its permissions), is no file: the row holds
// it, as its text (`definitionText`), with its SHA-256, and a migration reaches it as
// it reaches any row.
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
//
// Threat model of the definition beside the tree, and how each is closed:
//
// - The definition and the code generated from it drift apart: every
//   version is written through `storedVersion`, which generates its
//   `grasp.config.ts`, `server/schema.ts` and `server/_generated/` from
//   the definition it is committed with (and the last from its server
//   modules too), whatever the files held, before the tree is hashed;
//   nothing else writes those paths (the agent's `write` refuses them,
//   app-definition.ts). Generation goes one way: nothing reads a
//   definition back from code. Applying a version's schema to its store
//   refuses a table or field its definition gives no ID
//   (app-definition.ts, `schemaIdsOf`).
// - A definition changed or swapped after it was committed: the row
//   holds its SHA-256, checked on every read (`readStored`); a
//   trigger refuses any change of either (migration 0228); the version's
//   sealed release names the hash next to the tree's (`definitionHash`),
//   and its schema is applied only by the definition of that hash
//   (app-schema.ts).
// - A row that holds no definition: the column is nullable only as it
//   was added (expand, then contract), and every version is written with
//   one. Read anyway, it is an invalid definition (`readStored`), refused
//   as any other is.
// - The App's draft and a version made live meanwhile both change the
//   definition: the draft keeps its own copy (drafts.ts), and is
//   published only over the version it is based on while that is live
//   (publish.ts, `publish`), else refused as a conflict.

export type AppRow = typeof apps.$inferSelect;
/** A version as this release writes it: never the previous release's `screens`. */
export type VersionRow = Omit<typeof appVersions.$inferSelect, "screens">;

/** A tree as a version stores it. */
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
  liveLabel: row.liveLabel,
  archived: row.archivedAt !== null,
  link: row.link,
  process: storedProcessOf(row.process),
  createdAt: row.createdAt.toISOString(),
});

export const toVersion = (row: VersionRow): AppVersion => ({
  kind: "app",
  app: appIdSchema.parse(row.appId),
  version: row.version,
  label: row.label,
  parent: row.parent,
  tree: row.tree,
  files: row.files,
  author: row.authorId,
  createdAt: row.createdAt.toISOString(),
});

/** The audit entry of a change to `app` by `by`: identifiers only. */
export const changeEntry = (
  by: Pick<Acting, "userId" | "staff" | "actor">,
  action:
    | "app.created"
    | "app.committed"
    | "app.preview.reset"
    | "app.version.built"
    | "app.version.publish_failed"
    | "app.version.unfinished"
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
  needed: MemberRole,
  /** For what manages the App without reading its data (`requireAppRole`). */
  options: { managing?: boolean } = {}
): Promise<App> => {
  const app = await findApp(env, input);
  await requireAppRole(env, by, app, needed, options);
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
  needed: MemberRole = "user"
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
  input: unknown,
  /** For what manages the App without reading its data (`requireAppRole`). */
  options: { managing?: boolean } = {}
): Promise<App> => {
  const app = await appFor(env, by, input, "builder", options);
  requireNotArchived(app);
  return app;
};

/**
 * That App `app` is archived when the statement runs, as SQL: for a write
 * an earlier `editableApp` let in, so an archive committed since stops it
 * (app-status.ts).
 */
export const archivedNow = (app: string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${apps} WHERE ${apps.id} = ${app} AND ${apps.archivedAt} IS NOT NULL)`;

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

/** The number an App's next version takes: past every version it has. */
export const nextVersion = async (env: Env, app: AppId): Promise<number> =>
  ((await latestVersion(env, app)) ?? 0) + 1;

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

/**
 * `files`' size against an App's limits: what Grasp generates under
 * `server/_generated/` (app-definition.ts) apart, so an App at its limits
 * can still be written, whatever its references take.
 */
const sizeOf = (files: ReadonlyMap<string, string>): Size => {
  let count = 0;
  let length = 0;
  for (const [path, content] of files) {
    if (!isUnderGeneratedServerFolder(path)) {
      count += 1;
      length += content.length;
    }
  }
  return { files: count, length };
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

/**
 * A definition as Grasp holds it: itself, its text (`definitionText`,
 * one text for equal definitions, which is what is stored and compared)
 * and that text's SHA-256.
 */
export interface StoredDefinition {
  definition: AppDefinition;
  text: string;
  hash: string;
}

/** `definition` as Grasp holds it. */
export const storedDefinition = async (
  definition: AppDefinition
): Promise<StoredDefinition> => {
  const text = definitionText(definition);
  return { definition, text, hash: await sha256Hex(text) };
};

/**
 * The definition a version's row, a chat's draft or a blueprint holds,
 * read and checked whole: the one reader of a stored definition. Checked
 * against the hash the row holds, where it holds one (a version's, see
 * the header). `app.definition_invalid` for one that holds none.
 */
export const readStored = async (stored: {
  readonly definition: string | null;
  readonly definitionHash?: string | null;
}): Promise<StoredDefinition> => {
  const { definition: text, definitionHash } = stored;
  if (text === null || definitionHash === null) {
    throw appErrors.create("app.definition_invalid", {
      issues: ["The App's version holds no definition."],
    });
  }
  const hash = await sha256Hex(text);
  if (definitionHash !== undefined && hash !== definitionHash) {
    throw new Error("A stored definition doesn't match its hash");
  }
  return { definition: readDefinition(JSON.parse(text)), text, hash };
};

/**
 * The stable IDs `release`'s schema is applied by (app-definition.ts,
 * `schemaIdsOf`): its version's definition's, only while that is the
 * definition the release was sealed with (`definitionHash`).
 */
export const releaseIdsOf = async (
  env: Env,
  release: Pick<Release, "manifest" | "app">
): Promise<SchemaIds> => {
  const app = appIdSchema.parse(release.manifest.resourceId);
  const row = await findVersion(env, app, release.manifest.resourceVersion);
  const { definition, hash } = await readStored(row);
  if (hash !== release.manifest.definitionHash) {
    throw new Error("A release names another definition than its version's");
  }
  return schemaIdsOf(definition, release.app.schema);
};

/**
 * The paths of the functions `release` serves by stable ID
 * (app-definition.ts, `functionIdsOf`): its version's definition's, only
 * while that is the definition the release was sealed with, as
 * `releaseIdsOf` reads it.
 */
export const releaseFunctionsOf = async (
  env: Env,
  release: Pick<Release, "manifest" | "app">
): Promise<ReadonlyMap<string, string>> => {
  const app = appIdSchema.parse(release.manifest.resourceId);
  const row = await findVersion(env, app, release.manifest.resourceVersion);
  const { definition, hash } = await readStored(row);
  if (hash !== release.manifest.definitionHash) {
    throw new Error("A release names another definition than its version's");
  }
  return functionIdsOf(definition, release.app);
};

/** A version as it is stored: its tree, the hash of its code, its definition. */
export interface StoredVersion extends Tree {
  code: string;
  definition: StoredDefinition;
}

/**
 * The definitions a commit over `latest` carries function IDs from,
 * nearest first: `latest`'s, then that of App `app`'s current version,
 * whose IDs workflows are bound by, so a function a commit in between
 * left out comes back with its ID.
 */
export const carriedDefinitions = async (
  env: Env,
  app: AppId,
  latest: VersionRow | undefined
): Promise<AppDefinition[]> => {
  if (latest === undefined) {
    return [];
  }
  const { currentVersion } = await findApp(env, app);
  const rows = [latest];
  if (currentVersion !== null && currentVersion !== latest.version) {
    rows.push(await findVersion(env, app, currentVersion));
  }
  const read = await Promise.all(
    rows.map(async (row) => await readStored(row))
  );
  return read.map(({ definition }) => definition);
};

/**
 * The paths of the queries and mutations `files`' server code exports,
 * as the App compiler finds them building it, from their syntax, so code
 * that doesn't build yet (a package not approved yet) has them too;
 * undefined for a server file that doesn't parse, a build refused (a
 * bound passed, the builders busy) or one that doesn't answer within the
 * build wait: a commit never waits
 * longer on whether its code compiles, nor fails on it. A seal refuses a
 * version whose code exports one it gave no ID (app-releases.ts), so
 * the next commit gives it.
 */
const exportedPaths = async (
  env: Env,
  app: AppId,
  files: ReadonlyMap<string, string>
): Promise<string[] | undefined> => {
  // Imported here, not at the top: builds reach back into this module.
  const { buildAppCode, withinBuildWait } = await import("./pages.ts");
  try {
    // Within the build wait, as a save waits on its builds: a later
    // commit gives what this one couldn't.
    const build = await withinBuildWait(
      env,
      // Without their copy of `server/_generated/`, as a seal builds
      // them (app-releases.ts, `sealedSource`): the same build, cached.
      async () =>
        await buildAppCode(env, ownFiles(Object.fromEntries(files)), app)
    );
    if (build === "late" || build.functions === undefined) {
      return undefined;
    }
    // Only paths a function may have: what a definition takes.
    return build.functions.filter((path) => isFunctionPath(path));
  } catch (error) {
    // Whatever stopped the build: the commit stands, and the next one
    // gives what this one couldn't (a seal refuses a version short of
    // one, app-releases.ts).
    log.warn("app.function_ids_unbuilt", { app, ...errorFields(error) });
    return undefined;
  }
};

/**
 * Refuses a definition that gives a path another function's ID: one the
 * version it is committed over (`previous`) gives another ID, whose
 * function the code still exports there. A rename moves a function to a
 * new path; an ID moved onto a function the App has is that function
 * (`app.definition_invalid`).
 */
const requireNoFunctionTaken = (
  definition: AppDefinition,
  previous: AppDefinition | undefined,
  exported: readonly string[]
): void => {
  const held = new Map(
    (previous?.functions ?? []).map(({ id, name }) => [name, id])
  );
  const taken = (definition.functions ?? []).filter(
    ({ id, name }) =>
      exported.includes(name) &&
      held.get(name) !== undefined &&
      held.get(name) !== id
  );
  if (taken.length > 0) {
    throw appErrors.create("app.definition_invalid", {
      issues: taken.map(
        ({ name }) =>
          `\`${name}\` is another function's, with an ID of its own: rename a function to a new path, and that one away first in a version of its own.`
      ),
    });
  }
};

/**
 * `definition` giving stable IDs to exactly the queries and mutations
 * `files`' server code exports (sdk's `withExportedFunctions`): each keeps
 * the ID `definition` or `previous` gives its path, a new one gets one,
 * and one gone loses its. Found as the App compiler builds the code, from
 * its syntax (the compiler's `exportedFunctionsOf`), the build cached as
 * every build is. Code that doesn't build seals nothing, so its version
 * keeps the IDs it was given, or `previous`'s, for the next commit to
 * carry on.
 */
const exportedFunctionsOf = async (
  env: Env,
  app: AppId,
  files: ReadonlyMap<string, string>,
  definition: AppDefinition,
  previous: readonly AppDefinition[]
): Promise<AppDefinition> => {
  const exported = await exportedPaths(env, app, files);
  if (exported === undefined) {
    const { functions = previous[0]?.functions ?? [] } = definition;
    const named = functions.map(({ name }) => name);
    requireNoFunctionTaken(definition, previous[0], named);
    return withExportedFunctions(definition, previous, named);
  }
  requireNoFunctionTaken(definition, previous[0], exported);
  return withExportedFunctions(definition, previous, exported);
};

/**
 * `files` and `definition` as a version stores them, `files` changed in
 * place to hold what is generated among them (`withGeneratedCode`: the
 * config, the schema and `server/_generated/`), whatever they held,
 * before the tree is hashed: every version is written through here, so its code is
 * always its definition's (see the header). `app.too_large` if they are
 * over an App's limits.
 */
export const storedVersion = async (
  env: Env,
  app: AppId,
  files: Map<string, string>,
  definition: AppDefinition,
  /** The definitions it carries function IDs from (`carriedDefinitions`). */
  previous: readonly AppDefinition[] = []
): Promise<StoredVersion> => {
  withGeneratedCode(files, definition);
  const defined = await exportedFunctionsOf(
    env,
    app,
    files,
    definition,
    previous
  );
  return {
    ...(await versionTree(files)),
    code: await codeIdentity(files),
    definition: await storedDefinition(defined),
  };
};

/** Whether `stored` is exactly the version `row`: its code and its definition. */
export const sameVersion = (
  stored: StoredVersion,
  row: Pick<VersionRow, "tree" | "definitionHash"> | undefined
): boolean =>
  stored.tree === row?.tree && stored.definition.hash === row.definitionHash;

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
    responsibleId: null,
    audienceType: null,
    audienceId: null,
    process: null,
    blueprint: blueprint ?? null,
    currentVersion: null,
    liveLabel: null,
    archivedAt: null,
    archivedBy: null,
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
 * (agent-builds.ts), with the config and schema `definition` generates,
 * refused as a whole when they would be over the App's limits, hold
 * paths that can't both exist, or an AGENTS.md over its limit. The
 * changes, checked.
 */
export const applyChanges = (
  files: Map<string, string>,
  input: unknown,
  /** The definition the files are of: their config and schema are its. */
  definition: AppDefinition
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
  // What is generated (the config, the schema and `server/_generated/`)
  // as the definition and the changed code generate it, whatever the
  // changes held of it, before the App's limits are checked.
  // Answered as changes too, so a draft saves the files it was checked
  // with.
  const submitted = new Map(
    [...generatedPaths].map((path) => [path, files.get(path)])
  );
  // The App's limits first, which `server/_generated/` doesn't count
  // toward: nothing past them is read for what it declares.
  for (const [path, source] of Object.entries(definitionSources(definition))) {
    files.set(path, source);
  }
  checkLimits(files, before);
  withGeneratedCode(files, definition);
  checkPaths(files.keys(), added);
  checkMemory(agentsBefore, files.get(appMemoryPath));
  const generated = [...generatedPaths].flatMap((path): [string, string][] => {
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
 * A draft's definition (`readStored`): its own, else its base version's;
 * null for a draft of an App with no version that hasn't written yet.
 */
export const draftDefinition = async (
  env: Env,
  app: AppId,
  { base, definition }: Pick<DraftState, "base" | "definition">
): Promise<StoredDefinition | null> => {
  if (definition !== null) {
    return await readStored({ definition });
  }
  return base === null
    ? null
    : await readStored(await findVersion(env, app, base));
};

/** What a publish commits of a draft: its files and definition, over its base. */
export interface DraftCommit {
  parent: number | null;
  /**
   * The number the version takes, read as the publish began: of two
   * publishes of one draft at once, the second finds it taken.
   */
  version: number;
  files: Map<string, string>;
  /** Null for a draft of an App with no version that holds none. */
  definition: AppDefinition | null;
}

/**
 * Commits the App's draft (`DraftCommit`) as its next version, by
 * `by`, one of its builders publishing it (app-publish.ts): not live
 * yet, which the publish makes it. Its files were built as they were
 * checked. A version committed meanwhile takes the number:
 * `draft.conflict`.
 */
export const commitDraft = async (
  env: Env,
  by: Acting,
  app: unknown,
  { parent, version, files, definition }: DraftCommit
): Promise<AppVersion> => {
  const { id: appId, name } = await editableApp(env, by, app);
  const latest =
    parent === null ? undefined : await findVersion(env, appId, parent);
  const carried = await carriedDefinitions(env, appId, latest);
  const committed = definition ?? emptyDefinition(name);
  // Imported here, not at the top: bindings reach back into this module.
  const { requireRecordableBindings } =
    await import("./app-workflow-bindings.ts");
  await requireRecordableBindings(env, by, committed, carried[0] ?? null);
  const stored = await storedVersion(env, appId, files, committed, carried);
  if (sameVersion(stored, latest)) {
    throw draftErrors.create("draft.empty");
  }
  const { tree, json } = stored;
  refuseAppWorkflows(files.keys());
  await storeTree(env, appId, { tree, json });
  const row: VersionRow = {
    appId,
    version,
    parent,
    tree,
    code: stored.code,
    definition: stored.definition.text,
    definitionHash: stored.definition.hash,
    files: files.size,
    authorId: by.userId,
    // Unused (schema.ts).
    message: "",
    createdAt: new Date(),
    approved: null,
    pages: hasPages(files),
    proposedBy: null,
    label: null,
    status: null,
    publishedManifestHash: null,
  };
  const db = drizzle(env.DB);
  let undone: unknown;
  try {
    // Taken back in the same batch should the App have been archived since
    // `editableApp` let the draft in: no version, nothing audited.
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
          definition: row.definitionHash,
          files: row.files,
        }),
        sql`NOT ${archivedNow(appId)}`
      ),
    ] as const;
    const results: readonly unknown[] = await auditedBatch(env, db, write);
    // The delete's rows: what an archive took back.
    undone = results.at(1);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw draftErrors.create("draft.conflict");
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
  by: Member,
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
 * The label a version of App `app` goes live under: the one it went live
 * under before (`held`, a roll back), or the next (`nextLabel`).
 */
const labelFor = async (
  env: Env,
  app: AppId,
  held: string | null
): Promise<string> =>
  held ?? (await nextLabel(env, { kind: "app", id: app }, new Date()));

/**
 * What making `version` of `app` live over `previous` tells besides,
 * with the change (the audit event `eventId`) or not at all: its first
 * live version opens the App to the people it is shared with, which its
 * webhooks are told.
 */
const firstLive = (
  db: ReturnType<typeof drizzle<Record<string, never>, D1Database>>,
  {
    app,
    version,
    previous,
  }: { app: AppId; version: number; previous: number | null },
  eventId: string
) =>
  previous === null
    ? queuedWebhookDeliveries(
        db,
        {
          app,
          event: "published",
          dedupe: `published:${eventId}`,
          version,
        },
        storedEvent(eventId)
      )
    : [];

/** Whether a switch binds or unbinds anything (app-workflow-bindings.ts). */
const rebound = ({
  changes,
  removals,
}: {
  readonly changes: readonly unknown[];
  readonly removals: readonly unknown[];
}): boolean => changes.length > 0 || removals.length > 0;

/**
 * Makes a published version the one that runs, live (app-publish.ts):
 * the App's draft just published, or any other, such as an earlier one to
 * roll back. Only over `basedOn`, the version current when its publish began
 * (null for none), and only while the version is still published, in
 * the statement that makes it current. A version runs only from its
 * release, read back from storage here first, every byte
 * checked, so neither a rollback nor a publish switches to bytes changed
 * since they were sealed. Its tests ran as it was published, never again
 * here. It takes its label (`nextLabel`) the first time it goes live, in
 * the batch that makes it live, and keeps it after; its first live
 * version opens the App to everyone it is shared with. `alsoWhenLive`
 * adds to that batch what goes only with it: the draft emptied over the
 * version (drafts.ts, `emptyDraftStatements`), audited as `action`. What
 * an admin granted the App stays granted, whichever version runs: only
 * new access waits for an admin, asked for as the version declares it.
 */
export const activateVersion = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown,
  basedOn: number | null,
  action: "version.published" | "version.rolled_back",
  alsoWhenLive: (live: SQL) => Promise<BatchItem<"sqlite">[]> = async () =>
    await Promise.resolve([])
): Promise<App> => {
  const found = await appFor(env, by, app, "builder");
  const appId = found.id;
  const row = await findVersion(env, appId, version);
  const { version: number, label: held } = row;
  if (found.currentVersion === number) {
    return found;
  }
  // Published over the version current then: any other since is a change
  // its publish never saw.
  if (found.currentVersion !== basedOn) {
    throw draftErrors.create("draft.conflict");
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
  const { applyVersionSchema, unfinishedPublish } =
    await import("./app-schema.ts");
  const { boundFunctionsServedSql, requireBoundFunctionsServed } =
    await import("./app-function-bindings.ts");
  const {
    bindableSql,
    bindingChangeStatements,
    tellBindingChanged,
    versionBindingChanges,
  } = await import("./app-workflow-bindings.ts");
  const release = await readBackRelease(env, appId, number);
  const previous = found.currentVersion;
  // No workflow bound to one of the App's functions loses it, or finds it
  // changed so its calls no longer fit (app-function-bindings.ts): a
  // publish, a rollback and any older version made current alike.
  const served = await requireBoundFunctionsServed(
    env,
    appId,
    previous,
    release
  );
  // What the version binds of its workflows, as its release sealed it,
  // checked now and bound in the same batch (app-workflow-bindings.ts).
  const bindingsOf = async () =>
    await versionBindingChanges(env, by, found, release);
  // Refused here before the store changes; checked again once it has
  // (below), as roles may have changed while its schema applied.
  await bindingsOf();
  // Last before the batch, after every gate above, so no refused gate
  // leaves the store changed: the version's schema applied to its store,
  // its migrations with it, all or nothing (app-schema.ts). The store and
  // D1 share no transaction: the store takes the schema only over the
  // version current as the publish began (`previous`), so of two
  // publishes at once one goes on; the batch is retried here if it fails,
  // and a version found current after all is answered as such. A batch
  // that doesn't make it current puts the current version's schema back,
  // or, where it can't, says so (`unfinishedPublish`).
  const applied = await applyVersionSchema(env, by, release, previous);
  let rebinding: Awaited<ReturnType<typeof bindingsOf>>;
  try {
    rebinding = await bindingsOf();
  } catch (error) {
    if (applied !== null) {
      await unfinishedPublish(env, by, appId, number, applied.appliedAt);
    }
    throw error;
  }
  // Its label: the one it went live under before (a roll back), or the
  // next, taken only by the batch below that makes it live.
  const label = await labelFor(env, appId, held);
  const event = createAuditEvent(
    subjectEntry(
      by,
      action,
      { kind: "app", id: appId },
      {
        version: number,
        label,
        previous,
        // What its schema did to the store, counted; each change by name is
        // the store's own entry (store-host.ts, `app.data.*`).
        ...(applied === null
          ? {}
          : {
              schemaHash: applied.schemaHash,
              schemaChanged: applied.changed,
              tablesRenamed: applied.changes.renamedTables.length,
              fieldsRenamed: applied.changes.renamedFields.length,
              tablesMigrated: applied.changes.migratedTables.length,
              tablesKept: applied.changes.keptTables.length,
              fieldsKept: applied.changes.keptFields.length,
              fieldsFilled: applied.changes.filledFields.length,
              recordsRewritten: applied.records,
            }),
      }
    ),
    "core"
  );
  const db = drizzle(env.DB);
  const alongside = await alsoWhenLive(storedEvent(event.id));
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
              liveLabel: label,
              // Kept for one release: the release before reads whether an
              // App is open to its people from it (schema.ts).
              status: "published",
            })
            .where(
              and(
                eq(apps.id, appId),
                sql`${apps.currentVersion} IS ${previous}`,
                // Archived since `editableApp` let it in: read-only now.
                isNull(apps.archivedAt),
                runnableReleaseSql(appId, number),
                publishedSql(appId, number),
                // A workflow granted a function since it was checked.
                boundFunctionsServedSql(appId, served),
                // A workflow it binds deleted, or made live at another
                // version, since it was checked.
                bindableSql(appId, rebinding)
              )
            )
            .returning(),
          outboxedEventWhere(db, event, sql`changes() > 0`),
          db
            .update(appVersions)
            .set({ label })
            .where(
              and(
                eq(appVersions.appId, appId),
                eq(appVersions.version, number),
                isNull(appVersions.label),
                storedEvent(event.id)
              )
            ),
          ...alongside,
          // Its workflows bound with it, or not at all.
          ...bindingChangeStatements(
            env,
            by,
            { app: appId, appVersion: number, switchId: event.id },
            rebinding,
            storedEvent(event.id)
          ),
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
          ...firstLive(db, { app: appId, version: number, previous }, event.id),
        ])
    );
  const [[changed]] = await batch().catch(async (error: unknown) => {
    if (applied !== null) {
      await unfinishedPublish(env, by, appId, number, applied.appliedAt);
    }
    throw error;
  });
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
      if (rebound(rebinding)) {
        waitUntil(tellBindingChanged(env, appId));
      }
      waitUntil(versionMadeCurrent(env, appId));
      return await editableApp(env, by, appId);
    }
    if (applied !== null) {
      await unfinishedPublish(env, by, appId, number, applied.appliedAt);
    }
    requireNotArchived(await findApp(env, appId));
    // Revoked or deleted since it was checked: refused as such.
    await requireRunnableRelease(env, appId, number);
    // Unpublished since it was checked: its release deleted by the sweep.
    if (!(await isPublished(env, appId, number))) {
      throw versionErrors.create("version.unpublished");
    }
    // A workflow bound since to a function it doesn't serve: named.
    await requireBoundFunctionsServed(env, appId, previous, release);
    // A workflow it binds deleted, or no longer the person's to bind.
    await bindingsOf();
    // What is left is a conflict: the base moved.
    throw draftErrors.create("draft.conflict");
  }
  if (rebound(rebinding)) {
    waitUntil(tellBindingChanged(env, appId));
  }
  // The pages open on the App hear of it (spec 11.5): their pages show
  // a new version ready, and switch to it (pages-rpc.ts, `watchVersion`).
  waitUntil(versionMadeCurrent(env, appId));
  return toApp(changed);
};

/**
 * App `app`'s live version, or while none is live its latest whose
 * publish didn't fail (the first of an App made from a blueprint): what a
 * draft with no changes is over, and the only base a draft is published
 * over (publish.ts). Never simply the latest: after a roll back that is a
 * version nobody uses, and a draft whose publish failed leaves its
 * version behind, which a discard must not bring back.
 */
const liveBase = async (env: Env, app: string): Promise<number | null> => {
  const { id, currentVersion } = await findApp(env, app);
  if (currentVersion !== null) {
    return currentVersion;
  }
  const latest = await drizzle(env.DB)
    .select({ version: appVersions.version })
    .from(appVersions)
    .where(
      and(eq(appVersions.appId, id), sql`${appVersions.status} IS NOT 'failed'`)
    )
    .orderBy(desc(appVersions.version))
    .limit(1)
    .get();
  return latest?.version ?? null;
};

/**
 * An App as drafts and versions see it (drafts.ts, publish.ts): its draft
 * written by its builders while it isn't archived, over its live version
 * (`liveBase`). How it is published is app-publish.ts' `appSteps`.
 */
export const appKind: DraftKind = {
  kind: "app",
  readable: async (env, by, input) => {
    const { id } = await appFor(env, by, input, "builder");
    return id;
  },
  editable: async (env, by, input) => {
    const { id } = await editableApp(env, by, input);
    return id;
  },
  stillEditable: (app, by) =>
    sql`NOT ${archivedNow(app)} AND ${stillBuiltBy(by, appIdSchema.parse(app))}`,
  currentVersion: async (env, app) => {
    const { currentVersion } = await findApp(env, app);
    return currentVersion;
  },
  liveBase,
  versionFiles: async (env, app, version) =>
    new Map(
      Object.entries(await versionFiles(env, appIdSchema.parse(app), version))
    ),
  versionDefinition: async (env, app, version) => {
    const row = await findVersion(env, appIdSchema.parse(app), version);
    return row.definition;
  },
  versions: {
    list: async (env, by, app, before) =>
      await listVersions(env, by, app, before),
    get: async (env, by, app, version) =>
      await getVersion(env, by, app, version),
  },
};
