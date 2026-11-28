import { serverFunctionsIn } from "@grasp-os/runtime/definition";
import {
  declaredPermission,
  generateModules,
  manifestText,
} from "@grasp-os/runtime/host";
import type { AppDataPage, AppDataTable } from "@grasp-os/shared/app-data";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { appErrors } from "@grasp-os/shared/apps";
import { withinTime } from "@grasp-os/shared/deadline";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { draftSealFailures, functionErrors } from "@grasp-os/shared/functions";
import type { FunctionResult } from "@grasp-os/shared/functions";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson, canonicalText } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WriterRoles } from "@grasp-os/shared/stores";
import { exports } from "cloudflare:workers";

import { functionRoles } from "./app-access.ts";
import { testDataOf } from "./app-data.ts";
import { schemaIdsOf } from "./app-definition.ts";
import {
  publicFunctionOf,
  readFunctionRequest,
  refusalOf,
} from "./app-functions.ts";
import type { FunctionAnswer, FunctionRequest } from "./app-functions.ts";
import {
  answerPeople,
  isPeoplePath,
  memberPeople,
  peopleReadOf,
} from "./app-people.ts";
import type { Release } from "./app-releases.ts";
import { editableApp } from "./apps.ts";
import { memberRole } from "./auth/identity.ts";
import { holdThrowawayStore, throwawayStore } from "./data-stores.ts";
import type { OpenStore } from "./data-stores.ts";
import { pageModulesOf } from "./draft-references.ts";
import type { PageModules } from "./draft-references.ts";
import {
  draftSealKey,
  draftSource,
  keptRelease,
  releaseOfEntry,
  requireApprovedPackages,
  sealOfSource,
} from "./draft-seals.ts";
import type { DraftSeal, DraftSource } from "./draft-seals.ts";
import { changesAnything } from "./drafts.ts";
import type { DraftState } from "./drafts.ts";
import { appPreview, callObject } from "./durable-objects.ts";
import { hostFunctionCall } from "./function-host.ts";
import type { Invocation, ProgressSink } from "./function-host.ts";
import { checkedValue, isWorkflowMutationPath } from "./page-workflows.ts";
import { functionProblem } from "./preview-reports.ts";
import { hostedRelease, noStore } from "./release-runner.ts";
import type { SchemaIds } from "./schema-changes.ts";
import {
  isWorkflowQueryPath,
  workflowQueryOf,
} from "./workflow-reference-queries.ts";

// An App's preview of its one shared draft (GRA-1665): the draft, sealed
// as the version it would become, run by the function host as a version
// is (function-host.ts), and reached through pages' one call path
// (page-calls.ts for calls and actions, pages-rpc.ts for live queries)
// under a lease core signed for the builder, naming the App's draft
// (page-delivery.ts). Every builder of the App previews the same draft,
// each as themselves, on one store of test data they share (the App's
// preview, app-preview.ts, names it).
// A draft is code nobody reviewed, written by an agent from what it was
// told. Threat model, and how each is closed:
//
// - The draft reaches the App's data: nothing names the App's store. The
//   draft's release binds none (`loadDraftRelease` refuses one that
//   does), and every invocation is handed the preview's throwaway store
//   (`draftStore`): a store object no inventory lists and no release
//   binds, named by the App, its preview's seed and the draft's schema,
//   which refuses to be a listed store (`DataStore.holdThrowaway`).
// - The draft reaches outside systems, or starts real work: its
//   invocations bind no resource (no connection, Brain, model, template or
//   other App), start no workflow, send no run an event and tell no
//   webhook, so the function host refuses each such request
//   (`permission.unavailable`); a page's workflow commands and watches, and
//   a workflow reference's queries, are refused before anything runs. Its
//   code runs in the release runner's isolates, with no network and no env.
// - Someone who doesn't build the App: the lease is signed for one
//   person and the App, and they must build the App, read again before
//   the call starts and before every protected step (`builderGate`). Each
//   call runs as its caller, with their roles: the test data is all the
//   builders share.
// - Other code runs than the draft's: it is sealed from the draft's files
//   as they are now (`sealDraftRelease`, every check a version's seal
//   makes), by the App's preview object once for everyone, and kept under
//   the hash of everything that decides the seal, signed in R2 and loaded
//   back through `loadRelease`'s own checks wherever it is read
//   (draft-seals.ts, which has the threat model of what it keeps).
// - What someone typed into a preview stays: its store empties itself a
//   day after its last use (`throwawayStoreMs`), and at once, for good,
//   when a builder resets the test data or the App is removed
//   (`DataStore.emptyThrowaway`, app-preview.ts), which refuses every call
//   after, one under way included; the preview then names a new store
//   (`DraftRun.seed`). A new schema gets a new, empty store too.
// - One App's test data reaches another's: a store per App, preview seed
//   and schema, shared with nothing outside the App's builders, who build
//   its code and read its live data already.

