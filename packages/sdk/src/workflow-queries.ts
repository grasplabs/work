import type { OperationManifest } from "./app.ts";
import type { BoundWorkflow } from "./generate.ts";
import { ValueDefinitionError } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { descriptorOf, schemaOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";
import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "./values.ts";

// The ordinary queries a generated workflow reference exposes (spec
// 10.7.2): `workflows.<wf>.queries.runs`, `.history`, `.decisions` and
// `.decision`. Public query references like any of the App's, for
// `useQuery` and `usePaginatedQuery`: never commands, and never aliases
// for `useWorkflow`. Their arguments and answers are declared here once,
// as schemas, so their descriptors and the types generated from them say
// the same; the host serves each against the binding in force, checks
// every item's visibility, and answers only what these declare.
//
// `decisions` and `decision` exist only for a workflow that declares
// decisions: one that asks nobody has no inbox to read. History rows of
// an event or a decision likewise exist only where there are any, each
// keyed by its declared literal.

/** The names of the queries a workflow reference exposes. */
export type WorkflowQueryName = "runs" | "history" | "decisions" | "decision";

const idText = v.string().min(1).max(256);
const plainText = v.string().max(2000);

const runHandle = v.object({
  runId: idText,
  workflowId: idText,
  workflowVersion: v.number().integer().min(1),
  manifestHash: idText,
});

/** A run's status, as a screen sees it, compensation aside. */
const settledStatus = v.enum([
  "queued",
  "running",
  "waiting",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

const compensation = {
  status: v.literal("compensating"),
  cause: v.enum(["failure", "cancellation"]),
  activity: v.enum(["running", "waiting", "paused"]),
};

const runFields = {
  run: runHandle,
  startedAt: v.timestamp().nullable(),
  finishedAt: v.timestamp().nullable(),
  canWatch: v.boolean(),
};

/** One run in a list: no output, error or input (spec 10.7.2). */
const runRow = v.union(
  v.object({ ...runFields, status: settledStatus }),
  v.object({ ...runFields, ...compensation })
);

const sanitizedError = v.object({
  code: v.string().min(1).max(256),
  message: plainText,
  category: v.enum([
    "source",
    "contract",
    "domain",
    "authorization",
    "operational",
    "uncertain",
    "safety",
  ]),
  retryable: v.boolean(),
  requestId: idText.nullable(),
});

const historyFields = {
  id: idText,
  sequence: v.number().integer().min(0),
  taskId: v.string().min(1).max(1024).nullable(),
  at: v.timestamp(),
};

const attempt = v.number().integer().min(1);

/** `names` as an enum's values, or undefined for none. */
const enumOf = (names: readonly string[]): AnySchema | undefined => {
  const [first, ...rest] = names.toSorted();
  return first === undefined ? undefined : v.enum([first, ...rest]);
};

/**
 * One row of a run's history (spec 10.7.2): metadata only, never input,
 * output, reviewers or review bodies.
 */
const historyRow = (workflow: BoundWorkflow): AnySchema => {
  const rows: AnySchema[] = [
    v.object({
      ...historyFields,
      kind: v.literal("lifecycle"),
      status: settledStatus,
    }),
    v.object({
      ...historyFields,
      kind: v.literal("lifecycle"),
      ...compensation,
    }),
    v.object({
      ...historyFields,
      kind: v.literal("step"),
      state: v.enum(["started", "completed", "retrying"]),
      attempt,
    }),
    v.object({
      ...historyFields,
      kind: v.literal("step"),
      state: v.literal("failed"),
      attempt,
      error: sanitizedError,
    }),
    v.object({
      ...historyFields,
      kind: v.literal("wait"),
      waitId: idText,
      waitKind: v.enum(["timer", "event", "decision", "child", "blocked"]),
      state: v.enum(["opened", "closed"]),
      deadline: v.timestamp().nullable(),
    }),
    v.object({
      ...historyFields,
      kind: v.literal("compensation"),
      state: v.enum(["started", "completed"]),
      attempt,
    }),
    v.object({
      ...historyFields,
      kind: v.literal("compensation"),
      state: v.literal("failed"),
      attempt,
      error: sanitizedError,
    }),
  ];
  const events = enumOf(Object.keys(workflow.events));
  if (events !== undefined) {
    rows.push(
      v.object({
        ...historyFields,
        kind: v.literal("event"),
        eventId: idText,
        key: events,
        state: v.enum(["accepted", "consumed", "expired"]),
      })
    );
  }
  const decisions = enumOf(Object.keys(workflow.decisions));
  if (decisions !== undefined) {
    rows.push(
      v.object({
        ...historyFields,
        kind: v.literal("decision"),
        decisionId: idText,
        key: decisions,
        state: v.enum(["opened", "answered", "expired", "cancelled"]),
      })
    );
  }
  const [first, ...rest] = rows;
  if (first === undefined) {
    throw new TypeError("A history has rows.");
  }
  return v.union(first, ...rest);
};

/** A decision wait keyed `key`, as its run snapshot names it. */
const decisionWait = (key: string): AnySchema =>
  v.object({
    kind: v.literal("decision"),
    id: idText,
    taskId: v.string().min(1).max(1024),
    key: v.literal(key),
    title: v.string().max(200),
    openedAt: v.timestamp(),
    deadline: v.timestamp().nullable(),
    canRespond: v.boolean(),
  });

/** `descriptor`, a host-resolved one, as a checked schema. */
const schemaFrom = (descriptor: ValueDescriptor): AnySchema =>
  schemaOf(readDescriptor(descriptor, 1, { nodes: 0 }));

/** `items`, which has at least one. */
const nonEmpty = <Item>(items: readonly Item[]): [Item, ...Item[]] => {
  const [first, ...rest] = items;
  if (first === undefined) {
    throw new TypeError("At least one is needed.");
  }
  return [first, ...rest];
};

/** `members` as one union, or the one member alone. */
const unionOf = (members: readonly AnySchema[]): AnySchema => {
  const [first, ...rest] = members;
  if (first === undefined) {
    throw new TypeError("A union has members.");
  }
  return rest.length === 0 ? first : v.union(first, ...rest);
};

/** The schemas of `workflow`'s queries, by name. */
const querySchemas = (
  workflow: BoundWorkflow
): Partial<
  Record<WorkflowQueryName, { args: AnySchema; returns: AnySchema }>
> => {
  const keys = Object.keys(workflow.decisions).toSorted();
  const schemas: Partial<
    Record<WorkflowQueryName, { args: AnySchema; returns: AnySchema }>
  > = {
    runs: {
      args: v.object({
        status: v
          .enum([
            "queued",
            "running",
            "waiting",
            "paused",
            "compensating",
            "completed",
            "failed",
            "cancelled",
          ])
          .optional(),
        pagination: paginationOptionsValidator,
      }),
      returns: paginationResultValidator(runRow),
    },
    history: {
      args: v.object({ runId: idText, pagination: paginationOptionsValidator }),
      returns: paginationResultValidator(historyRow(workflow)),
    },
  };
  if (keys.length > 0) {
    schemas.decisions = {
      args: v.object({
        runId: idText.optional(),
        pagination: paginationOptionsValidator,
      }),
      returns: paginationResultValidator(
        unionOf(
          keys.map((key) =>
            v.object({ run: runHandle, wait: decisionWait(key) })
          )
        )
      ),
    };
    schemas.decision = {
      args: v.object({ runId: idText, decisionId: idText }),
      // Null for an authorized decision that is closed or unavailable.
      // Null for an authorized decision that is closed or unavailable:
      // the union's own null, so 64 decisions still fit a union.
      returns: v
        .union(
          ...nonEmpty(
            keys.map((key) => {
              const declared = workflow.decisions[key];
              if (declared === undefined) {
                throw new TypeError(`No decision ${key}`);
              }
              return v.object({
                key: v.literal(key),
                wait: decisionWait(key),
                prompt: plainText,
                context: schemaFrom(declared.context),
                canRespond: v.boolean(),
              });
            })
          )
        )
        .nullable(),
    };
  }
  return schemas;
};

/**
 * The queries `workflow`'s reference exposes, as the App's own public
 * queries are: by path (`workflows.<alias>.queries.<name>`), with their
 * argument and answer descriptors. Fingerprinted and generated as any
 * function reference is.
 */
export const workflowQueries = (
  workflow: BoundWorkflow
): Partial<Record<WorkflowQueryName, OperationManifest>> => {
  let declared: ReturnType<typeof querySchemas>;
  try {
    declared = querySchemas(workflow);
  } catch (error) {
    // A decision's context sits two levels down in a detail, and every
    // context shares one descriptor: contexts that fit a decision binding
    // may still not fit together. Refused by name, never cut down.
    if (error instanceof ValueDefinitionError) {
      throw new TypeError(
        `${workflow.alias}'s decision contexts don't fit its decision query: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
  const queries: Partial<Record<WorkflowQueryName, OperationManifest>> = {};
  for (const [name, schemas] of Object.entries(declared)) {
    // SAFETY: the keys of `querySchemas`' own answer are query names.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    queries[name as WorkflowQueryName] = {
      path: `workflows.${workflow.alias}.queries.${name}`,
      kind: "query",
      visibility: "public",
      args: descriptorOf(schemas.args),
      returns: descriptorOf(schemas.returns),
      stream: null,
      uses: [],
      tables: {},
    };
  }
  return queries;
};
