/**
 * Durations as workflows write them. A literal in a definition is an
 * object of whole units (`{ days, hours, … }`, open-workflow's values.ts)
 * or an ISO 8601 duration of fixed units; what a duration expression
 * returns is whole milliseconds or such an ISO 8601 duration. Each means a
 * number of milliseconds, the one form a run works with.
 */

const msPerUnit = {
  W: 604_800_000n,
  D: 86_400_000n,
  H: 3_600_000n,
  M: 60_000n,
  S: 1000n,
} as const;
const isoDuration =
  /^P(?:(?<W>\d{1,12}(?:\.\d{1,9})?)W)?(?:(?<D>\d{1,12}(?:\.\d{1,9})?)D)?(?:T(?=\d)(?:(?<H>\d{1,12}(?:\.\d{1,9})?)H)?(?:(?<M>\d{1,12}(?:\.\d{1,9})?)M)?(?:(?<S>\d{1,12}(?:\.\d{1,9})?)S)?)?$/u;
const unitsInOrder = ["W", "D", "H", "M", "S"] as const;

/**
 * Whole milliseconds of an ISO 8601 duration of fixed units (weeks, days,
 * hours, minutes, seconds), computed exactly; `undefined` for a calendar
 * duration (years, months: the pattern has neither), a fraction on any but
 * the lowest-order unit given (ISO 8601 allows one only there), a fraction
 * below a millisecond, zero, more than a safe integer, or anything that
 * isn't one.
 */
export const isoDurationMs = (text: string): number | undefined => {
  const groups = isoDuration.exec(text)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const given = unitsInOrder.filter((unit) => groups[unit] !== undefined);
  if (given.slice(0, -1).some((unit) => groups[unit]?.includes(".") === true)) {
    return undefined;
  }
  let total = 0n;
  for (const [unit, ms] of Object.entries(msPerUnit)) {
    const amount = groups[unit];
    if (amount === undefined) {
      continue;
    }
    const [whole = "0", fraction = ""] = amount.split(".");
    const scale = 10n ** BigInt(fraction.length);
    const scaled = (BigInt(whole) * scale + BigInt(fraction || "0")) * ms;
    if (scaled % scale !== 0n) {
      return undefined;
    }
    total += scaled / scale;
  }
  return total > 0n && total <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(total)
    : undefined;
};

/**
 * Milliseconds of a duration value: a positive safe integer of
 * milliseconds as it is, or an ISO 8601 duration of fixed units;
 * `undefined` for anything else.
 */
export const durationMs = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  return typeof value === "string" ? isoDurationMs(value) : undefined;
};