/** What one call of a draft's preview runs on. */
export interface DraftRun {
  readonly app: AppId;
  /** The draft's revision: what the call's problems and logs are filed under. */
  readonly revision: number;
  /**
   * Whether the draft has changes of its own, whose problems the agent's
   * check reads: one that changes nothing previews the App's latest version.
   */
  readonly own: boolean;
  /**
   * What its throwaway store is named by besides the App and its schema:
   * new once the preview's test data is reset (`AppPreview.run`).
   */
  readonly seed: string;
  readonly release: Release;
  /** The stable IDs its definition gives its schema (app-definition.ts). */
  readonly ids: SchemaIds;
}

/** How long a throwaway store keeps what it holds once nothing uses it. */
const throwawayStoreMs = 24 * 60 * 60 * 1000;

/** How often an isolate holds a throwaway store again while it is used. */
const holdAgainMs = 60 * 60 * 1000;

/**
 * The most sealed drafts one isolate keeps: each holds its App's modules
 * and its own copy of the server SDK, a quarter of a megabyte for a small
 * App, and R2 holds every one besides.
 */
const sealedMax = 16;

/**
 * Drafts sealed and loaded in this isolate, by their key
 * (draft-seals.ts), the most recently used last: the release itself,
 * never a promise of it.
 */
const sealedDrafts = new Map<string, Release>();

/** Keeps `release` under `key` as the most recently used. */
const keepSealed = (key: string, release: Release): void => {
  sealedDrafts.delete(key);
  sealedDrafts.set(key, release);
  if (sealedDrafts.size > sealedMax) {
    const [oldest] = sealedDrafts.keys();
    if (oldest !== undefined) {
      sealedDrafts.delete(oldest);
    }
  }
};

/**
 * The entry of `seal` as the App's preview object answers it, kept or
 * sealed there (`AppPreview.seal`), asked again should the object restart
 * under the call (`callObject`). Throws as the seal does.
 */
const fromPreview = async (env: Env, seal: DraftSeal): Promise<string> => {
  const { app, ...draft } = seal;
  return await callObject(async () => await appPreview(env, app).seal(draft));
};

/** `seal`'s release from the App's preview object (`fromPreview`), by `until`. */
const releaseFromPreview = async (
  env: Env,
  seal: DraftSeal,
  until: number | undefined
): Promise<Release> => {
  let text: string;
  try {
    text =
      until === undefined
        ? await fromPreview(env, seal)
        : await withinTime(
            async () => await fromPreview(env, seal),
            Math.max(until - Date.now(), 0)
          );
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw versionErrors.create("version.seal_slow");
    }
    throw error;
  }
  const release = await releaseOfEntry(seal, text);
  if (release === undefined) {
    throw new Error("The draft's preview sealed a release that doesn't load.");
  }
  return release;
};

/**
 * `source`, a draft of `app` as `version`, sealed and loaded back through
 * the same checks as a version's release (draft-seals.ts): from this
 * isolate, from R2, or from the App's preview object, which seals it once
 * for everyone (`fromPreview`). Only its code and tests are sealed
 * (`appCodeAndTestFiles`, the very selection its build and check make),
 * so a write of a page seals nothing again. By `until`, if given, or
 * refused with `version.seal_slow` while the seal goes on, for the next
 * to read; a seal that failed is never kept here.
 */
