// What a workflow's sealed build may hold (core's workflow-builds.ts,
// `tasksFileSchema`) and what its run host takes: one home for the bounds
// the host reads a sealed table back with, so each generator bounds what
// it seals by the same numbers and nothing it publishes fails to load.

import { valueDepth } from "./value-depth.ts";

const day = 86_400_000;

export const sealedBuildLimits = {
  /** Tasks in one sealed table. */
  tasks: 10_000,
  /** Expressions in one sealed table. */
  expressions: 10_000,
  /**
   * Entries of one array or object of a call's template, where anything in
   * it is built at call time; a literal part, sealed as one value, isn't
   * bound by it.
   */
  templateItems: 1024,
  /** Characters of one key of such an object. */
  templateKeyLength: 1024,
  /**
   * Characters of a JSON Pointer a build seals (its task and expression
   * tables, and what it reports unsupported). A definition may hold
   * longer ones: a generator refuses a construct at one, so nothing
   * sealed fails to load.
   */
  pointerLength: 2048,
  /** Characters of one expression's code, as generated. */
  expressionLength: 8192,
  /**
   * Objects and arrays one call's arguments nest, as the host writes them
   * (core's `boundedJson`): a value as deep as the SDK takes one, and the
   * two around it a call adds.
   */
  callDepth: valueDepth + 2,
  /** The furthest ahead a deadline may be, as the engine sleeps: a year. */
  deadlineMs: 365 * day,
  /** The types one event wait takes: a filter each. */
  eventTypes: 16,
  /** Characters of an event's type, as a run's inbox keeps one. */
  eventTypeLength: 256,
} as const;
