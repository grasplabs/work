import type { FunctionManifest } from "./app-types.ts";
import type { ReferenceKind } from "./function-references.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";

// What a page knows of its App's public functions beyond their names:
// what `useForm` checks a submission with (a mutation's or an action's
// kind and arguments) and what `DataGrid` reads its columns from (a
// query's declared return). A reference is a name and nothing else, so
// this comes with the page's build instead (`.grasp/functions.ts`, which
// the host generates from the release's manifest and the compiler builds
// in beside the route tree), and the client looks a function up by the
// name its reference holds. Nothing a reference carries besides its name
// is ever read: an object that brings its own arguments or kind changes
// nothing, and a name the release has no public function at (an
// internal one, a key every object inherits) finds none. Core checks
// every call again with the function's own validator, in the release
// current when it's called.

/** One of the release's public functions, as a page reads it. */
export interface PageFunction {
  readonly kind: ReferenceKind;
  readonly args: ValueDescriptor;
  /** Its declared return; null where it declares none. */
  readonly returns: ValueDescriptor | null;
}

/** A release's public functions, by name. */
export type PageFunctions = ReadonlyMap<string, PageFunction>;

const kinds: ReadonlySet<unknown> = new Set(["query", "mutation", "action"]);

/** `value` as a descriptor, strictly; undefined for anything else. */
const descriptorIn = (value: unknown): ValueDescriptor | undefined => {
  try {
    return readDescriptor(value, 1, { nodes: 0 });
  } catch {
    return undefined;
  }
};

/** `value` as one function's entry, or undefined when it isn't one. */
const pageFunctionOf = (value: unknown): PageFunction | undefined => {
  if (!isPlainObject(value) || !kinds.has(value.kind)) {
    return undefined;
  }
  const args = descriptorIn(value.args);
  const returns = value.returns === null ? null : descriptorIn(value.returns);
  if (args === undefined || returns === undefined) {
    return undefined;
  }
  // SAFETY: one of `kinds`, checked above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return { kind: value.kind as ReferenceKind, args, returns };
};

/**
 * The functions `value` holds by name (`.grasp/functions.ts`'s
 * `functions`), as a map: only its own entries that read as one, so no
 * name finds what every object inherits. None for anything else.
 */
export const readPageFunctions = (value: unknown): PageFunctions => {
  const read = new Map<string, PageFunction>();
  if (!isPlainObject(value)) {
    return read;
  }
  for (const [name, entry] of Object.entries(value)) {
    const fn = pageFunctionOf(entry);
    if (fn !== undefined) {
      read.set(name, fn);
    }
  }
  return read;
};

/**
 * `.grasp/functions.ts`: the release's public functions by name, data
 * only, for the page's build. Generated from its manifest, in name order.
 */
export const pageFunctionsOf = (
  operations: Readonly<Record<string, FunctionManifest>>
): Record<string, PageFunction> =>
  Object.fromEntries(
    Object.values(operations)
      .filter((operation) => operation.visibility === "public")
      .toSorted((a, b) => (a.path < b.path ? -1 : 1))
      .map((operation) => [
        operation.path,
        {
          kind: operation.kind,
          args: operation.args,
          returns: operation.returns,
        },
      ])
  );
