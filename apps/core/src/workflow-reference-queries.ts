import {
  contractFingerprint,
  declaredWorkflows,
  schemaFromDescriptor,
  workflowQueries,
} from "@grasp-os/sdk/host";
import type { WorkflowPin, WorkflowQueryName } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  categoryOf,
  isRetryableCode,
  operationErrors,
} from "@grasp-os/shared/operations";
import type { OperationResult } from "@grasp-os/shared/operations";
import {
  liveWindowMaxItems,
  queryMaxResults,
} from "@grasp-os/shared/store-limits";
import { dataErrors } from "@grasp-os/shared/stores";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type { RunHistoryEntry } from "@grasp-os/shared/workflows";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Release } from "./app-releases.ts";
import {
  appWorkflowBindings,
  workflowResourceRuns,
  workflowStartReceipts,
} from "./db/core/schema.ts";
import { windowPages } from "./query-windows.ts";
import { loadWorkflowBuild } from "./workflow-builds.ts";
import { historyEntries } from "./workflows/history.ts";
import { detailsRemoved } from "./workflows/retention.ts";

// A workflow reference's ordinary queries, as an App's screens read them
// (spec 10.7.2): `workflows.<alias>.queries.runs`, `.history`,
// `.decisions` and `.decision`, whose arguments and answers the SDK
// declares (workflow-queries.ts) and generates into `#grasp`. They aren't
// the App's functions: core serves them itself, from the independent
// workflow the App's binding of `<alias>` names now. Threat model (also on
// GRA-673), and how each is closed:
//
// - A reference made up, or of another release or contract: it resolves
//   only against the App's current sealed release, its declared workflow
//   and what its seal resolved, rebuilt into the generated queries, and
//   must name exactly that release, kind and fingerprint.
// - Reading another person's runs, or another App's: `runs` lists only
//   runs whose start receipt says this App started them for the caller,
//   of the workflow its active binding of the alias names, read here and
//   never from the request. A removed binding answers nothing.
// - Existence leaked through counts or cursors: pages are keyset pages
//   over the caller's own runs, and a cursor is a place in that list.
// - A run's ID as an oracle: `history` reads a run only when its start
//   receipt says this App started it for the caller, it acts for them,
//   and it is of exactly the workflow version the release's seal resolved
//   the alias to (`pinned`, contracts.json); any other run, a rebound
//   alias's included, is refused as one that doesn't exist
//   (`workflow.run_unavailable`), before anything of it is read. A
//   release that pinned nothing reads no run's history, nor one whose
//   alias the App has since bound to another workflow: as `runs` lists
//   the binding's runs, history is read only while the binding names the
//   pinned workflow. A version rebound without a seal leaves its new
//   runs' history unread until the next seal pins it.
// - What a history tells: metadata only, from the engine's journal
//   (workflows/history.ts), which holds no input, output or payload. A
//   failure's message, the workflow's own text, never leaves: a code the
//   platform defines as it is, any other as `workflow.step_failed`, so no
//   code can be made of what the run read. A task is named
//   only by an ID the version's sealed build declares.
// - A decision's ID as an oracle: `decision` refuses alike, whatever the
//   ID; there are no decisions of independent runs yet.
// - Arguments or answers outside the contract: arguments are checked by
//   the generated descriptor, answers too before they leave, projected
//   field by field: a run row carries no input, output or error.
// - Cost: one person's runs of a workflow are read through
//   `workflow_resource_runs_principal_idx` (workflow ID, principal,
//   created at, ID), never a scan of everyone's runs of it; a history
//   page reads its run by ID and at most `historyEntries`' bounded reads
//   of its journal.

const queryPath =
  /^workflows\.(?<alias>[A-Za-z][A-Za-z0-9_]{0,63})\.queries\.(?<name>runs|history|decisions|decision)$/u;

/** Whether `contractId` names one of a workflow reference's queries. */
export const isWorkflowQueryPath = (contractId: string): boolean =>
  queryPath.test(contractId);

const names: ReadonlySet<string> = new Set([
  "runs",
  "history",
  "decisions",
  "decision",
]);

const toName = (name: string): WorkflowQueryName => {
  if (!names.has(name)) {
    throw operationErrors.create("operation.not_found");
  }
  // SAFETY: checked against the query names just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return name as WorkflowQueryName;
};

/** A workflow query a reference resolved to, in a release. */
export interface ResolvedWorkflowQuery {
  readonly alias: string;
  readonly name: WorkflowQueryName;
  readonly args: unknown;
  readonly returns: unknown;
  /** The workflow version the release's seal resolved the alias to. */
  readonly pinned: WorkflowPin | undefined;
}