const sealed = async (
  env: Env,
  app: AppId,
  version: number,
  source: DraftSource,
  until?: number
): Promise<Release> => {
  const seal = sealOfSource(app, version, source);
  const key = await draftSealKey(env, seal);
  const inR2 = sealedDrafts.has(key)
    ? undefined
    : await keptRelease(env, key, seal);
  const release =
    sealedDrafts.get(key) ??
    inR2?.release ??
    (await releaseFromPreview(env, seal, until));
  keepSealed(key, release);
  await requireApprovedPackages(env, release);
  return release;
};

/**
 * What `draft`, a draft of `app`, holds (`draftSource`) and the release it
 * seals to (`sealed`), by `until` if given; null for a draft that holds
 * nothing.
 */
const sealedDraft = async (
  env: Env,
  app: AppId,
  draft: DraftState,
  until?: number
) => {
  const source = await draftSource(env, app, draft);
  return source === null
    ? null
    : {
        source,
        release: await sealed(env, app, (draft.base ?? 0) + 1, source, until),
      };
};

/**
 * The release `draft`, a draft of `app`, seals to (`sealed`), the very one
 * its calls run on: what a review of the draft reads its manifest from
 * (app-review.ts). Null for a draft that holds nothing; throws as the
 * seal does.
 */
export const draftRelease = async (
  env: Env,
  app: AppId,
  draft: DraftState
): Promise<Release | null> => {
  const drafted = await sealedDraft(env, app, draft);
  return drafted?.release ?? null;
};

/**
 * The page modules (`PageModules`: the `@server/_generated/api`
 * references and the release's functions) the pages of `draft`, a draft
 * of `app` (now, or a kept version of it), build with: generated from the
 * release the draft seals to (`sealed`), the very one its calls run on.
 * Null when it generates none; throws as the seal does.
 */
export const draftReferences = async (
  env: Env,
  app: AppId,
  draft: DraftState
): Promise<PageModules | null> => {
  const drafted = await sealedDraft(env, app, draft);
  if (drafted === null) {
    return null;
  }
  const { source, release } = drafted;
  const generated = await generateModules(
    release.app,
    serverFunctionsIn(Object.fromEntries(source.files))
  );
  return pageModulesOf(generated) ?? null;
};

/**
 * What App `app`'s draft runs on now, for `by`: only while they build the
 * App and it isn't archived. The draft that changes nothing previews the
 * App's live version, as its page shows it. By `until`, if given: a seal
 * still under way then answers `version.seal_slow`.
 */
export const draftRunOf = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: AppId,
  /** By when a call needs it: past it, `version.seal_slow` (`sealed`). */
  until?: number
): Promise<DraftRun> => {
  await editableApp(env, by, app);
  const { draft, seed } = await appPreview(env, app).run();
  const drafted = await sealedDraft(env, app, draft, until);
  // The draft that holds nothing previews the App's live version, so a
  // draft to preview always has a definition.
  if (drafted === null) {
    throw appErrors.create("app.not_running");
  }
  const { source, release } = drafted;
  return {
    app,
    revision: draft.revision,
    own: changesAnything(draft),
    seed,
    release,
    ids: schemaIdsOf(source.definition, release.app.schema),
  };
};

/**
 * The gate of every call of a preview, for `userId`: an active member who
 * builds the App, read now. Before the call starts, and again before each
 * commit, so losing the role stops a call already running.
 */
const builderGate =
  (env: Env, userId: string, app: AppId) => async (): Promise<WriterRoles> => {
    const role = await memberRole(env.DB, userId);
    if (role === undefined) {
      throw permissionErrors.create("permission.person_inactive");
    }
    const roles = await functionRoles(env, { userId, role }, app);
    if (!roles.appBuilder) {
      throw roleErrors.create("role.forbidden");
    }
    return roles;
  };

/** When each throwaway store was last held by this isolate, and made. */
const heldStores = new Map<string, number>();

/** Whether `release`'s App has a store: tables. */
const needsStore = (release: Release): boolean =>
  Object.keys(release.app.schema.tables).length > 0;

/**
 * The preview's throwaway store for a call of `run`, its tables those of
 * the draft's schema, made by the App's server as a fixture's are
 * (app-tests.ts), shared by every builder of the App: none for a draft
 * without tables.
 * Held again (and its tables made, which changes nothing the second time)
 * at most every `holdAgainMs` per isolate, well within the day it keeps
 * what it holds, so a store in use never empties under its preview.
 */
