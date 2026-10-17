// Loaded first, as a side effect before every other import: it takes the
// clock, randomness and the platform's globals away before anything else
// in the isolate evaluates. A side-effect import keeps its place.
import "./compute-lockdown.ts";
import { actionHandler } from "./action.ts";
import { lockedDown } from "./compute-locked.ts";
import { computeHandler } from "./compute.ts";

// What core runs in the isolate of a workflow's own modules
// (workflow-modules.ts): never imported by a workflow's own code
// (compiler: `computeCode` imports only `@grasp-os/sdk/compute` and
// `@grasp-os/sdk/action`). Three things only:
//
// - `computeManifestOf`: the contracts of the calculations and actions the
//   modules export, read once as a version is published, so the host
//   seals them;
// - `runCompute`: one calculation run on one value, as a run's
//   `grasp.compute` task asks for it;
// - `runAction`: one action run on its arguments, as a run's
//   `grasp.operation` task of a local binding asks for it, its resources
//   calls of the one host capability core passes in.
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
const { entries, freeze, getOwnPropertyDescriptor, hasOwn, keys } = Object;
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
      if (!matches(exportPattern, name)) {
        continue;
      }
      if (computeHandler(value) !== undefined) {
        const contract = exportOf(value, "~compute");
        manifest[`local:${path}#${name}`] = {
          kind: "compute",
          input: exportOf(contract, "input"),
          output: exportOf(contract, "output"),
        };
      } else if (actionHandler(value) !== undefined) {
        const contract = exportOf(value, "~action");
        manifest[`local:${path}#${name}`] = {
          kind: "operation",
          input: exportOf(contract, "input"),
          output: exportOf(contract, "output"),
          uses: exportOf(contract, "uses"),
        };
      }
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

/** The host's one capability in an action's isolate: a resource call. */
export interface ActionHost {
  readonly call: (alias: string, request: unknown) => Promise<unknown>;
}

/** One action to run: its module and export, and its arguments. */
export interface ActionRequest {
  readonly module: string;
  readonly export: string;
  readonly input: unknown;
}

/** Why `error`, which an action threw, failed: its own message, as data. */
const failureOf = (error: unknown, fallback: string): string => {
  const message: unknown =
    (typeof error === "object" && error !== null) || typeof error === "function"
      ? getOwnPropertyDescriptor(error, "message")?.value
      : undefined;
  return cut(
    typeof message === "string" ? message : fallback,
    failureMaxLength
  );
};

/**
 * Runs the action `request` names on its arguments, its resources each a
 * call of `host`'s: the handler's answer as JSON text, or why it failed.
 * `ctx.resources` holds the aliases the action declared, and nothing
 * else; the host checks each call against the sealed contract again, so
 * what this builds is a convenience, never the boundary.
 */
export const runAction = async (
  modules: ComputeModules,
  request: ActionRequest,
  host: ActionHost
): Promise<ComputeAnswer> => {
  requireLockedDown();
  const value = hasOwn(modules, request.module)
    ? exportOf(modules[request.module], request.export)
    : undefined;
  const handler = actionHandler(value);
  const uses: unknown = exportOf(exportOf(value, "~action"), "uses");
  const hostCall: unknown = reflectGet(host, "call");
  if (
    handler === undefined ||
    !Array.isArray(uses) ||
    typeof hostCall !== "function"
  ) {
    return { ok: false, message: "There is no such action." };
  }
  // Every call made, so the action answers only once each has settled:
  // one it didn't wait for still reaches the host within its step.
  const made: Promise<unknown>[] = [];
  // The very promise the action gets: what it chains on it is a reaction
  // registered before the runner's own wait, so a call it starts there is
  // made before the runner looks again.
  // oxlint-disable-next-line typescript/promise-function-async -- the very promise, not a new one
  const callHost = (alias: string, call: unknown): Promise<unknown> => {
    const calling: Promise<unknown> = (async () => {
      const answer: unknown = await apply(hostCall, host, [alias, call]);
      return answer;
    })();
    made.push(calling);
    return calling;
  };
  // Until none is left: a call started while waiting is waited for too.
  // By index, awaiting each: no array method or iterator module code could
  // have replaced.
  const settled = async (): Promise<void> => {
    // oxlint-disable-next-line typescript/prefer-for-of -- by index: no iterator module code could replace
    for (let index = 0; index < made.length; index += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one at a time, as made
        await made[index];
      } catch {
        // Its refusal is the host's to keep.
      }
    }
  };
  const resources: Record<string, unknown> = {};
  for (const use of uses) {
    const alias: unknown = exportOf(use, "alias");
    const kind: unknown = exportOf(use, "kind");
    if (typeof alias !== "string") {
      continue;
    }
    resources[alias] = freeze(
      kind === "connector"
        ? {
            // oxlint-disable-next-line typescript/promise-function-async -- the very promise callHost tracks
            call: (operation: unknown, args: unknown) =>
              callHost(alias, { operation, arguments: args }),
          }
        : {
            // oxlint-disable-next-line typescript/promise-function-async -- the very promise callHost tracks
            call: (args: unknown) => callHost(alias, { arguments: args }),
          }
    );
  }
  const ctx = freeze({ resources: freeze(resources) });
  try {
    const output: unknown = await handler(ctx, request.input);
    await settled();
    // Serialized here, so a `toJSON` on the answer runs locked down too.
    const text = stringify(output);
    return text === undefined
      ? { ok: false, message: "The action answered no JSON value." }
      : { ok: true, output: text };
  } catch (error) {
    await settled();
    return { ok: false, message: failureOf(error, "The action threw") };
  }
};
