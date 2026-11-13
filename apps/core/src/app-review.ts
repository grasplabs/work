import { appCodeFiles } from "@grasp-os/compiler";
import {
  declaredPermission,
  declaredPermissions,
  descriptorFromText,
  ownFiles,
} from "@grasp-os/runtime/host";
import type {
  AppManifest,
  RowRule,
  WorkflowBindingExtras,
} from "@grasp-os/runtime/host";
import type { AppReview } from "@grasp-os/shared/app-review";
import { appErrors, fileChangesSchema } from "@grasp-os/shared/apps";
import type { App, ReviewChange, TableRowRules } from "@grasp-os/shared/apps";
import type {
  DataModelChange,
  DraftDataModel,
  IndexUse,
} from "@grasp-os/shared/data-model";
import type { Draft } from "@grasp-os/shared/drafts";
import { draftErrors } from "@grasp-os/shared/drafts";
import { canonicalText } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  defineInDraft,
  draftDefinitions,
  saveDraftChanges,
} from "./agent-builds.ts";
import {
  dataModelOf,
  definitionPlan,
  operationDetail,
  usesOf,
} from "./app-definition.ts";
import { versionManifest } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import {
  appFor,
  appKind,
  diffFiles,
  draftDefinition,
  editableApp,
  findVersion,
  givenDefinition,
  readStored,
  versionFiles,
} from "./apps.ts";
import type { Member } from "./auth/identity.ts";
import {
  workflowResources,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { draftRelease } from "./draft-runs.ts";
import { draftOf, draftSummary, filesOf, nextLabel } from "./drafts.ts";
import type { DraftState } from "./drafts.ts";
import { buildAppCode, buildPages } from "./pages.ts";
import { permissionsOpenTo } from "./permissions-open.ts";
import { takesFile } from "./workflows/start-files.ts";

// What is App-only about an App's draft, for its builders (`apps.review`,
// `apps.dataModel`, `apps.define`, apps-rpc.ts): what publishing it would
// change, worked out by core from the draft as it is now, never taken
// from whoever wrote it; its data model; and a change of its definition
// by the person themselves, as a chat's agent's definition tools make
// one. Each checks the person builds the App. Whether the draft passes
// its checks is every kind's (publish.ts, `check`).
//
// What publishing an App's draft changes (`reviewDraft`) is worked out
// from the draft and the App as they are now, never taken from whoever
// wrote it (a chat's agent, say), so a draft can't describe itself as
// less than it is. Against the
// live version: its server code, its migrations, what the App asks for
// that no admin granted yet, what it holds, and which of that publishing
// would ask an admin for again. What it may reach is what it declares
// (its manifest, read from the release the draft seals to, the one its
// preview runs: draft-runs.ts), each binding approved for that
// declaration: no code is read to say what it calls.

/** The args of a bound workflow version's contract. */
const boundContractSchema = z.object({ args: z.json() });

/**
 * Whether the live version of any workflow the draft of an App binds once
 * live takes a file in its args, as that version's contract says: what
 * its release seals (`sealed`, bound-workflows.ts).
 */
const boundTakesFile = async (
  env: Env,
  sealed: readonly WorkflowBindingExtras[]
): Promise<boolean> => {
  // One read for every distinct workflow, however many aliases name it.
  const workflows = [...new Set(sealed.map(({ workflowId }) => workflowId))];
  if (workflows.length === 0) {
    return false;
  }
  // Each at its live version, which a binding starts.
  const rows = await drizzle(env.DB)
    .select({ contract: workflowResourceVersions.contract })
    .from(workflowResourceVersions)
    .innerJoin(
      workflowResources,
      and(
        eq(workflowResources.id, workflowResourceVersions.workflowResourceId),
        eq(workflowResources.currentVersion, workflowResourceVersions.version)
      )
    )
    .where(inList(workflowResourceVersions.workflowResourceId, workflows));
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
 * The row rules of the draft's tables (`AppReview.rowRules`), as
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
 * binds (`AppReview.handsFilesToWorkflows`): a boundary whoever
 * publishes it sees, whatever else changed.
 */
const handsFilesOf = async (
  env: Env,
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
  // live version of the workflow each alias is bound to once the draft is
  // live.
  return await boundTakesFile(env, workflows);
};

/**
 * The explicit migrations of the draft (`next`, its manifest) the live
 * version (`previous`, none while none is) doesn't have as they are (see
 * `AppReview.migrations`), read from each one's App manifest, so
 * wherever and however they are declared or registered. A migration
 * declared the same counts as modified when the server code changed
 * (`serverChanged`): its transform may run any of it.
 */
const migrationsOf = (
  next: AppManifest,
  previous: AppManifest | undefined,
  serverChanged: boolean
): NonNullable<AppReview["migrations"]> => {
  const had = previous?.migrations ?? {};
  const listed: NonNullable<AppReview["migrations"]> = [];
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
  AppReview,
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
      handsFilesToWorkflows: await handsFilesOf(env, release),
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
): Promise<{ changed: boolean; plan: AppReview["plan"] }> => {
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
 * code, what its manifest declares, and the access the App asks for that
 * no admin granted yet, as the permissions API shows it to `by`.
 */
export const reviewDraft = async (
  env: Env,
  by: Member,
  found: Pick<App, "id" | "currentVersion">,
  draft: DraftState
): Promise<
  Pick<
    AppReview,
    | "server"
    | "serverFiles"
    | "migrations"
    | "handsFilesToWorkflows"
    | "readsPeople"
    | "rowRules"
    | "permissions"
    | "plan"
  >
> => {
  const { currentVersion: current } = found;
  const files = ownFiles(
    Object.fromEntries(await filesOf(env, appKind, found.id, draft))
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
  // What the App asks for that waits on an admin, as the permissions API
  // shows it to this person: what it holds stays granted, whichever
  // version runs.
  const requested = await permissionsOpenTo(
    env,
    by,
    { type: "app", appId: found.id },
    "requested"
  );
  return {
    server,
    plan,
    serverFiles: serverChanges.map(({ name, change }) => ({
      path: name,
      change,
    })),
    ...manifest,
    permissions: requested,
  };
};

/**
 * What publishing App `app`'s draft would change against its live
 * version, for `by`, who builds it: its files, what it does to the App's
 * records and the access the App holds and asks for (`reviewDraft`). All
 * read at the draft's revision now, which the person publishes over.
 */
export const reviewChanges = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppReview> => {
  const found = await appFor(env, by, app, "builder");
  const { id, currentVersion } = found;
  const draft = await draftOf(env, appKind, id);
  const files = await filesOf(env, appKind, id, draft);
  const live = new Map(
    currentVersion === null
      ? []
      : Object.entries(await versionFiles(env, id, currentVersion))
  );
  const [review, next] = await Promise.all([
    reviewDraft(env, by, found, draft),
    nextLabel(env, { kind: "app", id }, new Date()),
  ]);
  return {
    ...review,
    revision: draft.revision,
    live: currentVersion,
    liveLabel: found.liveLabel,
    next,
    files: diffFiles(live, files),
  };
};

/**
 * What uses each of the draft's indexes, from what the compiler found
 * building its server code and its pages (cached by their files, as the
 * preview and the draft's check build them): none where a build fails,
 * or can't run now, which the data model is shown without.
 */
const indexUses = async (
  env: Env,
  app: string,
  files: ReadonlyMap<string, string>
): Promise<IndexUse[]> => {
  // Never their copy of what Grasp generates, as the preview builds them.
  const given = ownFiles(Object.fromEntries(files));
  try {
    const [code, pages] = await Promise.all([
      buildAppCode(env, given, app),
      // Compiled for what each page calls, not type-checked: a page that
      // calls a function reads as calling it whether or not it builds.
      buildPages(env, given, app, { profile: "preview", checks: false }),
    ]);
    return usesOf(code.ok ? (code.indexReads ?? []) : [], pages.calls ?? {});
  } catch (error) {
    log.warn("data_model.index_uses_failed", { app, ...errorFields(error) });
    return [];
  }
};

/**
 * The data model of App `app`'s draft (its definition), and what
 * publishing it does to the App's records, for `by`, who builds it.
 */
export const draftDataModel = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<DraftDataModel> => {
  const found = await appFor(env, by, app, "builder");
  const held = await draftDefinitions(env, found);
  if ("problem" in held) {
    throw appErrors.create("app.definition_invalid", {
      issues: [held.problem],
    });
  }
  return {
    model: dataModelOf(held.own),
    plan: definitionPlan(held.before, held.own),
    uses: await indexUses(env, found.id, held.files),
  };
};

/** A person's write of an App's draft (`AppsApi.editDraft`). */
const appDraftEditSchema = z.strictObject({
  revision: z.int().min(0),
  changes: fileChangesSchema,
  definition: z.json().optional(),
});

/**
 * Writes `input` (`appDraftEditSchema`) into App `app`'s draft for `by`,
 * one of its builders, over the revision they read (`draft.conflict`
 * otherwise), as their own checkpoint, refused as a chat's agent's write
 * is (agent-builds.ts, `saveDraftChanges`): its changes, TypeScript fixed
 * and formatted as the lint does safely, with its definition whole when
 * given (`givenDefinition`).
 * Answers the draft as saved.
 */
export const editAppDraft = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown
): Promise<Draft> => {
  const found = await editableApp(env, by, app);
  const { revision, changes, definition } = appErrors.parse(
    "app.invalid",
    appDraftEditSchema,
    input
  );
  const draft = await draftOf(env, appKind, found.id);
  if (draft.revision !== revision) {
    throw draftErrors.create("draft.conflict");
  }
  await saveDraftChanges(
    env,
    { by, detail: { files: Object.keys(changes).length } },
    found,
    {
      draft,
      files: await filesOf(env, appKind, found.id, draft),
      changes,
      ...(definition === undefined
        ? {}
        : { definition: givenDefinition(definition) }),
    }
  );
  return await draftSummary(env, appKind, found.id);
};

/**
 * Changes the definition in App `app`'s draft by `operation`, by `by`
 * themselves, as a chat's agent's definition tools do (agent-builds.ts,
 * `defineInDraft`), audited as theirs: only while they build the App and
 * it isn't archived. With `preview`, saves nothing: what it would make of
 * the model, and the plan, to show before it is made.
 */
export const defineDraft = async (
  env: Env,
  by: Identity,
  app: unknown,
  operation: unknown,
  preview = false
): Promise<DataModelChange> => {
  const found = await editableApp(env, by, app);
  const defined = await defineInDraft(
    env,
    by,
    found,
    operation,
    async (draft, files, changes, definition) => {
      if (!preview) {
        await saveDraftChanges(
          env,
          { by, detail: operationDetail(operation) },
          found,
          { draft, files, changes, definition }
        );
      }
    }
  );
  return defined.ok
    ? {
        ok: true,
        model: dataModelOf(defined.definition),
        plan: defined.plan,
        change: defined.change,
      }
    : defined;
};
