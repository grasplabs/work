// What the runner checks a step's options by. Internal to the SDK: neither
// workflow code nor the runtime imports this module.

import {
  maxAttemptTimeoutMs,
  maxStepRetries,
} from "@grasp-os/shared/workflows";
import { z } from "zod";

import { paramValueSchemas } from "./params.ts";
import type { CaughtError, RetryChoice } from "./workflow-steps.ts";

// Step names become part of engine step names and idempotency keys
// (`runId:name`), so they never contain `:`, `#` or `$`, which the SDK uses
// for per-item keys and its own step names.
export const namePattern = /^[A-Za-z][\w-]{0,63}$/u;

/** What {@link namePattern} allows, for error messages. */
export const nameRule =
  'up to 64 letters, digits, "-" or "_", starting with a letter';

/**
 * The name the engine gets for a step: its name, `name:key` for a keyed step
 * (the key URI-encoded), plus `#part` for the parts of a decision
 * (`review#ask`). The SDK's own step (parameters) starts with `$`.
 */
export const engineStepPattern = new RegExp(
  // namePattern without its anchors.
  `^(?<name>${namePattern.source.slice(1, -1)})(?::(?<key>[^#]+))?(?:#(?<part>[\\w-]+))?$`,
  "u"
);

// Durations

/** The units a duration is written in, largest first, in milliseconds. */
export const durationUnits = [
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
] as const;

const unitMilliseconds = new Map<string, number>(durationUnits);
const durationPattern =
  /^(?<amount>\d+(?:\.\d+)?) (?<unit>second|minute|hour|day|week)s?$/u;
/** The longest wait the SDK allows, which every engine it targets supports. */
const maxDuration = 365 * 86_400_000;

const millisecondsOf = (duration: number | string): number => {
  if (typeof duration === "number") {
    return duration;
  }
  const match = durationPattern.exec(duration);
  return match
    ? Number(match.groups?.amount) *
        (unitMilliseconds.get(match.groups?.unit ?? "") ?? Number.NaN)
    : Number.NaN;
};

/**
 * A time span, e.g. `"3 days"` or a number of milliseconds, as whole
 * milliseconds between 1 and 365 days' worth.
 */
const durationSchema = z
  .union([z.number(), z.string()])
  .transform((duration, context) => {
    const milliseconds = millisecondsOf(duration);
    if (
      !Number.isInteger(milliseconds) ||
      milliseconds <= 0 ||
      milliseconds > maxDuration
    ) {
      context.issues.push({
        code: "custom",
        input: duration,
        message: `"${duration}" isn't a duration of whole milliseconds, up to 365 days, e.g. "3 days"`,
      });
      return z.NEVER;
    }
    return milliseconds;
  });

// Step options

const maxKeyLength = 128;
const text = z.string().trim().min(1);

const common = {
  description: text,
  key: z
    .union([
      // Encoded into the engine's step name; ill-formed text can't be.
      z
        .string()
        .refine(
          (key) =>
            key !== "" &&
            key.isWellFormed() &&
            encodeURIComponent(key).length <= maxKeyLength
        ),
      z.number().refine(Number.isFinite),
    ])
    .optional(),
};

// Refused here, where the step is written, rather than held to the
// platform's ceilings at run time without the author seeing it: a
// declaration may only be stricter. The host refuses the same
// for code that gets past the SDK.
const retries = z
  .strictObject({
    limit: z
      .int()
      .min(0)
      .max(maxStepRetries, {
        message: `A step retries at most ${maxStepRetries} times, ${maxStepRetries + 1} attempts in all`,
      }),
    delay: durationSchema.optional(),
    backoff: z.enum(["constant", "linear", "exponential"]).optional(),
  })
  .optional();
/** How long one attempt of a step may run: up to a minute. */
const attemptTimeout = durationSchema
  .refine((milliseconds) => milliseconds <= maxAttemptTimeoutMs, {
    message: `A step attempt's timeout is at most ${maxAttemptTimeoutMs / 1000} seconds, e.g. "30 seconds": a longer step is split into steps, or waits with step.sleep or a decision`,
  })
  .optional();

/** What each `step` method takes, checked at run time. */
export const stepOptionSchemas = {
  do: z.strictObject({
    ...common,
    retries,
    timeout: attemptTimeout,
    input: z.json().optional(),
  }),
  decision: z.strictObject({
    ...common,
    from: paramValueSchemas.person,
    timeout: durationSchema,
  }),
  sleep: z.strictObject({
    ...common,
    duration: durationSchema,
  }),
};

/**
 * What the steps only generated workflows run take (`step.sleepUntil`,
 * `step.caught`, `step.listen`, and `do`'s `retry`), whose engine methods
 * only a sealed build's run host has.
 */
export const generatedStepOptionSchemas = {
  sleepUntil: z.strictObject({
    ...common,
    until: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  caught: z.strictObject(common),
  listen: z.strictObject(common),
  /** A `do` step's `retry` option, which only generated code passes. */
  retry: z
    .custom<(error: CaughtError) => Promise<RetryChoice | null>>(
      (value) => typeof value === "function"
    )
    .optional(),
};
