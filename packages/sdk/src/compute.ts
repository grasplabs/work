import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { descriptorOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";
import type { Infer, InferInput } from "./values.ts";

// `compute`: a pure calculation a JSON workflow calls through
// `grasp.compute` (platform specification 13.6, 32.4). It lives in the
// workflow's own `code/` modules, which import nothing but this module and
// each other (compiler: `computeCode`).
//
// ```ts
// import { compute, v } from "@grasp-os/sdk/compute";
//
// export const total = compute({
//   input: v.array(v.number().integer().min(0)).max(1000),
//   output: v.number().integer().min(0),
//   handler: (amounts) => amounts.reduce((sum, amount) => sum + amount, 0),
// });
// ```
//
// A definition is a value: it runs nothing. The host reads its contract
// (its input and output descriptors) once, as the version is published,
// and seals it; a run's call is checked against that sealed contract on
// both sides. The handler runs in an isolate of its own with no env, no
// network, no clock and no randomness (compute-runner.ts), on the one
// validated value it is given, and answers synchronously: a calculation
// has nothing to wait for, so it can hide no effect behind a promise.

export { v } from "./values.ts";
export type { Infer, InferInput } from "./values.ts";

/** What `compute` is declared with. */
export interface ComputeDefinition<
  Input extends AnySchema,
  Output extends AnySchema,
> {
  /** What a call passes: the host checks each call's arguments against it. */
  readonly input: Input;
  /** What the handler answers: the host checks each answer against it. */
  readonly output: Output;
  /** The calculation: pure, and synchronous. */
  readonly handler: (input: Infer<Input>) => InferInput<Output>;
}

/** A compute module's contract, as the host's manifest records it. */
export interface ComputeContract {
  readonly input: ValueDescriptor;
  readonly output: ValueDescriptor;
}

/** A declared calculation, as `compute` answers it. */
export interface Compute<Input extends AnySchema, Output extends AnySchema> {
  readonly "~compute": ComputeContract;
  /** Runs the calculation directly, in ordinary code (no durable history). */
  readonly handler: (input: Infer<Input>) => InferInput<Output>;
}

/** Why a calculation's declaration was refused. */
export class ComputeDefinitionError extends Error {
  readonly code = "compute.invalid_definition";

  constructor(message: string) {
    super(message);
    this.name = "ComputeDefinitionError";
  }
}

const refuse = (message: string): never => {
  throw new ComputeDefinitionError(message);
};

const definitionKeys: ReadonlySet<string> = new Set([
  "input",
  "output",
  "handler",
]);

/**
 * The handler of each calculation `compute` declared, by its value: what
 * makes a value one. An object shaped like a definition that `compute`
 * didn't make has no handler here, so it is no calculation.
 */
const handlers = new WeakMap<object, (input: unknown) => unknown>();

/** Reads `key` of `definition` as a data property: never a getter. */
const dataOf = (definition: object, key: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(definition, key);
  if (property !== undefined && !("value" in property)) {
    return refuse(`A calculation's \`${key}\` is a value, not a getter.`);
  }
  return property?.value;
};

/**
 * Declares a calculation (see the header): throws `ComputeDefinitionError`
 * for a declaration that isn't one.
 */
export const compute = <
  const Input extends AnySchema,
  const Output extends AnySchema,
>(
  definition: ComputeDefinition<Input, Output>
): Compute<Input, Output> => {
  if (!isPlainObject(definition)) {
    return refuse("Declare a calculation as `{ input, output, handler }`.");
  }
  for (const key of Object.keys(definition)) {
    if (!definitionKeys.has(key)) {
      refuse(`A calculation has no \`${key}\`.`);
    }
  }
  const handler = dataOf(definition, "handler");
  if (typeof handler !== "function") {
    return refuse("A calculation's `handler` is a function.");
  }
  const contract: ComputeContract = Object.freeze({
    // Each throws for anything but a `v` schema.
    input: descriptorOf(dataOf(definition, "input")),
    output: descriptorOf(dataOf(definition, "output")),
  });
  const run = (input: unknown): unknown =>
    Reflect.apply(handler, undefined, [input]);
  const declared = Object.freeze({
    "~compute": contract,
    handler: run,
  });
  handlers.set(declared, run);
  return declared;
};

/**
 * The handler of `value` if `compute` declared it; undefined for anything
 * else, a lookalike included. For the runner (compute-runner.ts) only.
 */
export const computeHandler = (
  value: unknown
): ((input: unknown) => unknown) | undefined =>
  (typeof value === "object" || typeof value === "function") && value !== null
    ? handlers.get(value)
    : undefined;
