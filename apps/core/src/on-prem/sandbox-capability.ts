/**
 * The capabilities an isolate gets in a sandbox session
 * (sandbox-session.ts): workerd RpcTargets, each with exactly the methods
 * core named, forwarding to the session's capnweb stub. The isolate calls
 * them over workerd's own RPC; what it passes goes on to core, which
 * bounds and checks every argument where it lands (sandboxed.ts).
 */
import { RpcPromise, RpcStub } from "capnweb";
// oxlint-disable-next-line no-restricted-imports -- a forwarder to core, which bounds what arrives; it holds nothing itself
import { RpcTarget } from "cloudflare:workers";

/**
 * The key that marks a capability core passes during a call, as an
 * argument of a callback into the isolate (a workflow step's attempt
 * host, given to the step's function): `{ [capabilityMarker]: methods,
 * target }`, the target a capnweb stub of core's forwarder. Shared by
 * core, which marks it (apps/core/src/sandbox-session.ts), and this host,
 * which turns it into a capability of those methods (`inward`).
 */
export const capabilityMarker = "grasp:capability";

/** The most methods one capability may have. */
const maxMethods = 64;

/** A method name a capability may have: no getters, nothing internal. */
const methodName = /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/u;

/**
 * Whether `name` is one a Cap'n Web stub or any object answers itself
 * (`then`, `map`, `toString`, `hasOwnProperty`, ...): never a capability's,
 * as a call by it would never reach core. Read from the classes, so a
 * name either gains is refused too.
 */
const isReserved = (name: string): boolean =>
  name in Object.prototype ||
  name in RpcPromise.prototype ||
  name in RpcStub.prototype ||
  // A Worker's own (a WorkerEntrypoint's), and what disposes a stub.
  name === "fetch" ||
  name === "connect" ||
  name === "dispose";

/**
 * `value` as the method names of a capability: at most {@link maxMethods},
 * each a plain name no stub answers itself; undefined for anything else.
 */
export const declaredMethodsOf = (value: unknown): string[] | undefined =>
  Array.isArray(value) &&
  value.length <= maxMethods &&
  value.every(
    (name) =>
      typeof name === "string" && methodName.test(name) && !isReserved(name)
  )
    ? value.map(String)
    : undefined;

/** Calls `name` on `target`, or `target` itself without a name. */
export const invoke = async (
  target: unknown,
  name: string | undefined,
  args: unknown[]
): Promise<unknown> => {
  let fn: unknown = target;
  if (name !== undefined) {
    fn =
      typeof target === "object" || typeof target === "function"
        ? Reflect.get(target ?? {}, name)
        : undefined;
  }
  if (typeof fn !== "function") {
    throw new TypeError("That capability has no such method.");
  }
  return await Reflect.apply(fn, target, args);
};

/**
 * What crosses from core to the isolate as an argument of a callback: a
 * capability core marked becomes one of exactly its methods (a capnweb
 * stub never reaches the isolate, which couldn't take it, and whose every
 * name a stub answers); anything else goes as it is.
 */
const inward = (value: unknown): unknown => {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, capabilityMarker)
  ) {
    return value;
  }
  const methods = declaredMethodsOf(Reflect.get(value, capabilityMarker));
  const target: unknown = Reflect.get(value, "target");
  if (methods === undefined || target === undefined || target === null) {
    throw new TypeError(
      "A capability core passed isn't in the expected shape."
    );
  }
  // oxlint-disable-next-line no-use-before-define -- each refers to the other: a capability's arguments may hold callbacks, a callback's capabilities
  return objectCapability(target, methods);
};

/** Disposes `stub` where it is disposable: a workerd stub, say. */
const disposeOf = (stub: object): void => {
  const dispose: unknown = Reflect.get(stub, Symbol.dispose);
  if (typeof dispose === "function") {
    Reflect.apply(dispose, stub, []);
  }
};

/**
 * What crosses from the isolate to core: a function becomes one capnweb can
 * pass by reference (it calls back into the isolate, its arguments as
 * `inward` makes them); anything else goes as it is, and core checks it as
 * it checks every argument. A function core keeps past the call that
 * passed it (a live query's callback in an App's tests) still reaches the
 * isolate: workerd lets go of a stub it passed a call once that call
 * returns, unless it's duplicated, so it's duplicated here, and let go of
 * once core lets go of it (capnweb disposes what it exported then), or as
 * the session's process ends after its one call.
 */
export const outward = (value: unknown): unknown => {
  if (typeof value !== "function") {
    return value;
  }
  const dup: unknown = Reflect.get(value, "dup");
  const kept: unknown =
    typeof dup === "function" ? Reflect.apply(dup, value, []) : value;
  return Object.assign(
    async (...args: unknown[]) =>
      await invoke(kept, undefined, args.map(inward)),
    {
      [Symbol.dispose]: (): void => {
        if (
          kept !== value &&
          (typeof kept === "object" || typeof kept === "function") &&
          kept !== null
        ) {
          disposeOf(kept);
        }
      },
    }
  );
};

/** A workerd RpcTarget with exactly `methods`, each forwarding to `stub`. */
export const objectCapability = (
  stub: unknown,
  methods: readonly string[]
): RpcTarget => {
  class Capability extends RpcTarget {}
  for (const name of methods) {
    Object.defineProperty(Capability.prototype, name, {
      value: async (...args: unknown[]) =>
        await invoke(stub, name, args.map(outward)),
    });
  }
  return new Capability();
};
