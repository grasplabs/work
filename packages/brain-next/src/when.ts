import { Temporal } from "temporal-polyfill";
import { z } from "zod";

import { valueMaxLength } from "./contract.ts";

// The dates a memory names, resolved in code (extraction.ts). The model
// never does date arithmetic: it says what the text says, a date written
// out, or a relative phrase as a structure ("next Friday" is a Friday,
// some weeks on; "in two weeks" is an offset), and this resolves it with
// Temporal's calendar against the day the words were said, in the
// company's time zone. What the structure can't hold ("end of the
// quarter") stays the phrase, unresolved: never a guess.

/** A date as a text names it, for the model to give and code to resolve. */
export const whenSchema = z.discriminatedUnion("kind", [
  /** A date written out in the text, as an ISO date. */
  z.strictObject({ kind: z.literal("date"), date: z.iso.date() }),
  /**
   * An offset from the day said ("tomorrow", "in two weeks", "last
   * month"). Bounded by Temporal's own range of dates: one past it is
   * unresolved (`resolveWhen`).
   */
  z.strictObject({
    kind: z.literal("offset"),
    days: z.int().optional(),
    weeks: z.int().optional(),
    months: z.int().optional(),
    years: z.int().optional(),
  }),
  /**
   * A weekday, 1 (Monday) to 7 (Sunday), counted in whole weeks from the
   * day said: 0 is the first one after it ("next Friday" said on a
   * Wednesday, when the text means that week's), 1 the one after that;
   * -1 the last one before it ("last Friday"), -2 the one before that.
   */
  z.strictObject({
    kind: z.literal("weekday"),
    weekday: z.int().min(1).max(7),
    weeks: z.int(),
  }),
  /** A date no structure above holds: the phrase, kept as said (it becomes a memory's value). */
  z.strictObject({
    kind: z.literal("phrase"),
    phrase: z.string().min(1).max(valueMaxLength),
  }),
]);
export type When = z.infer<typeof whenSchema>;

/** A date resolved (an ISO date), the phrase that couldn't be, or none: past Temporal's range. */
export type Resolved = { date: string } | { phrase: string } | null;

/** The calendar day `at` falls on in `timeZone`. */
export const dayOf = (at: Date, timeZone: string): Temporal.PlainDate =>
  Temporal.Instant.fromEpochMilliseconds(at.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();

const daysInWeek = 7;

/** `when` as a date counted from `said` (below); throws past Temporal's range. */
const dateOf = (when: When, said: Temporal.PlainDate): Resolved => {
  switch (when.kind) {
    case "date": {
      return { date: Temporal.PlainDate.from(when.date).toString() };
    }
    case "offset": {
      const { days = 0, weeks = 0, months = 0, years = 0 } = when;
      return { date: said.add({ days, weeks, months, years }).toString() };
    }
    case "weekday": {
      // 1 to 7 days on: the first such weekday strictly after the day said;
      // or 1 to 7 days back: the last one strictly before it.
      const after =
        ((when.weekday - said.dayOfWeek + daysInWeek - 1) % daysInWeek) + 1;
      const before =
        ((said.dayOfWeek - when.weekday + daysInWeek - 1) % daysInWeek) + 1;
      const days =
        when.weeks >= 0
          ? after + when.weeks * daysInWeek
          : -before + (when.weeks + 1) * daysInWeek;
      return { date: said.add({ days }).toString() };
    }
    case "phrase": {
      return { phrase: when.phrase };
    }
    default: {
      throw new Error("Unknown kind of date");
    }
  }
};

/**
 * `when` as a date, counted from `said`, the day the words were said: by
 * Temporal's ISO calendar (a month on from 31 January is the last of
 * February). A date written out is taken as written. None when it falls
 * outside the dates Temporal holds.
 */
export const resolveWhen = (when: When, said: Temporal.PlainDate): Resolved => {
  try {
    return dateOf(when, said);
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
};

/**
 * The moment the day `date` ends in `timeZone`: the start of the day
 * after, so a fact "until Friday" holds all of Friday.
 */
export const endOfDay = (date: string, timeZone: string): Date =>
  new Date(
    Temporal.PlainDate.from(date)
      .add({ days: 1 })
      .toZonedDateTime({ timeZone })
      .toInstant().epochMilliseconds
  );
