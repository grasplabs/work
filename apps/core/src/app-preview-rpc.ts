import { isAppLayout } from "@grasp-os/compiler";
import { appDataErrors } from "@grasp-os/shared/app-data";
import type { AppDataPage, AppDataTable } from "@grasp-os/shared/app-data";
import type { AppPreviewApi } from "@grasp-os/shared/app-review";
import { previewShownSchema, readOnlyRevision } from "@grasp-os/shared/chat";
import type {
  PreviewAt,
  PreviewBundle,
  PreviewRefresh,
  PreviewShown,
  PreviewUpdate,
} from "@grasp-os/shared/chat";
import { draftSealFailures } from "@grasp-os/shared/functions";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import {
  pageErrors,
  pageHrefSchema,
  pageProblemSchema,
} from "@grasp-os/shared/pages";
import type { PageProblem } from "@grasp-os/shared/pages";
import type { Identity } from "@grasp-os/shared/rpc";
import { drizzle } from "drizzle-orm/d1";

import {
  appFor,
  appKind,
  changeEntry,
  editableApp,
  findVersion,
  hasPages,
} from "./apps.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { withReferencesText } from "./draft-references.ts";
import type { PageModules } from "./draft-references.ts";
import { draftReferences, draftTestData } from "./draft-runs.ts";
import { changesAnything, filesOf, readCheckpoint } from "./drafts.ts";
import type { DraftState } from "./drafts.ts";
import { appPreview } from "./durable-objects.ts";
import { leaseFor } from "./page-delivery.ts";
import {
  appModules,
  frameAccess,
  previewFrame,
  stageFrame,
  stageModules,
  updatingFrameAccess,
} from "./page-frame.ts";
import { versionPages } from "./pages.ts";
import type { BuiltPage } from "./pages.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// A signed-in person's `apps.preview` (GRA-1665): each App's one preview
// of its draft (app-preview.ts), which every builder shares, on one store
// of test data. Only a builder of the App previews it, checked at every
// call, and an archived App has none. The preview's frames call the draft
// on the path every page calls on, under the lease the bundle carries
// (page-calls.ts, draft-runs.ts); each open frame follows the draft's
// writes through `drafts.watch` (drafts-rpc.ts).

const encoder = new TextEncoder();

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
 * What a preview builds (`AppPreviewRpc.#previewed`): its files, the
 * references their pages import, the draft's revision it is at
 * (`readOnlyRevision` for a checkpoint or a version opened read-only),
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

export class AppPreviewRpc extends CoreRpcTarget implements AppPreviewApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  /** The App's preview of its draft (app-preview.ts). */
  #previewOf(app: AppId) {
    return appPreview(this.#env, app);
  }

  /**
   * Clears the test data of the App's preview, for everyone who builds
   * it (`AppPreview.resetData`): only while the person builds the App and
   * it isn't archived. Audited as theirs first.
   */
  async resetData(app: string): Promise<void> {
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
  async tables(app: string): Promise<AppDataTable[]> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await editableApp(this.#env, by, app);
      const tables = await draftTestData(this.#env, by, id);
      if (!Array.isArray(tables)) {
        throw new TypeError("The preview answered a page for its tables");
      }
      return tables;
    });
  }

  async records(
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
   * The pages of the App's draft, to preview: only while the person
   * builds the App, as the agent must to write it. With `checkpoint`, of that
   * checkpoint of the draft, read-only: built the same way, but at
   * `readOnlyRevision`, with no lease, so it calls nothing. With
   * `version` instead, of that version of the App, read-only the same
   * way.
   */
  async open(
    app: string,
    checkpoint?: number,
    version?: number
  ): Promise<PreviewBundle> {
    return await withPerson(this.#check, async (by) => {
      // As its recheck (`buildsNow`): an archived App has no preview.
      const { id, name } = await editableApp(this.#env, by, app);
      const asked = checkpoint === undefined ? { version } : { checkpoint };
      const load = async (): Promise<PreviewBundle> =>
        await this.#loadPreview(by, id, name, asked);
      // A checkpoint or version opened read-only is one person's click, never
      // asked for again by a write: it builds as it is asked.
      if (checkpoint !== undefined || version !== undefined) {
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
  async update(
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
   * What a read-only preview of App `id` opens: its checkpoint `checkpoint`,
   * or else its version `version` as a draft over it with no changes.
   */
  async #readOnlyDraft(
    id: AppId,
    {
      checkpoint,
      version,
    }: { checkpoint?: number; version?: number | undefined }
  ): Promise<DraftState> {
    if (checkpoint !== undefined) {
      return await readCheckpoint(this.#env, { kind: "app", id }, checkpoint);
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
   * of its checkpoint `checkpoint` or its version `version`, or (`fallback`)
   * of the version the draft is over in place of the draft, and the
   * references their pages import, read over the same build. A checkpoint or
   * version is read-only (`readOnlyRevision`). The draft now that changes
   * nothing, and the fallback, `shows` that version, read anew.
   */
  async #previewed(
    id: AppId,
    {
      checkpoint,
      version,
      fallback = false,
    }: {
      checkpoint?: number;
      version?: number | undefined;
      fallback?: boolean;
    }
  ): Promise<Previewed> {
    const preview = this.#previewOf(id);
    if (checkpoint !== undefined || version !== undefined) {
      const draft = await this.#readOnlyDraft(id, { checkpoint, version });
      return {
        files: await filesOf(this.#env, appKind, id, draft),
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
      files: await filesOf(this.#env, appKind, id, draft),
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
   * or read-only from its checkpoint `checkpoint` or version `version`
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
    opened: { checkpoint?: number; version?: number | undefined }
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
  async report(
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
