import type { ValueDescriptor } from "@grasp-os/sdk";
import { valueTypeOf } from "@grasp-os/sdk/host";

import type { CheckedWorkflow } from "./check.ts";
import { eachStep } from "./format.ts";
import type { ExpressionRoot, Step } from "./format.ts";

// What a checked document's expressions read, as TypeScript types, for
// the compiler's typed check (@grasp-os/compiler's `expressionTypeCheck`):
// the run's input and parameters from the document's own schemas, each
// step's output from what it declares or calls, and each expression's
// source by the pointer of its `{ $expr }`. The checks of check.ts come
// first: what this reads is a document that passed them, so every read of
// a step that may not have run, or of a root out of its place (`error`
// outside a catch, `item` outside a loop, `output` outside a step's
// `state`), is already refused there. Its roots are the format's
// (`expressionRoots`), each typed here.
//
// A step whose output the document doesn't type (a decision's, a wait's, a
// call of the workflow's own modules) is `any`: the check passes what
// reads it rather than refuse what it can't know.

/** The types an expression reads, as the compiler's check takes them. */
export interface ExpressionScope {
  readonly input: string;
  readonly steps: Readonly<Record<string, string>>;
  readonly params: string;
  readonly run: string;
  readonly roots: Readonly<Record<string, string>>;
}

/** What the compiler's typed check of a document's expressions takes. */
export interface ExpressionTypeRequest {
  readonly scope: ExpressionScope;
  /** Each expression's source, by the pointer of its `{ $expr }`. */
  readonly expressions: Readonly<Record<string, { readonly source: string }>>;
}

/** A failure a catch reads as `error` (the SDK's `CaughtError`). */
const caughtErrorType =
  "{ readonly type: string; readonly status: number; readonly instance: string; readonly title?: string; readonly detail?: string }";

/** What a run's code knows of its run. */
const runType = "{ readonly id: string }";

/** A value whose type the document doesn't declare. */
const untyped = "any";

const typeOf = (descriptor: ValueDescriptor): string =>
  valueTypeOf(descriptor, "output");

/** An object type of `fields`, each by its name as a string literal. */
const objectType = (fields: readonly (readonly [string, string])[]): string =>
  `{ ${fields.map(([name, type]) => `readonly ${JSON.stringify(name)}: ${type};`).join(" ")} }`;

/** The value at JSON Pointer `pointer` of `document`. */
const at = (document: unknown, pointer: string): unknown => {
  let value = document;
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    const next: unknown =
      typeof value === "object" && value !== null && Object.hasOwn(value, key)
        ? Reflect.get(value, key)
        : undefined;
    value = next;
  }
  return value;
};

/**
 * The type of each of the format's roots (`expressionRoots`) in
 * `checked`: a type of every one, so the compiler's check knows each root
 * the format's check lets an expression read. A state key reads its declared schema's type, or `undefined`
 * where no run kept it, or kept a value that no longer fits. A loop's
 * `item` and a step's own `output` are `any`: one scope types every
 * expression, wherever it stands.
 */
const rootTypes = (
  checked: CheckedWorkflow
): Readonly<Record<ExpressionRoot, string>> => ({
  inbox: "{ readonly [alias: string]: string | undefined }",
  state: `{ ${[...checked.state]
    .map(
      ([key, descriptor]) =>
        `readonly ${JSON.stringify(key)}?: ${typeOf(descriptor)};`
    )
    .join(" ")} }`,
  error: caughtErrorType,
  item: untyped,
  output: untyped,
});

/**
 * What `checked`'s expressions read, typed, and their sources. A `do`
 * step's output is `output(step)`'s, its call's contract's (a connector
 * operation's, an action's or a calculation's), when it has one; an `agent` step's
 * is the answer its `output` schema declares.
 */
export const expressionTypeRequest = (
  checked: CheckedWorkflow,
  output: (step: Step) => ValueDescriptor | undefined
): ExpressionTypeRequest => {
  const steps = eachStep(checked.document.steps).map(({ step, pointer }) => {
    const answer =
      step.type === "agent" ? checked.answers.get(pointer) : output(step);
    return [step.id, answer === undefined ? untyped : typeOf(answer)] as const;
  });
  const expressions: Record<string, { source: string }> = {};
  for (const pointer of checked.code.keys()) {
    const node = at(checked.document, pointer);
    const source: unknown =
      typeof node === "object" && node !== null && "$expr" in node
        ? node.$expr
        : undefined;
    if (typeof source === "string") {
      expressions[pointer] = { source };
    }
  }
  return {
    scope: {
      input: typeOf(checked.contract.input),
      steps: Object.fromEntries(steps),
      params: objectType(
        [...checked.contract.params].map(([name, descriptor]) => [
          name,
          typeOf(descriptor),
        ])
      ),
      run: runType,
      roots: rootTypes(checked),
    },
    expressions,
  };
};
