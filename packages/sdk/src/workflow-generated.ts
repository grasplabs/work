import type { Json } from "@grasp-os/shared/json";

import type { ValueSchema } from "./value-descriptor.ts";
import { issueText } from "./workflow-error.ts";

// `@grasp-os/sdk/workflow-generated`: what only the code generated from a
// grasp-workflow/1 document calls (@grasp-os/workflow-schema's
// generate.ts), beside `@grasp-os/sdk/workflow`. Not the SDK's API: no
// workflow is written against it.

/**
 * A value an expression reads, as generated code holds it: any (see
 * `@grasp-os/sdk/workflow`'s `readMember`).
 */
// oxlint-disable-next-line typescript/no-explicit-any -- see above
type Read = any;

/**
 * `value`, checked by `schema` as `v` checks a value: what it answers,
 * typed so, or a `TypeError` naming the first thing that doesn't fit,
 * which fails the step it runs in. What generated code holds what a step
 * records to (a decision's recipients, a deadline).
 */
export const parse = <Input, Output>(
  schema: ValueSchema<Input, Output>,
  value: unknown
): Output => {
  const result = schema["~standard"].validate(value);
  if (result.issues === undefined) {
    return result.value;
  }
  throw new TypeError(`Not of its schema: ${issueText(result.issues)}`);
};

/**
 * The items a loop's enter step recorded, each as every value an
 * expression reads (`Read`), so an item read bare (`100 * item`) compiles
 * as its expression was checked. The host holds the record to a list
 * (`workflow.collection_invalid`); anything else is a `TypeError` here.
 */
export const itemsOf: (items: Json) => readonly Read[] = (items) => {
  if (!Array.isArray(items)) {
    throw new TypeError("A loop's items are a list.");
  }
  const list: readonly Json[] = items;
  return list;
};
