import { z } from "zod";

import { sha256Hex } from "./encoding.ts";
import { platformLimits } from "./platform-limits.ts";

// A deployment's quota policy: the platform's limits (platform-limits.ts),
// with whichever of them the deployment's operator lowered. Set by the
// console as the `QUOTA_LIMITS` var and parsed by core with this schema,
// which the console also checks before it deploys, so neither ever takes
// a value above the platform's: a limit is lowered here, and raised only
// by a release that changes the platform's, with the evidence that takes.
//
// Only the limits core reads through the policy are listed: setting one
// that nothing enforces would claim a limit that doesn't hold. Each is
// read at the moment of each admission (a run's step, a step's attempt,
// a child run's start, a provider request to a model), never kept with
// what was admitted before, so a changed policy applies to every admission
// after it, and to none before.

/**
 * The limits a deployment's operator may lower. Each is a ceiling core
 * checks as it admits work: a run's steps, a step's attempts (its first
 * included), the levels and descendant runs of a run lineage, the
 * lineage's active execution and age, the provider requests it sends to
 * models (core's model ledger, model-budgets.ts), the host calls its
 * attempts make, the attempts running at once in the client, for one
 * person and of one App, the steps waiting for a share, for one person and
 * of one App, how long one step waits, the independent workflows and
 * live triggers one person creates (core's workflow-resources.ts,
 * trigger-resources.ts), and the provider requests to models in flight at
 * once in the client, for one person and of one App, with the calls
 * waiting for a share (core's model ledger, model-admission.ts), and the
 * build jobs building at once in the client and of one App (core's
 * build-admission.ts).
 */
export const lowerableLimits = [
  "workflowSteps",
  "workflowAttemptsPerStep",
  "workflowNestingLevels",
  "workflowDescendantRuns",
  "workflowActiveMs",
  "workflowAgeMs",
  "lineageModelRequests",
  "lineageHostCalls",
  "workflowResourcesPerPerson",
  "workflowClientAttempts",
  "workflowPersonAttempts",
  "workflowAppAttempts",
  "workflowQueuedPerPerson",
  "workflowQueuedPerApp",
  "workflowQueuedStepMs",
  "triggerResourcesPerPerson",
  "modelClientRequests",
  "modelPersonRequests",
  "modelAppRequests",
  "modelQueuedPerPerson",
  "modelQueuedPerApp",
  "tenantBuildJobs",
  "keyBuildJobs",
] as const;

export type LowerableLimit = (typeof lowerableLimits)[number];

/** A lowered value of `name`: a whole number, at least 1, at most the platform's. */
const lowered = (name: LowerableLimit) =>
  z.int().min(1).max(platformLimits[name]).optional();

/**
 * `QUOTA_LIMITS`: `{ generation, limits }`. `generation` is the policy's
 * own number, which whoever sets the policy raises with every change.
 * Core is the authority: it records each generation's limits the first
 * time it sees it, and applies only the highest it recorded, as recorded,
 * refusing (and logging) a lower generation or other limits under a
 * recorded one (core's src/workflows/quotas.ts, `quotaPolicy`). Each
 * admission records the generation it was admitted under. `limits` lowers
 * some of {@link lowerableLimits}; a value above the platform's, or a name
 * not listed, refuses the whole var.
 */
export const quotaLimitsSchema = z.strictObject({
  generation: z.int().min(1),
  limits: z.strictObject({
    workflowSteps: lowered("workflowSteps"),
    workflowAttemptsPerStep: lowered("workflowAttemptsPerStep"),
    workflowNestingLevels: lowered("workflowNestingLevels"),
    workflowDescendantRuns: lowered("workflowDescendantRuns"),
    workflowActiveMs: lowered("workflowActiveMs"),
    workflowAgeMs: lowered("workflowAgeMs"),
    lineageModelRequests: lowered("lineageModelRequests"),
    lineageHostCalls: lowered("lineageHostCalls"),
    workflowResourcesPerPerson: lowered("workflowResourcesPerPerson"),
    workflowClientAttempts: lowered("workflowClientAttempts"),
    workflowPersonAttempts: lowered("workflowPersonAttempts"),
    workflowAppAttempts: lowered("workflowAppAttempts"),
    workflowQueuedPerPerson: lowered("workflowQueuedPerPerson"),
    workflowQueuedPerApp: lowered("workflowQueuedPerApp"),
    workflowQueuedStepMs: lowered("workflowQueuedStepMs"),
    triggerResourcesPerPerson: lowered("triggerResourcesPerPerson"),
    modelClientRequests: lowered("modelClientRequests"),
    modelPersonRequests: lowered("modelPersonRequests"),
    modelAppRequests: lowered("modelAppRequests"),
    modelQueuedPerPerson: lowered("modelQueuedPerPerson"),
    modelQueuedPerApp: lowered("modelQueuedPerApp"),
    tenantBuildJobs: lowered("tenantBuildJobs"),
    keyBuildJobs: lowered("keyBuildJobs"),
  } satisfies Record<LowerableLimit, z.ZodType>),
});

