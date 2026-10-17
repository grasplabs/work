import {
  contractFingerprint,
  declaredWorkflows,
  schemaFromDescriptor,
  workflowQueries,
} from "@grasp-os/sdk/host";
import type { WorkflowQueryName } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import type { OperationResult } from "@grasp-os/shared/operations";
import {
  liveWindowMaxItems,
  queryMaxResults,
} from "@grasp-os/shared/store-limits";
import { dataErrors } from "@grasp-os/shared/stores";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Release } from "./app-releases.ts";
import {
  appWorkflowBindings,
  workflowResourceRuns,
  workflowStartReceipts,
} from "./db/core/schema.ts";
import { windowPages } from "./query-windows.ts";

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
// - A run's or decision's ID as an oracle: `history` and `decision`
//   refuse alike, whatever the ID; there are no decisions of independent
//   runs yet, nor a projection of their journal for an App.
// - Arguments or answers outside the contract: arguments are checked by
//   the generated descriptor, answers too before they leave, projected
//   field by field: a run row carries no input, output or error.
// - Cost: one person's runs of a workflow are read through
//   `workflow_resource_runs_principal_idx` (workflow ID, principal,
//   created at, ID), never a scan of everyone's runs of it.

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
      // Nothing of a run can be followed through an App yet: its history
      // refuses (GRA-695) and nothing keeps it fresh (GRA-696).
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
      // A run's journal isn't projected for an App yet: refused for every
      // run, the caller's own and anyone else's alike.
      throw workflowResourceErrors.create("workflow.history_unavailable");
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
 * page's worth of records past that. Only `runs` pages through records;
 * `decisions` answers its empty inbox, and anything else isn't paginated.
 */
export const readWorkflowWindow = async (
  env: Env,
  caller: WorkflowQueryCaller,
  query: ResolvedWorkflowQuery,
  input: unknown,
  window: {
    readonly extent: number;
    readonly charge: (pages: number, whole: number) => Promise<void>;
  }
): Promise<OperationResult> => {
  if (query.name !== "runs" && query.name !== "decisions") {
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
  const page = await runsPage(env, caller, workflowId, {
    ...(typeof args.status === "string" ? { status: args.status } : {}),
    size: Math.min(Math.max(window.extent, 1), liveWindowMaxItems),
  });
  const owed =
    Math.ceil(page.items.length / queryMaxResults) - windowPages(window.extent);
  if (owed > 0) {
    await window.charge(owed, windowPages(window.extent) + owed);
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
