/**
 * What Chat SDK's adapters need to send from a Worker. Microsoft's Teams
 * SDK (under `@chat-adapter/teams`) and Slack's Web API (under
 * `@chat-adapter/slack`) send through axios, whose fetch adapter builds each
 * request with `cache: "default"`. workerd refuses every cache mode it
 * doesn't implement, that one included ("Unsupported cache mode: default"),
 * so every send fails, and Slack's client retries it for good. Checked on
 * 23 October 2026 with chat 4.43.0, in workerd and with
 * `cache_option_enabled`.
 *
 * `"default"` asks for what a request does without a cache mode, so
 * dropping it changes nothing a request means; any other mode reaches
 * workerd as it was, to be honoured or refused there.
 *
 * axios takes `Request` and `fetch` when its fetch adapter loads
 * (`getFetch()` at the module's top level), so the fix has to be in before
 * that: importing this module puts it in. A Worker that sends through an
 * axios-based adapter imports `@grasp-os/chat/workerd` first in its entry,
 * before anything that loads an adapter.
 */

/** Whether the fix is in, for this isolate. */
let allowed = false;

/**
 * `init` without a `cache: "default"`, which means the same. workerd's
 * types list only the modes it implements, so the mode is read untyped.
 */
const withoutDefaultCache = (
  init: RequestInit | undefined
): RequestInit | undefined => {
  const cache: unknown =
    init === undefined ? undefined : Reflect.get(init, "cache");
  if (init === undefined || cache !== "default") {
    return init;
  }
  const rest = { ...init };
  Reflect.deleteProperty(rest, "cache");
  return rest;
};

/**
 * Lets requests that ask for `cache: "default"` through `Request` and
 * `fetch` in this isolate. Importing the module calls it; calling it again
 * does nothing.
 */
export const allowDefaultCacheMode = (): void => {
  if (allowed) {
    return;
  }
  allowed = true;
  const WorkerdRequest = globalThis.Request;
  const workerdFetch = globalThis.fetch;
  // Defined rather than assigned: the subclass is what `Request` is, but
  // workerd's types give the global a shape a subclass can't spell.
  Object.defineProperty(globalThis, "Request", {
    configurable: true,
    writable: true,
    value: class extends WorkerdRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, withoutDefaultCache(init));
      }
    },
  });
  globalThis.fetch = async (input, init) =>
    await workerdFetch(input, withoutDefaultCache(init));
};

allowDefaultCacheMode();
