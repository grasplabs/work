import { evaluatorLimits } from "@grasp-os/workflow-expressions/limits";

/**
 * The static bounds of grasp-open-workflow/1. They bound validation itself
 * (every walk is linear in what they allow), and sit above the host's own
 * quotas (section 18), which are lower and win.
 */
export const profileLimits = {
  /** UTF-8 bytes of workflow.json. */
  maxDefinitionBytes: 1024 * 1024,
  /**
   * Arrays and objects inside one another in the definition: 16 task
   * scopes of up to 4 levels each, a 32-deep data schema (two levels a
   * schema) inside the deepest task, and its framing.
   */
  maxDefinitionDepth: 160,
  /** Values and object keys in the definition. */
  maxDefinitionValues: 250_000,
  /**
   * Literal data (arguments, `set`, event data) nests like any value an
   * expression takes or returns.
   */
  maxDataDepth: evaluatorLimits.maxJsonDepth,
  /** Tasks, reusable function bodies included. */
  maxTasks: 500,
  /**
   * Expressions in one definition. Each is compiled by jq at validation,
   * about a millisecond apiece in workerd.
   */
  maxExpressions: 1500,
  /**
   * Task lists inside one another, from the workflow's `do`: as deep as an
   * expression's task may sit.
   */
  maxScopes: evaluatorLimits.maxTaskScopes,
  maxParams: 64,
  maxBindings: 64,
  maxFunctions: 64,
  maxReusable: 64,
  maxSwitchCases: 64,
  maxForkBranches: 64,
  /** Items of an inline `for.in` array. */
  maxInlineItems: 1000,
  maxConcurrency: 8,
  maxRetryAttempts: 5,
  maxTitleLength: 200,
  maxSummaryLength: 2000,
  maxTags: 32,
  maxTagLength: 256,
  /** Duration of retry jitter, in milliseconds. */
  maxJitterMs: 60_000,
} as const;

/** The profile name a definition declares in `document.metadata.grasp`. */
export const profileName = "grasp-open-workflow/1";

/** The Open Workflow DSL version a definition declares. */
export const dslVersion = "1.0.3";
