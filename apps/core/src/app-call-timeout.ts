import { platformLimits } from "@grasp-os/shared/platform-limits";

/**
 * How long one call of an App's sealed function may take in all, starting
 * its code and waiting included: a run step's call ends by then (its
 * deadline, app-functions.ts), and so does the session of the isolate
 * that runs it (release-runner.ts). A server invocation's wall time
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