/**
 * The workflow query `reference` names in `release`, checked as a function
 * reference is: one the release generates, of its exact App and version,
 * kind and fingerprint (`operation.not_found`, `operation.kind_mismatch`,
 * `version.mismatch`).
 */
export const workflowQueryOf = async (
  release: Release,
  reference: {
    readonly resourceId: string;
    readonly resourceVersion: number;
    readonly contractId: string;
    readonly fingerprint: string;
    readonly kind: string;
  }
): Promise<ResolvedWorkflowQuery> => {
  const match = queryPath.exec(reference.contractId)?.groups;
  const alias = match?.alias ?? "";
  const bound = declaredWorkflows(release.app, release.workflows).find(
    (workflow) => workflow.alias === alias
  );
  const name = match?.name;
  const operation =
    bound === undefined || name === undefined
      ? undefined
      : workflowQueries(bound)[toName(name)];
  if (operation === undefined || name === undefined) {
    throw operationErrors.create("operation.not_found");
  }
  if (reference.kind !== operation.kind) {
    throw operationErrors.create("operation.kind_mismatch");
  }
  if (
    reference.resourceId !== release.manifest.resourceId ||
    reference.resourceVersion !== release.manifest.resourceVersion ||
    reference.fingerprint !== (await contractFingerprint(operation))
  ) {
    throw versionErrors.create("version.mismatch");
  }
  return {
    alias,
    name: toName(name),
    args: operation.args,
    returns: operation.returns,
    pinned: bound?.pinned,
  };
};

/** Who reads a workflow query, and through which App. */
export interface WorkflowQueryCaller {
  readonly app: string;
  readonly userId: string;
}

