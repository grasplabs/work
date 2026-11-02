import { env } from "cloudflare:workers";
import { z } from "zod";

// The quota limits a test lowers (`TEST_QUOTA_LIMITS`, quotas.ts), to
// reach one cheaply: never above the platform's.

/** The limits the tests' deployment lowers (vite.config.ts). */
export const configuredLimits: Readonly<Record<string, number>> = z
  .record(z.string(), z.int())
  .parse(env.TEST_QUOTA_LIMITS);

/**
 * What `run` returns, with the quota limits `limits` lowered, and a
 * step's retries at once; the deployment's own limits again after it.
 */
export const withQuotas = async <Result>(
  limits: Record<string, number>,
  run: () => Promise<Result>
): Promise<Result> => {
  const retryDelay = env.WORKFLOW_RETRY_DELAY_MS;
  env.TEST_QUOTA_LIMITS = limits;
  env.WORKFLOW_RETRY_DELAY_MS = "0";
  try {
    return await run();
  } finally {
    env.TEST_QUOTA_LIMITS = configuredLimits;
    if (retryDelay === undefined) {
      Reflect.deleteProperty(env, "WORKFLOW_RETRY_DELAY_MS");
    } else {
      env.WORKFLOW_RETRY_DELAY_MS = retryDelay;
    }
  }
};
