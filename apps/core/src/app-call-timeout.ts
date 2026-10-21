import { platformLimits } from "@grasp-os/shared/platform-limits";

/**
 * How long one call may take in all, starting the code and waiting
 * included, before the host gives up on it: its caller gets
 * `app.timed_out`, and its token stops working, so a call that never ends
 * can't keep acting for its caller. A server invocation's wall time
 * (spec 18.1); tests shorten it with `APP_CALL_TIMEOUT_MS`, which can
 * only lower it, and it is never set in wrangler.jsonc.
 */
const defaultCallTimeoutMs = platformLimits.serverInvocationWallMs;

export const callTimeoutMs = (
  env: Pick<Env, "APP_CALL_TIMEOUT_MS">
): number => {
  const set = Number(env.APP_CALL_TIMEOUT_MS);
  return Number.isInteger(set) && set > 0 && set < defaultCallTimeoutMs
    ? set
    : defaultCallTimeoutMs;
};
