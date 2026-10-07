// How long a sleep or an event wait lasts, in Cloudflare Workflows' terms:
// a number of milliseconds, or a string
// such as "10 seconds" or "1.5 hours". The units are the reference's own
// (a month is 30 days, a year 365.25), and only the documented form is
// accepted: no other spacing, no bare numeric strings, no negatives.
import { namedError } from "./errors.ts";

const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;

const units = new Map<string, number>([
  ["second", second],
  ["minute", minute],
  ["hour", hour],
  ["day", day],
  ["week", 7 * day],
  ["month", 30 * day],
  ["year", 365.25 * day],
]);

const durationPattern =
  /^(?<amount>\d+(?:\.\d+)?) (?<unit>second|minute|hour|day|week|month|year)s?$/u;

/** The longest sleep or event wait: Cloudflare Workflows' documented 365 days. */
export const maxWaitMs = 365 * day;

/** How long `waitForEvent` waits when it's given no timeout. */
export const defaultEventTimeoutMs = day;

/**
 * The milliseconds `duration` stands for, whole and between 0 and
 * `maxWaitMs`; a TypeError for anything else.
 */
export const parseDuration = (duration: unknown, what: string): number => {
  let ms: number | undefined;
  if (typeof duration === "number") {
    ms = duration;
  } else if (typeof duration === "string") {
    const groups = durationPattern.exec(duration)?.groups;
    const unit = units.get(groups?.unit ?? "");
    ms = unit === undefined ? undefined : Number(groups?.amount) * unit;
  }
  if (ms === undefined || !Number.isFinite(ms) || ms < 0 || ms > maxWaitMs) {
    throw new TypeError(
      `${what} is a number of milliseconds or a duration such as "10 seconds", from 0 up to 365 days: ${JSON.stringify(duration)}`
    );
  }
  // A deadline is a whole millisecond, never earlier than asked.
  return Math.ceil(ms);
};

/** What an event wait that ran out throws, on first run and on replay. */
export const waitTimedOut = (timeoutMs: number): Error =>
  namedError(
    "WorkflowTimeoutError",
    `Execution timed out after ${timeoutMs}ms`
  );
