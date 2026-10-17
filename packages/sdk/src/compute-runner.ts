// Loaded first: it takes the clock and randomness away before anything
// else in the isolate evaluates.
import { lockedDown } from "./compute-lockdown.ts";
import { computeHandler } from "./compute.ts";

// What core's compute call runs in the isolate of a workflow's compute
// modules (workflow-modules.ts): never imported by a workflow's own code
// (compiler: `computeCode` imports only `@grasp-os/sdk/compute`). Two
// things only:
//
// - `computeManifestOf`: the contracts of the calculations the modules
//   export, read once as a version is published, so the host seals them;
// - `runCompute`: one calculation run on one value, as a run's
//   `grasp.compute` task asks for it.
//
// Everything in the isolate is untrusted, this module too: the host checks
// what either answers, against its own bounds and the sealed contract.

/** A module's exports, by its path (`code/<file>.ts`). */
export type ComputeModules = Readonly<Record<string, unknown>>;

/**
 * `JSON.stringify` as it was when the runner loaded, before any of the
 * workflow's modules could replace it.
 */
const { stringify } = JSON;
/**
 * Every other intrinsic the runner calls, taken as `stringify` is: module
 * code that replaces `Reflect.get`, `RegExp.prototype.exec`,
 * `String.prototype.slice` or an `instanceof` hook changes nothing here,
 * so a thenable answer is refused however it is dressed up.
 */
const { entries, getOwnPropertyDescriptor, hasOwn, keys } = Object;
const { apply, get: reflectGet } = Reflect;
const regexpExec: unknown = getOwnPropertyDescriptor(
  RegExp.prototype,
  "exec"
)?.value;
const stringSlice: unknown = getOwnPropertyDescriptor(
  String.prototype,
  "slice"
)?.value;

/** Whether `text` matches `pattern`, through the captured `exec`. */
const matches = (pattern: RegExp, text: string): boolean =>
  typeof regexpExec === "function" &&
  apply(regexpExec, pattern, [text]) !== null;

/** The first `length` code units of `text`, through the captured `slice`. */
const cut = (text: string, length: number): string => {
  const sliced: unknown =
    typeof stringSlice === "function"
      ? apply(stringSlice, text, [0, length])
      : "";
  return typeof sliced === "string" ? sliced : "";
};

/** The most of a handler's failure an answer keeps. */
const failureMaxLength = 500;

/** An export name a contract key may name (`local:code/<file>.ts#<export>`). */
const exportPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

const requireLockedDown = (): void => {
  if (!lockedDown) {
    throw new Error(
      "The isolate couldn't take the clock and randomness away, so no calculation runs in it."
    );
  }
};

/** The own data property `key` of `namespace`, never a getter's answer. */
const exportOf = (namespace: unknown, key: string): unknown => {
  if (typeof namespace !== "object" || namespace === null) {
    return undefined;
  }
  const property = getOwnPropertyDescriptor(namespace, key);
  return property !== undefined && "value" in property
    ? property.value
    : undefined;
};

/**
 * The contract of every calculation `modules` export, as JSON text: an
 * object from `local:code/<file>.ts#<export>` to `{ input, output }`, the
 * descriptors `compute` read. Exports that aren't calculations are left
 * out.
 */
export const computeManifestOf = (modules: ComputeModules): string => {
  requireLockedDown();
  const manifest: Record<string, unknown> = {};
  for (const [path, namespace] of entries(modules)) {
    if (typeof namespace !== "object" || namespace === null) {
      continue;
    }
    for (const name of keys(namespace)) {
      const value = exportOf(namespace, name);
      if (
        !matches(exportPattern, name) ||
        computeHandler(value) === undefined
      ) {
        continue;
      }
      const contract = exportOf(value, "~compute");
      manifest[`local:${path}#${name}`] = {
        input: exportOf(contract, "input"),
        output: exportOf(contract, "output"),
      };
    }
  }
  return stringify(manifest);
};

/** One calculation to run: its module and export, and its input. */
export interface ComputeRequest {
  readonly module: string;
  readonly export: string;
  readonly input: unknown;
}

/** What a run answered: its output as JSON text, or why it failed. */
export type ComputeAnswer =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly message: string };

/** Whether `value` looks like a promise: anything with a `then` function. */
const isThenable = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof reflectGet(value, "then") === "function";

/**
 * Runs the calculation `request` names on its input: the handler's answer
 * as JSON text, or why it failed (it threw, answered a promise, or
 * answered what JSON can't hold). The host validated the input and
 * validates the output.
 */
export const runCompute = (
  modules: ComputeModules,
  request: ComputeRequest
): ComputeAnswer => {
  requireLockedDown();
  const handler = hasOwn(modules, request.module)
    ? computeHandler(exportOf(modules[request.module], request.export))
    : undefined;
  if (handler === undefined) {
    return { ok: false, message: "There is no such calculation." };
  }
  try {
    const output = handler(request.input);
    if (isThenable(output)) {
      return {
        ok: false,
        message:
          "A calculation's handler answers its value, not a promise: it has nothing to wait for.",
      };
    }
    // Serialized here, so a `toJSON` on the answer runs locked down too.
    const text = stringify(output);
    return text === undefined
      ? { ok: false, message: "The calculation answered no JSON value." }
      : { ok: true, output: text };
  } catch (error) {
    // Its own `message`, as an error has it: read as data, never through
    // a hook module code could have set.
    const message: unknown =
      (typeof error === "object" && error !== null) ||
      typeof error === "function"
        ? getOwnPropertyDescriptor(error, "message")?.value
        : undefined;
    return {
      ok: false,
      message: cut(
        typeof message === "string" ? message : "The calculation threw",
        failureMaxLength
      ),
    };
  }
};
