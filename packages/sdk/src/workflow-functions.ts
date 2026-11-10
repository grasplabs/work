import type { FunctionManifest } from "./app-types.ts";
import type { BoundWorkflow } from "./bound-workflows.ts";
import { descriptorOf } from "./sealed-descriptors.ts";
import { ValueDefinitionError } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";
import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "./values.ts";
import { workflowReferenceLimits } from "./workflow-references.ts";

// The ordinary functions a generated workflow reference exposes, as
// Convex's workflow component does: queries
// (`workflows.<wf>.queries.run`, `.canStart`, `.runs`, `.history`,
// `.decisions` and `.decision`) for `useQuery` and `usePaginatedQuery`,
// and mutations (`workflows.<wf>.mutations.start`, `.pause`, `.resume`,
// `.cancel` and `.send`) for `useMutation`. `useWorkflow` is built on
// them alone (react/workflow.ts). Their arguments and answers are
// declared here once, as schemas, so their descriptors and the types
// generated from them say the same; the host serves each against the
// binding in force, checks every item's visibility, and answers only
// what these declare (page-workflows.ts, workflow-reference-queries.ts).
//
// `decisions` and `decision` exist only for a workflow that declares
// decisions: one that asks nobody has no inbox to read; `send` only for
// one that declares events. History rows of an event or a decision
// likewise exist only where there are any, each keyed by its declared
// literal.

/** The names of the queries a workflow reference exposes. */
export type WorkflowQueryName =
  | "run"
  | "canStart"
  | "runs"
  | "history"
  | "decisions"
  | "decision";

/** The names of the mutations a workflow reference exposes. */
export type WorkflowMutationName =
  | "start"
  | "pause"
  | "resume"
  | "cancel"
  | "send";

const idText = v.string().min(1).max(256);
const plainText = v.string().max(2000);

const handleFields = {
  runId: idText,
  workflowId: idText,
  workflowVersion: v.number().integer().min(1),
  manifestHash: idText,
};

const runHandle = v.object(handleFields);

/** A run's status, as a page sees it, compensation aside. */
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

const rowFields = {
  run: runHandle,
  startedAt: v.timestamp().nullable(),
  finishedAt: v.timestamp().nullable(),
  canWatch: v.boolean(),
};

