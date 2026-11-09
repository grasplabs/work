import { canonicalJson } from "@grasp-os/shared/json";
import { isEventType } from "@grasp-os/shared/sealed-builds";

import { clientError } from "./client-error.ts";
import { namePattern, sha256Pattern } from "./declaration.ts";
import type { FunctionReference } from "./function-references.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import type { WorkflowDecisionReference } from "./workflow-decisions.ts";
import type { WorkflowEventReference } from "./workflow-events.ts";
import { workflowReferenceLimits } from "./workflow-references.ts";
import type { RunHandle } from "./workflow-runs.ts";
import type { RunSnapshot } from "./workflow-view.ts";

/** A workflow mutation, as the client calls it. */
type WorkflowMutation<Args, Return> = FunctionReference<
  "mutation",
  "public",
  Args,
  Return
>;

/** A control's mutation, as the client calls it: its receipt answered. */
type ControlMutation = WorkflowMutation<
  { readonly runId: string },
  {
    readonly kind: "pause" | "resume" | "cancel";
    readonly state: "admitted" | "applied" | "superseded";
  }
>;

/** A workflow reference, read as data and checked. */
export interface ReadWorkflow {
  /** What identifies it: its App, release, contract and fingerprint. */
  readonly key: string;
  /** Its registered path, e.g. `workflows.summarizeNote`. */
  readonly contractId: string;
  /**
   * The ordinary functions `useWorkflow` is built on, each named under
   * this very workflow's path: never another function of the App's.
   * Typed as their descriptors (workflow-functions.ts) declare them.
   */
  readonly functions: {
    readonly run: FunctionReference<
      "query",
      "public",
      { readonly runId: string },
      RunSnapshot | null
    >;
    readonly canStart: FunctionReference<
      "query",
      "public",
      Record<never, never>,
      boolean
    >;
    readonly start: WorkflowMutation<{ readonly input: unknown }, RunHandle>;
    readonly pause: ControlMutation;
    readonly resume: ControlMutation;
    readonly cancel: ControlMutation;
    /** None for a workflow that declares no events. */
    readonly send:
      | WorkflowMutation<
          {
            readonly runId: string;
            readonly event: string;
            readonly data: unknown;
          },
          unknown
        >
      | undefined;
  };
  /**
   * Its event references, by alias: the very objects it was generated
   * with, which a wait's event resolves to.
   */
  readonly events: ReadonlyMap<string, WorkflowEventReference>;
  /** Its listen tasks, by path: the aliases of the events each listens for. */
  readonly listens: ReadonlyMap<string, ReadonlySet<string>>;
  /** Its decision references, by key. */
  readonly decisions: ReadonlyMap<string, WorkflowDecisionReference>;
}

const readWorkflows = new WeakMap<object, ReadWorkflow>();

const maxEvents = workflowReferenceLimits.events;

/** The release and contract of the workflow reference being read. */
interface WorkflowIdentity {
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly contractId: string;
  readonly fingerprint: string;
}

/**
 * Whether `event` is a reference to an event of `workflow` under `alias`:
 * that very workflow's release, contract and fingerprint, its own alias,
 * a type, a fingerprint, and a data descriptor that reads.
 */
const isEventOf = (
  event: unknown,
  alias: string,
  workflow: WorkflowIdentity
): event is WorkflowEventReference => {
  if (
    !namePattern.test(alias) ||
    !isPlainObject(event) ||
    event.kind !== "workflowEvent" ||
    event.alias !== alias ||
    event.resourceId !== workflow.resourceId ||
    event.resourceVersion !== workflow.resourceVersion ||
    event.workflow !== workflow.contractId ||
    event.workflowFingerprint !== workflow.fingerprint ||
    typeof event.type !== "string" ||
    !isEventType(event.type) ||
    typeof event.fingerprint !== "string" ||
    !sha256Pattern.test(event.fingerprint)
  ) {
    return false;
  }
  try {
    readDescriptor(event.data, 1, { nodes: 0 });
  } catch {
    return false;
  }
  return true;
};

