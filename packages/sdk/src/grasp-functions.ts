import { identifierMaxLength } from "@grasp-os/shared/identifier";
import type {
  PlatformMeasure,
  platformMeasures,
} from "@grasp-os/shared/platform-measures";

import type { AnySchema } from "./value-schema.ts";
import { v } from "./values.ts";
import type { ValueShape } from "./values.ts";

/**
 * One of the platform's read-only functions (`graspFunctions`): a query,
 * its arguments a map of field schemas, and its return.
 */
interface GraspFunctionConfig<
  Shape extends ValueShape = ValueShape,
  Returns extends AnySchema = AnySchema,
> {
  readonly kind: "query";
  readonly args: Shape;
  readonly returns: Returns;
}

/** The measures the platform publishes (`platformMeasures`). */
const measureNames = [
  "platform.workflow_runs",
  "platform.improvement_signals",
] as const satisfies readonly PlatformMeasure[];

/** The dimensions of the platform's measures. */
const measureDimensions = [
  "app",
  "workflow",
  "kind",
] as const satisfies readonly (typeof platformMeasures)[PlatformMeasure][number][];

/**
 * The platform's read-only functions an App reaches under alias `grasp`
 * (`permission.grasp`), by path:
 *
 * - `statistics.read`: a measure the platform publishes (such as the runs
 *   of Apps' workflows) over the last `days` × 24 hours up to `until`,
 *   of one App (`where.app`, narrowed by its other dimensions) or up to
 *   100 (`apps`), added up by the dimensions in `groupBy`, the page of
 *   groups from `offset` on. It counts only Apps whose runs the person
 *   the call acts for may see, and names the rest `unavailable`.
 */
export const graspFunctions = Object.freeze({
  "statistics.read": {
    kind: "query",
    args: {
      measure: v.enum(measureNames),
      days: v.number().integer().min(1).max(366),
      where: v.record(v.string().min(1).max(128)).default({}),
      apps: v
        .array(v.string().min(1).max(identifierMaxLength))
        .min(1)
        .max(100)
        .optional(),
      offset: v.number().integer().min(0).max(10_000).default(0),
      until: v.string().optional(),
      groupBy: v.array(v.enum(measureDimensions)).max(3).default([]),
    },
    returns: v.object({
      measure: v.string(),
      from: v.string(),
      to: v.string(),
      groups: v.array(
        v.object({
          dimensions: v.record(v.string().nullable()),
          count: v.number(),
          sum: v.number(),
          min: v.number(),
          max: v.number(),
        })
      ),
      truncated: v.boolean(),
      unavailable: v.array(v.string()).optional(),
      computation: v.string().nullable().optional(),
    }),
  },
} as const satisfies Readonly<Record<string, GraspFunctionConfig>>);

/** The platform's read-only functions, as `ctx.grasp` calls them. */
export type GraspFunctions = typeof graspFunctions;
