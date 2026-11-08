import { valueLimits } from "./value-descriptor.ts";

const cronPartPattern =
  /^(?:(?<all>\*)|(?<from>\d{1,2})(?:-(?<to>\d{1,2}))?)(?:\/(?<step>\d{1,2}))?$/u;

/** The lowest and highest number of each cron field, in order. */
const cronFieldRanges = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

/** The most days each month can have, January first. */
const longestMonths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The numbers one part of a cron field names (`5`, `1-5`, `*`, `1-5/2`,
 * `*\/15`), or nothing when it isn't one. A step follows `*` or a range
 * only, and is no larger than the field's highest number.
 */
const cronPartNumbers = (
  part: string,
  lowest: number,
  highest: number
): number[] | undefined => {
  const groups = cronPartPattern.exec(part)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const { all, from, to, step } = groups;
  let first = lowest;
  let last = highest;
  if (all === undefined) {
    first = Number(from);
    last = to === undefined ? first : Number(to);
  }
  const stride = step === undefined ? 1 : Number(step);
  const stepsAnything = all !== undefined || to !== undefined;
  const valid =
    first >= lowest &&
    last <= highest &&
    first <= last &&
    stride >= 1 &&
    stride <= highest &&
    (step === undefined || stepsAnything);
  if (!valid) {
    return undefined;
  }
  const numbers: number[] = [];
  for (let number = first; number <= last; number += stride) {
    numbers.push(number);
  }
  return numbers;
};

/** The numbers a whole cron field names, or nothing when it isn't one. */
const cronFieldNumbers = (
  field: string | undefined,
  lowest: number,
  highest: number
): number[] | undefined => {
  const numbers: number[] = [];
  for (const part of (field ?? "").split(",")) {
    const named = cronPartNumbers(part, lowest, highest);
    if (named === undefined) {
      return undefined;
    }
    numbers.push(...named);
  }
  return numbers;
};

/**
 * Five cron fields (minute, hour, day of month, month, day of week) in
 * numbers, single spaces between them: `*`, `5`, `1-5`, `*\/15`, `1-5/2` and
 * lists of those, naming a time that comes (not 31 February). Names (`MON`)
 * and other dialects aren't one fixed form. Everything accepted here is
 * accepted by the parser schedules run on (`isCronExpression` in
 * `@grasp-os/shared/workflows`); values.test.ts holds the two together.
 */
export const isCron = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > valueLimits.nameLength) {
    return false;
  }
  const fields = value.split(" ");
  if (fields.length !== cronFieldRanges.length) {
    return false;
  }
  const numbers = cronFieldRanges.map(([lowest, highest], index) =>
    cronFieldNumbers(fields[index], lowest, highest)
  );
  const { 2: days, 3: months } = numbers;
  if (
    numbers.includes(undefined) ||
    days === undefined ||
    months === undefined
  ) {
    return false;
  }
  // A day of the week makes a date come whatever the day of the month says;
  // without one, some named month must be long enough for a named day.
  return (
    fields[4] !== "*" ||
    months.some((month) =>
      days.some((day) => day <= (longestMonths[month - 1] ?? 0))
    )
  );
};
