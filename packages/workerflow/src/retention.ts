// How long a run is kept once it has ended, as the reference says it: a
// run's own `retention` ({ successRetention?, errorRetention? }), else the
// binding's default, else Grasp's product setting. The success retention
// counts after a run completed or was terminated, the error retention
// after it errored.
//
// The values are bounded by the host's limits, 1 to 30 days unless the
// host says otherwise: Grasp's existing retention setting, kept on purpose
// rather than inheriting a managed engine's plan maxima. A value outside
// them is refused, never cut to fit. The clock starts when the run ends
// (run.ts), so no retention ever removes a run that is still to end.
import { describe, isPlainObject, readSettings } from "./config.ts";
import type { WorkflowDuration } from "./contracts.ts";
import { parseDuration } from "./durations.ts";

const dayMs = 24 * 60 * 60 * 1000;

/** Grasp's retention when nothing says otherwise: 30 days. */
export const defaultRetentionMs = 30 * dayMs;

/** The shortest and longest retention Grasp takes, unless the host says. */
export const defaultRetentionLimits: RetentionLimits = {
  minMs: dayMs,
  maxMs: 30 * dayMs,
};

/**
 * The greatest limit a host may set: 365 days, the longest wait, so a
 * run's end plus its retention is always a time an alarm takes.
 */
export const maxRetentionLimitMs = 365 * dayMs;

export interface RetentionLimits {
  readonly minMs: number;
  readonly maxMs: number;
}

/** A run's retention, resolved: milliseconds after each kind of end. */
export interface Retention {
  readonly successMs: number;
  readonly errorMs: number;
}

/** A retention as a caller gives it, in the reference's shape. */
export interface RetentionOptions {
  readonly successRetention?: WorkflowDuration;
  readonly errorRetention?: WorkflowDuration;
}

/** The host's limits, checked: whole milliseconds, from 1. */
export const readRetentionLimits = (
  limits: RetentionLimits | undefined
): RetentionLimits => {
  if (limits === undefined) {
    return defaultRetentionLimits;
  }
  const { minMs, maxMs } = limits;
  if (
    !Number.isSafeInteger(minMs) ||
    !Number.isSafeInteger(maxMs) ||
    minMs < 1 ||
    maxMs > maxRetentionLimitMs
  ) {
    throw new TypeError(
      `Retention limits are whole milliseconds from 1 to 365 days: ${String(minMs)} to ${String(maxMs)}`
    );
  }
  if (maxMs < minMs) {
    throw new TypeError(
      `Retention limits run from the least to the greatest: ${minMs} to ${maxMs}`
    );
  }
  return { minMs, maxMs };
};

const readOne = (
  value: unknown,
  what: string,
  fallback: number,
  limits: RetentionLimits
): number => {
  if (value === undefined) {
    return fallback;
  }
  const ms = parseDuration(value, what);
  if (ms < limits.minMs || ms > limits.maxMs) {
    throw new TypeError(
      `${what} is from ${limits.minMs} to ${limits.maxMs} milliseconds: ${JSON.stringify(value)}`
    );
  }
  return ms;
};

/**
 * `retention`, read once each and checked against `limits`; what it leaves
 * out is `fallback`'s. An unknown setting, or a value outside the limits,
 * is refused.
 */
export const readRetention = (
  retention: unknown,
  what: string,
  fallback: Retention,
  limits: RetentionLimits
): Retention => {
  if (retention === undefined) {
    return fallback;
  }
  if (!isPlainObject(retention)) {
    throw new TypeError(
      `${what} is { successRetention?, errorRetention? }, not ${retention === null ? "null" : describe(retention)}`
    );
  }
  const { successRetention, errorRetention } = readSettings(what, retention, [
    "successRetention",
    "errorRetention",
  ] as const);
  return {
    successMs: readOne(
      successRetention,
      `${what}'s successRetention`,
      fallback.successMs,
      limits
    ),
    errorMs: readOne(
      errorRetention,
      `${what}'s errorRetention`,
      fallback.errorMs,
      limits
    ),
  };
};
