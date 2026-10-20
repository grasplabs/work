import { manifestText } from "@grasp-os/sdk/host";
import { appErrors } from "@grasp-os/shared/apps";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { storeIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId, StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { streamMaxRunning } from "@grasp-os/shared/operation-limits";
import { jsonOf, operationErrors } from "@grasp-os/shared/operations";
import type { OperationResult } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { roleErrors } from "@grasp-os/shared/roles";
import { jsonBytes } from "@grasp-os/shared/screens";
import { dataErrors } from "@grasp-os/shared/stores";
import type { WriterRoles } from "@grasp-os/shared/stores";
import {
  idempotencyKeySchema,
  submissionErrors,
} from "@grasp-os/shared/submissions";
import { exports } from "cloudflare:workers";
import { and, count, eq, gt, isNull, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  keepsReceipt,
  readerOf,
  refused as refusedResult,
  resultOf,
  wake,
  withReason,
} from "./action-invocation.ts";
import type { Live } from "./action-invocation.ts";
import { operationRoles } from "./app-access.ts";
import {
  publicOperationOf,
  readFunctionRequest,
  refusalOf,
} from "./app-functions.ts";
import type { FunctionAnswer, FunctionRequest } from "./app-functions.ts";
import {
  answerPreferences,
  isPreferencePath,
  preferenceOperationOf,
} from "./app-preferences.ts";
import { loadDraftRelease, sealDraftRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { draftFiles } from "./apps.ts";
import { memberRole } from "./auth/identity.ts";
import { discardFixtureStore, openFixtureStore } from "./data-stores.ts";
import type { OpenStore } from "./data-stores.ts";
import { previewFixtureStores } from "./db/core/schema.ts";
import {
  previewReleaseArtifacts,
  previewReleases,
  previewStores,
} from "./db/workspace/schema.ts";
import { callOperation } from "./operations.ts";
import type { Invocation } from "./operations.ts";
import { readWindow } from "./query-windows.ts";
import { within } from "./release-retention.ts";
import { hostedRelease, noStore } from "./release-runner.ts";
import { isWorkflowQueryPath } from "./workflow-reference-queries.ts";
import type { Draft } from "./workspace.ts";

// A chat's preview of its draft of an App of spec 8's layout: the draft
// sealed into a draft release, and every call of its screens, its live
// queries and the chat's agent run on that release through the operation
// host, as a screen's call runs on a version's release (app-functions.ts),
// in the chat's Workspace object. Only the chat's own person reaches it,
// while they build the App (chats-rpc.ts), and the chat's agent, acting
// for them (agent-builds.ts). A draft is code nobody reviewed, written by
// an agent from what it was told, so its preview is held to this threat
// model, and how each is closed:
//
// - The draft reaches the App's data: nothing names the App's store. The
//   draft release binds no store (`loadDraftRelease` refuses one that
//   does), and each invocation is handed the preview's own store, a
//   fixture store that core's inventory never lists (`openFixtureStore`),
//   so no release binds it and `openStore` never opens it. It starts
//   empty, with the draft's schema, for the draft's revision alone.
// - The draft reads or writes its person's real preferences: the draft's
//   `preferences.get` and `update` are answered by core as on a version
//   (app-preferences.ts), but only from the preview's own store, named by
//   the running preview, never by the release or the request; an App with
//   preferences and no tables gets one too (`needsStore`). The App's
//   store, where the real ones are, is opened by nothing here.
// - A workflow reference's queries read runs through the App's binding of
//   the workflow; a preview binds no resource, so they are refused
//   (`resource.unavailable`) before anything is read, whatever the alias.
// - The draft reaches outside systems: no resource is bound for its
//   invocations (no connection, Knowledge, model or other App), so every
//   resource request is refused by the operation host
//   (`resource.unavailable`). Its code runs in the release runner's
//   isolates, with no network and no env (release-runner.ts).
// - The preview runs code that wasn't sealed, or that changed since: the
//   draft is sealed exactly as a version is (`sealDraftRelease`), its
//   manifest and every artifact kept here, and each preview loads it back
//   through `loadRelease`'s own checks, every hash, before anything of it
//   runs (`loadDraftRelease`). What runs is what was loaded.
// - A draft release is taken for a version's: it is kept only here, in
//   the chat's object, never where a version's release is
//   (`sdk_release_manifests`), so nothing that runs a version finds it.
// - Someone else uses the preview, or keeps using it once they no longer
//   build the App: core checks the chat is the person's and that they
//   build the App before every call (chats-rpc.ts), and each protected
//   step of a call (its start, every commit) checks again that they are a
//   member who builds the App (`authorize`).
// - The preview outlives its draft: a new revision, a dropped or
//   proposed draft, or a deleted chat drops it (`drop`). A call for
//   another revision is `app.preview_outdated`, a call already running
//   commits nothing more (each protected step checks its preview is still
//   the one running), and its store is discarded.
// - One preview's data reaches another's: a store per chat, App and
//   revision, created empty, shared with nothing.
// - A store is lost: each is recorded here before its object is first
//   touched, and forgotten only once it is discarded; what a failure left
//   is discarded at the next preview this object starts.
// - A preview's store outlives its use: someone may type personal data
//   into it, and its chat's object may never wake again to drop it. Core
//   discards every preview store a week after it was made, whatever its
//   object does (`sweepPreviewStores`), recording it gone only once it
//   is. A discarded store refuses every call after, one already running
//   included, and never makes tables again, so nothing is ever written
//   into it. A preview whose store core no longer records is out of date
//   at its next protected step (`authorize`) and forgets it; its next call
//   starts a new, empty store, and a store kept for a revision is reused
//   only while core still records it (`#makeStore`). Losing the builder
//   role refuses every call at once and leaves the store to that sweep.
// - What App code keeps of one invocation acts in another's: every
//   invocation runs in a fresh isolate of the release runner, whose
//   channel stops working once it ends, as for every call of an App.
//
// A streaming action (spec 10.7.6) runs here too, on the same release and
// store, with no resources, held by the preview that started it: one
// invocation per person and key, which a start joins (with the same
// input), an attach reads again without starting, and a cancel stops,
// as a live screen's does (action-invocation.ts), read through the same
// latest-snapshot reader. So:
// - It outlives its preview: dropping the preview cancels every
//   invocation it holds, and each protected step of the run checks the
//   preview is still the one running, so nothing more commits; an attach
//   once it's gone is `submission.expired`.
// - It escapes its budgets: this object (all of one person's chats)
//   runs at most `streamMaxRunning` at once (a start past them records
//   nothing), each ends by `serverInvocationWallMs`, and one nobody
//   follows is cancelled after `streamIdleCancelMs`. While it runs only
//   its latest snapshot is kept; once settled, no snapshot, and its
//   receipt only when its result is small (`receiptBytes`), at most
//   `receiptsKept` of them in this object, oldest forgotten first: an
//   attach of one forgotten is `submission.expired`. Never the input or a
//   progress log.
// - Another key's input, another action, or another person: the key is
//   the person's own and the action's (`streamName`), and other input
//   under it is `submission.key_conflict`.
// - A key's protection outlasting this object: invocations and receipts
//   live in its memory alone, as the preview's store holds only fixture
//   data. A restart forgets them (an attach is then `submission.expired`,
//   a start under the same key runs anew), which a preview, changing
//   nothing real, can afford.

/** Whether core records `storeId` as a preview's store (`preview_fixture_stores`). */
const recordedStore = async (env: Env, storeId: string): Promise<boolean> =>
  (await drizzle(env.DB)
    .select({ storeId: previewFixtureStores.storeId })
    .from(previewFixtureStores)
    .where(eq(previewFixtureStores.storeId, storeId))
    .get()) !== undefined;

/** Deletes core's record of preview store `storeId`. */
const recordDeleted = async (
  db: ReturnType<typeof drizzle>,
  storeId: string
): Promise<void> => {
  await db
    .delete(previewFixtureStores)
    .where(eq(previewFixtureStores.storeId, storeId));
};

/** How long the sweep leaves a store whose discard failed before it tries again. */
const retryDelayMs = 60 * 60 * 1000;

/**
 * Leaves preview store `storeId` until `retryDelayMs` after `at`, its
 * discard having failed: logged, never thrown, as a failure to note it
 * only means the next sweep tries it again sooner.
 */
const retriedLater = async (
  db: ReturnType<typeof drizzle>,
  storeId: string,
  at: Date
): Promise<void> => {
  try {
    await db
      .update(previewFixtureStores)
      .set({ retryAfter: new Date(at.getTime() + retryDelayMs) })
      .where(eq(previewFixtureStores.storeId, storeId));
  } catch (error) {
    log.warn("preview.store_retry_unrecorded", {
      store: storeId,
      ...errorFields(error),
    });
  }
};

/** How long core keeps a preview's store once it was made. */
const previewStoreKeptMs = 7 * 24 * 60 * 60 * 1000;

/** Most stores one batch of the sweep takes. */
const storesPerSweep = 100;

/** How long one sweep goes on discarding, batch after batch. */
const sweepBudgetMs = 20_000;

/**
 * The longest one store's discard may take in a sweep: a fraction of its
 * budget, so one that hangs costs that sweep little.
 */
const storeStepMs = 5000;

/**
 * Discards every preview store made longer ago than core keeps one
 * (`previewStoreKeptMs`), oldest first, batch after batch for as long as
 * the sweep's time allows, whatever its chat's object does: each store's
 * object first (`DataStore.discardFixture`, which refuses any store that
 * isn't a recorded fixture), then core's row, so a discard that fails is
 * found again by the next sweep. A preview still running on one is out of
 * date at its next step (`#requireRecorded`). From the cron, for the time
 * `at`.
 */
export const sweepPreviewStores = async (
  env: Env,
  at = new Date()
): Promise<void> => {
  const until = Date.now() + sweepBudgetMs;
  const cutoff = new Date(at.getTime() - previewStoreKeptMs);
  const db = drizzle(env.DB);
  // Past the last store each batch took, so stores whose discard keeps
  // failing never hold up the rest; the next sweep starts over, and tries
  // them again.
  let after: { createdAt: Date; storeId: string } | undefined;
  while (Date.now() < until) {
    // oxlint-disable-next-line no-await-in-loop -- batch after batch
    const batch = await db
      .select({
        storeId: previewFixtureStores.storeId,
        createdAt: previewFixtureStores.createdAt,
      })
      .from(previewFixtureStores)
      .where(
        and(
          lte(previewFixtureStores.createdAt, cutoff),
          // One whose discard failed waits out its delay, so it never takes
          // each sweep's time from the rest.
          or(
            isNull(previewFixtureStores.retryAfter),
            lte(previewFixtureStores.retryAfter, at)
          ),
          after === undefined
            ? undefined
            : or(
                gt(previewFixtureStores.createdAt, after.createdAt),
                and(
                  eq(previewFixtureStores.createdAt, after.createdAt),
                  gt(previewFixtureStores.storeId, after.storeId)
                )
              )
        )
      )
      .orderBy(previewFixtureStores.createdAt, previewFixtureStores.storeId)
      .limit(storesPerSweep);
    for (const { storeId } of batch) {
      // The budget checked before each store, not only each batch: one
      // slow store never takes the sweep past it.
      if (Date.now() >= until) {
        break;
      }
      // Each step bounded, never past the sweep's own budget either: one
      // that hangs, or is cut short, is tried again once its delay is over
      // (a discard again changes nothing).
      const stepMs = () =>
        Math.max(1, Math.min(storeStepMs, until - Date.now()));
      try {
        // oxlint-disable-next-line no-await-in-loop -- one store after another
        await within(
          discardFixtureStore(env, storeIdSchema.parse(storeId)),
          stepMs()
        );
        // oxlint-disable-next-line no-await-in-loop -- as above
        await within(recordDeleted(db, storeId), stepMs());
      } catch (error) {
        log.warn("preview.store_sweep_failed", {
          store: storeId,
          ...errorFields(error),
        });
        // oxlint-disable-next-line no-await-in-loop -- as above
        await retriedLater(db, storeId, at);
      }
    }
    // A short batch, all of it dealt with, was the last.
    if (batch.length < storesPerSweep && Date.now() < until) {
      return;
    }
    after = batch.at(-1);
  }
  // Out of time with stores past the cutoff left: said, so a backlog that
  // keeps growing is seen.
  const [left] = await db
    .select({ stores: count() })
    .from(previewFixtureStores)
    .where(lte(previewFixtureStores.createdAt, cutoff));
  if ((left?.stores ?? 0) > 0) {
    log.warn("preview.store_sweep_backlog", { stores: left?.stores ?? 0 });
  }
};

/** What one chat's preview of one App runs: its revision, release and store. */
interface Running {
  readonly revision: number;
  /** The version the draft would become: the identity it is sealed with. */
  readonly version: number;
  /** The draft release, sealed and stored, then loaded back and verified. */
  readonly release: Promise<Release>;
  /** The preview's store, once it is made. */
  store?: Promise<OpenStore>;
  /** The ID `store` resolved to, once it did. */
  storeId?: string;
  /** Its streaming actions' invocations, by `streamName`, oldest first. */
  readonly streams: Map<string, PreviewStream>;
}

/** One streaming action's invocation in a preview (`SealedPreviews.openStream`). */
interface PreviewStream {
  /** The SHA-256 of its input's canonical JSON: all a key conflict needs. */
  readonly inputHash: string;
  readonly live: Live;
}

/** Forgets `held`, which `of` holds as `named`, if it still holds that one. */
const forget = (of: Running, named: string, held: Live): void => {
  if (of.streams.get(named)?.live === held) {
    of.streams.delete(named);
  }
};

/** The most settled invocations' receipts one object keeps, of all its previews. */
const receiptsKept = 8;

/** The largest result whose receipt is kept, as JSON: a larger one isn't. */
const receiptBytes = 16 * 1024;

/**
 * The key of `personId`'s invocation of the action `call` names under
 * `key`, as a live invocation's name (`invocationName`): never anyone
 * else's, nor another action's under the same key.
 */
const streamName = (
  personId: string,
  call: FunctionRequest,
  key: string
): string =>
  canonicalJson([
    personId,
    call.reference.contractId,
    call.reference.fingerprint,
    key,
  ]);

/**
 * The streaming action `request` names, with the key it must have:
 * `contract.invalid_request` for anything else.
 */
const streamRequestOf = (
  request: unknown
): { call: FunctionRequest; key: string } => {
  const call = readFunctionRequest(request);
  const key = idempotencyKeySchema.safeParse(call.idempotencyKey);
  if (!key.success || call.reference.kind !== "action") {
    throw operationErrors.create("contract.invalid_request");
  }
  return { call, key: key.data };
};

/** What a call of a preview's function answers, and what a query read. */
export interface PreviewAnswer {
  readonly answer: FunctionAnswer;
  readonly reads:
    | { readonly storeId: StoreId; readonly readSet: Record<string, number> }
    | undefined;
}

/** How a call of a preview's function is made, beyond who and what. */
export interface PreviewCallOptions {
  /** Only this kind of function may be called (a live query's). */
  readonly kind?: FunctionRequest["reference"]["kind"];
  /** When it must end, in milliseconds since the epoch. */
  readonly deadline?: number;
  /**
   * Given, the call may read a paginated list's window (a screen's,
   * query-windows.ts): what charges the person for its pages past what
   * the caller paid, as for a version's screen (`WindowRequest.charge`).
   */
  readonly chargeWindow?: (pages: number, whole: number) => Promise<void>;
}

/** The key of one chat's preview of one App. */
const nameOf = (chatId: ChatId, app: string): string => `${chatId}:${app}`;

/** Waits for `work`, whose failure its awaiters hear: never left unhandled. */
const heard = async (work: Promise<unknown>): Promise<void> => {
  try {
    await work;
  } catch {
    // Each call that awaits it hears how it went.
  }
};

/** What refuses a window's pages when nothing charges them. */
const noCharge = async (): Promise<never> =>
  await Promise.reject(operationErrors.create("contract.invalid_request"));

/** Whether `release`'s App declares tables, which its store holds. */
const hasTables = (release: Release): boolean =>
  Object.keys(release.app.schema.tables).length > 0;

/**
 * Whether `release`'s App has a store: it declares tables, or preferences,
 * which its store keeps (app-preferences.ts).
 */
const needsStore = (release: Release): boolean =>
  hasTables(release) || release.app.preferences !== null;

/** How many leftover stores one preview's start discards. */
const leftoversPage = 20;

/** The previews of one Workspace object's chats' drafts of spec 8 Apps. */
export class SealedPreviews {
  readonly #ctx: DurableObjectState;
  readonly #env: Env;
  readonly #db: DrizzleSqliteDODatabase;
  /** The revision of the chat's draft of an App now, if it has a draft. */
  readonly #revisionOf: (chatId: ChatId, app: string) => number | undefined;
  /** The stores whose discard failed since this object started. */
  readonly #stuck = new Set<string>();
  /** The stores being discarded now, so none is discarded twice at once. */
  readonly #discarding = new Set<string>();
  /** What each preview runs, by `nameOf`. In memory: a restart loads it again. */
  readonly #running = new Map<string, Running>();
  /** The receipts kept of settled invocations, oldest first (`#kept`). */
  readonly #receipts: { running: Running; name: string; live: Live }[] = [];

  constructor(
    ctx: DurableObjectState,
    env: Env,
    db: DrizzleSqliteDODatabase,
    revisionOf: (chatId: ChatId, app: string) => number | undefined
  ) {
    this.#ctx = ctx;
    this.#env = env;
    this.#db = db;
    this.#revisionOf = revisionOf;
  }

  /**
   * The draft release previewing `draft`, the chat's draft of `app` at its
   * revision, with the version it is sealed as: sealed on first use and
   * kept, or loaded back and verified as kept.
   */
  async release(
    chatId: ChatId,
    app: AppId,
    draft: Draft
  ): Promise<{ release: Release; version: number }> {
    const running = this.#runningFor(chatId, app, draft);
    return {
      release: await this.#loaded(chatId, app, running),
      version: running.version,
    };
  }

  /**
   * Calls the function `request` names, as text as a screen sends it, in
   * the preview of `draft`, for `personId`, whose chat it is: resolved
   * against the draft release as a screen's call is against a version's
   * (`publicOperationOf`), then run by the operation host on the
   * preview's store, with no resources. Answers what the call answered,
   * or why it was refused, and what a query read of the store; never
   * throws for the call.
   */
  async call(
    chatId: ChatId,
    personId: string,
    app: AppId,
    draft: Draft,
    request: unknown,
    options: PreviewCallOptions = {}
  ): Promise<PreviewAnswer> {
    const requestId = crypto.randomUUID();
    let reads: PreviewAnswer["reads"];
    const refused = (error: unknown): PreviewAnswer => ({
      answer: {
        result: { ok: false, error: refusalOf(error, requestId) },
        provenance: null,
        fingerprint: null,
        manifestHash: null,
      },
      reads,
    });
    let call: FunctionRequest;
    try {
      call = readFunctionRequest(request);
      if (options.kind !== undefined && call.reference.kind !== options.kind) {
        throw operationErrors.create("contract.invalid_request");
      }
      // A window is a screen's, and a query's only, as on a version.
      if (
        call.window !== undefined &&
        (options.chargeWindow === undefined || call.reference.kind !== "query")
      ) {
        throw operationErrors.create("contract.invalid_request");
      }
    } catch (error) {
      return refused(error);
    }
    // What the call ran on, once it has it: a discarded store's refusal
    // thrown rather than answered (a window's last check of its reads)
    // is mapped as an answered one is (`#unlessDiscarded`).
    let held: { running: Running; store: OpenStore } | undefined;
    try {
      const running = this.#runningFor(chatId, app, draft);
      const release = await this.#loaded(chatId, app, running);
      // A workflow reference's queries read runs through the App's
      // binding of the workflow; a preview binds no resource, so there is
      // none to read through, whatever the alias.
      if (isWorkflowQueryPath(call.reference.contractId)) {
        throw operationErrors.create("resource.unavailable");
      }
      const deadline =
        options.deadline ?? Date.now() + platformLimits.serverInvocationWallMs;
      if (isPreferencePath(call.reference.contractId)) {
        return await this.#preferences(chatId, personId, app, running, {
          release,
          call,
          deadline,
        });
      }
      const path = publicOperationOf(release, call.reference);
      // Before the preview's store is made or opened.
      await this.#authorizer(chatId, personId, app, running)();
      const store = await this.#storeOf(chatId, app, running, release);
      held = { running, store };
      const invocation = this.#invocationOf(chatId, personId, app, running, {
        store,
        requestId,
        deadline,
      });
      const observe = hasTables(release)
        ? (readSet: Record<string, number>) => {
            reads = { storeId: storeIdSchema.parse(store.id), readSet };
          }
        : undefined;
      const observed =
        observe === undefined
          ? invocation
          : { ...invocation, observeReads: observe };
      const hosted = this.#hostedOf(chatId, app, running, release);
      const answered = await (call.window === undefined
        ? callOperation(
            hosted,
            observed,
            { path, kind: call.reference.kind },
            call.input,
            call.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: call.idempotencyKey }
          )
        : readWindow(
            {
              // Checked above: a window comes with what charges its pages.
              charge: options.chargeWindow ?? noCharge,
              app: hosted,
              invocation,
              reference: { path, kind: call.reference.kind },
              args: release.app.operations[path]?.args,
              input: call.input,
              extent: call.window.extent,
            },
            observe
          ));
      const result = this.#unlessDiscarded(
        chatId,
        app,
        running,
        store,
        answered
      );
      return {
        answer: {
          result,
          provenance: null,
          fingerprint: call.reference.fingerprint,
          manifestHash: release.manifestHash,
        },
        reads,
      };
    } catch (error) {
      if (
        held !== undefined &&
        dataErrors.codeOf(error) === "data.fixture_discarded"
      ) {
        this.#forgetStore(chatId, app, held.running, held.store.id);
        return refused(appErrors.create("app.preview_outdated"));
      }
      return refused(error);
    }
  }

  /**
   * The draft's preferences, as `preferences.get` and `update` answer
   * them on a version (app-preferences.ts), from the preview's own store:
   * never the App's, which a draft release doesn't bind and nothing here
   * opens. Gated as the preview's every call is (`#invocationOf`), with
   * its deadline, before the store is read and again before it is
   * written. Throws for a refusal; `call` answers it.
   */
  async #preferences(
    chatId: ChatId,
    personId: string,
    app: AppId,
    running: Running,
    {
      release,
      call,
      deadline,
    }: {
      release: Release;
      call: FunctionRequest;
      deadline: number;
    }
  ): Promise<PreviewAnswer> {
    // Read whole: there is no window of one document.
    if (call.window !== undefined) {
      throw operationErrors.create("contract.invalid_request");
    }
    const preference = await preferenceOperationOf(release, call.reference);
    const authorize = this.#authorizer(chatId, personId, app, running);
    // Before the preview's store is made or opened.
    await authorize();
    const store = await this.#storeOf(chatId, app, running, release);
    let reads: PreviewAnswer["reads"];
    const result = await answerPreferences(
      this.#env,
      {
        userId: personId,
        release,
        previewStore: storeIdSchema.parse(store.id),
        gate: async () => {
          await authorize();
          if (Date.now() >= deadline) {
            throw operationErrors.create("operation.deadline_exceeded");
          }
        },
        observeReads: (storeId, readSet) => {
          reads = { storeId, readSet };
        },
      },
      preference,
      call.input,
      call.idempotencyKey
    );
    return {
      answer: {
        result,
        provenance: null,
        fingerprint: call.reference.fingerprint,
        manifestHash: release.manifestHash,
      },
      reads,
    };
  }

  /**
   * The gate of every call of `running`, for `personId`: the preview is
   * still the draft's, and the person still an active member who builds
   * the App. Run before the preview's store is made or opened, so a
   * caller who may not use the preview makes none, and again before
   * each protected step (`#invocationOf`).
   */
  #authorizer(
    chatId: ChatId,
    personId: string,
    app: AppId,
    running: Running
  ): () => Promise<WriterRoles> {
    const name = nameOf(chatId, app);
    const requireCurrent = (): void => {
      if (this.#running.get(name) !== running) {
        throw appErrors.create("app.preview_outdated");
      }
    };
    return async () => {
      requireCurrent();
      const role = await memberRole(this.#env.DB, personId);
      if (role === undefined) {
        throw permissionErrors.create("permission.person_inactive");
      }
      const roles = await operationRoles(
        this.#env,
        { userId: personId, role },
        app
      );
      if (!roles.appBuilder) {
        throw roleErrors.create("role.forbidden");
      }
      requireCurrent();
      return roles;
    };
  }

  /**
   * The invocation of a call of `running`, for `personId`, on `store`:
   * its one gate (`#authorizer`), before the call starts and each commit.
   * No resources: a preview reaches no outside system.
   */
  #invocationOf(
    chatId: ChatId,
    personId: string,
    app: AppId,
    running: Running,
    {
      store,
      requestId,
      deadline,
    }: { store: OpenStore; requestId: string; deadline: number }
  ): Invocation {
    return {
      principal: personId,
      consumer: { resourceId: app, resourceVersion: running.version },
      store,
      requestId,
      deadline,
      runId: null,
      // The preview's gate, after the store this call holds is checked
      // to be one core still records (the sweep may have taken it).
      authorize: async () => {
        await this.#requireRecorded(chatId, app, running, store);
        return await this.#authorizer(chatId, personId, app, running)();
      },
    };
  }

  /**
   * `release` as the operation host runs it for `running`: each isolate
   * tailed for the chat's preview alone, so what the draft's function
   * writes with `console` goes to the agent's next check of this revision
   * (server-logs.ts), as data.
   */
  #hostedOf(
    chatId: ChatId,
    app: AppId,
    running: Running,
    release: Release
  ): ReturnType<typeof hostedRelease> {
    const preview = {
      workspaceId: workspaceIdSchema.parse(this.#ctx.id.name),
      chatId,
      revision: running.revision,
    };
    return hostedRelease(this.#env, release, (fn) =>
      exports.AppTail({
        props: { app, version: null, preview, method: fn },
      })
    );
  }

  /**
   * Starts, joins or (`attach`) reads again `personId`'s invocation of the
   * streaming action `request` names (its text, as a screen sends it) in
   * the preview of `draft`, by the request's key (see the header), and
   * answers what its reader is sent: JSON lines of progress, then its
   * result, as a live invocation's (action-invocation.ts). A refusal of
   * the invocation is that result; a request that isn't a streaming
   * action's is thrown (`contract.invalid_request`), as is a preview gone
   * meanwhile (`app.preview_outdated`).
   */
  async openStream(
    chatId: ChatId,
    personId: string,
    app: AppId,
    draft: Draft,
    request: unknown,
    attach: boolean
  ): Promise<ReadableStream<Uint8Array>> {
    const { call, key } = streamRequestOf(request);
    // Input past what reads as a value is refused, never hashed as none:
    // two such inputs would share a key's run.
    const input = jsonOf(call.input);
    if (input === undefined && call.input !== undefined) {
      throw operationErrors.create("contract.invalid_request");
    }
    // Which preview it is for is decided now, with the draft the caller
    // just read, before anything awaits: a draft saved meanwhile drops
    // this preview, and the stream is then refused rather than recreate
    // it over the newer one. An attach reads only what runs: a preview
    // not running holds nothing, and none is sealed just to say so.
    const running = attach
      ? this.#runningAt(chatId, app, draft)
      : this.#runningFor(chatId, app, draft);
    const inputHash = await sha256Hex(canonicalJson(input ?? null));
    if (
      running !== undefined &&
      this.#running.get(nameOf(chatId, app)) !== running
    ) {
      throw appErrors.create("app.preview_outdated");
    }
    const name = streamName(personId, call, key);
    const known = running?.streams.get(name);
    if (known !== undefined) {
      return known.inputHash === inputHash
        ? readerOf(known.live)
        : resultOf(
            refusedResult(submissionErrors.create("submission.key_conflict"))
          );
    }
    if (running === undefined || attach) {
      return resultOf(
        refusedResult(submissionErrors.create("submission.expired"))
      );
    }
    const under = [...this.#running.values()]
      .flatMap(({ streams }) => [...streams.values()])
      .filter(({ live }) => live.result === undefined).length;
    if (under >= streamMaxRunning) {
      return resultOf(
        refusedResult(
          operationErrors.create("operation.stream_limit", {
            maxRunning: streamMaxRunning,
          })
        )
      );
    }
    const live: Live = {
      runId: crypto.randomUUID(),
      progress: null,
      result: undefined,
      readers: 0,
      stop: new AbortController(),
      unfollowed: false,
      needsFollowers: true,
      idle: undefined,
      changed: Promise.withResolvers(),
    };
    running.streams.set(name, { inputHash, live });
    const run = async (): Promise<void> => {
      const outcome = await this.#runStream(
        chatId,
        personId,
        app,
        running,
        call,
        live
      );
      clearTimeout(live.idle);
      live.idle = undefined;
      live.result = withReason(outcome.result, live.unfollowed);
      // Settled, it keeps no snapshot: its readers get its result next.
      live.progress = null;
      wake(live);
      // A dropped preview keeps no receipt: nothing can attach to it, and
      // it would take the place of a current preview's. Nor does a run
      // that ran nothing of the App's, as a live one keeps none
      // (`keepsReceipt`): the same key may run again once, say, the
      // sandbox is back.
      if (this.#running.get(nameOf(chatId, app)) !== running) {
        return;
      }
      if (keepsReceipt(outcome)) {
        this.#kept(running, name, live);
      } else {
        forget(running, name, live);
      }
    };
    this.#ctx.waitUntil(run());
    return readerOf(live);
  }

  /**
   * Asks `personId`'s invocation of the streaming action `request` names
   * in the preview of `draft` to stop: as at its deadline, its result
   * saying what is known. Answers whether it was still running, never
   * what stopping did; false for an invocation the preview doesn't hold.
   */
  async cancelStream(
    chatId: ChatId,
    personId: string,
    app: AppId,
    draft: Draft,
    request: unknown
  ): Promise<boolean> {
    await Promise.resolve();
    const { call, key } = streamRequestOf(request);
    const known = this.#runningAt(chatId, app, draft)?.streams.get(
      streamName(personId, call, key)
    );
    if (known === undefined || known.live.result !== undefined) {
      return false;
    }
    known.live.stop.abort();
    return true;
  }

  /**
   * Runs the streaming action `call` of `running`, for `personId`, as a
   * preview's call runs (`call`), its progress published to `live` and
   * cancelled by `live.stop`: what it answered, a refusal included.
   */
  async #runStream(
    chatId: ChatId,
    personId: string,
    app: AppId,
    running: Running,
    call: FunctionRequest,
    live: Live
  ): Promise<{ result: OperationResult; reached: boolean; effects: number }> {
    const requestId = crypto.randomUUID();
    // As a live run reports them (`invokeAppAction`): whether the
    // operation host was reached, and how many effects the run made.
    let reached = false;
    let effects = 0;
    let heldStore: OpenStore | undefined;
    try {
      const release = await this.#loaded(chatId, app, running);
      const path = publicOperationOf(release, call.reference);
      const store = await this.#storeOf(chatId, app, running, release);
      heldStore = store;
      const invocation = this.#invocationOf(chatId, personId, app, running, {
        store,
        requestId,
        deadline: Date.now() + platformLimits.serverInvocationWallMs,
      });
      reached = true;
      const answered = await callOperation(
        this.#hostedOf(chatId, app, running, release),
        invocation,
        { path, kind: call.reference.kind },
        call.input,
        {
          ...(call.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: call.idempotencyKey }),
          progress: {
            publish: (value: Json) => {
              live.progress = { seq: (live.progress?.seq ?? 0) + 1, value };
              wake(live);
            },
          },
          cancelled: live.stop.signal,
          onEffect: () => {
            effects += 1;
          },
        }
      );
      const result = this.#unlessDiscarded(
        chatId,
        app,
        running,
        store,
        answered
      );
      return { result, reached, effects };
    } catch (error) {
      const result = refusedResult(error);
      return {
        result:
          heldStore === undefined
            ? result
            : this.#unlessDiscarded(chatId, app, running, heldStore, result),
        reached,
        effects,
      };
    }
  }

  /**
   * Keeps the receipt of `live`, settled, which `running` holds as
   * `name`: only when its result is small, then at most `receiptsKept` in
   * this object, the oldest forgotten first.
   */
  #kept(running: Running, name: string, live: Live): void {
    if (jsonBytes(live.result, receiptBytes) > receiptBytes) {
      forget(running, name, live);
      return;
    }
    this.#receipts.push({ running, name, live });
    while (this.#receipts.length > receiptsKept) {
      const oldest = this.#receipts.shift();
      if (oldest !== undefined) {
        forget(oldest.running, oldest.name, oldest.live);
      }
    }
  }

  /** The preview of `draft` running now, if one runs its revision. */
  #runningAt(chatId: ChatId, app: AppId, draft: Draft): Running | undefined {
    const known = this.#running.get(nameOf(chatId, app));
    return known?.revision === draft.revision ? known : undefined;
  }

  /**
   * The preview of `draft`: the one running, while it runs the draft's
   * revision; otherwise a new one, the one before dropped first.
   */
  #runningFor(chatId: ChatId, app: AppId, draft: Draft): Running {
    const name = nameOf(chatId, app);
    const known = this.#running.get(name);
    if (known?.revision === draft.revision) {
      return known;
    }
    if (known !== undefined) {
      this.drop(chatId, app);
    }
    const version = (draft.base ?? 0) + 1;
    const running: Running = {
      revision: draft.revision,
      version,
      release: this.#sealed(chatId, app, draft, version),
      streams: new Map(),
    };
    // Not left unhandled while nothing awaits it: each call that does
    // hears how it went.
    void heard(running.release);
    this.#running.set(name, running);
    this.#discardLeftovers();
    return running;
  }

  /**
   * The draft release of `draft`, as the version it would become: the
   * one kept, when it is of the draft's revision; otherwise sealed and
   * kept. Then loaded back from what is kept, every hash checked.
   */
  async #sealed(
    chatId: ChatId,
    app: AppId,
    draft: Draft,
    version: number
  ): Promise<Release> {
    const kept = this.#keptRelease(chatId, app);
    if (kept?.revision !== draft.revision || kept.version !== version) {
      const files = await draftFiles(this.#env, app, draft);
      const sealed = await sealDraftRelease(this.#env, { app, version }, files);
      // Replaced while it was sealed: nothing of it is kept.
      if (this.#running.get(nameOf(chatId, app))?.revision !== draft.revision) {
        throw appErrors.create("app.preview_outdated");
      }
      this.#ctx.storage.transactionSync(() => {
        this.#forgetRelease(chatId, app);
        this.#db
          .insert(previewReleases)
          .values({
            chatId,
            appId: app,
            revision: draft.revision,
            version,
            manifest: sealed.manifest,
            manifestHash: sealed.manifestHash,
          })
          .run();
        const decoder = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        });
        for (const { sha256, bytes } of sealed.artifacts) {
          this.#db
            .insert(previewReleaseArtifacts)
            .values({
              chatId,
              appId: app,
              sha256,
              content: decoder.decode(bytes),
            })
            .run();
        }
      });
    }
    return await this.#load(chatId, app, version);
  }

  /** The draft release kept for the chat's preview of `app`, without its artifacts. */
  #keptRelease(chatId: ChatId, app: string) {
    return this.#db
      .select({
        revision: previewReleases.revision,
        version: previewReleases.version,
        manifest: previewReleases.manifest,
        manifestHash: previewReleases.manifestHash,
      })
      .from(previewReleases)
      .where(
        and(eq(previewReleases.chatId, chatId), eq(previewReleases.appId, app))
      )
      .get();
  }

  /**
   * The draft release kept for the chat's preview of `app`, loaded and
   * verified (`loadDraftRelease`): `app.preview_outdated` once none is.
   */
  async #load(chatId: ChatId, app: AppId, version: number): Promise<Release> {
    const kept = this.#keptRelease(chatId, app);
    if (kept === undefined) {
      throw appErrors.create("app.preview_outdated");
    }
    const encoder = new TextEncoder();
    return await loadDraftRelease({ app, version }, kept, async (sha256) => {
      const row = this.#db
        .select({ content: previewReleaseArtifacts.content })
        .from(previewReleaseArtifacts)
        .where(
          and(
            eq(previewReleaseArtifacts.chatId, chatId),
            eq(previewReleaseArtifacts.appId, app),
            eq(previewReleaseArtifacts.sha256, sha256)
          )
        )
        .get();
      return await Promise.resolve(
        row === undefined ? undefined : encoder.encode(row.content)
      );
    });
  }

  /** `running`'s release, once it is still the preview that runs. */
  async #loaded(
    chatId: ChatId,
    app: AppId,
    running: Running
  ): Promise<Release> {
    const release = await running.release;
    if (this.#running.get(nameOf(chatId, app)) !== running) {
      throw appErrors.create("app.preview_outdated");
    }
    return release;
  }

  /**
   * The preview's store: none for a release without tables; otherwise the
   * one kept for its revision, or a new fixture store, recorded before it
   * is first touched, its tables defined with the draft's schema.
   */
  async #storeOf(
    chatId: ChatId,
    app: AppId,
    running: Running,
    release: Release
  ): Promise<OpenStore> {
    if (!needsStore(release)) {
      return noStore();
    }
    running.store ??= this.#makeStore(chatId, app, running, release);
    const making = running.store;
    try {
      const store = await making;
      if (running.store === making) {
        running.storeId = store.id;
      }
      return store;
    } catch (error) {
      // Tried again by the next call, unless another call replaced it.
      if (running.store === making) {
        running.store = undefined;
      }
      throw error;
    }
  }

  async #makeStore(
    chatId: ChatId,
    app: AppId,
    running: Running,
    release: Release
  ): Promise<OpenStore> {
    const kept = this.#db
      .select({ storeId: previewStores.storeId })
      .from(previewStores)
      .where(
        and(
          eq(previewStores.chatId, chatId),
          eq(previewStores.appId, app),
          eq(previewStores.revision, running.revision)
        )
      )
      .get();
    // Recorded with nothing awaited since the check that the preview still
    // runs, so a drop after this finds it, and discards it.
    if (this.#running.get(nameOf(chatId, app)) !== running) {
      throw appErrors.create("app.preview_outdated");
    }
    // The one kept for this revision is set up again, as a failure may
    // have cut its setup short: both steps below change nothing the second
    // time. Only while core still records it: one it doesn't was cut short
    // before it was recorded, or discarded by the sweep since, and a
    // discarded store is never set up again. Either way a new one starts.
    const reusable =
      kept !== undefined && (await recordedStore(this.#env, kept.storeId));
    if (kept !== undefined && !reusable) {
      this.#db
        .delete(previewStores)
        .where(eq(previewStores.storeId, kept.storeId))
        .run();
    }
    if (this.#running.get(nameOf(chatId, app)) !== running) {
      throw appErrors.create("app.preview_outdated");
    }
    const id = storeIdSchema.parse(
      reusable ? kept.storeId : crypto.randomUUID()
    );
    if (!reusable) {
      this.#db
        .insert(previewStores)
        .values({ storeId: id, chatId, appId: app, revision: running.revision })
        .run();
      // In core's database too, before the object is first touched: what
      // lets the object be discarded as a fixture (`DataStore.discardFixture`).
      // Never again for one reused: it is recorded, as just checked, and
      // writing it again could record one the sweep discarded meanwhile.
      await drizzle(this.#env.DB)
        .insert(previewFixtureStores)
        .values({ storeId: id, appId: app, createdAt: new Date() })
        .onConflictDoNothing();
    }
    // Dropped while that was written: its tables aren't made. The drop
    // discards the store (once that row exists, at the next preview).
    if (this.#running.get(nameOf(chatId, app)) !== running) {
      throw appErrors.create("app.preview_outdated");
    }
    const store = openFixtureStore(this.#env, id);
    try {
      await store.defineTables(manifestText(release.app.schema), {
        resourceId: app,
        resourceVersion: running.version,
      });
    } catch (error) {
      // Discarded since it was checked: forgotten, so the next call starts
      // a new one rather than find it again.
      if (dataErrors.codeOf(error) === "data.fixture_discarded") {
        this.#db
          .delete(previewStores)
          .where(eq(previewStores.storeId, id))
          .run();
        throw appErrors.create("app.preview_outdated");
      }
      throw error;
    }
    if (this.#running.get(nameOf(chatId, app)) !== running) {
      throw appErrors.create("app.preview_outdated");
    }
    return store;
  }

  /**
   * Refuses the call of `running` on `store` once core no longer records
   * that store (`app.preview_outdated`): the sweep discarded it, so it
   * refuses everything anyway. The preview forgets it, and its next call
   * starts a new, empty one (`#makeStore`). A release without tables has
   * no store to check.
   */
  async #requireRecorded(
    chatId: ChatId,
    app: AppId,
    running: Running,
    store: OpenStore
  ): Promise<void> {
    // Of the store this call holds, never the one the preview caches now,
    // which another call may have replaced: a release without tables has
    // none to check.
    if (
      store.id === noStore().id ||
      (await recordedStore(this.#env, store.id))
    ) {
      return;
    }
    this.#forgetStore(chatId, app, running, store.id);
    throw appErrors.create("app.preview_outdated");
  }

  /**
   * Forgets store `storeId` of `running`, discarded: the cached store
   * only while it is that one, never a new one another call is making,
   * and the chat's record of it, so the next call starts a new, empty one.
   */
  #forgetStore(
    chatId: ChatId,
    app: AppId,
    running: Running,
    storeId: string
  ): void {
    if (
      this.#running.get(nameOf(chatId, app)) === running &&
      running.storeId === storeId
    ) {
      running.store = undefined;
      running.storeId = undefined;
    }
    this.#db
      .delete(previewStores)
      .where(eq(previewStores.storeId, storeId))
      .run();
  }

  /**
   * `result` of a call of `running` on `store`, unless the store refused it
   * as discarded (the sweep took it while core still recorded it, or
   * while the call ran): then the store is forgotten (`#forgetStore`) and
   * the call is `app.preview_outdated`, as at its next step it would be.
   */
  #unlessDiscarded(
    chatId: ChatId,
    app: AppId,
    running: Running,
    store: OpenStore,
    result: OperationResult
  ): OperationResult {
    if (result.ok || result.error.code !== "data.fixture_discarded") {
      return result;
    }
    this.#forgetStore(chatId, app, running, store.id);
    return refusedResult(appErrors.create("app.preview_outdated"));
  }

  /**
   * Stops the chat's preview of `app`, if one runs: a call it stops
   * midway is `app.preview_outdated`, its draft release is forgotten, and
   * its stores are discarded.
   */
  drop(chatId: ChatId, app: string): void {
    const running = this.#running.get(nameOf(chatId, app));
    this.#running.delete(nameOf(chatId, app));
    // Its streaming actions stop, and commit nothing more: each protected
    // step checks the preview is still the one running.
    for (const { live } of running?.streams.values() ?? []) {
      live.stop.abort();
    }
    // Its receipts go with it.
    for (let at = this.#receipts.length - 1; at >= 0; at -= 1) {
      if (this.#receipts[at]?.running === running) {
        this.#receipts.splice(at, 1);
      }
    }
    this.#ctx.storage.transactionSync(() => {
      this.#forgetRelease(chatId, app);
    });
    const stores = this.#db
      .select({ storeId: previewStores.storeId })
      .from(previewStores)
      .where(
        and(eq(previewStores.chatId, chatId), eq(previewStores.appId, app))
      )
      .all();
    // Once a store being made has its tables (or failed to): a discard
    // midway would leave what the rest of its making writes.
    this.#discard(
      stores.map(({ storeId }) => storeId),
      running?.store
    );
  }

  /** Forgets the draft release kept for the chat's preview of `app`. */
  #forgetRelease(chatId: ChatId, app: string): void {
    this.#db
      .delete(previewReleaseArtifacts)
      .where(
        and(
          eq(previewReleaseArtifacts.chatId, chatId),
          eq(previewReleaseArtifacts.appId, app)
        )
      )
      .run();
    this.#db
      .delete(previewReleases)
      .where(
        and(eq(previewReleases.chatId, chatId), eq(previewReleases.appId, app))
      )
      .run();
  }

  /**
   * Discards the stores of previews no draft is at any more, a page of
   * them: those a failed discard or a restart left.
   */
  #discardLeftovers(): void {
    const running = new Set(
      [...this.#running.entries()].map(
        ([name, { revision }]) => `${name}:${revision}`
      )
    );
    const left = this.#db
      .select({
        storeId: previewStores.storeId,
        chatId: previewStores.chatId,
        appId: previewStores.appId,
        revision: previewStores.revision,
      })
      .from(previewStores)
      .orderBy(previewStores.storeId)
      .all()
      .filter(
        (row) =>
          !running.has(`${nameOf(row.chatId, row.appId)}:${row.revision}`) &&
          this.#revisionOf(row.chatId, row.appId) !== row.revision &&
          // One that keeps failing waits for the object's next start, so
          // it never holds up the rest of the page.
          !this.#stuck.has(row.storeId)
      )
      .slice(0, leftoversPage);
    this.#discard(left.map(({ storeId }) => storeId));
  }

  /**
   * Discards stores `ids`, each forgotten once it is: one that fails stays
   * recorded, for the next preview to discard, and is left out of the
   * leftovers this object discards until it starts again (`#stuck`). One
   * core's database never recorded (its insert failed) is only forgotten:
   * that row is written before the object is first touched, so the object
   * holds nothing, and it would refuse to be discarded anyway.
   */
  #discard(ids: readonly string[], making?: Promise<OpenStore>): void {
    if (ids.length === 0) {
      return;
    }
    this.#ctx.waitUntil(
      Promise.all(
        ids.map(async (id) => {
          if (this.#discarding.has(id)) {
            return;
          }
          this.#discarding.add(id);
          try {
            await heard(making ?? Promise.resolve());
            const recorded = await drizzle(this.#env.DB)
              .select({ storeId: previewFixtureStores.storeId })
              .from(previewFixtureStores)
              .where(eq(previewFixtureStores.storeId, id))
              .get();
            if (recorded !== undefined) {
              await discardFixtureStore(this.#env, storeIdSchema.parse(id));
              await drizzle(this.#env.DB)
                .delete(previewFixtureStores)
                .where(eq(previewFixtureStores.storeId, id));
            }
            this.#db
              .delete(previewStores)
              .where(eq(previewStores.storeId, id))
              .run();
          } catch (error) {
            this.#stuck.add(id);
            log.warn("preview.store_discard_failed", {
              store: id,
              ...errorFields(error),
            });
          } finally {
            this.#discarding.delete(id);
          }
        })
      )
    );
  }
}
