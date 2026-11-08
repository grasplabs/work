import { canonicalJson } from "@grasp-os/shared/json";
import { isEventType } from "@grasp-os/shared/sealed-builds";

import { clientError } from "./client-error.ts";
import { namePattern, sha256Pattern } from "./declaration.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import type { WorkflowDecisionReference } from "./workflow-decisions.ts";
import type { WorkflowEventReference } from "./workflow-events.ts";
import { workflowReferenceLimits } from "./workflow-references.ts";

/** A workflow reference, read as data and checked. */
export interface ReadWorkflow {
  /** What identifies it: its App, release, contract and fingerprint. */
  readonly key: string;
  readonly resourceId: string;
  readonly contractId: string;
  readonly fingerprint: string;
  readonly input: ValueDescriptor;
  readonly output: ValueDescriptor;
  /**
   * Its event references, by alias: the very objects it was generated
   * with, which a wait's event resolves to.
   */
  readonly events: ReadonlyMap<string, WorkflowEventReference>;
  /** Its listen tasks, by path: the aliases of the events each listens for. */
  readonly listens: ReadonlyMap<string, ReadonlySet<string>>;
  /** Its decision references, by key. */
  readonly decisions: ReadonlyMap<string, WorkflowDecisionReference>;
  /** What a request names of it, exactly as the host reads it. */
  readonly wire: {
    readonly resourceId: string;
    readonly resourceVersion: number;
    readonly contractId: string;
    readonly fingerprint: string;
    readonly kind: "workflow";
  };
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
 * `value` as a public workflow reference, read as data, its descriptors
 * checked; `contract.invalid_request` for anything else (an operation's
 * reference, an internal one, a string, a forged object).
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
  let input: ValueDescriptor;
  let output: ValueDescriptor;
  try {
    input = readDescriptor(value.input, 1, { nodes: 0 });
    output = readDescriptor(value.output, 1, { nodes: 0 });
  } catch {
    throw clientError("contract.invalid_request");
  }
  const wire = {
    resourceId: value.resourceId,
    resourceVersion: value.resourceVersion,
    contractId: value.contractId,
    fingerprint: value.fingerprint,
    kind: "workflow",
  } as const;
  const events = readEvents(value.events, wire);
  const listens = readListens(value.listens, events);
  const decisions = readDecisions(value.decisions, wire);
  const read: ReadWorkflow = {
    key: canonicalJson([
      wire.resourceId,
      wire.resourceVersion,
      wire.contractId,
      wire.fingerprint,
    ]),
    resourceId: wire.resourceId,
    contractId: wire.contractId,
    fingerprint: wire.fingerprint,
    input,
    output,
    events,
    listens,
    decisions,
    wire,
  };
  readWorkflows.set(value, read);
  return read;
};
