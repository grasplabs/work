import { RpcTarget } from "capnweb";

import { requestErrors } from "./errors.ts";
import { passedBound } from "./value-bounds.ts";
import type { ValueBounds } from "./value-bounds.ts";

// What an untrusted side's call hands a target's method, bounded once,
// before the method sees it.
//
// Each message is bounded as it is read (its depth by Cap'n Web, its size
// and nodes by the accountant on the transport, rpc-accounting.ts), not
// the values a call ends up with. A message may
// refer to what earlier ones sent: a value it pushed (`["push", v]`), or
// what a call answered, referred to as `["pipeline", n]` from a later
// call's arguments, which Cap'n Web puts in place after it has checked
// the message. Pushes refer to pushes, so a value built over many small
// messages is as deep or as big as the sender likes, and a value referred
// to many times is walked as many times by whoever measures, parses or
// clones it: two levels deeper a push, or twice as big. Whatever walks it
// recursively then runs out of stack (a schema, `structuredClone`, a
// measure of its bytes), and Cap'n Web has no hook on what it delivers.
//
// So the bound is held where every call arrives: each method of a target
// checks its arguments as they were delivered, with the referred values
// in place, before its own code runs. A target the methods of which a
// side may call extends a class made here (a lint rule says so), and the
// methods its class and the classes between declare are wrapped, on its
// prototype, the first time one of them is constructed. The bounds are
// the session's own per message, so a call that fits in one message, as
// every call our own clients make does, is never refused.

/** The prototypes whose methods are wrapped already. */
const wrapped = new WeakSet<object>();

/**
 * Refuses `args` past `bounds`: `request.too_deep` or `request.too_large`,
 * never a stack overflow, or `request.unsupported_value` for an object of
 * no kind a call takes (a prototype set to a value sent as `__proto__`).
 */
const holdWithin = (args: readonly unknown[], bounds: ValueBounds): void => {
  const passed = passedBound(args, bounds);
  if (passed === "depth") {
    throw requestErrors.create("request.too_deep");
  }
  if (passed === "size") {
    throw requestErrors.create("request.too_large");
  }
  if (passed === "kind") {
    throw requestErrors.create("request.unsupported_value");
  }
};

/** `method`, refusing arguments past `bounds` before it runs. */
const bounded = (
  name: string,
  method: (...args: unknown[]) => unknown,
  bounds: ValueBounds
): ((...args: unknown[]) => unknown) =>
  // A method, so it's called with the target as `this`, as Cap'n Web
  // calls it, and keeps the name it had.
  ({
    [name](this: unknown, ...args: unknown[]): unknown {
      holdWithin(args, bounds);
      return Reflect.apply(method, this, args);
    },
  })[name] ?? method;

/** Whether a prototype's property is a method. */
const isMethod = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === "function";

/**
 * Wraps the methods declared on `prototype` and every prototype above it
 * up to `base`'s. Cap'n Web calls a target's methods by name, and only
 * those its class declares (an instance's own properties it refuses), so
 * these are all a side can call, but for the ones every object has
 * (`toString`, ...), which read no argument. Getters aren't wrapped: Cap'n
 * Web passes them nothing.
 */
const wrapMethods = (
  prototype: object,
  base: object,
  bounds: ValueBounds
): void => {
  for (
    let current: object | null = prototype;
    current !== null && current !== base && !wrapped.has(current);
    current = Reflect.getPrototypeOf(current)
  ) {
    for (const name of Reflect.ownKeys(current)) {
      const property = Reflect.getOwnPropertyDescriptor(current, name);
      const method: unknown = property?.value;
      // Cap'n Web names a method by a string; symbols (`Symbol.dispose`)
      // it calls itself, with nothing a side sent.
      // A method that can't be wrapped would take any argument unchecked:
      // never silently.
      if (
        typeof name === "string" &&
        name !== "constructor" &&
        property !== undefined &&
        isMethod(method) &&
        !Reflect.defineProperty(current, name, {
          ...property,
          value: bounded(name, method, bounds),
        })
      ) {
        throw new TypeError(
          `The method ${name} can't be bounded: it isn't writable and configurable.`
        );
      }
    }
    // Only once every method of it is bounded: a prototype that threw is
    // tried again, and throws again, at its next construction.
    wrapped.add(current);
  }
};

/**
 * A base for the targets an untrusted side reaches over a Cap'n Web
 * session: every argument of every call of their methods is within
 * `bounds` when the method runs, deep and big, however it was sent. Give
 * it the session's own limits on a message: `depth` one less than its
 * `maxDepth` (a direct argument's levels, the call's list of arguments
 * apart), `size` the longest message its transport takes.
 *
 * A method a target calls on itself is held to the same bounds.
 */
export const boundedRpcTarget = (bounds: ValueBounds) => {
  class BoundedRpcTarget extends RpcTarget {
    constructor() {
      super();
      wrapMethods(new.target.prototype, BoundedRpcTarget.prototype, bounds);
    }
  }
  return BoundedRpcTarget;
};
