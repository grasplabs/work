import { platformLimits } from "@grasp-os/shared/platform-limits";

import { own as ownField } from "./expression-runtime.ts";
import { WorkflowError } from "./workflow-error.ts";
import { caughtError as caughtErrorOf } from "./workflow-journal.ts";
import type { CaughtError, Read } from "./workflow-steps.ts";

// `@grasp-os/sdk/workflow-generated`: what only the code generated from a
// grasp-workflow/2 document calls (@grasp-os/workflow-schema's
// generate.ts), beside `@grasp-os/sdk/workflow`. Not the SDK's API: no
// workflow is written against it.

/**
 * A field of a name a built-in prototype has as a function, as an
 * expression reads it (expression-runtime.ts, `own`): the value's own
 * field, never the method. Generated code imports it as `$own`.
 */
export const own: (value: unknown, name: string, optional?: boolean) => Read =
  ownField;

/**
 * What a catch reads as `error`: the failure it took, as frozen data with
 * no prototype (`CaughtError`), whatever was thrown.
 */
export const caughtError: (thrown: unknown) => CaughtError = caughtErrorOf;

/**
 * A loop's items: a list of at most the platform's 1,000
 * (`workflow.collection_invalid` past them), each as every value an
 * expression reads (`Read`), so an item read bare (`100 * item`) compiles
 * as its expression was checked. Anything else is a `TypeError`, never
 * iterated (a string would be, a character at a time).
 */
export const itemsOf = (items: unknown): readonly Read[] => {
  if (!Array.isArray(items)) {
    throw new TypeError("A loop's items are a list.");
  }
  if (items.length > platformLimits.workflowCollectionItems) {
    throw new WorkflowError(
      "workflow.invalid_step_call",
      `A loop takes at most ${platformLimits.workflowCollectionItems} items.`
    );
  }
  const list: readonly Read[] = items;
  return list;
};