const draftStore = async (env: Env, run: DraftRun): Promise<OpenStore> => {
  const { release } = run;
  if (!needsStore(release)) {
    return noStore();
  }
  const id = storeIdSchema.parse(
    `throwaway-${await sha256Hex(
      canonicalJson([
        run.app,
        run.seed,
        release.manifest.schemaHash,
        // Its tables' and fields' IDs too, which the schema's hash leaves
        // out: other ones are a new store, never one it can't read.
        canonicalText(run.ids),
      ])
    )}`
  );
  const store = throwawayStore(env, id);
  const now = Date.now();
  if (now - (heldStores.get(id) ?? 0) < holdAgainMs) {
    return store;
  }
  // Kept with the App's preview before it is first touched, so a reset of
  // its test data or the App's removal empties it at once; one emptied so
  // refuses this hold, and every call after.
  await appPreview(env, run.app).keepStore({ storeId: id, seed: run.seed });
  await holdThrowawayStore(env, id, now + throwawayStoreMs);
  // A store made for this schema alone: applied again, it changes nothing.
  await store.applySchema({
    manifest: manifestText(release.app.schema),
    ids: run.ids,
    answers: release.app.answers ?? [],
    actor: { type: "app", appId: run.app, part: "server" },
  });
  heldStores.set(id, now);
  return store;
};

/**
 * `run`'s release as the function host runs it: each isolate tailed for
 * the App's preview alone, so what the draft's code writes with
 * `console` reaches the next check of this revision (server-logs.ts), as
 * data.
 */
const hosted = (env: Env, run: DraftRun): ReturnType<typeof hostedRelease> =>
  hostedRelease(env, run.release, (method) =>
    exports.AppTail({
      props: {
        app: run.app,
        version: null,
        preview: { revision: run.revision },
        method,
      },
    })
  );

/** What an invocation of a preview is made of. */
interface DraftCall {
  readonly requestId: string;
  readonly deadline: number;
  /** Told what the draft's code threw, for the agent's check alone. */
  readonly draftFailure?: (message: string) => void;
}

/**
 * The invocation of `run` for `by`: the preview's throwaway store, the
 * builder's gate before the call and every commit, and nothing else bound.
 */
const invocationOf = (
  env: Env,
  by: Pick<Identity, "userId">,
  run: DraftRun,
  store: OpenStore,
  { requestId, deadline, draftFailure }: DraftCall
): Invocation => {
  const authorize = builderGate(env, by.userId, run.app);
  return {
    ...(draftFailure === undefined ? {} : { draftFailure }),
    principal: by.userId,
    actor: { type: "person", userId: by.userId },
    // The throwaway store holds no one's data: nothing to record.
    sensitiveReads: null,
    consumer: {
      resourceId: run.app,
      resourceVersion: run.release.manifest.resourceVersion,
    },
    store,
    requestId,
    deadline,
    runId: null,
    authorize,
    people: memberPeople(env, {
      app: run.app,
      userId: by.userId,
      roles: authorize,
      declared:
        declaredPermission(run.release.app, "people", "people") !== undefined,
      actor: { type: "app", appId: run.app, part: "server" },
      requestId,
    }),
  };
};

/**
 * Keeps what a call of the draft's own revision failed with for the
 * agent's next check of the draft (preview-reports.ts), and that the
 * preview ran: never for a draft that changes nothing.
 */
const reported = async (
  env: Env,
  run: DraftRun,
  request: unknown,
  result: FunctionResult,
  thrown: string | undefined
): Promise<void> => {
  if (!run.own) {
    return;
  }
  await appPreview(env, run.app).called(
    run.revision,
    functionProblem(request, result, thrown) ?? null
  );
};

/** How a call of a preview is made, beyond who and what. */
export interface DraftCallOptions {
  readonly deadline: number;
  /** Only this kind of function may be called (a live query's). */
  readonly kind?: FunctionRequest["reference"]["kind"];
  /** Told the store a query read and its read set. */
  readonly observeReads?: (
    storeId: OpenStore["id"],
    readSet: Record<string, number>
  ) => void;
  /**
   * The chat's agent's own call (`env.build.call`): told what the draft's
   * code threw, as data, and nothing is kept for its next check, since it
   * hears how the call went itself.
   */
  readonly thrown?: (message: string) => void;
}

