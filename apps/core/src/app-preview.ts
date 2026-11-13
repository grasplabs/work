import { appErrors } from "@grasp-os/shared/apps";
import { readOnlyRevision } from "@grasp-os/shared/chat";
import type { PreviewProblem } from "@grasp-os/shared/chat";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { PageProblem, ServerLog } from "@grasp-os/shared/pages";
import { dataErrors } from "@grasp-os/shared/stores";
import { DurableObject } from "cloudflare:workers";

import { appDraftKind } from "./apps.ts";
import { emptyThrowawayStore } from "./data-stores.ts";
import { isPageModules } from "./draft-references.ts";
import type { PageModules } from "./draft-references.ts";
import { changesAnything, readDraft } from "./drafts.ts";
import type { DraftState } from "./drafts.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { PreviewBuilds } from "./preview-builds.ts";
import type { PreviewBuilt } from "./preview-builds.ts";
import { PreviewReports } from "./preview-reports.ts";
import type { Reports } from "./preview-reports.ts";

// One App's preview of its draft (GRA-1665), named by the App's ID: one
// object per App, shared by everyone who builds it. The draft runs on the
// path every page calls on (draft-runs.ts, page-calls.ts), each call as
// its caller, with their own roles, on one store of test data the
// preview's builders share: only the data is shared. Core checks the
// caller builds the App before every call reaches this object
// (app-preview-rpc.ts, agent-builds.ts, draft-runs.ts); this object holds
// what the preview shares:
//
// - the seed its test store is named by (draft-runs.ts, `draftStore`),
//   and every store it named, so "Reset test data" empties each for good
//   for everyone, at once, and names a new one (`resetData`);
// - what its pages and calls ran into, for the next check of the draft by
//   any builder's agent (preview-reports.ts), and what its server code
//   logged (server-logs.ts);
// - one build per viewer and revision (preview-builds.ts), and the
//   references its pages last built against, for while the draft's
//   server code doesn't build.
//
// The draft itself is the App's, in core's database (drafts.ts): read
// afresh for each step, and followed by the pages open on it through its
// own object (draft-watch.ts). What this object keeps is the preview's
// alone, never the draft: a restart loses its reports, which a page's
// next call makes again.

/** How often a check waiting for the preview reads its reports again. */
const pollMs = 100;

/** Where the seed of the preview's test store is kept. */
const seedKey = "seed";

/** Where the test stores the preview named are kept, by ID. */
const storesKey = "stores";

/** Where the references its pages last built against are kept. */
const referencesKey = "references";