/** Whether `value` is a descriptor that reads. */
const readsAsDescriptor = (value: unknown): boolean => {
  try {
    readDescriptor(value, 1, { nodes: 0 });
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether `decision` is a reference to a decision of `workflow` under
 * `key`: that very workflow's release, contract and fingerprint, its own
 * key, a fingerprint, and a value schema and context that read as
 * descriptors, as data.
 */
const isDecisionOf = (
  decision: unknown,
  key: string,
  workflow: WorkflowIdentity
): decision is WorkflowDecisionReference =>
  namePattern.test(key) &&
  isPlainObject(decision) &&
  decision.kind === "workflowDecision" &&
  decision.key === key &&
  decision.resourceId === workflow.resourceId &&
  decision.resourceVersion === workflow.resourceVersion &&
  decision.workflow === workflow.contractId &&
  decision.workflowFingerprint === workflow.fingerprint &&
  typeof decision.fingerprint === "string" &&
  sha256Pattern.test(decision.fingerprint) &&
  isPlainObject(decision.valueSchema) &&
  decision.valueSchema.kind === "descriptor" &&
  readsAsDescriptor(decision.valueSchema.descriptor) &&
  readsAsDescriptor(decision.context);

/** The decisions of a workflow reference, `value`, by key; or throws. */
const readDecisions = (
  value: unknown,
  workflow: WorkflowIdentity
): ReadonlyMap<string, WorkflowDecisionReference> => {
  if (!isPlainObject(value)) {
    throw clientError("contract.invalid_request");
  }
  const entries = Object.entries(value);
  if (entries.length > workflowReferenceLimits.decisions) {
    throw clientError("contract.invalid_request");
  }
  const decisions = new Map<string, WorkflowDecisionReference>();
  for (const [key, decision] of entries) {
    if (!isDecisionOf(decision, key, workflow)) {
      throw clientError("contract.invalid_request");
    }
    decisions.set(key, decision);
  }
  return decisions;
};

const maxListens = workflowReferenceLimits.listens;

/**
 * The listen tasks of a workflow reference, `value`, by path: each a
 * task's path with the events of `events` it listens for, each once.
 * Anything else throws.
 */
const readListens = (
  value: unknown,
  events: ReadonlyMap<string, WorkflowEventReference>
): ReadonlyMap<string, ReadonlySet<string>> => {
  if (!isPlainObject(value)) {
    throw clientError("contract.invalid_request");
  }
  const entries = Object.entries(value);
  if (entries.length > maxListens) {
    throw clientError("contract.invalid_request");
  }
  const listens = new Map<string, ReadonlySet<string>>();
  for (const [task, aliases] of entries) {
    if (
      task.length === 0 ||
      task.length > workflowReferenceLimits.taskPathLength ||
      !Array.isArray(aliases) ||
      aliases.length === 0 ||
      aliases.some(
        (alias) => typeof alias !== "string" || !events.has(alias)
      ) ||
      new Set(aliases).size !== aliases.length
    ) {
      throw clientError("contract.invalid_request");
    }
    listens.set(task, new Set<string>(aliases));
  }
  return listens;
};

/**
 * The events of a workflow reference, `value`, by alias: each one of
 * `workflow`'s own (`isEventOf`), the very objects given. Anything else
 * throws.
 */
const readEvents = (
  value: unknown,
  workflow: WorkflowIdentity
): ReadonlyMap<string, WorkflowEventReference> => {
  if (!isPlainObject(value)) {
    throw clientError("contract.invalid_request");
  }
  const entries = Object.entries(value);
  if (entries.length > maxEvents) {
    throw clientError("contract.invalid_request");
  }
  const events = new Map<string, WorkflowEventReference>();
  for (const [alias, event] of entries) {
    if (!isEventOf(event, alias, workflow)) {
      throw clientError("contract.invalid_request");
    }
    events.set(alias, event);
  }
  return events;
};

/**
 * The function `name` of `group` in a workflow reference's functions
 * (`value`), read: it must be the one under the workflow's own path
 * (`<contractId>.<group>.<name>`), so a forged reference never sends a
 * call of the App's own functions in its place; a mutation's arguments a
 * descriptor that reads.
 */
const functionIn = (
  value: unknown,
  contractId: string,
  group: "queries" | "mutations",
  name: string
): { readonly name: string; readonly args: ValueDescriptor | undefined } => {
  const fn =
    isPlainObject(value) && Object.hasOwn(value, name)
      ? value[name]
      : undefined;
  const path = `${contractId}.${group}.${name}`;
  if (!isPlainObject(fn) || fn.name !== path) {
    throw clientError("contract.invalid_request");
  }
  if (group === "queries") {
    return { name: path, args: undefined };
  }
  try {
    return { name: path, args: readDescriptor(fn.args, 1, { nodes: 0 }) };
  } catch {
    throw clientError("contract.invalid_request");
  }
};

/**
 * A workflow reference's mutation `name`, as `functionIn` reads it, typed
 * as its descriptors declare it (workflow-functions.ts).
 */
const mutationIn = <Args, Return>(
  value: unknown,
  contractId: string,
  name: string
): WorkflowMutation<Args, Return> => {
  const { args } = functionIn(value, contractId, "mutations", name);
  if (args === undefined) {
    throw clientError("contract.invalid_request");
  }
  return {
    name: `${contractId}.mutations.${name}`,
    kind: "mutation",
    args,
  };
};

/**
 * `value` as a public workflow reference, read as data, its events and
 * decisions checked; `contract.invalid_request` for anything else (an
 * operation's reference, an internal one, a string, a forged object).
 */
export const readWorkflowReference = (value: unknown): ReadWorkflow => {
  const known =
    typeof value === "object" && value !== null
      ? readWorkflows.get(value)
      : undefined;
  if (known !== undefined) {
    return known;
  }
  if (
    !isPlainObject(value) ||
    value.kind !== "workflow" ||
    value.visibility !== "public" ||
    typeof value.resourceId !== "string" ||
    typeof value.resourceVersion !== "number" ||
    !Number.isSafeInteger(value.resourceVersion) ||
    typeof value.alias !== "string" ||
    typeof value.contractId !== "string" ||
    typeof value.fingerprint !== "string" ||
    !sha256Pattern.test(value.fingerprint)
  ) {
    throw clientError("contract.invalid_request");
  }
  const identity: WorkflowIdentity = {
    resourceId: value.resourceId,
    resourceVersion: value.resourceVersion,
    contractId: value.contractId,
    fingerprint: value.fingerprint,
  };
  const events = readEvents(value.events, identity);
  const listens = readListens(value.listens, events);
  const decisions = readDecisions(value.decisions, identity);
  const { contractId } = identity;
  const query = (name: string) => ({
    name: functionIn(value.queries, contractId, "queries", name).name,
  });
  const { mutations } = value;
  const read: ReadWorkflow = {
    key: canonicalJson([
      identity.resourceId,
      identity.resourceVersion,
      contractId,
      identity.fingerprint,
    ]),
    contractId,
    functions: {
      run: query("run"),
      canStart: query("canStart"),
      start: mutationIn(mutations, contractId, "start"),
      pause: mutationIn(mutations, contractId, "pause"),
      resume: mutationIn(mutations, contractId, "resume"),
      cancel: mutationIn(mutations, contractId, "cancel"),
      send:
        events.size === 0
          ? undefined
          : mutationIn(mutations, contractId, "send"),
    },
    events,
    listens,
    decisions,
  };
  readWorkflows.set(value, read);
  return read;
};
