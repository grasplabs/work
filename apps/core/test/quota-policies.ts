import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { env } from "cloudflare:workers";

// The deployment's quota policy (`QUOTA_LIMITS`) as a test sets it, as an
// operator would: each policy under a generation of its own, higher than
// any before, since core applies none lower than the highest it recorded
// (quotas.ts, `quotaPolicy`).

/** The generation of the latest policy a test set. */
let generations = 10_000;

/** The generation the latest policy was set under. */
export const lastGeneration = (): number => generations;

/** A policy setting `limits`, under a generation of its own. */
export const nextPolicy = (limits: Record<string, number>) => {
  generations += 1;
  return { generation: generations, limits };
};

/** The limits the tests' deployment sets (vite.config.ts). */
const configuredLimits = quotaLimitsSchema.parse(env.QUOTA_LIMITS).limits;

/**
 * What `run` returns, with the operator's quota policy `limits` in force,
 * and a step's retries at once; the deployment's own limits again after
 * it, under a newer generation.
 */
export const withQuotas = async <Result>(
  limits: Record<string, number>,
  run: () => Promise<Result>
): Promise<Result> => {
  const retryDelay = env.WORKFLOW_RETRY_DELAY_MS;
  env.QUOTA_LIMITS = nextPolicy(limits);
  env.WORKFLOW_RETRY_DELAY_MS = "0";
  try {
    return await run();
  } finally {
    env.QUOTA_LIMITS = nextPolicy(configuredLimits);
    if (retryDelay === undefined) {
      Reflect.deleteProperty(env, "WORKFLOW_RETRY_DELAY_MS");
    } else {
      env.WORKFLOW_RETRY_DELAY_MS = retryDelay;
    }
  }
};
