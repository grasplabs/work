import type {
  BoundWorkflowDecision,
  BoundWorkflowEvent,
  WorkflowBindingExtras,
} from "./bound-workflows.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";

/** What a sealed release's contracts can't be: anything but what was sealed. */
const unsealed = (what: string): never => {
  throw new TypeError(`The release's sealed workflows hold ${what}.`);
};

/** `value` as a plain record, or a refusal naming `what` it should be. */
const sealedRecord = (
  value: unknown,
  what: string
): Readonly<Record<string, unknown>> =>
  isPlainObject(value) ? value : unsealed(`${what} that isn't a record`);

/** A descriptor sealed as data, read back as strictly as when it was made. */
const sealedDescriptor = (value: unknown): ValueDescriptor =>
  readDescriptor(value, 1, { nodes: 0 });

/** What a release's contracts seal of one workflow it declares, read back. */
const sealedWorkflow = (value: unknown): WorkflowBindingExtras => {
  const sealed = sealedRecord(value, "a workflow");
  const { alias } = sealed;
  if (typeof alias !== "string") {
    return unsealed("a workflow with no alias");
  }
  const events: Record<string, BoundWorkflowEvent> = {};
  for (const [name, event] of Object.entries(
    sealedRecord(sealed.events, "events")
  )) {
    const { type, data } = sealedRecord(event, "an event");
    if (typeof type !== "string") {
      return unsealed("an event with no type");
    }
    events[name] = { type, data: sealedDescriptor(data) };
  }
  const listens: Record<string, readonly string[]> = {};
  for (const [task, listened] of Object.entries(
    sealedRecord(sealed.listens, "listen tasks")
  )) {
    if (
      !Array.isArray(listened) ||
      !listened.every((name) => typeof name === "string")
    ) {
      return unsealed("a listen task that isn't a list of events");
    }
    listens[task] = listened;
  }
  const decisions: Record<string, BoundWorkflowDecision> = {};
  for (const [name, decision] of Object.entries(
    sealedRecord(sealed.decisions, "decisions")
  )) {
    const { value: decided, context } = sealedRecord(decision, "a decision");
    decisions[name] = {
      value: sealedDescriptor(decided),
      context: sealedDescriptor(context),
    };
  }
  if (sealed.pinned === undefined) {
    return { alias, events, listens, decisions };
  }
  const { workflowId, version } = sealedRecord(sealed.pinned, "a pin");
  if (
    typeof workflowId !== "string" ||
    workflowId.length === 0 ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return unsealed("a pin that isn't a workflow's version");
  }
  return { alias, events, listens, decisions, pinned: { workflowId, version } };
};

/**
 * What the host resolved of each workflow a release declares, read back
 * from its sealed contracts (`contracts.json`'s `workflows`): so the
 * references a sealed version's pages get are generated from what its
 * seal resolved, whatever its bindings say now. Throws on anything else.
 */
export const readSealedWorkflows = (
  workflows: unknown
): WorkflowBindingExtras[] =>
  Object.values(sealedRecord(workflows, "workflows")).map((sealed) =>
    sealedWorkflow(sealed)
  );
