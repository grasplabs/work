import type { Json } from "@grasp-os/shared/json";
import { z } from "zod";

import { schemaFromDescriptor } from "./descriptor-text.ts";

/**
 * `value` held to the value descriptor `descriptor` holds as JSON text,
 * read as the run host reads it (`schemaFromDescriptor`): what the
 * validator answers (its defaults filled in), or what doesn't fit.
 */
const fitOf = (
  descriptor: string,
  value: unknown
): { readonly value: Json } | { readonly unfit: string } => {
  const result = schemaFromDescriptor(descriptor)["~standard"].validate(value);
  if (result instanceof Promise) {
    return { unfit: "validated asynchronously" };
  }
  if (result.issues === undefined) {
    return { value: z.json().parse(result.value) };
  }
  const [issue] = result.issues;
  const at = issue?.path?.join(".") ?? "";
  return {
    unfit: `${at === "" ? "" : `at ${at}: `}${issue?.message ?? "not of its schema"}`,
  };
};

/**
 * `value`, held to `descriptor` (what generated code carries for a value it
 * keeps, a step's state): the value itself, unchanged, as the host checks
 * and keeps it, or a `TypeError` naming the first thing that doesn't fit,
 * which fails the step.
 */
export const fittedValue = (descriptor: string, value: Json): Json => {
  const fit = fitOf(descriptor, value);
  if ("unfit" in fit) {
    throw new TypeError(`Not of its schema: ${fit.unfit}`);
  }
  return value;
};

/**
 * What a run reads of its workflow's state `state`, frozen: each key of
 * `descriptors` whose value fits its descriptor, as the validator answers
 * it, its defaults filled in, so an expression reads what its type check
 * typed. Every version of a workflow writes the same state, so a value an
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
        if (value === undefined) {
          return [];
        }
        const fit = fitOf(descriptor, value);
        return "unfit" in fit ? [] : [[key, fit.value]];
      })
    )
  );