export class AppPreview extends DurableObject<Env> {
  /** What the preview ran into (preview-reports.ts). */
  readonly #reports = new PreviewReports();
  /** What bounds the preview's builds (preview-builds.ts). */
  readonly #builds = new PreviewBuilds();
  /** The App this object previews: the name it was made by. */
  get #app(): AppId {
    return appIdSchema.parse(this.ctx.id.name);
  }

  /**
   * The seed the preview's test store is named by (draft-runs.ts), made on
   * first use: the same until its test data is reset (`resetData`), then
   * a new one, so no call ever finds a store emptied for good again.
   */
  #seed(): string {
    const kept = this.ctx.storage.kv.get<string>(seedKey);
    if (kept !== undefined) {
      return kept;
    }
    const seed = crypto.randomUUID();
    this.ctx.storage.kv.put(seedKey, seed);
    return seed;
  }

  /**
   * What a call of the preview runs on now (draft-runs.ts): what it shows
   * (`draft`), and the seed its test store is named by.
   */
  async run(): Promise<{ draft: DraftState; seed: string }> {
    const draft = await this.draft();
    return { draft, seed: this.#seed() };
  }

  /**
   * What the preview shows, which a viewer has open now: the draft, over
   * the version it began from; while the draft changes nothing (none
   * written yet, or published, discarded or rolled back), the version it
   * is over (the live one), at the draft's revision, so the
   * preview always shows the App and the draft's next write comes into
   * the frame showing it. With `fallback`, that version whatever the
   * draft holds: what a preview shows while the draft's page doesn't
   * build. `app.not_running` only for an App with no version and no
   * changes, with nothing to show.
   */
  async draft({
    fallback = false,
  }: { fallback?: boolean } = {}): Promise<DraftState> {
    const draft = await readDraft(this.env, { kind: "app", id: this.#app });
    this.#reports.opened();
    if (!fallback && changesAnything(draft)) {
      return draft;
    }
    const base = await appDraftKind.liveBase(this.env, this.#app);
    if (base === null) {
      throw appErrors.create("app.not_running");
    }
    return { base, changes: {}, definition: null, revision: draft.revision };
  }

  /**
   * Keeps that `storeId` is the preview's test store (draft-runs.ts), so
   * a reset of its test data or the App's removal empties it at once,
   * rather than a day after its last use. Only a run of the preview as it
   * is now: one that read its seed before a reset never makes that store
   * again (`app.preview_outdated`).
   */
  keepStore({ storeId, seed }: { storeId: string; seed: string }): void {
    if (this.ctx.storage.kv.get<string>(seedKey) !== seed) {
      throw appErrors.create("app.preview_outdated");
    }
    const stores = this.ctx.storage.kv.get<string[]>(storesKey) ?? [];
    if (!stores.includes(storeId)) {
      this.ctx.storage.kv.put(storesKey, [...stores, storeId]);
    }
  }

  /**
   * Clears the preview's test data for everyone: a new seed, so the next
   * call names a new, empty store, and every store it named emptied for
   * good (`DataStore.emptyThrowaway`), a call under way on one refused.
   * Core checks the caller builds the App, and audits it, first
   * (app-preview-rpc.ts).
   */
  async resetData(): Promise<void> {
    this.ctx.storage.kv.put(seedKey, crypto.randomUUID());
    await this.#emptyStores();
  }

  /** Empties every test store the preview named, forgetting each once it is. */
  async #emptyStores(): Promise<void> {
    for (const storeId of this.ctx.storage.kv.get<string[]>(storesKey) ?? []) {
      // oxlint-disable-next-line no-await-in-loop -- one store at a time
      await emptyThrowawayStore(this.env, storeIdSchema.parse(storeId));
      const left = (this.ctx.storage.kv.get<string[]>(storesKey) ?? []).filter(
        (kept) => kept !== storeId
      );
      this.ctx.storage.kv.put(storesKey, left);
    }
  }

  /**
   * Forgets `personId` in every test store the preview named, as an App's
   * own store forgets them (`StoreHost.forgetPerson`): an admin erased
   * them (person-erasure.ts). A store emptied for good holds nothing.
   */
  async forgetPerson(personId: string): Promise<void> {
    for (const storeId of this.ctx.storage.kv.get<string[]>(storesKey) ?? []) {
      const id = storeIdSchema.parse(storeId);
      try {
        // oxlint-disable-next-line no-await-in-loop -- one store at a time
        await inJurisdiction(this.env, this.env.DATA_STORES)
          .getByName(id)
          .forgetPerson(id, personId);
      } catch (error) {
        if (dataErrors.codeOf(error) !== "data.fixture_discarded") {
          throw error;
        }
      }
    }
  }

  /**
   * Discards everything the preview holds, its test data first: its App
   * was removed (app-removal.ts).
   */
  async discard(): Promise<void> {
    await this.#emptyStores();
    this.#reports.drop();
    await this.ctx.storage.deleteAll();
  }

  /**
   * What `build` answers, a build of `what` (the kind of ask and its
   * page) of `viewer`'s preview, at `revision` (the draft's now when not
   * named): one build per viewer and revision, shared by every ask of
   * theirs for it while it runs (preview-builds.ts); `app.preview_outdated`
   * for a revision the draft moved past. The caller builds; this only
   * shares what it answers.
   */
  async build(
    viewer: string,
    what: string,
    revision: number | undefined,
    build: () => Promise<PreviewBuilt>
  ): Promise<PreviewBuilt> {
    const { revision: now } = await readDraft(this.env, {
      kind: "app",
      id: this.#app,
    });
    return await this.#builds.build(
      `${viewer}:${what}`,
      revision ?? now,
      now,
      build
    );
  }

  /**
   * Keeps `references`, the page modules (draft-references.ts) the
   * draft's server code last generated, for its pages to build against
   * while it doesn't (app-preview-rpc.ts).
   */
  keepReferences(references: PageModules | null): void {
    this.ctx.storage.kv.put(referencesKey, references);
  }

  /** The references `keepReferences` kept last, if any. */
  referencesKept(): PageModules | null | undefined {
    const kept = this.ctx.storage.kv.get(referencesKey);
    // Anything but page modules is as good as none.
    return kept === null || isPageModules(kept) ? kept : undefined;
  }

  /**
   * Keeps what a call of the draft at `revision` failed with (`problem`),
   * for the next check of the draft (preview-reports.ts), and that the
   * preview ran at all: only of the draft's own revision now, as an
   * earlier page's calls decide nothing of the draft now.
   */
  async called(
    revision: number,
    problem: PreviewProblem | null
  ): Promise<void> {
    const { revision: now } = await readDraft(this.env, {
      kind: "app",
      id: this.#app,
    });
    if (now !== revision) {
      return;
    }
    if (problem !== null) {
      this.#reports.report(revision, problem);
    }
    this.#reports.saw(revision);
  }

  /**
   * Keeps `problem`, what the preview of the draft at `at` reported on
   * `path`, for the next check (preview-reports.ts): only of the draft's
   * own revision, which a frame names for what that revision's page ran
   * into, an update of it the frame tried and rolled back too. Dropped
   * for any other: an earlier page's problems decide nothing of the draft
   * now. Never kept for a frame showing a version of the App, or an undo
   * point opened read-only: nothing it reports is its draft's.
   */
  async report(at: unknown, path: string, problem: PageProblem): Promise<void> {
    if (typeof at !== "number" || at === readOnlyRevision) {
      return;
    }
    const { revision } = await readDraft(this.env, {
      kind: "app",
      id: this.#app,
    });
    if (at !== revision) {
      return;
    }
    this.#reports.report(revision, { source: "page", at: path, ...problem });
  }

  /**
   * What the preview of the draft at `revision` ran into, and what its
   * server code logged, for the agent's checks of the draft
   * (agent-builds.ts): while someone has it open, waiting up to `waitMs`
   * for it to report on that revision at all, as a check may come right
   * after the write. `seen` is false when it didn't: nobody has it open
   * (answered at once), or its pages neither called the server nor
   * failed.
   */
  async reports(revision: number, waitMs: number): Promise<Reports> {
    const until = Date.now() + waitMs;
    let now = this.#reports.read(revision);
    while (!now.seen && Date.now() < until && this.#reports.isOpen()) {
      // oxlint-disable-next-line no-await-in-loop -- polls until it reported, or the wait ends
      await scheduler.wait(pollMs);
      now = this.#reports.read(revision);
    }
    return now;
  }

  /**
   * Keeps what the draft's server code at `revision` wrote with `console`
   * in the preview: for the preview's tail alone (server-logs.ts).
   */
  logs(revision: number, logs: ServerLog[]): void {
    this.#reports.log(revision, logs);
  }
}