/** The answer to `request` once it ran, or why it was refused. */
const answerOf = (result: FunctionResult, run?: DraftRun): FunctionAnswer => ({
  result,
  provenance: null,
  manifestHash: run?.release.manifestHash ?? null,
});

/**
 * The call `request` asks of a preview, as `options` take it: refused as
 * the preview's side effect when it calls a workflow reference's
 * mutations, and as `contract.invalid_request` when it isn't of the kind
 * asked for.
 */
const draftCallOf = (
  request: unknown,
  { kind }: Pick<DraftCallOptions, "kind">
): FunctionRequest => {
  const call = readFunctionRequest(request);
  if (isWorkflowMutationPath(call.reference.name)) {
    throw appErrors.create("app.preview_side_effect");
  }
  if (kind !== undefined && call.reference.kind !== kind) {
    throw functionErrors.create("contract.invalid_request");
  }
  return call;
};

/**
 * What a preview answers `call` of a workflow reference's query, which
 * reads runs through the App's binding of the workflow, a preview has
 * none of: no run (`run` answers `null`), none it may start (`canStart`
 * answers `false`), so a page built on `useWorkflow` shows as it does
 * before its first start; any other query `permission.unavailable`. The
 * draft must declare the workflow, and the arguments be the query's.
 */
const draftWorkflowQuery = (
  release: Release,
  call: FunctionRequest
): FunctionResult => {
  const query = workflowQueryOf(release, call.reference);
  if (query.name !== "run" && query.name !== "canStart") {
    throw functionErrors.create("permission.unavailable");
  }
  checkedValue(query.args, call.args, "contract.invalid_args");
  return { ok: true, value: query.name === "run" ? null : false };
};

/** `call` of one of the draft's own functions, on `store`. */
const draftFunctionCall = async (
  env: Env,
  by: Pick<Identity, "userId">,
  run: DraftRun,
  store: OpenStore,
  call: FunctionRequest,
  { observeReads, ...made }: DraftCall & Pick<DraftCallOptions, "observeReads">
): Promise<FunctionResult> => {
  const path = publicFunctionOf(run.release, call.reference);
  const invocation = invocationOf(env, by, run, store, made);
  const observe =
    observeReads === undefined
      ? undefined
      : (readSet: Record<string, number>) => {
          observeReads(store.id, readSet);
        };
  const reference = { path, kind: call.reference.kind };
  return await hostFunctionCall(
    hosted(env, run),
    observe === undefined
      ? invocation
      : { ...invocation, observeReads: observe },
    reference,
    call.args,
    call.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: call.idempotencyKey }
  );
};

/**
 * `request`, a page's call as its text, run on `run` for `by` (see the
 * header): a public query, mutation or action of the draft, or who
 * calls; a window of a query when it may read one.
 * Answers as a page's call is answered, a refusal included; never throws.
 */
export const callDraft = async (
  env: Env,
  by: Pick<Identity, "userId">,
  run: DraftRun,
  request: unknown,
  options: DraftCallOptions
): Promise<FunctionAnswer> => {
  const { deadline, thrown: told } = options;
  const requestId = crypto.randomUUID();
  let thrown: string | undefined;
  let result: FunctionResult;
  try {
    const call = draftCallOf(request, options);
    const authorize = builderGate(env, by.userId, run.app);
    const gate = async (): Promise<void> => {
      await authorize();
      if (Date.now() >= deadline) {
        throw functionErrors.create("function.deadline_exceeded");
      }
    };
    // Before anything is read, the store made or opened.
    await gate();
    if (isWorkflowQueryPath(call.reference.name)) {
      return answerOf(draftWorkflowQuery(run.release, call), run);
    }
    if (isPeoplePath(call.reference.name)) {
      const value = await answerPeople(
        memberPeople(env, {
          app: run.app,
          userId: by.userId,
          roles: authorize,
          declared:
            declaredPermission(run.release.app, "people", "people") !==
            undefined,
          actor: { type: "app", appId: run.app, part: "page" },
          requestId,
        }),
        peopleReadOf(call.reference),
        call.args
      );
      return answerOf({ ok: true, value }, run);
    }
    const store = await draftStore(env, run);
    result = await draftFunctionCall(env, by, run, store, call, {
      ...options,
      requestId,
      draftFailure: (message) => {
        thrown = message;
      },
    });
  } catch (error) {
    result = { ok: false, error: refusalOf(error, requestId) };
  }
  if (told === undefined) {
    await reported(env, run, request, result, thrown);
  } else if (thrown !== undefined) {
    told(thrown);
  }
  return answerOf(result, run);
};

