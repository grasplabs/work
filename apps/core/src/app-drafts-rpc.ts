import { isAppLayout } from "@grasp-os/compiler";
import { ownFiles } from "@grasp-os/runtime/host";
import { agentErrors } from "@grasp-os/shared/agent";
import { appDataErrors } from "@grasp-os/shared/app-data";
import type { AppDataPage, AppDataTable } from "@grasp-os/shared/app-data";
import type {
  AppDraft,
  AppDraftChanges,
  AppDraftHistoryPoint,
  AppDraftPoint,
  AppDraftProblem,
  AppDraftsApi,
} from "@grasp-os/shared/app-drafts";
import { appErrors } from "@grasp-os/shared/apps";
import type { App, AppFiles } from "@grasp-os/shared/apps";
import { previewShownSchema, readOnlyRevision } from "@grasp-os/shared/chat";
import type {
  PreviewAt,
  PreviewBundle,
  PreviewRefresh,
  PreviewShown,
  PreviewUpdate,
} from "@grasp-os/shared/chat";
import type {
  DataModelChange,
  DraftDataModel,
  IndexUse,
} from "@grasp-os/shared/data-model";
import { isExpectedError } from "@grasp-os/shared/errors";
import { draftSealFailures } from "@grasp-os/shared/functions";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  pageErrors,
  pageHrefSchema,
  pageProblemSchema,
} from "@grasp-os/shared/pages";
import type { PageProblem } from "@grasp-os/shared/pages";
import type { Identity } from "@grasp-os/shared/rpc";
import { drizzle } from "drizzle-orm/d1";

import {
  checkFiles,
  defineInDraft,
  draftDefinitions,
  saveDraftChanges,
} from "./agent-builds.ts";
import type { DraftCheck } from "./agent-builds.ts";
import {
  dataModelOf,
  definitionPlan,
  operationDetail,
  usesOf,
} from "./app-definition.ts";
import {
  draftOf,
  draftPoints,
  draftSummary,
  emptyDraft,
  liveBase,
  readPoint,
  restorePoint,
} from "./app-drafts.ts";
import type { Draft } from "./app-drafts.ts";
import { publishDraft } from "./app-publish.ts";
import {
  appFor,
  changeEntry,
  changesAnything,
  diffFiles,
  draftFiles,
  editableApp,
  findVersion,
  hasPages,
  nextLabel,
  versionFiles,
} from "./apps.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { withReferencesText } from "./draft-references.ts";
import type { PageModules } from "./draft-references.ts";
import { draftReferences, draftTestData } from "./draft-runs.ts";
import { appPreview } from "./durable-objects.ts";
import { indexAppNow } from "./knowledge/apps-collection.ts";
import { callbackFor, isStub } from "./page-callbacks.ts";
import type { StillOpen } from "./page-callbacks.ts";
import { leaseFor } from "./page-delivery.ts";
import {
  appModules,
  frameAccess,
  previewFrame,
  stageFrame,
  stageModules,
  updatingFrameAccess,
} from "./page-frame.ts";
import { buildAppCode, buildPages, versionPages } from "./pages.ts";
import type { BuiltPage } from "./pages.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { Subscription } from "./subscription.ts";
import { reviewDraft } from "./version-review.ts";

// A signed-in person's `apps.drafts` (GRA-1665): each App's one draft
// (app-drafts.ts), which every builder of the App and their chats' agents
// share, and its one preview (app-preview.ts), which every builder shares
// too: the same test data for all, each acting as themselves. Only a
// builder of the App reads, changes or previews it, checked at every
// call, and a change of an archived App is refused; each write lands only
// over the revision the person read (`app.conflict` once another write
// landed), and is audited as theirs. Every write tells the App's preview,
// which tells every page that follows the draft (`watch`), so each open
// preview takes it at once, whoever made it. The preview's frames call
// the draft on the path every page calls on, under the lease the bundle
// carries (page-calls.ts, draft-runs.ts).

/**
 * Most drafts one connection follows at once, as a connection follows at
 * most so many chats (chats-rpc.ts).
 */
const maxWatches = 10;

/** How a push to a page that follows a draft is refused. */
const refusals = {
  invalid: () => agentErrors.create("agent.invalid_request"),
  closed: () => appErrors.create("app.preview_outdated"),
};

