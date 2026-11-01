import type { RouterTarget } from "@grasp-os/shared/router";

// How the admin reaches a Grasp Cloud client's core: its script in the
// clients' dispatch namespace, through the admin's own binding of it
// (`DISPATCHER`, the namespace the router binds), Cloudflare's internal
// route, never over the public internet (GRA-283). Every call the admin
// makes to a core (its health, the smoke check and probe, the snapshot,
// onboarding, kickoff, AI status, a staff question) goes through here.
// The internal route doesn't replace authentication: each request still
// carries the router secret, and signs with the client's auth secret
// where core asks for it.
//
// A map entry naming a core's own workers.dev origin (an account of its
// own, a placement since retired) is never reached at all: it reads as
// not reachable, never as a request over the internet. On-prem cores
// aren't reached either: an install calls out to Grasp (GRA-1291), so
// what it is sent arrives by another way than a `CoreAddress`.

/** Where a client's core answers, and how to send it a request. */
export interface CoreAddress {
  /** The origin a request's URL names: the client's hostname. */
  readonly origin: string;
  /** Sends a request to that core alone, through the dispatch namespace. */
  readonly fetch: typeof fetch;
}

/** The dispatch namespace, as the admin uses it: one script's Worker by name. */
export interface ClientDispatcher {
  get: (script: string) => { fetch: typeof fetch };
}

/**
 * Where `target`'s core answers for `hostname`: its script through
 * `dispatcher`. Undefined for anything the namespace can't reach (no
 * dispatcher bound, or a target that isn't a script in it), which the
 * caller reads as not reachable, never as somewhere else.
 */
export const coreAddressOf = (
  target: RouterTarget,
  hostname: string,
  dispatcher: ClientDispatcher | undefined
): CoreAddress | undefined => {
  if (target.kind !== "dispatch" || dispatcher === undefined) {
    return undefined;
  }
  const { script } = target;
  return {
    origin: `https://${hostname}`,
    fetch: async (input, init) =>
      await dispatcher.get(script).fetch(input, init),
  };
};