/**
 * `request`, a page's call as its text, run on App `app`'s draft as it is
 * now, for `by` (`draftRunOf`, `callDraft`): a draft
 * whose code doesn't seal answers why, as a call answers a refusal, for
 * its page to show while it is being fixed; the agent's check of the
 * draft builds it and hears why itself. One whose seal is still under way
 * by the call's deadline answers `version.seal_slow`, which a page tries
 * again, a live query too, as the seal goes on.
 */
export const callDraftOn = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: AppId,
  request: unknown,
  options: DraftCallOptions
): Promise<FunctionAnswer> => {
  let run: DraftRun;
  try {
    run = await draftRunOf(env, by, app, options.deadline);
  } catch (error) {
    if (
      !(
        isExpectedError(error) &&
        (draftSealFailures.has(error.code) ||
          error.code === "version.seal_slow")
      )
    ) {
      throw error;
    }
    return answerOf({
      ok: false,
      error: refusalOf(error, crypto.randomUUID()),
    });
  }
  return await callDraft(env, by, run, request, options);
};

/**
 * Runs the public action `call` of `run` once for `by`, for the invocation
 * object that holds it (action-invocation.ts), as a version's runs
 * (`invokeAppAction`): what it returned, whether App code may have run,
 * and how many effects it made. Never throws.
 */
export const invokeDraftAction = async (
  env: Env,
  by: Pick<Identity, "userId">,
  run: DraftRun,
  call: FunctionRequest,
  {
    progress,
    cancelled,
    deadline,
  }: {
    readonly progress?: ProgressSink;
    readonly cancelled: AbortSignal;
    readonly deadline: number;
  }
): Promise<{ result: FunctionResult; reached: boolean; effects: number }> => {
  const requestId = crypto.randomUUID();
  let reached = false;
  let effects = 0;
  let thrown: string | undefined;
  let result: FunctionResult;
  try {
    const path = publicFunctionOf(run.release, call.reference);
    await builderGate(env, by.userId, run.app)();
    const store = await draftStore(env, run);
    const invocation = invocationOf(env, by, run, store, {
      requestId,
      deadline,
      draftFailure: (message) => {
        thrown = message;
      },
    });
    reached = true;
    result = await hostFunctionCall(
      hosted(env, run),
      invocation,
      { path, kind: call.reference.kind },
      call.args,
      {
        ...(call.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: call.idempotencyKey }),
        ...(progress === undefined ? {} : { progress }),
        cancelled,
        onEffect: () => {
          effects += 1;
        },
      }
    );
  } catch (error) {
    result = { ok: false, error: refusalOf(error, requestId) };
  }
  await reported(env, run, JSON.stringify(call), result, thrown);
  return { result, reached, effects };
};

/**
 * The preview's test data, as `by` reads it (app-data.ts, `testDataOf`):
 * its tables, on the data model of what the preview shows, or (`read`) a
 * page of one's records, newest first, their roles and the tables' access
 * and row rules applied as on the App's own data. Only while they build
 * the App (`builderGate`).
 */
export const draftTestData = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: AppId,
  read?: { table: string; cursor: string | null }
): Promise<AppDataTable[] | AppDataPage> => {
  const run = await draftRunOf(env, by, app);
  const roles = await builderGate(env, by.userId, app)();
  const store = await draftStore(env, run);
  return await testDataOf(
    store,
    {
      schemaHash: run.release.manifest.schemaHash,
      principal: by.userId,
      appMember: roles.appMember,
      appBuilder: roles.appBuilder,
      teams: roles.teams,
      consumer: {
        resourceId: run.app,
        resourceVersion: run.release.manifest.resourceVersion,
      },
    },
    run.release.app.schema.tables,
    read
  );
};
