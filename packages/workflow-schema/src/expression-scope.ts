import type { ValueDescriptor } from "@grasp-os/sdk";
import { valueTypeOf } from "@grasp-os/sdk/host";

import type { CheckedWorkflow } from "./check.ts";
import { eachStep, resultStepTypes } from "./format.ts";
import type { ExpressionRoot, Step } from "./format.ts";

// What a checked document's expressions read, as TypeScript types, for
// the compiler's typed check (@grasp-os/compiler's `expressionTypeCheck`):
// the run's args and parameters from the document's own schemas, each
// step's result from what it declares or calls, and each expression's
// source by the pointer of its `{ $expr }`. The checks of check.ts come
// first: what this reads is a document that passed them, so every read of
// a step that may not have run, or of a root out of its place (`error`
// outside a catch, `item` outside a loop, `output` outside a step's
// `state`), is already refused there. Its roots are the format's
// (`expressionRoots`), each typed here.
//
// A step whose result the document doesn't type (a decision's, an event
// wait's, a call of the workflow's own modules) is `any`: the check passes what
// reads it rather than refuse what it can't know.

/** The types an expression reads, as the compiler's check takes them. */
export interface ExpressionScope {
  readonly args: string;
  readonly steps: Readonly<Record<string, string>>;
  readonly params: string;
  readonly run: string;
  readonly roots: Readonly<Record<string, string>>;
}

/** What the compiler's typed check of a document's expressions takes. */
export interface ExpressionTypeRequest {
  readonly scope: ExpressionScope;
  /** Each expression's source, by the pointer of its `{ $expr }`. */
  readonly expressions: Readonly<
    Record<
      string,
      { readonly source: string; readonly guards?: readonly string[] }
    >
  >;
}

/** A failure a catch reads as `error` (the SDK's `CaughtError`). */
const caughtErrorType =
  "{ readonly code: string; readonly message: string; readonly details?: any; readonly step?: string }";

/**
 * A decision's result, as the SDK's `Decision` types it in the generated
 * module: what an expression reads of it is typed as the build types it.
 */
const decisionType =
  "{ readonly timedOut: false; readonly approved: boolean; readonly by: string; readonly payload: any } | { readonly timedOut: true }";

/** An event wait's result for `types`, as the SDK's `EventWait` types it. */
const eventWaitType = (types: readonly string[]): string =>
  `{ readonly timedOut: false; readonly event: { readonly id: string; readonly type: ${types.map((type) => JSON.stringify(type)).join(" | ")}; readonly source: string; readonly subject?: string; readonly time: string; readonly data: any } } | { readonly timedOut: true }`;

/** The source of `expression`, if it is one. */
const sourceOf = (expression: unknown): string | undefined =>
  typeof expression === "object" &&
  expression !== null &&
  "$expr" in expression &&
  typeof expression.$expr === "string"
    ? expression.$expr
    : undefined;

/**
 * The conditions that hold where the generated code evaluates each of
 * `steps`' expressions, by pointer prefix (generate.ts): a step's own `if`
 * around its call (`<if> ? await … : null`), an `if` step's condition
 * around its `then` and its negation around its `else`, a loop's `while`
 * around its steps (`if (!<while>) break;`), a catch's code and `when`
 * around its `do`. A callback the code passes (a retry's `when`, a step's
 * `state`) is checked under none: narrowing may not reach a closure, and
 * a condition left out only makes the check stricter than the build.
 */
const guardsOf = (
  steps: readonly Step[],
  pointer: string,
  around: readonly string[],
  guards: Map<string, readonly string[]>
): void => {
  for (const [index, step] of steps.entries()) {
    const at = `${pointer}/${index}`;
    guards.set(`${at}/if`, around);
    const own = sourceOf(step.if);
    const inside = own === undefined ? around : [...around, own];
    // Every expression of the step's own, but what the cases below set.
    guards.set(at, inside);
    guards.set(`${at}/state`, []);
    if (step.type === "if") {
      const condition = sourceOf(step.condition) ?? "true";
      guardsOf(step.then, `${at}/then`, [...inside, condition], guards);
      guardsOf(
        step.else ?? [],
        `${at}/else`,
        [...inside, `!(${condition})`],
        guards
      );
    } else if (step.type === "forEach") {
      const holds = sourceOf(step.while);
      guardsOf(
        step.do,
        `${at}/do`,
        holds === undefined ? inside : [...inside, holds],
        guards
      );
    } else if (step.type === "try") {
      guardsOf(step.try, `${at}/try`, inside, guards);
      guards.set(`${at}/catch/retry`, []);
      const caught = [
        ...inside,
        ...(step.catch.code === undefined
          ? []
          : [`error.code === ${JSON.stringify(step.catch.code)}`]),
      ];
      guards.set(`${at}/catch/when`, caught);
      const when = sourceOf(step.catch.when);
      guardsOf(
        step.catch.do ?? [],
        `${at}/catch/do`,
        when === undefined ? caught : [...caught, when],
        guards
      );
    }
  }
};

/** The guards of the expression at `pointer`: those of its longest prefix. */
const guardsAt = (
  guards: ReadonlyMap<string, readonly string[]>,
  pointer: string
): readonly string[] => {
  for (
    let prefix = pointer;
    prefix !== "";
    prefix = prefix.slice(0, prefix.lastIndexOf("/"))
  ) {
    const held = guards.get(prefix);
    if (held !== undefined) {
      return held;
    }
  }
  return [];
};

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
 * What `checked`'s expressions read, typed, and their sources: each step
 * with a result by its ID. A `call` step's result is `output(step)`'s, its
 * call's contract's (a connection action's, an action's or a
 * calculation's), when it has one; a `generate` step's is the answer its
 * `returns` declares.
 */
export const expressionTypeRequest = (
  checked: CheckedWorkflow,
  output: (step: Step) => ValueDescriptor | undefined
): ExpressionTypeRequest => {
  const steps = eachStep(checked.document.steps).flatMap(
    ({ step, pointer }) => {
      if (!resultStepTypes.has(step.type)) {
        return [];
      }
      let type: string;
      if (step.type === "decide") {
        type = decisionType;
      } else if (step.type === "waitForEvent") {
        type = eventWaitType(
          typeof step.eventType === "string" ? [step.eventType] : step.eventType
        );
      } else {
        const answer =
          step.type === "generate"
            ? checked.answers.get(pointer)
            : output(step);
        type = answer === undefined ? untyped : typeOf(answer);
      }
      // A step its `if` skips is `null`, as the generated `const` is.
      return [
        [step.id, step.if === undefined ? type : `(${type}) | null`] as const,
      ];
    }
  );
  const guards = new Map<string, readonly string[]>();
  guardsOf(checked.document.steps, "/steps", [], guards);
  const expressions: Record<
    string,
    { source: string; guards?: readonly string[] }
  > = {};
  for (const pointer of checked.code.keys()) {
    const source = sourceOf(at(checked.document, pointer));
    if (source !== undefined) {
      const held = guardsAt(guards, pointer);
      expressions[pointer] =
        held.length === 0 ? { source } : { source, guards: held };
    }
  }
  return {
    scope: {
      args: typeOf(checked.contract.args),
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
