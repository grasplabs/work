import { Temporal } from "temporal-polyfill";

// The calendar days a text mentions, however it writes them (GRA-1798):
// read where a chunk is indexed (words.ts `indexWords` writes them to
// `chunk_days`) and where a question is asked (exact.ts), by this one
// reader, so the two never drift apart. Recall then matches a question's
// date by its day, not by its words: "14 maart 2026" finds "14/03/2026",
// "March 14th, 2026" and "2026-03-14T09:00:00Z".
//
// No hand-written table of forms. The forms are the platform's own: the
// Unicode CLDR's date formats of the five languages recall serves, as
// `Intl.DateTimeFormat` writes them (`formatToParts`), read back. Each
// locale's format of a day, month and year, in figures and with the
// month's name (long and short), and of a day and month by name alone,
// becomes one pattern: its parts in its order, its literals as written
// (any run of spaces as any), its month names as the locale writes them,
// with and without their accents. English is read as both the US and the
// UK write it, so "03/04/2026" is both 4 March and 3 April, and a question
// writing it matches either. Besides, the standard's own form: an ISO 8601
// calendar date (`2026-03-14`), with a time after it or not, as RFC 3339
// writes one. Every day read is checked against the calendar (Temporal):
// 31 April is no day.
//
// What CLDR doesn't write, and is read all the same, one rule: a day may
// carry an ordinal's letters ("14th", "1er", "14de", "1º"), up to three.
//
// Deliberately not read, each found by the word search as before: a year
// of two digits ("14/03/26", like versions, scores and page numbers), a
// day and month in figures alone ("14/03", like fractions and ranges), a
// short month name without a year ("4 mar", "3 ago"), forms CLDR doesn't
// write ("the 14th of March", "March 14 2026" without its comma), ranges
// and relative days ("next Tuesday"). Nor is a day and month by name read
// where a number stands next to it, which may be its year ("14 maart 25",
// "March 14 2025", "14 March '25", "2025 March 14"): after it, past
// spaces, a comma, an apostrophe, a date separator or the word the locale
// writes before a year ("de"), or before it, past the same. So "14 maart
// 3 mensen" is no day either; "14 maart." and "14 maart, de vergadering"
// are 14 March of any year. A reading that lies inside a longer
// one is dropped ("4 March" of "4 March 2026"); readings of the same
// words in two orders are both kept. A date never starts or ends inside a
// word or an ID: "INV-2026-03-14-7" and "PO-14.03.2026" are IDs, read by
// exact.ts, never days.

/** A calendar day a text mentions; `year` 0 when it writes none. */
export interface Day {
  year: number;
  month: number;
  day: number;
}

/** Where a text writes a date, `[start, end)`, and the days it may be. */
export interface Dated {
  start: number;
  end: number;
  days: Day[];
}

/** The locales whose CLDR formats are read: English twice (US and UK). */
const locales = ["en-US", "en-GB", "nl", "de", "fr", "es"] as const;

/**
 * The formats read, as `Intl.DateTimeFormat` options: in figures, with the
 * month's long and short name, and by the long name without a year.
 */
const skeletons: readonly Intl.DateTimeFormatOptions[] = [
  { year: "numeric", month: "numeric", day: "numeric" },
  { year: "numeric", month: "long", day: "numeric" },
  { year: "numeric", month: "short", day: "numeric" },
  { month: "long", day: "numeric" },
];

/**
 * The day formats are read for: one whose day and month differ and are
 * under ten, so neither is padded or read for the other.
 */
const probe = Date.UTC(2026, 2, 4);

/** Neither a letter or digit, nor a joiner after one, before a date. */
const before = String.raw`(?<![\p{L}\p{N}]|[\p{L}\p{N}][\-\/._])`;

/** Neither a letter or digit, nor a joiner before one, after a date. */
const after = String.raw`(?![\p{L}\p{N}]|[\-\/._][\p{L}\p{N}])`;

/** A day in figures, and an ordinal's letters after it, if any. */
const dayPart = String.raw`(?<day>\d{1,2})\p{L}{0,3}`;

/** A month in figures. */
const monthPart = String.raw`(?<month>\d{1,2})`;

/** A year: four figures. */
const yearPart = String.raw`(?<year>\d{4})`;

/**
 * An ISO 8601 calendar date in its extended form, and the time RFC 3339
 * writes after it, if any: read as the date's part, so a timestamp is one
 * date, never the IDs its colons would part (exact.ts).
 */
