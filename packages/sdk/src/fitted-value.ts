import type { Json } from "@grasp-os/shared/json";

import { schemaFromDescriptor } from "./descriptor-text.ts";

/**
 * What doesn't fit the value descriptor `descriptor` holds as JSON text,
 * read as the run host reads it (`schemaFromDescriptor`), or undefined.
 */
const unfitOf = (descriptor: string, value: unknown): string | undefined => {
  const result = schemaFromDescriptor(descriptor)["~standard"].validate(value);
  const [issue] = result instanceof Promise ? [] : (result.issues ?? []);
  if (issue === undefined) {
    return undefined;
  }
  const at = issue.path?.join(".") ?? "";
  return `${at === "" ? "" : `at ${at}: `}${issue.message}`;
};

/**
 * `value`, held to `descriptor` (what generated code carries for a value it
 * keeps, a step's state): the value itself, unchanged, or a `TypeError`
 * naming the first thing that doesn't fit, which fails the step.
 */
export const fittedValue = (descriptor: string, value: Json): Json => {
  const unfit = unfitOf(descriptor, value);
  if (unfit !== undefined) {
    throw new TypeError(`Not of its schema: ${unfit}`);
  }
  return value;
};

/**
 * What a run reads of its workflow's state `state`, frozen: each key of
 * `descriptors` whose value fits its descriptor, as `fittedValue` holds
 * it. Every version of a workflow writes the same state, so a value an
 * older version kept may not fit this one's schema: it reads as a key
 * never written, as does any key this version doesn't declare.
 */
export const fittedState = (
  state: Readonly<Record<string, Json>>,
  descriptors: Readonly<Record<string, string>>
): Readonly<Record<string, Json>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(descriptors).flatMap(([key, descriptor]) => {
        const value = Object.hasOwn(state, key) ? state[key] : undefined;
        return value === undefined || unfitOf(descriptor, value) !== undefined
          ? []
          : [[key, value]];
      })
    )
  );
