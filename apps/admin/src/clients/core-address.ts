import type { RouterTarget } from "@grasp-os/shared/router";

// How the admin reaches a client's core, as the router does (GRA-283): a
// core in the dispatch namespace through the admin's own binding of it
// (`DISPATCHER`, the namespace the router binds), never over the internet;
// a core in an account of its own at its workers.dev origin. Every call
// the admin makes to a core (its health, probe, snapshot, onboarding,
// kickoff, AI status, a staff question) goes through one of these.

/** Where a client's core answers, and how to send it a request. */
export interface CoreAddress {
  /** The origin a request's URL names: the client's hostname for a script. */
  readonly origin: string;
  /** Sends a request to that core alone. */
  readonly fetch: typeof fetch;
}

/** The dispatch namespace, as the admin uses it: one script's Worker by name. */
export interface ClientDispatcher {
  get: (script: string) => { fetch: typeof fetch };
}

/**
 * Where `target`'s core answers for `hostname`: its script through
 * `dispatcher`, or its origin. Undefined for a script without a
 * dispatcher to reach it by, which the caller reads as not reachable,
 * never as somewhere else.
 */
export const coreAddressOf = (
  target: RouterTarget,
  hostname: string,
  dispatcher: ClientDispatcher | undefined
): CoreAddress | undefined => {
  if (target.kind === "origin") {
    return {
      origin: target.origin,
      // Read as it's called, so the global `fetch` the runtime has then.
      fetch: async (input, init) => await fetch(input, init),
    };
  }
  if (dispatcher === undefined) {
    return undefined;
  }
  const { script } = target;
  return {
    origin: `https://${hostname}`,
    fetch: async (input, init) =>
      await dispatcher.get(script).fetch(input, init),
  };
};