const isoDate = new RegExp(
  `${before}${yearPart}-(?<month>\\d{2})-(?<day>\\d{2})(?:[Tt]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:[Zz]|[+\\-]\\d{2}:\\d{2})?)?${after}`,
  "gu"
);

const regexSpecial = /[$()*+.?[\\\]^{|}/]/gu;
const spaces = /\s+/gu;
const figures = /^\d+$/u;

/** `text` as a regular expression matching itself, any run of spaces as any. */
const literally = (text: string): string =>
  text
    .replaceAll(regexSpecial, String.raw`\$&`)
    .replaceAll(spaces, String.raw`\s+`);

/**
 * A month's name without its accents, lowercased: how one is looked up,
 * and its second spelling ("marz" of "März", "aout" of "août").
 */
const fold = (name: string): string =>
  name.normalize("NFD").replaceAll(/\p{M}/gu, "").toLowerCase();

/** Where a format's month names go in its pattern. */
const namePlace = "<name>";

/**
 * A part of a CLDR format as its pattern matches it: a literal as written
 * ("4. März" is the day, ". ", the month; " de " is a word between
 * spaces), a month's name as `namePlace`.
 */
const partOf = ({ type, value }: Intl.DateTimeFormatPart): string => {
  if (type === "day") {
    return dayPart;
  }
  if (type === "year") {
    return yearPart;
  }
  if (type === "month") {
    return figures.test(value) ? monthPart : namePlace;
  }
  return literally(value);
};

/**
 * What may stand between a day and month and a number that may be its
 * year: spaces, a comma, an apostrophe ("'25") and the date separators.
 */
const yearGap = String.raw`[\s,'’.\/\-]*`;

/**
 * The word `locale` writes before a year, if any: " de " in "4 de marzo
 * de 2026", none in "4 March 2026" or "March 4, 2026".
 */
const yearWordOf = (locale: string): string => {
  const parts = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).formatToParts(probe);
  const year = parts.findIndex(({ type }) => type === "year");
  const literal = parts[year - 1];
  return literal?.type === "literal"
    ? literal.value.replaceAll(/[^\p{L}]/gu, "")
    : "";
};

/** A pattern read from a CLDR format: its expression, and its month names. */
interface Pattern {
  expression: RegExp;
  /** A month's name, folded, and its month: none for a format in figures. */
  months: ReadonlyMap<string, number>;
}

/**
 * Every pattern read from the locales' formats, each shape once: formats
 * that differ only in their month names (English's long and short, US
 * and UK) are one pattern with all of them. A name two months share in a
 * pattern is no month's. A name's trailing dot is the pattern's to match
 * or not ("mrt" and "mrt.", "Sept" and "sept.").
 */
const patterns: readonly Pattern[] = (() => {
  const shapes = new Map<string, Map<string, Set<number>>>();
  /** Per shape without a year, the words its locales write before a year. */
  const yearWords = new Map<string, Set<string>>();
  for (const locale of locales) {
    for (const options of skeletons) {
      const format = new Intl.DateTimeFormat(locale, {
        ...options,
        timeZone: "UTC",
      });
      const shape = format.formatToParts(probe).map(partOf).join("");
      const spellings = shapes.get(shape) ?? new Map<string, Set<number>>();
      for (
        let month = 1;
        shape.includes(namePlace) && month <= 12;
        month += 1
      ) {
        const written = format
          .formatToParts(Date.UTC(2026, month - 1, 1))
          .find(({ type }) => type === "month")
          ?.value.normalize("NFC")
          .replace(/\.$/u, "");
        for (const spelling of written === undefined
          ? []
          : [written, fold(written)]) {
          spellings.set(
            spelling,
            new Set([...(spellings.get(spelling) ?? []), month])
          );
        }
      }
      shapes.set(shape, spellings);
      if (options.year === undefined) {
        const words = yearWords.get(shape) ?? new Set<string>();
        const word = yearWordOf(locale);
        if (word.length > 0) {
          words.add(word);
        }
        yearWords.set(shape, words);
      }
    }
  }
  return [...shapes].map(([shape, spellings]) => {
    const months = new Map<string, number>();
    for (const [spelling, of] of spellings) {
      const [month] = of;
      if (of.size === 1 && month !== undefined) {
        months.set(fold(spelling), month);
      }
    }
    // Longest first, so "march" is tried before "mar".
    const names = [...spellings.keys()]
      .filter((spelling) => months.has(fold(spelling)))
      .toSorted((a, b) => b.length - a.length)
      .map(literally)
      .join("|");
    const body = shape.replace(namePlace, String.raw`(?<name>${names})\.?`);
    const words = yearWords.get(shape);
    // A day and month alone: no number that may be its year beside it.
    const guards =
      words === undefined
        ? { before: "", after: "" }
        : {
            before: String.raw`(?<!\d${yearGap})`,
            after: String.raw`(?!${yearGap}${[...words].map((word) => `(?:${literally(word)}${yearGap})?`).join("")}\d)`,
          };
    return {
      expression: new RegExp(
        `${before}${guards.before}${body}${after}${guards.after}`,
        "giu"
      ),
      months,
    };
  });
})();

