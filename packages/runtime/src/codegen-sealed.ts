import type { WorkflowBindingExtras } from "./bound-workflows.ts";
import { isPlainObject } from "./value-descriptor.ts";

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

/** What a release's contracts seal of one workflow it declares, read back. */
const sealedWorkflow = (value: unknown): WorkflowBindingExtras => {
  const sealed = sealedRecord(value, "a workflow");
  const { alias } = sealed;
  if (typeof alias !== "string") {
    return unsealed("a workflow with no alias");
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
  return { alias, pinned: { workflowId, version } };
};

/**
 * The workflow version each binding of a release pinned, read back from
 * its sealed contracts (`contracts.json`'s `workflows`): what its seal
 * resolved, whatever its bindings say now. Throws on anything else.
 */
export const readSealedWorkflows = (
  workflows: unknown
): WorkflowBindingExtras[] =>
  Object.values(sealedRecord(workflows, "workflows")).map((sealed) =>
    sealedWorkflow(sealed)
  );
