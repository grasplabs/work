import { Temporal } from "temporal-polyfill";
import { z } from "zod";

// The dates a memory names, resolved in code (extraction.ts). The model
// never does date arithmetic: it says what the text says, a date written
// out, or a relative phrase as a structure ("next Friday" is a Friday,
// some weeks on; "in two weeks" is an offset), and this resolves it with
// Temporal's calendar against the day the words were said, in the
// company's time zone. What the structure can't hold ("end of the
// quarter") stays the phrase, unresolved: never a guess.

/** Most days, weeks, months or years an offset may name. */
const offsetMax = 3660;

/** How far ahead a weekday may be named, in weeks. */
const weeksAheadMax = 52;

/** A date as a text names it, for the model to give and code to resolve. */
export const whenSchema = z.discriminatedUnion("kind", [
  /** A date written out in the text, as an ISO date. */
  z.strictObject({ kind: z.literal("date"), date: z.iso.date() }),
  /** An offset from the day said ("tomorrow", "in two weeks"). */
  z.strictObject({
    kind: z.literal("offset"),
    days: z.int().min(-offsetMax).max(offsetMax).optional(),
    weeks: z.int().min(-offsetMax).max(offsetMax).optional(),
    months: z.int().min(-offsetMax).max(offsetMax).optional(),
    years: z.int().min(-offsetMax).max(offsetMax).optional(),
  }),
  /**
   * A weekday, 1 (Monday) to 7 (Sunday): the first one after the day
   * said, and `weeksAhead` weeks after that ("next Friday" said on a
   * Wednesday: that week's Friday, `weeksAhead` 0, or the next week's, 1,
   * as the text means it).
   */
  z.strictObject({
    kind: z.literal("weekday"),
    weekday: z.int().min(1).max(7),
    weeksAhead: z.int().min(0).max(weeksAheadMax),
  }),
  /** A date no structure above holds: the phrase, kept as said. */
  z.strictObject({
    kind: z.literal("phrase"),
    phrase: z.string().min(1).max(200),
  }),
]);
export type When = z.infer<typeof whenSchema>;

/** A date resolved (an ISO date), or the phrase that couldn't be. */
export type Resolved = { date: string } | { phrase: string };

/** The calendar day `at` falls on in `timeZone`. */
export const dayOf = (at: Date, timeZone: string): Temporal.PlainDate =>
  Temporal.Instant.fromEpochMilliseconds(at.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();

const daysInWeek = 7;

/**
 * `when` as a date, counted from `said`, the day the words were said: by
 * Temporal's ISO calendar (a month on from 31 January is the last of
 * February). A date written out is taken as written.
 */
export const resolveWhen = (when: When, said: Temporal.PlainDate): Resolved => {
  switch (when.kind) {
    case "date": {
      return { date: Temporal.PlainDate.from(when.date).toString() };
    }
    case "offset": {
      const { days = 0, weeks = 0, months = 0, years = 0 } = when;
      return { date: said.add({ days, weeks, months, years }).toString() };
    }
    case "weekday": {
      // 1 to 7 days on: the first such weekday strictly after the day said.
      const first =
        ((when.weekday - said.dayOfWeek + daysInWeek - 1) % daysInWeek) + 1;
      return {
        date: said
          .add({ days: first + when.weeksAhead * daysInWeek })
          .toString(),
      };
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
