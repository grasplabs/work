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
import type { AppDraftChanges } from "@grasp-os/shared/app-drafts";
import type { App, ReviewChange, TableRowRules } from "@grasp-os/shared/apps";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { definitionPlan } from "./app-definition.ts";
import { versionManifest } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import {
  draftDefinition,
  draftFiles,
  findVersion,
  readStored,
  versionFiles,
} from "./apps.ts";
import type { Member } from "./auth/identity.ts";
import {
  appWorkflowBindings,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { draftRelease } from "./draft-runs.ts";
import type { DraftState } from "./drafts.ts";
import { permissionsOpenTo } from "./permissions-open.ts";
import { askedAgainBy } from "./permissions.ts";
import { takesFile } from "./workflows/start-files.ts";

// What publishing an App's draft changes, for the builder who publishes
// it (`AppDraftsApi.changes`): worked out here from the draft and the App
// as they are now, never taken from whoever wrote it (a chat's agent,
// say), so a draft can't describe itself as less than it is. Against the
// live version: its server code, its migrations, what the App asks for
// that no admin granted yet, what it holds, and which of that publishing
// would ask an admin for again. What it may reach is what it declares
// (its manifest, read from the release the draft seals to, the one its
// preview runs: draft-runs.ts), each binding approved for that
// declaration: no code is read to say what it calls.

/** The args of a bound workflow version's contract. */
const boundContractSchema = z.object({ args: z.json() });

/**
 * Whether any workflow version the draft of App `app` may bind once live
 * takes a file in its args, as that version's contract says: what its
 * release seals (`pins`, bound-workflows.ts), so a binding the draft
 * records counts as it will bind, and what the App binds now.
 */
const boundTakesFile = async (
  env: Env,
  app: AppId,
  pins: readonly WorkflowBindingExtras[],
  manifest: AppManifest
): Promise<boolean> => {
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
      takesFile(descriptorFromText(JSON.stringify(parsed.data.args)))
    ) {
      return true;
    }
  }
  return false;
};

/**
 * The row rules of the draft's tables (`AppDraftChanges.rowRules`), as
 * its schema's manifest holds them: what the store will enforce, read
 * from the draft, never from what its writer says of it.
 */
const rowRulesOf = (manifest: AppManifest): TableRowRules[] =>
  Object.entries(manifest.schema.tables)
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

/**
 * Whether the draft may hand files people can read to the workflows it
 * binds (`AppDraftChanges.handsFilesToWorkflows`): a boundary whoever
 * publishes it sees, whatever else changed.
 */
const handsFilesOf = async (
  env: Env,
  app: AppId,
  { app: manifest, workflows }: Pick<Release, "app" | "workflows">
): Promise<boolean> => {
  const readsFiles =
    declaredPermission(manifest, "files", "files")?.operations.includes(
      "read"
    ) === true;
  if (!readsFiles) {
    return false;
  }
  if (
    declaredPermissions(manifest, "workflows").some(({ args }) =>
      takesFile(args)
    )
  ) {
    return true;
  }
  // What a start hands is copied by the bound workflow's own input
  // (`handFiles`), whatever the App declares for its alias: read from the
  // version each alias is bound to once the draft is live.
  return await boundTakesFile(env, app, workflows, manifest);
};

/**
 * The explicit migrations of the draft (`next`, its manifest) the live
 * version (`previous`, none while none is) doesn't have as they are (see
 * `AppDraftChanges.migrations`), read from each one's App manifest, so
 * wherever and however they are declared or registered. A migration
 * declared the same counts as modified when the server code changed
 * (`serverChanged`): its transform may run any of it.
 */
