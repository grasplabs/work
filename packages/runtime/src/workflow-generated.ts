import { platformLimits } from "@grasp-os/shared/platform-limits";
import { valueDepth } from "@grasp-os/shared/value-depth";

import { own as ownField } from "./expression-runtime.ts";
import { WorkflowError } from "./workflow-error.ts";
import {
  caughtError as caughtErrorOf,
  frozenData,
} from "./workflow-journal.ts";
import type { CaughtError, Read } from "./workflow-steps.ts";

// `@grasp-os/runtime/workflow-generated`: what only the code generated from a
// grasp-workflow/2 document calls (@grasp-os/workflow-schema's
// generate.ts), beside `@grasp-os/runtime/workflow`. Not the SDK's API: no
// workflow is written against it.

/**
 * A field of a name a built-in prototype has as a function, as an
 * expression reads it (expression-runtime.ts, `own`): the value's own
 * field, never the method. Generated code imports it as `$own`.
 */
export const own: (value: unknown, name: string) => Read = ownField;

/**
 * `JSON.parse(text)` as an expression calls it: `text`'s value as frozen
 * data with no prototype (`frozenData`), as every value an expression
 * reads is, so a `__proto__` or `constructor` key in it is an own field
 * holding data, never a prototype. Only text parses; anything else is a
 * `TypeError` (never converted to text, which would run a `toString`),
 * and text that isn't JSON is JSON's own `SyntaxError`. A value nested
 * deeper than any value may be (`valueDepth`, its leaf included) is a
 * `RangeError`, found without recursion before anything walks it: text
 * from outside (an email's body) could otherwise make a value no other
 * expression can, which the host takes for a tampered build once a call,
 * a state key or a decision is given it. Each is the step's own failure,
 * which a catch takes. Generated code imports it as `$parse`.
 */
export const parse = (text: unknown): Read => {
  if (typeof text !== "string") {
    throw new TypeError("`JSON.parse` takes text.");
  }
  const value: unknown = JSON.parse(text);
  const pending: [unknown, number][] = [[value, 1]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [held, depth] = next;
    if (depth > valueDepth) {
      throw new RangeError(
        `\`JSON.parse\` takes text nested at most ${valueDepth} levels.`
      );
    }
    if (typeof held === "object" && held !== null) {
      for (const inner of Object.values(held)) {
        pending.push([inner, depth + 1]);
      }
    }
  }
  return frozenData(value);
};

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
