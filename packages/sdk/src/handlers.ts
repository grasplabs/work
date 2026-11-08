import type { AnyActionHandler } from "./action.ts";
import type { SchemaDefinition } from "./schema-types.ts";
import type { AnyFunction } from "./server-function.ts";

// What each SDK constructor made, by the value it answered: what makes a
// value a server function, a calculation or an action, and what it holds.
// Kept apart from the subpaths App code imports (server.ts, compute.ts,
// action.ts), so App code can't look a handler up; only the SDK's own
// modules import this one.
//
// A correctness aid, not a boundary: it keeps a module from binding a plain
// object by mistake. A module set on forging one runs only its own code
// either way, in an isolate with nothing to reach, and its calls are checked
// against the contract sealed at publication (core's workflow-modules.ts).
// The intrinsics are taken as this module loads, before any of the
// workflow's own (compute-runner.ts loads it first), so patching
// `WeakMap.prototype` later changes nothing here.
const { apply } = Reflect;
const weakGet: unknown = Reflect.getOwnPropertyDescriptor(
  WeakMap.prototype,
  "get"
)?.value;
const weakSet: unknown = Reflect.getOwnPropertyDescriptor(
  WeakMap.prototype,
  "set"
)?.value;

/** What a constructor made, each with what it holds. */
const registry = <Held>(isHeld: (value: unknown) => value is Held) => {
  const held = new WeakMap<object, Held>();
  return {
    add: (value: object, what: Held): void => {
      if (typeof weakSet === "function") {
        apply(weakSet, held, [value, what]);
      }
    },
    /** What `value` holds if a constructor made it; undefined for anything else, a lookalike included. */
    of: (value: unknown): Held | undefined => {
      if (
        (typeof value !== "object" && typeof value !== "function") ||
        value === null ||
        typeof weakGet !== "function"
      ) {
        return undefined;
      }
      const found: unknown = apply(weakGet, held, [value]);
      return isHeld(found) ? found : undefined;
    },
  };
};

/** A calculation's handler, as the runner calls it. */
type ComputeHandler = (input: unknown) => unknown;

const isComputeHandler = (value: unknown): value is ComputeHandler =>
  typeof value === "function";

export const isActionHandler = (value: unknown): value is AnyActionHandler =>
  typeof value === "function";

/** What the SDK knows of a server function it made, and App code can't forge. */
interface FunctionState {
  readonly schema: SchemaDefinition;
}

const isFunctionState = (value: unknown): value is FunctionState =>
  typeof value === "object" && value !== null;

/** The handler of each calculation `compute` declared. */
export const computeHandlers = registry(isComputeHandler);

/** The handler of each action `action` declared. */
export const actionHandlers = registry(isActionHandler);

/** Every server function a constructor made, with the schema it was made for. */
export const serverFunctions = registry(isFunctionState);

/** Whether `value` is a server function a constructor made. */
export const isServerFunction = (value: unknown): value is AnyFunction =>
  serverFunctions.of(value) !== undefined;
