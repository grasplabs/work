// The measures the platform publishes to Apps' statistics (statistics.ts).
// Free of dependencies, like operation-limits.ts, because the SDK's root
// module, where a statistics resource lists the ones it reads, can't bring
// Zod along.

/** The measures the platform publishes, and the dimensions of each. */
export const platformMeasures = {
  /**
   * Each run of an App's workflow started, by its App and workflow: a
   * point of value 1, on the day it started.
   */
  "platform.workflow_runs": ["app", "workflow"],
  /**
   * Each improvement signal of the latest daily computation, by its App,
   * workflow and kind: its value (`@grasp-os/shared/signals`), on the day
   * it was computed. Its subject and evidence stay with who may read them.
   */
  "platform.improvement_signals": ["app", "workflow", "kind"],
} as const satisfies Record<string, readonly string[]>;
export type PlatformMeasure = keyof typeof platformMeasures;

/** Whether `measure` is one the platform publishes. */
export const isPlatformMeasure = (
  measure: string
): measure is PlatformMeasure => Object.hasOwn(platformMeasures, measure);