/** A run's status as a screen sees it, from what core keeps of it. */
const publicStatus = {
  starting: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/** The row statuses each public status is, for a status filter. */
const rowStatuses: Readonly<Record<string, readonly string[]>> = {
  queued: ["starting"],
  running: ["running"],
  completed: ["completed"],
  failed: ["failed"],
  cancelled: ["cancelled"],
  waiting: [],
  paused: [],
  compensating: [],
};

/** The most runs one page holds, and its size unless a page says. */
const maxPageSize = 100;
const defaultPageSize = 50;

const cursorPattern = /^(?<at>\d{1,16}):(?<id>[\w-]{1,128})$/u;

/** A place in a person's list of runs, after the run it names. */
const placeOf = (cursor: unknown): { at: number; id: string } | undefined => {
  if (cursor === null || cursor === undefined) {
    return undefined;
  }
  const groups =
    typeof cursor === "string" ? cursorPattern.exec(cursor)?.groups : undefined;
  if (groups?.at === undefined || groups.id === undefined) {
    throw dataErrors.create("data.invalid_cursor");
  }
  return { at: Number(groups.at), id: groups.id };
};

/** The workflow the App's binding of `alias` names now, or none. */
const boundWorkflowId = async (
  env: Env,
  app: string,
  alias: string
): Promise<string> => {
  const binding = await drizzle(env.DB)
    .select({ workflowId: appWorkflowBindings.workflowResourceId })
    .from(appWorkflowBindings)
    .where(
      and(
        eq(appWorkflowBindings.appId, app),
        eq(appWorkflowBindings.alias, alias),
        eq(appWorkflowBindings.status, "active")
      )
    )
    .get();
  if (binding === undefined) {
    throw operationErrors.create("resource.unavailable");
  }
  return binding.workflowId;
};

/** One page of the caller's runs of `workflowId` through `app`. */
const runsPage = async (
  env: Env,
  caller: WorkflowQueryCaller,
  workflowId: string,
  options: { status?: string; size: number; after?: { at: number; id: string } }
): Promise<{ items: Json[]; hasMore: boolean; last?: string }> => {
  const statuses =
    options.status === undefined
      ? undefined
      : (rowStatuses[options.status] ?? []);
  if (statuses !== undefined && statuses.length === 0) {
    return { items: [], hasMore: false };
  }
  const { after } = options;
  const rows = await drizzle(env.DB)
    .select({
      id: workflowResourceRuns.id,
      workflowId: workflowResourceRuns.workflowResourceId,
      version: workflowResourceRuns.version,
      manifestHash: workflowResourceRuns.manifestHash,
      status: workflowResourceRuns.status,
      createdAt: workflowResourceRuns.createdAt,
      endedAt: workflowResourceRuns.endedAt,
    })
    .from(workflowResourceRuns)
    .innerJoin(
      workflowStartReceipts,
      eq(workflowStartReceipts.id, workflowResourceRuns.id)
    )
    .where(
      and(
        eq(workflowResourceRuns.workflowResourceId, workflowId),
        eq(workflowStartReceipts.invokerType, "app"),
        eq(workflowStartReceipts.invokerId, caller.app),
        eq(workflowStartReceipts.principalId, caller.userId),
        eq(workflowResourceRuns.principalId, caller.userId),
        ...(statuses === undefined
          ? []
          : [
              or(
                ...statuses.map((status) =>
                  eq(
                    workflowResourceRuns.status,
                    // SAFETY: one of the row's own statuses (`rowStatuses`).
                    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
                    status as "starting"
                  )
                )
              ),
            ]),
        ...(after === undefined
          ? []
          : [
              or(
                lt(workflowResourceRuns.createdAt, new Date(after.at)),
                and(
                  eq(workflowResourceRuns.createdAt, new Date(after.at)),
                  lt(workflowResourceRuns.id, after.id)
                )
              ),
            ])
      )
    )
    .orderBy(
      desc(workflowResourceRuns.createdAt),
      desc(workflowResourceRuns.id)
    )
    .limit(options.size + 1);
  const shown = rows.slice(0, options.size);
  const items: Json[] = shown.map((row) => {
    const status = publicStatus[row.status];
    return {
      run: {
        runId: row.id,
        workflowId: row.workflowId,
        workflowVersion: row.version,
        manifestHash: row.manifestHash,
      },
      status,
      // Admitted is when it was started; a queued run hasn't begun.
      startedAt: status === "queued" ? null : row.createdAt.getTime(),
      finishedAt: row.endedAt === null ? null : row.endedAt.getTime(),
      // Nothing keeps a run fresh through an App yet (GRA-696), and its
      // history is read only for the version the release pins.
      canWatch: false,
    };
  });
  const lastRow = shown.at(-1);
  return {
    items,
    hasMore: rows.length > options.size,
    ...(lastRow === undefined
      ? {}
      : { last: `${lastRow.createdAt.getTime()}:${lastRow.id}` }),
  };
};

/** An engine event ID, as `historyEntries` writes one: plain digits. */
const sequencePattern = /^\d{1,16}$/u;

/** Where a history page starts: after the event `cursor` names, or the start. */
const sequenceOf = (cursor: unknown): number => {
  if (cursor === null || cursor === undefined) {
    return 0;
  }
  const sequence =
    typeof cursor === "string" && sequencePattern.test(cursor)
      ? Number(cursor)
      : Number.NaN;
  // Any event ID the engine can write: a safe integer, so it reads back
  // exactly.
  if (!Number.isSafeInteger(sequence)) {
    throw dataErrors.create("data.invalid_cursor");
  }
  return sequence;
};

/**
 * Run `runId`, when the caller may read its history through `app`: one
 * this App started for them (its receipt), acting for them, of exactly
 * `pinned`, whose workflow the App's binding still names (`bound`), as
 * `runs` lists it: rebound to another workflow, nothing is read until a
 * seal pins it. Anything else, an unknown ID included, is refused alike.
 */
const historyRunOf = async (
  env: Env,
  caller: WorkflowQueryCaller,
  { pinned, bound }: { pinned: WorkflowPin | undefined; bound: string },
  runId: string
) => {
  const refused = workflowResourceErrors.create("workflow.run_unavailable");
  if (pinned === undefined || pinned.workflowId !== bound) {
    throw refused;
  }
  const row = await drizzle(env.DB)
    .select({
      id: workflowResourceRuns.id,
      manifestHash: workflowResourceRuns.manifestHash,
      endedAt: workflowResourceRuns.endedAt,
      // The retention sweep marks a run's receipt (resource-runs.ts).
      detailsRemovedAt: workflowStartReceipts.detailsRemovedAt,
    })
    .from(workflowResourceRuns)
    .innerJoin(
      workflowStartReceipts,
      eq(workflowStartReceipts.id, workflowResourceRuns.id)
    )
    .where(
      and(
        eq(workflowResourceRuns.id, runId),
        eq(workflowResourceRuns.workflowResourceId, pinned.workflowId),
        eq(workflowResourceRuns.version, pinned.version),
        eq(workflowResourceRuns.principalId, caller.userId),
        eq(workflowStartReceipts.invokerType, "app"),
        eq(workflowStartReceipts.invokerId, caller.app),
        eq(workflowStartReceipts.principalId, caller.userId)
      )
    )
    .get();
  if (row === undefined) {
    throw refused;
  }
  return row;
};

/** A step of the generated code's own: its kind, then its task's ID. */
const taskStep = /^(?:task|enter|leave):(?<id>[a-z0-9][a-z0-9-]{0,63})$/u;

/** A history entry's error, as a screen reads one: never the workflow's text. */
const errorRow = (error: { code: string; message: string }): Json => ({
  code: error.code,
  message: error.message,
  category: categoryOf(error.code),
  retryable: isRetryableCode(error.code),
  requestId: null,
});

/**
 * Entry `entry` as a history row of the SDK's (workflow-queries.ts); none
 * for what a row doesn't tell: an unreadable event, a compensation's
 * attempt about to be tried again.
 */
const historyRowOf = (entry: RunHistoryEntry): Json | undefined => {
  const common = {
    id: entry.id,
    sequence: entry.sequence,
    taskId: entry.taskId,
    at: entry.at,
  };
  switch (entry.kind) {
    case "lifecycle": {
      return entry.status === "compensating"
        ? {
            ...common,
            kind: "lifecycle",
            status: "compensating",
            cause: entry.cause,
            activity: entry.activity,
          }
        : { ...common, kind: "lifecycle", status: entry.status };
    }
    case "step": {
      return entry.state === "failed"
        ? {
            ...common,
            kind: "step",
            state: "failed",
            attempt: entry.attempt,
            error: errorRow(entry.error),
          }
        : {
            ...common,
            kind: "step",
            state: entry.state,
            attempt: entry.attempt,
          };
    }
    case "wait": {
      return {
        ...common,
        kind: "wait",
        waitId: entry.waitId,
        // An unknown outcome blocks the step as a held one does.
        waitKind:
          entry.waitKind === "outcome_unknown" ? "blocked" : entry.waitKind,
        state: entry.state,
        deadline: entry.deadline,
      };
    }
    case "compensation": {
      if (entry.state === "failed") {
        return {
          ...common,
          kind: "compensation",
          state: "failed",
          attempt: entry.attempt,
          error: errorRow(entry.error),
        };
      }
      return entry.state === "retrying"
        ? undefined
        : {
            ...common,
            kind: "compensation",
            state: entry.state,
            attempt: entry.attempt,
          };
    }
    case "unreadable": {
      return undefined;
    }
    default: {
      return entry satisfies never;
    }
  }
};

/** The task IDs version `pinned`'s sealed build declares; none if unreadable. */
const declaredTasks = async (
  env: Env,
  pinned: WorkflowPin,
  manifestHash: string
): Promise<ReadonlySet<string> | undefined> => {
  try {
    const { tasks } = await loadWorkflowBuild(
      env,
      pinned.workflowId,
      pinned.version,
      manifestHash
    );
    return new Set(tasks.map(({ id }) => id));
  } catch (error) {
    // A build that is gone or no longer verifies is the platform's fault,
    // logged where it loads (workflow-builds.ts): its history tells
    // nothing rather than failing the caller's page.
    log.error("workflow.history_build_unreadable", {
      workflowId: pinned.workflowId,
      version: pinned.version,
      ...errorFields(error),
    });
    return undefined;
  }
};

/**
 * Up to `size` rows of run `runId`'s history after the event `after`, for
 * `caller` through the release's pin while the binding names `bound`,
 * oldest first.
 */
const historyPage = async (
  env: Env,
  caller: WorkflowQueryCaller,
  { query, bound }: { query: ResolvedWorkflowQuery; bound: string },
  runId: string,
  { size, cursor }: { size: number; cursor: unknown }
): Promise<{ items: Json[]; nextCursor: string | null; hasMore: boolean }> => {
  const nothing = { items: [], nextCursor: null, hasMore: false };
  const run = await historyRunOf(
    env,
    caller,
    { pinned: query.pinned, bound },
    runId
  );
  // Read only once the run is the caller's: a cursor tells nothing of a
  // run they can't read.
  const after = sequenceOf(cursor);
  if (detailsRemoved(env, run) || query.pinned === undefined) {
    return nothing;
  }
  const declared = await declaredTasks(env, query.pinned, run.manifestHash);
  if (declared === undefined) {
    return nothing;
  }
  const page = await historyEntries(
    env,
    run.id,
    { after, pageSize: size },
    {
      // Nobody reads a failure's own message through an App.
      sees: false,
      taskOf: (engineStep) => {
        const id = taskStep.exec(engineStep)?.groups?.id;
        return id !== undefined && declared.has(id) ? id : null;
      },
    }
  );
  return {
    items: page.items.flatMap((entry) => historyRowOf(entry) ?? []),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
};

/**
 * The most pages one window of a run's history reads: enough for the
 * largest window in pages of ten rows, as an App's own windows
 * (query-windows.ts). A journal sparser than that, mostly bookkeeping no
 * row tells, has its window refused (`operation.read_limit`) rather than
 * cut short, so Load More never stalls on the same records.
 */
const historyWindowMaxPages = liveWindowMaxItems / 10;

/**
 * Up to `size` rows of run `runId`'s history from its start, as a live
 * window reads it: page after page, each from the cursor the one before
 * ended at, until the window is full or the history ends. The caller paid
 * `windowPages(extent)` pages; `charge` is asked for each page past them,
 * and `gate`, the call's access check, before each page after the first,
 * so access lost while the window reads stops it.
 */
const historyWindow = async (
  env: Env,
  caller: WorkflowQueryCaller,
  from: { query: ResolvedWorkflowQuery; bound: string },
  runId: string,
  {
    size,
    extent,
    charge,
    gate,
  }: {
    size: number;
    extent: number;
    charge: (pages: number, whole: number) => Promise<void>;
    gate: () => Promise<void>;
  }
): Promise<{ items: Json[]; hasMore: boolean }> => {
  const paid = windowPages(extent);
  const items: Json[] = [];
  let cursor: string | null = null;
  for (let pages = 1; pages <= historyWindowMaxPages; pages += 1) {
    if (pages > 1) {
      // oxlint-disable-next-line no-await-in-loop -- access again before each further page
      await gate();
    }
    if (pages > paid) {
      // oxlint-disable-next-line no-await-in-loop -- a page's charge before its read
      await charge(1, pages);
    }
    // oxlint-disable-next-line no-await-in-loop -- each page goes on from the one before
    const page = await historyPage(env, caller, from, runId, {
      size: Math.min(size - items.length, queryMaxResults),
      cursor,
    });
    items.push(...page.items);
    if (!page.hasMore || page.nextCursor === null) {
      return { items, hasMore: false };
    }
    if (items.length >= size) {
      return { items, hasMore: true };
    }
    cursor = page.nextCursor;
  }
  throw operationErrors.create("operation.read_limit");
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `value` checked by `descriptor`, normalized: the arguments a caller sent
 * (`contract.invalid_args` otherwise) or an answer about to leave, which
 * must already be in the form its descriptor gives it.
 */
const checked = (
  descriptor: unknown,
  value: unknown,
  code: "contract.invalid_args" | "contract.invalid_return"
): Json => {
  const schema = schemaFromDescriptor(JSON.stringify(descriptor));
  const result = schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    throw operationErrors.create(code);
  }
  // SAFETY: what the descriptor admits is JSON.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const normalized = result.value as Json;
  if (
    code === "contract.invalid_return" &&
    canonicalText(normalized) !== canonicalText(value)
  ) {
    throw operationErrors.create(code);
  }
  return normalized;
};

/** The run checked arguments name. */
const runIdOf = (args: Readonly<Record<string, Json | undefined>>): string => {
  if (typeof args.runId !== "string") {
    throw operationErrors.create("contract.invalid_args");
  }
  return args.runId;
};

/** What a query answers, before its descriptor checks it. */
const answerOf = async (
  env: Env,
  caller: WorkflowQueryCaller,
  query: ResolvedWorkflowQuery,
  args: Readonly<Record<string, Json | undefined>>
): Promise<Json> => {
  // The binding in force, for every query: none, and nothing is read.
  const workflowId = await boundWorkflowId(env, caller.app, query.alias);
  switch (query.name) {
    case "runs": {
      const pagination = isObject(args.pagination) ? args.pagination : {};
      const size =
        typeof pagination.pageSize === "number"
          ? Math.min(pagination.pageSize, maxPageSize)
          : defaultPageSize;
      const after = placeOf(pagination.cursor);
      const page = await runsPage(env, caller, workflowId, {
        ...(typeof args.status === "string" ? { status: args.status } : {}),
        size,
        ...(after === undefined ? {} : { after }),
      });
      return page.hasMore && page.last !== undefined
        ? { items: page.items, nextCursor: page.last, hasMore: true }
        : { items: page.items, nextCursor: null, hasMore: false };
    }
    case "decisions": {
      // No decision of an independent run exists yet: the inbox is empty.
      return { items: [], nextCursor: null, hasMore: false };
    }
    case "decision": {
      // Whatever the ID: an unknown decision and a denied one alike.
      throw workflowResourceErrors.create("workflow.decision_unavailable");
    }
    case "history": {
      const pagination = isObject(args.pagination) ? args.pagination : {};
      return await historyPage(
        env,
        caller,
        { query, bound: workflowId },
        runIdOf(args),
        {
          size:
            typeof pagination.pageSize === "number"
              ? Math.min(pagination.pageSize, maxPageSize)
              : defaultPageSize,
          cursor: pagination.cursor,
        }
      );
    }
    default: {
      return query.name satisfies never;
    }
  }
};

/**
 * Answers workflow query `query` for `caller` with `input`, as the App's
 * own queries answer: `{ ok, value }`, or a refusal thrown. Its arguments
 * and answer are checked by the generated descriptors.
 */
export const callWorkflowQuery = async (
  env: Env,
  caller: WorkflowQueryCaller,
  query: ResolvedWorkflowQuery,
  input: unknown
): Promise<OperationResult> => {
  const args = checked(query.args, input, "contract.invalid_args");
  if (!isObject(args)) {
    throw operationErrors.create("contract.invalid_args");
  }
  const answer = await answerOf(env, caller, query, args);
  return {
    ok: true,
    value: checked(query.returns, answer, "contract.invalid_return"),
  };
};

/**
 * Reads a paginated workflow query's window of `extent` records for
 * `caller`, as a live list reads one (query-windows.ts): its records and
 * whether more follow, from one read, charged as a window's pages are:
 * the caller paid `windowPages(extent)`, and `charge` is asked for any
 * page's worth of records past that. `runs` and `history` page through
 * records; `decisions` answers its empty inbox, and `decision` isn't
 * paginated.
 */
export const readWorkflowWindow = async (
  env: Env,
  caller: WorkflowQueryCaller,
  query: ResolvedWorkflowQuery,
  input: unknown,
  window: {
    readonly extent: number;
    readonly charge: (pages: number, whole: number) => Promise<void>;
    /** The call's access check, passed again before each further page. */
    readonly gate: () => Promise<void>;
  }
): Promise<OperationResult> => {
  if (query.name === "decision") {
    throw operationErrors.create("contract.not_paginated");
  }
  if (!isObject(input) || Object.hasOwn(input, "pagination")) {
    // `pagination` is core's to supply: a caller never pages a window.
    throw operationErrors.create("contract.invalid_args");
  }
  const args = checked(
    query.args,
    { ...input, pagination: {} },
    "contract.invalid_args"
  );
  if (!isObject(args)) {
    throw operationErrors.create("contract.invalid_args");
  }
  const workflowId = await boundWorkflowId(env, caller.app, query.alias);
  if (query.name === "decisions") {
    return { ok: true, value: { items: [], hasMore: false } };
  }
  const size = Math.min(Math.max(window.extent, 1), liveWindowMaxItems);
  let page: { items: Json[]; hasMore: boolean };
  if (query.name === "history") {
    page = await historyWindow(
      env,
      caller,
      { query, bound: workflowId },
      runIdOf(args),
      {
        size,
        extent: window.extent,
        charge: window.charge,
        gate: window.gate,
      }
    );
  } else {
    page = await runsPage(env, caller, workflowId, {
      ...(typeof args.status === "string" ? { status: args.status } : {}),
      size,
    });
    const owed =
      Math.ceil(page.items.length / queryMaxResults) -
      windowPages(window.extent);
    if (owed > 0) {
      await window.charge(owed, windowPages(window.extent) + owed);
    }
  }
  // Each record as the query's own pages carry it: checked in pages of
  // the most a page holds, since a window holds more than one page.
  const items: Json[] = [];
  for (let start = 0; start < page.items.length; start += queryMaxResults) {
    const checkedPage = checked(
      query.returns,
      {
        items: page.items.slice(start, start + queryMaxResults),
        nextCursor: null,
        hasMore: false,
      },
      "contract.invalid_return"
    );
    const checkedItems: unknown = isObject(checkedPage)
      ? checkedPage.items
      : undefined;
    if (Array.isArray(checkedItems)) {
      const list: readonly Json[] = checkedItems;
      items.push(...list);
    }
  }
  return { ok: true, value: { items, hasMore: page.hasMore } };
};
