// The calendar days a text mentions, read by one closed table of written
// forms, the same where passages are indexed (words.ts `indexWords`, into
// `chunk_days`) and where a question is read (recall.ts). Neither `Intl`
// (it formats, it doesn't parse) nor `Temporal` (absent in workerd, and
// ISO only) reads dates out of running text, and no small dependency does
// it in five languages, so the forms are these, and nothing else is a
// date:
//
// 1. ISO: 2026-03-14, with a time and a zone or not (2026-03-14T09:00:00Z,
//    2026-03-14 09:00).
// 2. Numbers, day and month either way round, a four-digit year, split by
//    - / or . (14-03-2026, 3/4/2026, 14.03.2026): every reading that is a
//    day is kept, so 03/04/2026 is 3 April and 4 March.
// 3. A day, a month's name, and a year or none: 14 maart 2026, 14. März,
//    14th March 2026, 1er mars, 14 de marzo de 2026.
// 4. A month's name, a day, and a year or none: March 14th, 2026, marzo 14.
//
// Month names are each month's long and short names in English, Dutch,
// German, French and Spanish, from `Intl`, folded; a name two months share
// is left out. A short name that is only short ("mar", "ago", "dec") is a
// month only with a four-digit year beside it ("12 ago 2026" is a date,
// "a week ago 3 orders" is not); a long name is one with or without
// ("3 mars bars" and "Mars 3" are dates: accepted, a miss costs a stray
// row). Numbers with dots are read as a date both ways too ("1.2.2026").
// Two-digit years are out (they read like versions, amounts and pages),
// and so are ranges and relative days ("next Tuesday"). A form that isn't
// here is not a date, and its words are found by the words way as any
// words are: a miss costs nothing.
//
// Where two forms read overlapping text ("1. March 14, 2026"), every
// form's reading is collected and the best that don't overlap are kept: a
// reading with a year before one without, then the longer, then the
// earlier. So a numbered line's number is never taken for the day.

/** A calendar day: `year` 0 when the text names none. */
export interface Day {
  year: number;
  month: number;
  day: number;
}

/** A date a text writes: where, and the days it may be. */
export interface DateWritten {
  start: number;
  end: number;
  days: Day[];
}

/**
 * A month's name as the table compares it: lowercase, its accents off
 * ("März" is "marz", "février" is "fevrier"), its first run of
 * letters ("févr." is "fevr"). Enough for the names of five languages
 * written in Latin letters, and no other module's rules, so the word index
 * (words.ts), which reads the days a chunk writes, can import this one.
 */
const foldName = (name: string): string =>
  /\p{L}+/u.exec(
    name.normalize("NFKD").replaceAll(/\p{M}/gu, "").toLowerCase()
  )?.[0] ?? "";

/** The languages whose month names a date may be written with. */
const monthLocales = ["en", "nl", "de", "fr", "es"] as const;

/**
 * Each month's names in the five languages, folded, as one word, with
 * whether each is only ever a short name: month 1 to 12. A name two
 * months share is left out.
 */
const namesOfMonths = (): ReadonlyMap<
  string,
  { month: number; short: boolean }
> => {
  const names = new Map<string, { month: number; short: boolean }>();
  const shared = new Set<string>();
  for (const locale of monthLocales) {
    for (const style of ["long", "short"] as const) {
      const format = new Intl.DateTimeFormat(locale, {
        month: style,
        timeZone: "UTC",
      });
      for (let month = 1; month <= 12; month += 1) {
        const name = foldName(format.format(Date.UTC(2026, month - 1, 1)));
        if (name !== "") {
          const known = names.get(name);
          if (known !== undefined && known.month !== month) {
            shared.add(name);
          }
          names.set(name, {
            month,
            short: style === "short" && (known?.short ?? true),
          });
        }
      }
    }
  }
  for (const name of shared) {
    names.delete(name);
  }
  return names;
};

const monthNames = namesOfMonths();

/** The month `name` names, or 0: a short name only beside a year. */
const monthOf = (
  name: string | undefined,
  year: string | undefined
): number => {
  const known = monthNames.get(foldName(name ?? ""));
  return known === undefined || (known.short && year === undefined)
    ? 0
    : known.month;
};

