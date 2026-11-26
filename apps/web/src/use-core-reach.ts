import { useRouter } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

import type { CoreConnection, CoreReach } from "./core-connection.ts";

// What a component reads of the tab's connection to core itself: whether
// Grasp can be reached, and keeping it checked while something depends on
// hearing from core. Each reads the router's context as what it may be: a
// router with no context, or a test's stand-in for core, has none to ask.

/** What these read of the connection. */
type Reads = "reach" | "watchReach" | "keepAlive" | "holdHeartbeat";

/** The tab's connection, as far as the router's context has one. */
const useConnection = (): Partial<Pick<CoreConnection, Reads>> | undefined => {
  const context: { core?: Partial<Pick<CoreConnection, Reads>> } | undefined =
    useRouter().options.context;
  return context?.core;
};

const noWatching = () => () => {
  // Nothing to stop.
};

/**
 * Whether Grasp can be reached, as the tab's connection finds it, kept
 * current; none where the page has no connection to ask (a stand-in in a
 * test), so no line is said that isn't known.
 */
export const useCoreReach = (): CoreReach | undefined => {
  const core = useConnection() ?? {};
  const known = typeof core.watchReach === "function";
  return useSyncExternalStore(
    (changed) => core.watchReach?.(changed) ?? noWatching(),
    () => (known ? core.reach : undefined)
  );
};

/**
 * Keeps the tab's connection checked while `depends`
 * (`CoreConnection.keepAlive`).
 */
export const useKeepAlive = (depends: boolean): void => {
  const core = useConnection();
  useEffect(() => {
    if (!depends || core?.keepAlive === undefined) {
      return noWatching();
    }
    return core.keepAlive();
  }, [depends, core]);
};

/**
 * Holds off the tab's connection's heartbeat while a large message goes
 * out (`CoreConnection.holdHeartbeat`): returns what lets it go.
 */
export const useHoldHeartbeat = (): (() => () => void) => {
  const core = useConnection();
  return () => core?.holdHeartbeat?.() ?? noWatching();
};
