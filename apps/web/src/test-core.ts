import type { CoreApi } from "@grasp-os/shared/rpc";
import type { RpcStub } from "capnweb";

// One stand-in for core's API as the tab's connection reaches it
// (core-connection.ts), for every test that runs a `CoreConnection` on a
// fake core: it has each method the connection itself calls, so a test
// that only means to fake what a page reads never leaves one out, and a
// method the connection comes to call is added here, once, for them all.

/** What the tab's connection calls on core's API itself, never a page. */
export interface CoreStandIn {
  /** Signs the connection in: what a test fakes a page's reads on. */
  authenticate: () => Promise<unknown>;
  /** Whether the socket still answers (`CoreConnection`'s probe and status). */
  ping: () => Promise<string>;
  /** How people sign in here (`coreStatus`). */
  signInOptions: () => Promise<unknown[]>;
  /** Hears the socket break. */
  onRpcBroken: (onBroken: () => void) => void;
  [Symbol.dispose]: () => void;
}

/**
 * Core's API on a fake core: `authenticate` as the test has it, and the
 * rest as a socket that answers and never breaks, unless `parts` says
 * otherwise. The stand-in itself is returned too, for a test that changes
 * it as it runs.
 */
export const coreStandIn = (
  parts: Pick<CoreStandIn, "authenticate"> & Partial<CoreStandIn>
): { api: RpcStub<CoreApi>; standIn: CoreStandIn } => {
  const standIn: CoreStandIn = {
    ping: async () => await Promise.resolve("pong"),
    signInOptions: async () => await Promise.resolve([]),
    onRpcBroken: () => {
      // This one never breaks.
    },
    [Symbol.dispose]: () => {
      // Nothing to let go of.
    },
    ...parts,
  };
  // SAFETY: the connection reaches only what `CoreStandIn` names, which
  // this has; a page reaches only what the test's `authenticate` gives.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
  return { api: standIn as unknown as RpcStub<CoreApi>, standIn };
};