const encoder = new TextEncoder();

/** Whether `by` builds App `app` now. */
const buildsNow = async (
  env: Env,
  by: Identity,
  app: AppId
): Promise<boolean> => {
  try {
    await editableApp(env, by, app);
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/**
 * What the open frame of a preview imports of `built`, a build of its
 * draft at `revision` (@grasp-os/runtime's preview-runtime.ts): its route
 * tree's module, by address, and the App's and the kit's modules it
 * loads, and the App's version it is of, when it shows one
 * (`PreviewRefresh.appVersion`), and whether it runs in place of server
 * code that doesn't build (`PreviewRefresh.serverUnbuilt`).
 */
const refreshOf = (
  revision: number,
  { code, serverUnbuilt }: Pick<PreviewPage, "code" | "serverUnbuilt">,
  appVersion: number | undefined
): PreviewRefresh => ({
  ...(serverUnbuilt ? { serverUnbuilt: true } : {}),
  revision,
  entry: code.addresses[code.entry] ?? "",
  modules: Object.fromEntries(
    Object.entries(code.modules).map(([name, text]) => [
      code.addresses[name] ?? "",
      encoder.encode(text).byteLength,
    ])
  ),
  css: code.css,
  kit: Object.keys(code.kit),
  ...(appVersion === undefined ? {} : { appVersion }),
});

/**
 * What a preview builds (`AppDraftsRpc.#previewed`): its files, the
 * references their pages import, the draft's revision it is at
 * (`readOnlyRevision` for an undo point or a version opened read-only),
 * and the App's version it `shows`, when it shows one rather than the
 * draft's changes.
 */
interface Previewed {
  files: Map<string, string>;
  references: () => Promise<PreviewReferences>;
  revision: number;
  shows?: number;
}

/**
 * The references a preview's pages import (`draftReferences`), and
 * whether they are the last ones its draft generated in place of those of
 * server code that doesn't build now (`serverUnbuilt`), so a write of its
 * pages still reaches the frame, whose calls answer why.
 */
interface PreviewReferences {
  references: PageModules | null;
  serverUnbuilt: boolean;
}

/** A preview's pages, built, and whether its server code doesn't build now. */
type PreviewPage = BuiltPage & { serverUnbuilt: boolean };

/**
 * Whether `error` says code didn't build: its pages
 * (`page.build_failed`), or its server code (`draftSealFailures`).
 */
const buildFailed = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  (error.code === "page.build_failed" || draftSealFailures.has(error.code));

/** Most problems a draft's review lists (`AppDraftChanges.check`). */
const maxProblems = 50;

/**
 * The errors `check` found, as a builder reads them before publishing:
 * its builds' errors by file, then what its preview ran into. Warnings
 * never fail a check, so they aren't listed.
 */
const problemsOf = (check: DraftCheck): AppDraftProblem[] =>
  [
    ...[check.pages, check.server, check.lint].flatMap((build) =>
      build.diagnostics
        .filter(({ severity }) => severity === "error")
        .map(({ file, line, message }) => ({ at: file, line, message }))
    ),
    ...check.preview.problems
      .filter(({ kind }) => kind !== "warning")
      .map(({ at, message }) => ({ at, line: null, message })),
  ].slice(0, maxProblems);

/** A draft revision as the page sends it: a count of writes. */
const revisionOf = (revision: unknown): number => {
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw appErrors.create("app.invalid", {
      issues: ["A draft revision, as the draft was read."],
    });
  }
  return revision;
};

/** An undo point's number as the page sends it, to list those before it. */
const pointOf = (point: unknown): number => {
  if (typeof point !== "number" || !Number.isSafeInteger(point) || point < 1) {
    throw appErrors.create("app.invalid", {
      issues: ["An undo point's number, as the draft's history listed it."],
    });
  }
  return point;
};

export class AppDraftsRpc extends CoreRpcTarget implements AppDraftsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  /** This connection's follows of drafts, each until it's released. */
  readonly #watches = new Set<Disposable>();
  /**
   * Whether this connection may still follow drafts, before each push:
   * its session holds, as the connection's own check last read it (at
   * most `sessionRecheckMs` old, session-check.ts).
   */
  readonly #stillOpen: StillOpen;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#stillOpen = async () => {
      try {
        await check();
        return true;
      } catch {
        return false;
      }
    };
  }

  /** The App's preview of its draft (app-preview.ts). */
  #previewOf(app: AppId) {
    return appPreview(this.#env, app);
  }

  async get(app: string): Promise<AppDraft> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      return await draftSummary(this.#env, id);
    });
  }

  /**
   * Every file of the App's draft, read as its writers read them
   * (`draftOf`), so the code view shows what the preview builds.
   */
  async files(app: string): Promise<AppFiles> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      const draft = await draftOf(this.#env, id);
      return Object.fromEntries(await draftFiles(this.#env, id, draft));
    });
  }

  async points(app: string, before?: number): Promise<AppDraftHistoryPoint[]> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      return await draftPoints(
        this.#env,
        id,
        before === undefined ? undefined : pointOf(before)
      );
    });
  }

  /**
   * What publishing the App's draft would change against its live
   * version, for one who builds it: its files, what it does to the App's
   * records, the access the App holds and asks for, and its check, as
   * publishing checks it (`checkFiles`). All read at the draft's revision
   * now, which the person publishes over.
   */
  async changes(app: string): Promise<AppDraftChanges> {
    return await withPerson(this.#check, async (by) => {
      const found = await appFor(this.#env, by, app, "builder");
      const { id, currentVersion } = found;
      const draft = await draftOf(this.#env, id);
      const files = await draftFiles(this.#env, id, draft);
      const live = new Map(
        currentVersion === null
          ? []
          : Object.entries(await versionFiles(this.#env, id, currentVersion))
      );
      const [review, check, next] = await Promise.all([
        reviewDraft(this.#env, by, found, draft),
        checkFiles(this.#env, id, draft, Object.fromEntries(files)),
        nextLabel(this.#env, id, new Date()),
      ]);
      return {
        ...review,
        revision: draft.revision,
        live: currentVersion,
        liveLabel: found.liveLabel,
        next,
        files: diffFiles(live, files),
        check: { passed: check.passed, problems: problemsOf(check) },
      };
    });
  }

  /**
   * Makes undo point `point` the draft again, as a new point, over the
   * `revision` the person read: only while they build the App and it
   * isn't archived. Every open preview of the App takes it.
   */
  async restorePoint(
    app: string,
    point: number,
    revision: number
  ): Promise<AppDraftPoint> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      return await restorePoint(this.#env, by, id, point, revisionOf(revision));
    });
  }

  /**
   * Discards the draft's changes, over the `revision` the person read:
   * the draft is over the App's live version again, and its undo points
   * stay, to restore one. Only while they build the App and it isn't
   * archived.
   */
  async discard(app: string, revision: number): Promise<void> {
    await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      await emptyDraft(this.#env, id, {
        revision: revisionOf(revision),
        base: await liveBase(this.#env, id),
        by,
      });
    });
  }

  /**
   * Follows the App's draft for one page: `onRevision` hears its revision
   * after each write, whoever made it (`AppPreview.revised`), so the
   * page's open preview takes it at once. Only while the person builds
   * the App, checked before each push; counts as one of the connection's
   * watches.
   */
  async watch(
    app: string,
    onRevision: (revision: number) => void
  ): Promise<Subscription> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      if (!isStub(onRevision)) {
        throw pageErrors.create("page.invalid");
      }
      if (this.#watches.size >= maxWatches) {
        throw agentErrors.create("agent.too_many_watches");
      }
      const stillBuilds = async (): Promise<boolean> =>
        (await this.#stillOpen()) && (await buildsNow(this.#env, by, id));
      const listener = callbackFor(onRevision, stillBuilds, refusals, () => {
        this.#watches.delete(listener);
      });
      this.#watches.add(listener);
      const preview = this.#previewOf(id);
      let watchId: string;
      try {
        watchId = await preview.watch(by.userId, listener);
      } catch (error) {
        listener[Symbol.dispose]();
        throw error;
      }
      return new Subscription(async () => {
        listener[Symbol.dispose]();
        try {
          await preview.unwatch(watchId);
        } catch (error) {
          log.warn("app.preview_unwatch_failed", {
            app: id,
            ...errorFields(error),
          });
        }
      });
    });
  }

  /**
   * Clears the test data of the App's preview, for everyone who builds
   * it (`AppPreview.resetData`): only while the person builds the App and
   * it isn't archived. Audited as theirs first.
   */
  async resetTestData(app: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      const db = drizzle(this.#env.DB);
      await auditedBatch(this.#env, db, [
        outboxed(db, changeEntry(by, "app.preview.reset", id, {})),
      ]);
      await this.#previewOf(id).resetData();
    });
  }

  /**
   * The preview's test data, for one who builds the App: what the Data
   * view shows in place of the App's records while it shows the draft
   * (draft-runs.ts, `draftTestData`).
   */
  async testTables(app: string): Promise<AppDataTable[]> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      const tables = await draftTestData(this.#env, by, id);
      if (!Array.isArray(tables)) {
        throw new TypeError("The preview answered a page for its tables");
      }
      return tables;
    });
  }

  async testRecords(
    app: string,
    table: string,
    cursor: string | null
  ): Promise<AppDataPage> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      if (
        typeof table !== "string" ||
        (cursor !== null && typeof cursor !== "string")
      ) {
        throw appDataErrors.create("app_data.invalid");
      }
      const page = await draftTestData(this.#env, by, id, { table, cursor });
      if (Array.isArray(page)) {
        throw new TypeError("The preview answered tables for a page");
      }
      return page;
    });
  }

  /**
   * Publishes the App's draft at `revision` (app-publish.ts,
   * `publishDraft`), by the person themselves: only while they build the
   * App and it isn't archived. Then indexes the App into the Apps
   * collection (knowledge/apps-collection.ts): its entry holds the new
   * version once this returns, unless indexing failed or raced another;
   * the clock then heals it within 15 minutes.
   */
  async publish(app: string, revision: number, message?: string): Promise<App> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      const live = await publishDraft(
        this.#env,
        by,
        id,
        revisionOf(revision),
        message ?? "Published from the draft."
      );
      await indexAppNow(this.#env, id);
      return live;
    });
  }

  /**
   * What uses each of the draft's indexes, from what the compiler found
   * building its server code and its pages (cached by their files, as
   * the preview and the draft's check build them): none where a build
   * fails, or can't run now, which the data model is shown without.
   */
  async #indexUses(
    app: string,
    files: ReadonlyMap<string, string>
  ): Promise<IndexUse[]> {
    // Never their copy of what Grasp generates, as the preview builds them.
    const given = ownFiles(Object.fromEntries(files));
    try {
      const [code, pages] = await Promise.all([
        buildAppCode(this.#env, given, app),
        // Compiled for what each page calls, not type-checked: a page that
        // calls a function reads as calling it whether or not it builds.
        buildPages(this.#env, given, app, {
          profile: "preview",
          checks: false,
        }),
      ]);
      return usesOf(code.ok ? (code.indexReads ?? []) : [], pages.calls ?? {});
    } catch (error) {
      log.warn("data_model.index_uses_failed", { app, ...errorFields(error) });
      return [];
    }
  }

  /**
   * The data model of the App's draft (its definition), and what
   * publishing it does to the App's records: only while the person builds
   * the App, as for its files.
   */
  async dataModel(app: string): Promise<DraftDataModel> {
    return await withPerson(this.#check, async (by) => {
      const found = await appFor(this.#env, by, app, "builder");
      const held = await draftDefinitions(this.#env, found);
      if ("problem" in held) {
        throw appErrors.create("app.definition_invalid", {
          issues: [held.problem],
        });
      }
      return {
        model: dataModelOf(held.own),
        plan: definitionPlan(held.before, held.own),
        uses: await this.#indexUses(found.id, held.files),
      };
    });
  }

  /**
   * Changes the definition in the App's draft by `operation`, by the
   * person themselves, as a chat's agent's definition tools do
   * (agent-builds.ts, `defineInDraft`), audited as theirs: only while
   * they build the App and it isn't archived. With `preview`, saves
   * nothing: what it would make of the model, and the plan, to show
   * before it is made.
   */
  async define(
    app: string,
    operation: unknown,
    preview = false
  ): Promise<DataModelChange> {
    return await withPerson(this.#check, async (by) => {
      const found = await editableApp(this.#env, by, app);
      const defined = await defineInDraft(
        this.#env,
        by,
        found,
        operation,
        async (draft, files, changes, definition) => {
          if (!preview) {
            await saveDraftChanges(
              this.#env,
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
    });
  }

  /**
   * The pages of the App's draft, to preview: only while the person
   * builds the App, as the agent must to write it. With `point`, of that
   * undo point of the draft, read-only: built the same way, but at
   * `readOnlyRevision`, with no lease, so it calls nothing. With
   * `version` instead, of that version of the App, read-only the same
   * way.
   */
  async preview(
    app: string,
    point?: number,
    version?: number
  ): Promise<PreviewBundle> {
    return await withPerson(this.#check, async (by) => {
      // As its recheck (`buildsNow`): an archived App has no preview.
      const { id, name } = await editableApp(this.#env, by, app);
      const asked = point === undefined ? { version } : { point };
      const load = async (): Promise<PreviewBundle> =>
        await this.#loadPreview(by, id, name, asked);
      // A point or version opened read-only is one person's click, never
      // asked for again by a write: it builds as it is asked.
      if (point !== undefined || version !== undefined) {
        return await load();
      }
      // The draft as it is now: one open per viewer and revision, shared
      // by every preview of theirs that opens it at once.
      const opened = await this.#previewOf(id).build(
        by.userId,
        "open",
        undefined,
        load
      );
      // What `load` answered, shared under a key only it builds (`open`):
      // a bundle, which only a frame's open has.
      if (!("frameToken" in opened)) {
        throw new Error("A preview's open was answered with an update.");
      }
      return opened;
    });
  }

  /**
   * The pages of the App's draft at `revision`, the newest the asker
   * knows of, their modules staged for its open preview to import and
   * swap in (`PreviewRefresh`): only while the person builds the App, as
   * for `preview`. One build per viewer and revision, shared by every
   * preview of theirs that asks for it (preview-builds.ts);
   * `app.preview_outdated` once the draft moved past `revision`, as the
   * asker then hears of a newer one. No frame is staged, nothing is
   * sealed when the draft's server code is as it was (draft-runs.ts), and
   * its build skips the type check and lint, so a write reaches the page
   * at once; the agent's check of the draft has them. `shown` is what the
   * frame shows: it is handed only a build it can swap in, and otherwise
   * told whether what it shows is still what to show (`PreviewUpdate`).
   */
  async previewUpdate(
    app: string,
    revision: number,
    shown: PreviewShown
  ): Promise<PreviewUpdate> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      if (!Number.isSafeInteger(revision)) {
        throw pageErrors.create("page.invalid");
      }
      const frame = pageErrors.parse("page.invalid", previewShownSchema, shown);
      const update = async (): Promise<PreviewUpdate> =>
        await this.#updateFor(by, id, frame);
      const updated = await this.#previewOf(id).build(
        by.userId,
        // The answer depends on all the frame shows.
        `update:${canonicalJson(frame)}`,
        revision,
        update
      );
      // What `update` answered, shared under a key only it builds
      // (`update:` and what the frame shows): an update, never a frame's
      // bundle.
      if ("frameToken" in updated) {
        throw new Error("A preview's update was answered with a bundle.");
      }
      return updated;
    });
  }

  /**
   * What an open frame of `by`'s preview of App `id` takes now
   * (`PreviewUpdate`), the frame showing `shown`. The build to show is the
   * draft's changes, or the App's live version while the draft changes
   * nothing:
   *
   * - The App's live version: `unchanged` for a frame showing it; a
   *   build to swap in for a frame on the draft's changes; `restart` for
   *   one showing another version.
   * - The draft's changes: their build, swapped in. One that doesn't build
   *   fails as the build does, so the frame keeps what it shows and says
   *   it is being fixed, unless the frame shows the App's version in place
   *   of the draft and a newer one came since: it opens afresh on that
   *   one, as `#loadPreview` would.
   */
  async #updateFor(
    by: Identity,
    id: AppId,
    shown: PreviewShown
  ): Promise<PreviewUpdate> {
    const now = await this.#previewed(id, {});
    if (now.shows !== undefined) {
      if (shown.appVersion === now.shows) {
        return { app: id, unchanged: true };
      }
      if (shown.appVersion !== undefined) {
        return { app: id, restart: true };
      }
      return { app: id, refresh: await this.#staged(by, id, now) };
    }
    // Whether a newer version of the App came than the one a frame shows
    // in place of the draft: what `#loadPreview` would open it on now.
    const newerShown = async (): Promise<boolean> => {
      try {
        const { shows } = await this.#previewed(id, { fallback: true });
        return shows !== undefined && shows !== shown.appVersion;
      } catch {
        return false;
      }
    };
    // No page left in the draft: a frame on its changes opens afresh, on
    // the version the draft is over in its place, as `#loadPreview` opens
    // it; one on the App's version already moves on only to a newer one.
    if (!hasPages(now.files)) {
      return shown.appVersion === undefined || (await newerShown())
        ? { app: id, restart: true }
        : { app: id, unchanged: true };
    }
    try {
      return { app: id, refresh: await this.#staged(by, id, now) };
    } catch (error) {
      if (
        shown.appVersion === undefined ||
        !buildFailed(error) ||
        !(await newerShown())
      ) {
        throw error;
      }
      return { app: id, restart: true };
    }
  }

  /**
   * The pages of `previewed`, built and their modules staged under the
   * viewer's preview's own scope, where its open frame loads them
   * (page-frame.ts): the kit's are those it loaded already.
   */
  async #staged(
    by: Identity,
    id: AppId,
    previewed: Previewed
  ): Promise<PreviewRefresh> {
    const built = await this.#previewBuild(
      previewed.files,
      previewed.references,
      id
    );
    const { scope } = await previewFrame(by.userId, id, built.artifact, {
      updates: true,
    });
    await stageModules(this.#env, appModules(built.code, scope));
    return refreshOf(previewed.revision, built, previewed.shows);
  }

  /**
   * What a read-only preview of App `id` opens: its undo point `point`,
   * or else its version `version` as a draft over it with no changes.
   */
  async #readOnlyDraft(
    id: AppId,
    { point, version }: { point?: number; version?: number | undefined }
  ): Promise<Draft> {
    if (point !== undefined) {
      const { draft } = await readPoint(this.#env, id, point);
      return draft;
    }
    const found = await findVersion(this.#env, id, version);
    return {
      base: found.version,
      changes: {},
      definition: null,
      revision: readOnlyRevision,
    };
  }

  /**
   * What `by`'s preview of App `id` builds: the files of its draft now,
   * of its undo point `point` or its version `version`, or (`fallback`)
   * of the version the draft is over in place of the draft, and the
   * references their pages import, read over the same build. A point or
   * version is read-only (`readOnlyRevision`). The draft now that changes
   * nothing, and the fallback, `shows` that version, read anew.
   */
  async #previewed(
    id: AppId,
    {
      point,
      version,
      fallback = false,
    }: { point?: number; version?: number | undefined; fallback?: boolean }
  ): Promise<Previewed> {
    const preview = this.#previewOf(id);
    if (point !== undefined || version !== undefined) {
      const draft = await this.#readOnlyDraft(id, { point, version });
      return {
        files: await draftFiles(this.#env, id, draft),
        references: async () => ({
          references: await draftReferences(this.#env, id, draft),
          serverUnbuilt: false,
        }),
        // Opened read-only, it names no revision a draft is at, and gets
        // no lease: nothing it calls runs, even when it is the draft as it
        // is now.
        revision: readOnlyRevision,
      };
    }
    const draft = await preview.draft({ fallback });
    const shows =
      draft.base !== null && !changesAnything(draft) ? draft.base : undefined;
    return {
      files: await draftFiles(this.#env, id, draft),
      // Of the very build its files are of, or the last that built.
      references: async () => {
        try {
          const references = await draftReferences(this.#env, id, draft);
          await preview.keepReferences(references);
          return { references, serverUnbuilt: false };
        } catch (error) {
          const kept = buildFailed(error)
            ? await preview.referencesKept()
            : undefined;
          if (kept === undefined) {
            throw error;
          }
          return { references: kept, serverUnbuilt: true };
        }
      },
      revision: draft.revision,
      ...(shows === undefined ? {} : { shows }),
    };
  }

  /**
   * The bundle of `by`'s preview of App `id`, built from its draft now,
   * or read-only from its undo point `point` or version `version`
   * (`#previewed`). The draft now with changes that leave it no page that
   * builds opens on the version it is over instead, as a draft that
   * changes nothing would show it, said to be a `fallback`, its calls on
   * the draft as it is, as any preview's: its frame takes the draft's
   * next write that builds, as any frame does. So nothing is shown in
   * place of the App while a version of it builds.
   */
  async #loadPreview(
    by: Identity,
    id: AppId,
    name: string,
    opened: { point?: number; version?: number | undefined }
  ): Promise<PreviewBundle> {
    const now = await this.#previewed(id, opened);
    let shown = now;
    let built: PreviewPage;
    try {
      built = await this.#previewBuild(now.files, now.references, id);
    } catch (error) {
      // Only the draft as it is now, with changes of its own, falls back.
      const fallsBack =
        now.revision !== readOnlyRevision &&
        now.shows === undefined &&
        (buildFailed(error) || !hasPages(now.files));
      if (!fallsBack) {
        throw error;
      }
      try {
        shown = await this.#previewed(id, { fallback: true });
        built = await this.#previewBuild(shown.files, shown.references, id);
      } catch {
        // No version of the App that builds: the draft's own failure.
        throw error;
      }
    }
    // Only the draft as it is now takes updates, and only its frame's
    // policy allows them (page-frame.ts): one opened read-only stays as
    // it was, staged apart from the draft's writes.
    const updates = now.revision !== readOnlyRevision;
    // A preview reads no real data; its frame still runs exactly this
    // build and nothing else, until the page hands it an update.
    const { scope, artifact } = await previewFrame(
      by.userId,
      id,
      built.artifact,
      { updates }
    );
    await stageFrame(this.#env, artifact, built.code, {
      preview: true,
      scope,
    });
    return {
      app: id,
      name,
      revision: now.revision,
      artifact,
      frameToken: updates
        ? await updatingFrameAccess(this.#env, artifact)
        : await frameAccess(this.#env, artifact),
      // Its updates follow the draft's revisions, from the one it opened
      // at, and its calls the draft as it is then, on the path every page
      // calls on (page-calls.ts), as this builder: the lease names them
      // and the App's draft, and nothing of the App's release.
      ...(updates
        ? {
            refresh: refreshOf(now.revision, built, shown.shows),
            lease: await leaseFor(this.#env, by.userId, id, {
              kind: "draft",
              artifact,
            }),
          }
        : {}),
      ...(shown === now ? {} : { fallback: true }),
    };
  }

  /**
   * The pages of a preview's `files`, built for its frame: with the
   * references its draft release generates when it is of spec 8's layout,
   * the very release its calls run on, and without the type check and
   * lint, which the agent's check of the draft has (pages.ts).
   * `page.not_found` for files with no pages.
   */
  async #previewBuild(
    files: Map<string, string>,
    references: () => Promise<PreviewReferences>,
    id: AppId
  ): Promise<PreviewPage> {
    const source = Object.fromEntries(files);
    // Its server code read whatever its pages import: whether it builds
    // is said even of pages that call none of it.
    const reading = isAppLayout(source) ? references() : undefined;
    let read:
      | { references: PreviewReferences }
      | { failed: unknown }
      | undefined;
    if (reading !== undefined) {
      try {
        read = { references: await reading };
      } catch (error) {
        read = { failed: error };
      }
    }
    let needed = false;
    const withReferences = await withReferencesText(source, async () => {
      needed = true;
      const got = await reading;
      return got?.references ?? undefined;
    });
    // Its pages import references that couldn't be had: why (its server
    // code doesn't build, say) is what to tell, never that the App has no
    // server code, which a build without them would say.
    if (needed && read !== undefined && "failed" in read) {
      throw read.failed;
    }
    const serverUnbuilt =
      read !== undefined &&
      ("failed" in read
        ? buildFailed(read.failed)
        : read.references.serverUnbuilt);
    const built = await versionPages(
      this.#env,
      withReferences,
      null,
      id,
      "preview",
      { checks: false }
    );
    return { ...built, serverUnbuilt };
  }

  /**
   * Keeps what a page of the draft's preview reported, for the next check
   * of the draft by any builder's agent: text its code wrote, held to
   * size (`pageProblemSchema`).
   */
  async previewReport(
    app: string,
    at: PreviewAt,
    path: string,
    problem: PageProblem
  ): Promise<void> {
    await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      const shownOn = pageErrors.parse("page.invalid", pageHrefSchema, path);
      const reported = pageErrors.parse(
        "page.invalid",
        pageProblemSchema,
        problem
      );
      await this.#previewOf(id).report(at, shownOn, reported);
    });
  }
}