const migrationsOf = (
  next: AppManifest,
  previous: AppManifest | undefined,
  serverChanged: boolean
): NonNullable<AppDraftChanges["migrations"]> => {
  const had = previous?.migrations ?? {};
  const listed: NonNullable<AppDraftChanges["migrations"]> = [];
  for (const declared of Object.values(next.migrations)) {
    const old = Object.hasOwn(had, declared.name)
      ? had[declared.name]
      : undefined;
    const { name, table } = declared;
    // A draft's fixtures run only as it is published, sealed.
    const fixtures = declared.fixtures.length;
    if (old === undefined) {
      listed.push({ name, table, change: "added", fixtures });
    } else if (
      canonicalText(old) !== canonicalText(declared) ||
      serverChanged
    ) {
      listed.push({ name, table, change: "modified", fixtures });
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

/** What a draft's review reads from its manifest, or nulls when it can't be read. */
type ManifestReview = Pick<
  AppDraftChanges,
  "migrations" | "handsFilesToWorkflows" | "readsPeople" | "rowRules"
>;

/**
 * What the draft's manifest says (`ManifestReview`), from the release it
 * seals to (`draftRelease`), against the live version's: nulls when
 * either can't be read (its code doesn't build or inspect), as it may
 * then do anything.
 */
const manifestReviewOf = async (
  env: Env,
  found: Pick<App, "id">,
  draft: DraftState,
  before:
    | { version: number; files: Readonly<Record<string, string>> }
    | undefined,
  serverChanged: boolean
): Promise<ManifestReview> => {
  try {
    const release = await draftRelease(env, found.id, draft);
    if (release === null) {
      return {
        migrations: [],
        handsFilesToWorkflows: false,
        readsPeople: false,
        rowRules: [],
      };
    }
    const previous =
      before === undefined
        ? undefined
        : await versionManifest(env, found.id, before.version, before.files);
    return {
      migrations: migrationsOf(release.app, previous, serverChanged),
      handsFilesToWorkflows: await handsFilesOf(env, found.id, release),
      readsPeople:
        declaredPermission(release.app, "people", "people") !== undefined,
      rowRules: rowRulesOf(release.app),
    };
  } catch (error) {
    log.warn("version_review.manifest_unread", errorFields(error));
    return {
      migrations: null,
      handsFilesToWorkflows: null,
      readsPeople: null,
      rowRules: null,
    };
  }
};

/**
 * Whether `draft`'s definition (its own, or its base's) differs from the
 * live version's (none while none is), and what publishing it does to the
 * App's records (`plan`, the store's plan of the move from the live
 * version's): null when the definition can't be read. A draft that holds
 * its base's starts with none of its answers: an answer belongs to the
 * version it was committed with (agent-builds.ts, `draftDefinitions`).
 */
const definitionReviewOf = async (
  env: Env,
  found: Pick<App, "id" | "currentVersion">,
  draft: DraftState
): Promise<{ changed: boolean; plan: AppDraftChanges["plan"] }> => {
  try {
    const own = await draftDefinition(env, found.id, draft);
    const live =
      found.currentVersion === null
        ? null
        : await readStored(
            await findVersion(env, found.id, found.currentVersion)
          );
    const changed = (own?.hash ?? null) !== (live?.hash ?? null);
    if (own === null) {
      return { changed, plan: null };
    }
    const moved =
      draft.definition === null
        ? { ...own.definition, answers: [] }
        : own.definition;
    return { changed, plan: definitionPlan(live?.definition ?? null, moved) };
  } catch (error) {
    log.warn("version_review.definition_unread", errorFields(error));
    return { changed: draft.definition !== null, plan: null };
  }
};

/**
 * What publishing App `found`'s `draft` would change against its live
 * version, for `by`, one of its builders (see the header): its server
 * code, what its manifest declares, and the access the App holds and asks
 * for, with which of it publishing would ask an admin for again
 * (`askedAgainBy`), as the permissions API shows them to `by`.
 */
export const reviewDraft = async (
  env: Env,
  by: Member,
  found: Pick<App, "id" | "currentVersion">,
  draft: DraftState
): Promise<
  Pick<
    AppDraftChanges,
    | "server"
    | "serverFiles"
    | "migrations"
    | "handsFilesToWorkflows"
    | "readsPeople"
    | "rowRules"
    | "permissions"
    | "grants"
    | "callers"
    | "plan"
  >
> => {
  const { currentVersion: current } = found;
  const files = ownFiles(
    Object.fromEntries(await draftFiles(env, found.id, draft))
  );
  const before =
    current === null
      ? undefined
      : {
          version: current,
          files: ownFiles(await versionFiles(env, found.id, current)),
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
  const codeChange = serverChangeOf(
    serverChanges,
    Object.keys(appCodeFiles(before?.files ?? {})).length,
    Object.keys(appCodeFiles(files)).length
  );
  // The definition is no file: a change of it alone (two fields' IDs
  // swapped, say) changes no code, yet moves the records' values as the
  // draft goes live, so it counts as a change of the server code.
  const { changed: definitionChanged, plan } = await definitionReviewOf(
    env,
    found,
    draft
  );
  let definitionChange: ReviewChange | null = null;
  if (definitionChanged) {
    definitionChange = current === null ? "added" : "modified";
  }
  const server = codeChange ?? definitionChange;
  const manifest = await manifestReviewOf(
    env,
    found,
    draft,
    before,
    server !== null ||
      fileChanges.some(
        ({ name }) =>
          name === "grasp.config.ts" ||
          name === "values.ts" ||
          name.startsWith("server/")
      )
  );
  // What the App holds, and the workflows' grants to call its functions,
  // which trust its code alike (`madeCurrent`), as the permissions API
  // shows them to this person. Never kept as a blueprint copy's first
  // version is: a draft is someone's change of it.
  const [held, callers, requested] = await Promise.all([
    permissionsOpenTo(env, by, { type: "app", appId: found.id }, "active"),
    permissionsOpenTo(env, by, undefined, "active", found.id),
    permissionsOpenTo(env, by, { type: "app", appId: found.id }, "requested"),
  ]);
  return {
    server,
    plan,
    serverFiles: serverChanges.map(({ name, change }) => ({
      path: name,
      change,
    })),
    ...manifest,
    permissions: requested,
    grants: held.map((permission) => ({
      permission,
      askedAgain: askedAgainBy(by, permission),
    })),
    callers: callers.map((permission) => ({
      permission,
      askedAgain: askedAgainBy(by, permission),
    })),
  };
};
