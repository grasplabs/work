/**
 * The capabilities an isolate gets in a sandbox session
 * (sandbox-session.ts): workerd RpcTargets, each with exactly the methods
 * core named, forwarding to the session's capnweb stub. The isolate calls
 * them over workerd's own RPC; what it passes goes on to core, which
 * bounds and checks every argument where it lands (sandboxed.ts).
 */
// oxlint-disable-next-line no-restricted-imports -- a forwarder to core, which bounds what arrives; it holds nothing itself
import { RpcTarget } from "cloudflare:workers";

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
 * What crosses from the isolate to core: a function becomes one capnweb can
 * pass by reference (it calls back into the isolate); anything else goes as
 * it is, and core checks it as it checks every argument.
 */
export const outward = (value: unknown): unknown =>
  typeof value === "function"
    ? async (...args: unknown[]) => await invoke(value, undefined, args)
    : value;

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