/** Whether two days are the same day: one without a year is any year's. */
export const sameDay = (a: Day, b: Day): boolean =>
  a.month === b.month &&
  a.day === b.day &&
  (a.year === b.year || a.year === 0 || b.year === 0);

/** Whether `day` is a day of `month` (in a leap year, when it has no year). */
const onCalendar = ({ year, month, day }: Day): boolean => {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leapYear = 2000;
  return (
    day <=
    Temporal.PlainYearMonth.from({ year: year === 0 ? leapYear : year, month })
      .daysInMonth
  );
};

/** The day a match of `pattern` reads, if it is one. */
const dayOf = (
  groups: Record<string, string | undefined>,
  months: ReadonlyMap<string, number> | undefined
): Day | undefined => {
  const month =
    groups.name === undefined
      ? Number(groups.month)
      : months?.get(fold(groups.name));
  if (month === undefined) {
    return undefined;
  }
  const day: Day = {
    year: groups.year === undefined ? 0 : Number(groups.year),
    month,
    day: Number(groups.day),
  };
  return onCalendar(day) ? day : undefined;
};

/** Whether two days are written alike: the same year (or none), month and day. */
const isDay = (a: Day, b: Day): boolean =>
  a.year === b.year && a.month === b.month && a.day === b.day;

/**
 * The dates `text` writes, in order: each place and the days it may be
 * (more than one only when it reads both ways), none inside another.
 */
export const datesIn = (text: string): Dated[] => {
  // Every reading's place, a day or not: one off the calendar ("29
  // February 2026") still keeps the shorter reading inside it out.
  const found = new Map<string, Dated>();
  const read = (expression: RegExp, months?: ReadonlyMap<string, number>) => {
    for (const match of text.matchAll(expression)) {
      const start = match.index;
      const end = start + match[0].length;
      const key = `${start} ${end}`;
      const at = found.get(key) ?? { start, end, days: [] };
      const day = dayOf(match.groups ?? {}, months);
      if (day !== undefined && !at.days.some((other) => isDay(other, day))) {
        at.days.push(day);
      }
      found.set(key, at);
    }
  };
  read(isoDate);
  for (const { expression, months } of patterns) {
    read(expression, months);
  }
  const all = [...found.values()];
  return all
    .filter(
      (dated) =>
        dated.days.length > 0 &&
        !all.some(
          (other) =>
            other !== dated &&
            other.start <= dated.start &&
            other.end >= dated.end
        )
    )
    .toSorted((a, b) => a.start - b.start || a.end - b.end);
};

/** Every distinct day `text` mentions (`datesIn`). */
export const daysIn = (text: string): Day[] => {
  const days: Day[] = [];
  for (const { days: of } of datesIn(text)) {
    for (const day of of) {
      if (!days.some((other) => isDay(other, day))) {
        days.push(day);
      }
    }
  }
  return days;
};

/** A day's month and day as one number, as `chunk_days` holds it: 314 is 14 March. */
export const monthDayOf = ({ month, day }: Day): number => month * 100 + day;

/**
 * Writes the days the chunk at `row` mentions to `chunk_days`, in the
 * caller's transaction (words.ts `indexWords`).
 */
export const indexDays = (sql: SqlStorage, row: number, text: string): void => {
  for (const day of daysIn(text)) {
    sql.exec(
      "INSERT INTO chunk_days (chunk, month_day, year) VALUES (?, ?, ?)",
      row,
      monthDayOf(day),
      day.year
    );
  }
};
