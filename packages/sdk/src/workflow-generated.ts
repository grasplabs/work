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
export const own: (value: unknown, name: string) => Read = ownField;

/**
 * What a catch reads as `error`: the failure it took, as frozen data with
 * no prototype (`CaughtError`), whatever was thrown.
 */
export const caughtError: (thrown: unknown) => CaughtError = caughtErrorOf;

/**
 * A loop's items: a list of at most the platform's 1,000, each as every
 * value an expression reads (`Read`), so an item read bare (`100 * item`)
 * compiles as its expression was checked. Anything else fails the run's
 * code with `workflow.collection_invalid`, never iterated (a string would
 * be, a character at a time): the loop's data, which a catch may take.
 */
export const itemsOf = (items: unknown): readonly Read[] => {
  if (!Array.isArray(items)) {
    throw new WorkflowError(
      "workflow.collection_invalid",
      "A loop's items are a list."
    );
  }
  if (items.length > platformLimits.workflowCollectionItems) {
    throw new WorkflowError(
      "workflow.collection_invalid",
      `A loop takes at most ${platformLimits.workflowCollectionItems} items.`
    );
  }
  const list: readonly Read[] = items;
  return list;
};