/** One run in a list: no args, result or error. */
const runRow = v.union(
  v.object({ ...rowFields, status: settledStatus }),
  v.object({ ...rowFields, ...compensation })
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
 * One row of a run's history: metadata only, never args,
 * result, reviewers or review bodies.
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
      waitKind: v.enum(["timer", "event", "decision", "blocked"]),
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

/** The longest ID the host gives a wait. */
const waitIdText = v.string().min(1).max(256);

const waitFields = {
  id: waitIdText,
  taskId: v.string().min(1).max(1024),
  // A decision's alias, a task's path or `$run`: as long as a task path.
  key: v.string().min(1).max(workflowReferenceLimits.taskPathLength),
  title: v.string().max(200),
  openedAt: v.timestamp(),
  deadline: v.timestamp().nullable(),
};

/** The most waits one run lists. */
export const maxWaits = 256;

/**
 * A wait a run is held at, as `run` answers it: an event wait names its
 * event by the alias the workflow's reference holds it under, which
 * `useWorkflow` resolves to that reference.
 */
const waitSchema = v.union(
  v.object({
    ...waitFields,
    kind: v.literal("timer"),
    purpose: v.enum(["sleep", "retry"]),
    deadline: v.timestamp(),
  }),
  v.object({
    ...waitFields,
    kind: v.literal("event"),
    event: v.object({
      kind: v.literal("workflowEvent"),
      alias: v.string().min(1).max(64),
      fingerprint: v.string().min(64).max(64),
    }),
    canSend: v.boolean(),
  }),
  v.object({
    ...waitFields,
    kind: v.literal("decision"),
    canRespond: v.boolean(),
  }),
  v.object({
    ...waitFields,
    kind: v.literal("blocked"),
    reason: v.enum(["policy", "quota", "uncertain"]),
    message: plainText,
  })
);

/** The controls a page may ask of a run. */
export const controlKinds = ["pause", "resume", "cancel"] as const;

/** What a run is, whatever its status. */
const runFields = {
  ...handleFields,
  startedAt: v.timestamp().nullable(),
  finishedAt: v.timestamp().nullable(),
  waits: v.array(waitSchema).max(maxWaits),
  control: v.object({
    canPause: v.boolean(),
    canResume: v.boolean(),
    canCancel: v.boolean(),
    pendingControl: v
      .object({ kind: v.enum(controlKinds), stage: v.literal("applying") })
      .nullable(),
  }),
};

/**
 * `descriptor`, a host-resolved one, as an optional field's schema: a
 * default it has dropped, since only what was sent is read.
 */
const optionalFrom = (descriptor: ValueDescriptor): AnySchema => {
  const { defaultValue: _dropped, ...rest } = descriptor;
  return schemaFrom({ ...rest, presence: "optional" });
};

/**
 * One run as its person sees it: its status, what it returned once
 * completed (`result`, by the `returns` its App declares), why it failed, what it
 * rolls back after; or null for a run the person may not see, one that
 * doesn't exist alike. One object, not a union by status, so a generated
 * module holds its fields once; `useWorkflow` narrows it by status.
 */
const runSnapshot = (workflow: BoundWorkflow): AnySchema =>
  v
    .object({
      ...runFields,
      status: v.enum([
        "queued",
        "running",
        "waiting",
        "paused",
        "compensating",
        "completed",
        "failed",
        "cancelled",
      ]),
      result: optionalFrom(workflow.returns),
      error: sanitizedError.optional(),
      compensation: v
        .union(
          v.object({
            cause: v.literal("failure"),
            activity: compensation.activity,
            originalError: sanitizedError,
          }),
          v.object({
            cause: v.literal("cancellation"),
            activity: compensation.activity,
          })
        )
        .optional(),
    })
    .nullable();

/** One function's schemas: what it takes and what it answers. */
interface Schemas {
  readonly args: AnySchema;
  readonly returns: AnySchema;
}

/**
 * The schemas of `workflow`'s queries, by name. `runs`, `history` and
 * `decisions` page as an App's own queries do. A caller that passes
 * `endCursor` (as `usePaginatedQuery` does for a loaded page) must read
 * `splitCursor`, which means one thing however it was set: split the
 * page there. The answer holds every record up to that place, and may
 * hold those after it; the caller reads them from it.
 */
const querySchemas = (
  workflow: BoundWorkflow
): Partial<Record<WorkflowQueryName, Schemas>> => {
  const keys = Object.keys(workflow.decisions).toSorted();
  const schemas: Partial<Record<WorkflowQueryName, Schemas>> = {
    run: { args: v.object({ runId: idText }), returns: runSnapshot(workflow) },
    canStart: { args: v.object({}), returns: v.boolean() },
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

/** What a control's mutation answers: its receipt's kind and state. */
const receipt = v.object({
  kind: v.enum(controlKinds),
  state: v.enum(["admitted", "applied", "superseded"]),
});

/**
 * The schemas of `workflow`'s mutations, by name: `start` takes the
 * workflow's args as `args` and answers the run's handle once admitted;
 * `pause`, `resume` and `cancel` take a run and answer their receipt,
 * which the run's `pendingControl` shows applying until it settles;
 * `send` takes a run, one of the workflow's events by its alias, and that
 * event's data, and answers the event's ID once the run's inbox took it.
 */
const mutationSchemas = (
  workflow: BoundWorkflow
): Partial<Record<WorkflowMutationName, Schemas>> => {
  const control = { args: v.object({ runId: idText }), returns: receipt };
  const schemas: Partial<Record<WorkflowMutationName, Schemas>> = {
    start: {
      args: v.object({ args: schemaFrom(workflow.args) }),
      returns: runHandle,
    },
    pause: control,
    resume: control,
    cancel: control,
  };
  const events = Object.keys(workflow.events).toSorted();
  if (events.length > 0) {
    schemas.send = {
      args: unionOf(
        events.map((alias) => {
          const declared = workflow.events[alias];
          if (declared === undefined) {
            throw new TypeError(`No event ${alias}`);
          }
          return v.object({
            runId: idText,
            event: v.literal(alias),
            data: schemaFrom(declared.data),
          });
        })
      ),
      returns: v.object({ eventId: idText }),
    };
  }
  return schemas;
};

/** `schemas` as function manifests, under `workflows.<alias>.<group>`. */
const manifestsOf = <Name extends string>(
  workflow: BoundWorkflow,
  group: "queries" | "mutations",
  schemas: Partial<Record<Name, Schemas>>
): Partial<Record<Name, FunctionManifest>> => {
  const manifests: Partial<Record<Name, FunctionManifest>> = {};
  for (const [name, each] of Object.entries<Schemas | undefined>(schemas)) {
    if (each !== undefined) {
      // SAFETY: the keys of `schemas` are `Name`s.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      manifests[name as Name] = {
        path: `workflows.${workflow.alias}.${group}.${name}`,
        kind: group === "queries" ? "query" : "mutation",
        visibility: "public",
        args: descriptorOf(each.args),
        returns: descriptorOf(each.returns),
        stream: null,
      };
    }
  }
  return manifests;
};

/** The functions a workflow reference exposes, by group and name. */
export interface WorkflowFunctions {
  readonly queries: Partial<Record<WorkflowQueryName, FunctionManifest>>;
  readonly mutations: Partial<Record<WorkflowMutationName, FunctionManifest>>;
}

/**
 * The functions `workflow`'s reference exposes, as the App's own public
 * functions are: by path (`workflows.<alias>.queries.<name>`,
 * `workflows.<alias>.mutations.<name>`), with their argument and answer
 * descriptors. Generated as any function reference is.
 */
export const workflowFunctions = (
  workflow: BoundWorkflow
): WorkflowFunctions => {
  try {
    return {
      queries: manifestsOf(workflow, "queries", querySchemas(workflow)),
      mutations: manifestsOf(workflow, "mutations", mutationSchemas(workflow)),
    };
  } catch (error) {
    // A decision's context sits two levels down in a detail; a run's
    // result, its args and an event's data one: a contract that fits a
    // binding may still not fit its functions. Refused by name, never cut
    // down.
    if (error instanceof ValueDefinitionError) {
      throw new TypeError(
        `${workflow.alias}'s contracts don't fit its generated functions: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
};