/** `year`, `month` and `day` as a day, if there is one; any year when 0. */
const dayOf = (year: number, month: number, day: number): Day | undefined => {
  // A leap year stands for no year, so 29 February is a day.
  const checked = year === 0 ? 2000 : year;
  const date = new Date(Date.UTC(checked, month - 1, day));
  return (year === 0 || year >= 1000) &&
    date.getUTCFullYear() === checked &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? { year, month, day }
    : undefined;
};

/** A date form's groups, as its pattern names them. */
type Groups = Partial<
  Record<"year" | "month" | "day" | "first" | "second" | "name", string>
>;

/** No letter or digit just before. */
const before = String.raw`(?<![\p{L}\p{N}])`;

/** No digit just after (a letter may follow: an ISO time's zone). */
const after = String.raw`(?!\p{N})`;

/** An ordinal's ending after a day, in the five languages. */
const ordinal = String.raw`(?:st|nd|rd|th|ste|de|er|e|º|°|\.)?`;

/** A year after a day or a month's name: optional. */
const year = String.raw`(?:,?\s+(?:de\s+|del\s+)?(?<year>\d{4}))?`;

/** The forms (above), each with the days it reads. */
const forms: readonly [RegExp, (groups: Groups) => (Day | undefined)[]][] = [
  [
    new RegExp(
      String.raw`${before}(?<year>\d{4})-(?<month>\d{1,2})-(?<day>\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?${after}`,
      "giu"
    ),
    (groups) => [
      dayOf(Number(groups.year), Number(groups.month), Number(groups.day)),
    ],
  ],
  [
    new RegExp(
      String.raw`${before}(?<first>\d{1,2})(?<split>[-/.])(?<second>\d{1,2})\k<split>(?<year>\d{4})${after}`,
      "gu"
    ),
    ({ first, second, year: written }) => [
      dayOf(Number(written), Number(second), Number(first)),
      dayOf(Number(written), Number(first), Number(second)),
    ],
  ],
  [
    new RegExp(
      String.raw`${before}(?<day>\d{1,2})${ordinal}\s+(?:de\s+)?(?<name>\p{L}+)\.?${year}${after}`,
      "giu"
    ),
    ({ day, name, year: written }) => [
      dayOf(Number(written ?? 0), monthOf(name, written), Number(day)),
    ],
  ],
  [
    new RegExp(
      String.raw`${before}(?<name>\p{L}+)\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?${year}(?![\p{L}\p{N}])`,
      "giu"
    ),
    ({ day, name, year: written }) => [
      dayOf(Number(written ?? 0), monthOf(name, written), Number(day)),
    ],
  ],
];

/** The same day, once. */
const keyOf = ({ year: y, month, day }: Day): string => `${y}-${month}-${day}`;

/** 1 when a reading names a year, else 0: one with a year comes first. */
const hasYear = ({ days }: DateWritten): number =>
  days.some(({ year: written }) => written !== 0) ? 1 : 0;

/**
 * The dates `text` writes, in the order they start, each once: where, and
 * the days it may be (two for a numeric date valid both ways). Every
 * form's readings are collected, and the best that don't overlap kept:
 * one with a year first, then the longer, then the earlier.
 */
export const datesIn = (text: string): DateWritten[] => {
  const readings: DateWritten[] = [];
  for (const [pattern, read] of forms) {
    for (const match of text.matchAll(pattern)) {
      const days = read(match.groups ?? {}).filter(
        (day): day is Day => day !== undefined
      );
      const unique = [
        ...new Map(days.map((day) => [keyOf(day), day])).values(),
      ];
      if (unique.length > 0) {
        readings.push({
          start: match.index,
          end: match.index + match[0].length,
          days: unique,
        });
      }
    }
  }
  const kept: DateWritten[] = [];
  for (const reading of readings.toSorted(
    (a, b) =>
      hasYear(b) - hasYear(a) ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start
  )) {
    if (
      !kept.some((date) => reading.start < date.end && date.start < reading.end)
    ) {
      kept.push(reading);
    }
  }
  return kept.toSorted((a, b) => a.start - b.start);
};

/**
 * Whether a day a text writes is a day asked for: the same day and month,
 * and the same year unless either names none.
 */
export const sameDay = (written: Day, asked: Day): boolean =>
  written.month === asked.month &&
  written.day === asked.day &&
  (written.year === 0 || asked.year === 0 || written.year === asked.year);

/** A day as `chunk_days` holds it: its month and day as one number. */
export const monthDayOf = ({ month, day }: Day): number => month * 100 + day;