/** The limits in force, and the generation of the policy that set them. */
export interface QuotaPolicy {
  /** 0 for the platform's own, with no `QUOTA_LIMITS` set. */
  generation: number;
  limits: Readonly<Record<LowerableLimit, number>>;
}

/**
 * The policy a parsed `QUOTA_LIMITS` sets: each limit it lowers, the
 * platform's for the rest. None set, or none that parsed, is the
 * platform's own policy (generation 0): the qualified ceilings, never
 * anything higher.
 */
export const quotaPolicyOf = (
  configured?: z.output<typeof quotaLimitsSchema>
): QuotaPolicy => {
  const limits: Record<LowerableLimit, number> = {
    workflowSteps: platformLimits.workflowSteps,
    workflowAttemptsPerStep: platformLimits.workflowAttemptsPerStep,
    workflowNestingLevels: platformLimits.workflowNestingLevels,
    workflowDescendantRuns: platformLimits.workflowDescendantRuns,
    workflowActiveMs: platformLimits.workflowActiveMs,
    workflowAgeMs: platformLimits.workflowAgeMs,
    lineageModelRequests: platformLimits.lineageModelRequests,
    lineageHostCalls: platformLimits.lineageHostCalls,
    workflowResourcesPerPerson: platformLimits.workflowResourcesPerPerson,
    workflowClientAttempts: platformLimits.workflowClientAttempts,
    workflowPersonAttempts: platformLimits.workflowPersonAttempts,
    workflowAppAttempts: platformLimits.workflowAppAttempts,
    workflowQueuedPerPerson: platformLimits.workflowQueuedPerPerson,
    workflowQueuedPerApp: platformLimits.workflowQueuedPerApp,
    workflowQueuedStepMs: platformLimits.workflowQueuedStepMs,
    triggerResourcesPerPerson: platformLimits.triggerResourcesPerPerson,
    modelClientRequests: platformLimits.modelClientRequests,
    modelPersonRequests: platformLimits.modelPersonRequests,
    modelAppRequests: platformLimits.modelAppRequests,
    modelQueuedPerPerson: platformLimits.modelQueuedPerPerson,
    modelQueuedPerApp: platformLimits.modelQueuedPerApp,
    tenantBuildJobs: platformLimits.tenantBuildJobs,
    keyBuildJobs: platformLimits.keyBuildJobs,
  };
  if (configured === undefined) {
    return { generation: 0, limits };
  }
  for (const name of lowerableLimits) {
    const value = configured.limits[name];
    // The schema caps each at the platform's; `min` keeps it so whatever
    // reached here.
    if (value !== undefined) {
      limits[name] = Math.min(value, limits[name]);
    }
  }
  return { generation: configured.generation, limits };
};

/**
 * `limits` as text that is the same for the same limits, in any order:
 * what core records a generation's limits as, and hashes.
 */
export const canonicalLimits = (
  limits: Readonly<Record<string, number | undefined>>
): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(limits)
        .filter(([, value]) => value !== undefined)
        .toSorted(([a], [b]) => a.localeCompare(b))
    )
  );

/**
 * The hash of a policy's limits (SHA-256 of `canonicalLimits`, hex): what
 * core records with a generation, and what the console compares, so two
 * policies under one generation with other limits never read as one.
 */
export const quotaLimitsHash = async (
  limits: Readonly<Record<string, number | undefined>>
): Promise<string> => await sha256Hex(canonicalLimits(limits));
