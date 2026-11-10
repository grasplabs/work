import { definitionText } from "@grasp-os/runtime/definition";
import type { AppDefinition } from "@grasp-os/runtime/definition";
import {
  declaredPermission,
  generateModules,
  manifestText,
} from "@grasp-os/runtime/host";
import { appErrors } from "@grasp-os/shared/apps";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import { canonicalJson, canonicalText } from "@grasp-os/shared/json";
import {
  draftSealFailures,
  operationErrors,
} from "@grasp-os/shared/operations";
import type { OperationResult } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WriterRoles } from "@grasp-os/shared/stores";
import { exports } from "cloudflare:workers";

import { operationRoles } from "./app-access.ts";
import { schemaIdsOf, serverFunctionsIn } from "./app-definition.ts";
import {
  publicOperationOf,
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
import { loadDraftRelease, sealDraftRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import {
  changesAnything,
  draftDefinition,
  draftFiles,
  editableApp,
} from "./apps.ts";
import { memberRole } from "./auth/identity.ts";
import { holdThrowawayStore, throwawayStore } from "./data-stores.ts";
import type { OpenStore } from "./data-stores.ts";
import { pageModulesOf } from "./draft-references.ts";
import type { PageModules } from "./draft-references.ts";
import { workspace } from "./durable-objects.ts";
import { callOperation } from "./operations.ts";
import type { Invocation, ProgressSink } from "./operations.ts";
import { checkedValue, isWorkflowMutationPath } from "./page-workflows.ts";
import { appCodeAndTestFiles } from "./pages.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import { functionProblem } from "./preview-reports.ts";
import { hostedRelease, noStore } from "./release-runner.ts";
import type { SchemaIds } from "./schema-changes.ts";
import {
  isWorkflowQueryPath,
  workflowQueryOf,
} from "./workflow-reference-queries.ts";
import type { Draft } from "./workspace.ts";

// A builder's preview of their draft of an App: the draft, sealed as the
// version it would become, run by the operation host as a version is
// (operations.ts), and reached through pages' one call path (page-calls.ts
// for calls and actions, pages-rpc.ts for live queries) under a lease
// core signed for the builder, naming the draft's chat (page-delivery.ts).
// A draft is code nobody reviewed, written by an agent from what it was
// told. Threat model, and how each is closed:
//
// - The draft reaches the App's data: nothing names the App's store. The
//   draft's release binds none (`loadDraftRelease` refuses one that
//   does), and every invocation is handed the preview's throwaway store
//   (`draftStore`): a store object no inventory lists and no release
//   binds, named by the builder, their chat, the App and the draft's
//   schema, which refuses to be a listed store (`DataStore.holdThrowaway`).
// - The draft reaches outside systems, or starts real work: its
//   invocations bind no resource (no connection, Brain, model, template or
//   other App), start no workflow, stage no notification and tell no
//   webhook, so the operation host refuses each such request
//   (`resource.unavailable`); a page's workflow commands and watches, and
//   a workflow reference's queries, are refused before anything runs. Its
//   code runs in the release runner's isolates, with no network and no env.
// - Someone else's draft, or someone who doesn't build the App: the lease
//   is signed for one person, the App and the chat; the chat is looked up
//   in that person's own Workspace object, never anyone else's; and they
//   must build the App, read again before the call starts and before every
//   protected step (`builderGate`).
// - Other code runs than the draft's: it is sealed from the draft's files
//   as they are now (`sealDraftRelease`, every check a version's seal
//   makes) and loaded back through `loadRelease`'s own checks; this isolate
//   keeps it by the hash of exactly the files the seal reads and the
//   draft's definition (`sealed`).
// - What someone typed into a preview stays: its store empties itself a
//   day after its last use (`throwawayStoreMs`), and at once, for good,
//   when the draft is dropped, the chat deleted or its person removed or
//   erased (`DataStore.emptyThrowaway`), which refuses every call after,
//   one under way included; the preview then names a new store
//   (`DraftRun.seed`). A new schema gets a new, empty store too.
// - One preview's data reaches another's: a store per person, chat, App and
//   schema, shared with nothing.

/** What one call of a draft's preview runs on. */
export interface DraftRun {
  readonly app: AppId;
  readonly chatId: ChatId;
  readonly workspaceId: WorkspaceId;
  /** The draft's revision: what the call's problems and logs are filed under. */
  readonly revision: number;
  /**
   * Whether the draft has changes of its own, whose problems the agent's
   * check reads: one that changes nothing previews the App's latest version.
   */
  readonly own: boolean;
  /**
   * What its throwaway store is named by besides who, which chat and App
   * and which schema: new once the preview's data is dropped
   * (`Workspace.previewRun`).
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

/** The most sealed drafts one isolate keeps. */
const sealedMax = 16;

/** Drafts sealed in this isolate, by the hash of what the seal reads. */
const sealedDrafts = new Map<string, Promise<Release>>();

/** A draft's files and definition, as its seal reads them. */
interface DraftSource {
  readonly files: Map<string, string>;
  readonly definition: AppDefinition;
}

/**
 * `draft`'s files and definition (apps.ts); null for a draft of an App
 * with no version that holds nothing, which has nothing to seal.
 */
const draftSource = async (
  env: Env,
  app: AppId,
  draft: Draft
): Promise<DraftSource | null> => {
  const held = await draftDefinition(env, app, draft);
  return held === null
    ? null
    : {
        files: await draftFiles(env, app, draft),
        definition: held.definition,
      };
};

/**
 * `source`, a draft of `app` as `version`, sealed and loaded back through
 * the same checks as a version's release (`loadDraftRelease`): kept in
 * this isolate by the hash of the files its seal reads
 * (`appCodeAndTestFiles`, the very selection its build and check make)
 * and of its definition, so a write of a page seals nothing again. A
 * failed seal isn't kept.
 */
const sealed = async (
  env: Env,
  app: AppId,
  version: number,
  { files, definition }: DraftSource
): Promise<Release> => {
  const reads = appCodeAndTestFiles(Object.fromEntries(files));
  const key = await sha256Hex(
    canonicalJson([app, version, reads, definitionText(definition)])
  );
  const kept = sealedDrafts.get(key);
  if (kept !== undefined) {
    return await kept;
  }
  const sealing = (async () => {
    const draft = await sealDraftRelease(
      env,
      { app, version },
      files,
      definition
    );
    return await loadDraftRelease(
      { app, version },
      draft,
      async (sha256) =>
        await Promise.resolve(
          draft.artifacts.find((artifact) => artifact.sha256 === sha256)?.bytes
        )
    );
  })();
  sealedDrafts.set(key, sealing);
  if (sealedDrafts.size > sealedMax) {
    const [oldest] = sealedDrafts.keys();
    if (oldest !== undefined) {
      sealedDrafts.delete(oldest);
    }
  }
  try {
    return await sealing;
  } catch (error) {
    sealedDrafts.delete(key);
    throw error;
  }
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
  draft: Draft
): Promise<PageModules | null> => {
  const version = (draft.base ?? 0) + 1;
  const source = await draftSource(env, app, draft);
  if (source === null) {
    return null;
  }
  const release = await sealed(env, app, version, source);
  const generated = await generateModules(
    release.app,
    serverFunctionsIn(source.files)
  );
  return pageModulesOf(generated) ?? null;
};

/**
 * What `by`'s draft of `app` in their chat `chatId` runs on now: only
 * while they build the App and it isn't archived, and only for a chat of
 * their own (their Workspace object knows no one else's). The draft that
 * changes nothing previews the App's latest version, as its page shows it.
 */
export const draftRunOf = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  app: AppId,
  chatId: ChatId,
  /** The Workspace object the chat is in: the person's own, unless the
   * chat's agent names another it runs in (agent-builds.ts). */
  workspaceId: WorkspaceId = personalWorkspaceId(by.userId)
): Promise<DraftRun> => {
  await editableApp(env, by, app);
  const { draft, seed } = await workspace(env, workspaceId).previewRun(
    chatId,
    by.userId,
    app
  );
  const source = await draftSource(env, app, draft);
  // The draft that holds nothing previews the App's latest version, so a
  // draft to preview always has a definition.
  if (source === null) {
    throw appErrors.create("app.not_running");
  }
  const release = await sealed(env, app, (draft.base ?? 0) + 1, source);
  return {
    app,
    chatId,
    workspaceId,
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
    const roles = await operationRoles(env, { userId, role }, app);
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
 * The preview's throwaway store for `userId`'s `run`, its tables those of
 * the draft's schema: none for a draft without tables.
 * Held again (and its tables made, which changes nothing the second time)
 * at most every `holdAgainMs` per isolate, well within the day it keeps
 * what it holds, so a store in use never empties under its preview.
 */
const draftStore = async (
  env: Env,
  userId: string,
  run: DraftRun
): Promise<OpenStore> => {
  const { release } = run;
  if (!needsStore(release)) {
    return noStore();
  }
  const id = storeIdSchema.parse(
    `throwaway-${await sha256Hex(
      canonicalJson([
        userId,
        run.chatId,
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
  // Kept with the chat before it is first touched, so dropping the draft,
  // deleting the chat or removing or erasing its person empties it at
  // once; one emptied so refuses this hold, and every call after.
  await workspace(env, run.workspaceId).keepPreviewStore(
    run.chatId,
    userId,
    run.app,
    { storeId: id, seed: run.seed, revision: run.revision }
  );
  await holdThrowawayStore(env, id, now + throwawayStoreMs);
  // A store made for this schema alone: applied again, it changes nothing.
  await store.applySchema({
    manifest: manifestText(release.app.schema),
    ids: run.ids,
    answers: release.app.answers ?? [],
    actor: { type: "person", userId },
  });
  heldStores.set(id, now);
  return store;
};

/**
 * `run`'s release as the operation host runs it: each isolate tailed for
 * the chat's preview alone, so what the draft's code writes with
 * `console` reaches the agent's next check of this revision
 * (server-logs.ts), as data.
 */
const hosted = (env: Env, run: DraftRun): ReturnType<typeof hostedRelease> =>
  hostedRelease(env, run.release, (method) =>
    exports.AppTail({
      props: {
        app: run.app,
        version: null,
        preview: {
          workspaceId: run.workspaceId,
          chatId: run.chatId,
          revision: run.revision,
        },
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
  by: Pick<Identity, "userId">,
  run: DraftRun,
  request: unknown,
  result: OperationResult,
  thrown: string | undefined
): Promise<void> => {
  if (!run.own) {
    return;
  }
  await workspace(env, run.workspaceId).previewCalled(
    run.chatId,
    by.userId,
    run.app,
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
const answerOf = (result: OperationResult, run?: DraftRun): FunctionAnswer => ({
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
    throw operationErrors.create("contract.invalid_request");
  }
  return call;
};

/**
 * What a preview answers `call` of a workflow reference's query, which
 * reads runs through the App's binding of the workflow, a preview has
 * none of: no run (`run` answers `null`), none it may start (`canStart`
 * answers `false`), so a page built on `useWorkflow` shows as it does
 * before its first start; any other query `resource.unavailable`. The
 * draft must declare the workflow, and the arguments be the query's.
 */
const draftWorkflowQuery = (
  release: Release,
  call: FunctionRequest
): OperationResult => {
  const query = workflowQueryOf(release, call.reference);
  if (query.name !== "run" && query.name !== "canStart") {
    throw operationErrors.create("resource.unavailable");
  }
  checkedValue(query.args, call.args, "contract.invalid_args");
  return { ok: true, value: query.name === "run" ? null : false };
};

/** `call` of one of the draft's own functions, on `store`. */
const operationOf = async (
  env: Env,
  by: Pick<Identity, "userId">,
  run: DraftRun,
  store: OpenStore,
  call: FunctionRequest,
  { observeReads, ...made }: DraftCall & Pick<DraftCallOptions, "observeReads">
): Promise<OperationResult> => {
  const path = publicOperationOf(run.release, call.reference);
  const invocation = invocationOf(env, by, run, store, made);
  const observe =
    observeReads === undefined
      ? undefined
      : (readSet: Record<string, number>) => {
          observeReads(store.id, readSet);
        };
  const reference = { path, kind: call.reference.kind };
  return await callOperation(
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
  let result: OperationResult;
  try {
    const call = draftCallOf(request, options);
    const authorize = builderGate(env, by.userId, run.app);
    const gate = async (): Promise<void> => {
      await authorize();
      if (Date.now() >= deadline) {
        throw operationErrors.create("function.deadline_exceeded");
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
    const store = await draftStore(env, by.userId, run);
    result = await operationOf(env, by, run, store, call, {
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
    await reported(env, by, run, request, result, thrown);
  } else if (thrown !== undefined) {
    told(thrown);
  }
  return answerOf(result, run);
};

/**
 * `request`, a page's call as its text, run on `by`'s draft of `app` in
 * their chat `chatId` as it is now (`draftRunOf`, `callDraft`): a draft
 * whose code doesn't seal answers why, as a call answers a refusal, for
 * its page to show while it is being fixed; the agent's check of the
 * draft builds it and hears why itself.
 */
export const callDraftOn = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">,
  { app, chatId }: { app: AppId; chatId: ChatId },
  request: unknown,
  options: DraftCallOptions
): Promise<FunctionAnswer> => {
  let run: DraftRun;
  try {
    run = await draftRunOf(env, by, app, chatId);
  } catch (error) {
    if (!(isExpectedError(error) && draftSealFailures.has(error.code))) {
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
): Promise<{ result: OperationResult; reached: boolean; effects: number }> => {
  const requestId = crypto.randomUUID();
  let reached = false;
  let effects = 0;
  let thrown: string | undefined;
  let result: OperationResult;
  try {
    const path = publicOperationOf(run.release, call.reference);
    await builderGate(env, by.userId, run.app)();
    const store = await draftStore(env, by.userId, run);
    const invocation = invocationOf(env, by, run, store, {
      requestId,
      deadline,
      draftFailure: (message) => {
        thrown = message;
      },
    });
    reached = true;
    result = await callOperation(
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
  await reported(env, by, run, JSON.stringify(call), result, thrown);
  return { result, reached, effects };
};
