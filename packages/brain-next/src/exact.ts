import { allOf, foldForSearch, sequenceOf } from "./words.ts";

// The exact way of recall: the parts of a question that must be found as
// written, word for word in that order, not word by word in any form.
// Read from the question alone, by fixed rules, so what counts as exact
// never depends on what the store holds:
//
// 1. Quoted phrases: text between double quotes of any kind ("…", “…”,
//    „…“, «…»).
// 2. Dates: a day, month and year, written with numbers (2026-03-14,
//    14-03-2026, 14/3/2026, 14.03.2026) or with the month's name in one of
//    the five languages (14 maart 2026, 14. März 2026, 14 de marzo de 2026,
//    March 14, 2026). A date is found written in any of those ways. Day
//    before month, as Europe writes it; a date that only reads month
//    first (03/14/2026) is read so.
// 3. IDs: a word holding a digit and a letter (INV-2024-0042, PO12345) or
//    at least three digits (4400, 2027).
//
// Names are left to the words way: no rule tells a name from a sentence's
// first word or a run of German nouns, and the words way finds a name's
// words already.
//
// Each part of the question is read by the first rule that takes it, and
// then is no longer there for the next.
//
// What the word index holds of a chunk is its distinct words, so it finds
// the chunks holding every word of a part (`query`), and the order is
// checked here, against the chunk's text (`foundIn`). The index holds a
// chunk's distinct words in the order they first appear, so a phrase
// query on it (`near`) finds most chunks holding a form in a row, though
// not all and not only those: it orders the candidates, never decides.

/** A part of the question to find as written. */
export interface Exact {
  /** The part as the question wrote it. */
  asked: string;
  /** The ways it may be written, each as its words in order (`sequenceOf`). */
  forms: string[][];
  /** An FTS5 query finding the chunks that may hold one of its forms. */
  query: string;
  /**
   * An FTS5 query finding the chunks whose distinct words hold one of its
   * forms as a phrase: likely to hold it in a row (above).
   */
  near: string;
  /**
   * Which rule read it. A date or an ID stands for its words: a pack never
   * says them apart (recall.ts).
   */
  kind: "phrase" | "date" | "id";
}

/** Most exact parts of a question that count. */
const maxExacts = 8;

/** The languages whose month names a date may be written with. */
const monthLocales = ["en", "nl", "de", "fr", "es"] as const;

/**
 * Each month's names in the five languages, long and short, folded and as
 * one word, from the platform's own calendar data: month 1 to 12. A name
 * two months share in different languages is left out.
 */
const monthNames: ReadonlyMap<string, number> = (() => {
  const names = new Map<string, number>();
  const shared = new Set<string>();
  for (const locale of monthLocales) {
    for (const style of ["long", "short"] as const) {
      const format = new Intl.DateTimeFormat(locale, {
        month: style,
        timeZone: "UTC",
      });
      for (let month = 1; month <= 12; month += 1) {
        const [name] = sequenceOf(format.format(Date.UTC(2026, month - 1, 1)));
        if (name !== undefined && !/\d/u.test(name)) {
          const known = names.get(name);
          if (known !== undefined && known !== month) {
            shared.add(name);
          }
          names.set(name, month);
        }
      }
    }
  }
  for (const name of shared) {
    names.delete(name);
  }
  return names;
})();

/** Each month's names (`monthNames`), by month. */
const namesOfMonth = (month: number): string[] =>
  [...monthNames].filter(([, of]) => of === month).map(([name]) => name);

/** A day of the calendar. */
interface Day {
  year: number;
  month: number;
  day: number;
}

/** `year`, `month` and `day` as a day, if there is one. */
const dayOf = (year: number, month: number, day: number): Day | undefined => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1000 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? { year, month, day }
    : undefined;
};

/** A number with and without a leading zero. */
const padded = (value: number): string[] => [
  ...new Set([String(value), String(value).padStart(2, "0")]),
];

/** Every way the five languages write `day`, as words in order. */
const formsOfDay = ({ year, month, day }: Day): string[][] => {
  const y = String(year);
  const forms: string[][] = [];
  for (const d of padded(day)) {
    for (const m of padded(month)) {
      forms.push([y, m, d], [d, m, y]);
    }
    for (const name of namesOfMonth(month)) {
      forms.push([d, name, y], [name, d, y], [d, "de", name, "de", y]);
    }
  }
  return forms;
};

/** A day, then a month, then a year, numbers apart by - / or . */
const dayFirst =
  /(?<!\d)(?<day>\d{1,2})[-/.](?<month>\d{1,2})[-/.](?<year>\d{4})(?!\d)/gu;

/** A year, then a month, then a day. */
const yearFirst =
  /(?<!\d)(?<year>\d{4})[-/.](?<month>\d{1,2})[-/.](?<day>\d{1,2})(?!\d)/gu;

/** A day, a month's name and a year: "14 maart 2026", "14 de marzo de 2026". */
const dayNamed =
  /(?<!\d)(?<day>\d{1,2})\.?\s+(?:de\s+)?(?<name>\p{L}+)\.?\s+(?:de\s+)?(?<year>\d{4})(?!\d)/gu;

/** A month's name, a day and a year: "March 14, 2026". */
const nameDay =
  /(?<![\p{L}\p{N}])(?<name>\p{L}+)\.?\s+(?<day>\d{1,2}),?\s+(?<year>\d{4})(?!\d)/gu;

/** A date's parts, as a pattern's groups hold them. */
type DateGroups = Partial<Record<"day" | "month" | "name" | "year", string>>;

/** The day a date written as a pattern matched it stands for. */
type DayReader = (groups: DateGroups) => Day | undefined;

const monthOf = (name: string | undefined): number =>
  monthNames.get(foldForSearch(name ?? "")) ?? 0;

/** Each date pattern, with how it reads a day. */
const datePatterns: readonly [RegExp, DayReader][] = [
  [
    yearFirst,
    ({ year, month, day }) => dayOf(Number(year), Number(month), Number(day)),
  ],
  [
    dayFirst,
    ({ year, month, day }) =>
      dayOf(Number(year), Number(month), Number(day)) ??
      dayOf(Number(year), Number(day), Number(month)),
  ],
  [
    dayNamed,
    ({ year, name, day }) => dayOf(Number(year), monthOf(name), Number(day)),
  ],
  [
    nameDay,
    ({ year, name, day }) => dayOf(Number(year), monthOf(name), Number(day)),
  ],
];

/** A pair of double quotes of any kind, and what they hold. */
const quoted = /["“”„«»](?<inner>[^"“”„«»]+)["“”„«»]/gu;

/** What surrounds a word that isn't part of it: punctuation and symbols. */
const aroundWord = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

const digit = /\p{N}/u;
const letter = /\p{L}/u;
const threeDigits = /(?:\p{N}[^\p{N}]*){3}/u;

/** `forms` as one FTS5 query: any of them, each a phrase. */
const phrasesOf = (forms: readonly (readonly string[])[]): string =>
  [...new Set(forms.map((form) => `"${form.join(" ")}"`))].join(" OR ");

/** Any of `words` as one FTS5 query, each a quoted word. */
const anyWordOf = (words: readonly string[]): string =>
  `(${words.map((word) => `"${word}"`).join(" OR ")})`;

/**
 * An exact part written one way, `words`, or none when it holds no word:
 * the chunks holding all its words may hold it.
 */
const exactOf = (
  asked: string,
  words: string[],
  kind: "phrase" | "id"
): Exact | undefined =>
  words.length === 0
    ? undefined
    : {
        asked,
        forms: [words],
        query: allOf(words),
        near: phrasesOf([words]),
        kind,
      };

/**
 * A date as an exact part: the chunks holding its year, its day (with or
 * without a leading zero) and its month (its number, so written, or one of
 * its names) may hold one of its forms.
 */
const dateOf = (asked: string, day: Day): Exact => {
  const forms = formsOfDay(day);
  return {
    asked,
    forms,
    query: [
      `"${day.year}"`,
      anyWordOf(padded(day.day)),
      anyWordOf([...padded(day.month), ...namesOfMonth(day.month)]),
    ].join(" AND "),
    near: phrasesOf(forms),
    kind: "date",
  };
};

/** `text` with each of `pattern`'s matches `read` takes taken out, and what they read as. */
const takeOut = <T>(
  text: string,
  pattern: RegExp,
  read: (groups: DateGroups & { inner?: string }) => T | undefined
): { rest: string; found: { asked: string; value: T }[] } => {
  const found: { asked: string; value: T }[] = [];
  let rest = "";
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    const value = read(match.groups ?? {});
    if (value !== undefined) {
      rest += `${text.slice(from, match.index)} `;
      from = match.index + match[0].length;
      found.push({ asked: match[0], value });
    }
  }
  return { rest: `${rest}${text.slice(from)}`, found };
};

/** Whether a word, as the question wrote it, is an ID (rule 3). */
const isId = (word: string): boolean =>
  digit.test(word) && (letter.test(word) || threeDigits.test(word));

/** The IDs among `text`'s words, in order (rule 3). */
const idsOf = (text: string): Exact[] =>
  text.split(/\s+/u).flatMap((written) => {
    const word = written.replaceAll(aroundWord, "");
    const exact = isId(word)
      ? exactOf(word, sequenceOf(word), "id")
      : undefined;
    return exact === undefined ? [] : [exact];
  });

/**
 * The parts of `question` to find as written (above), in the order the
 * rules take them, each once, at most `maxExacts`.
 */
export const exactsOf = (question: string): Exact[] => {
  const phrases = takeOut(question, quoted, ({ inner }) =>
    exactOf((inner ?? "").trim(), sequenceOf(inner ?? ""), "phrase")
  );
  let { rest } = phrases;
  const dates: Exact[] = [];
  for (const [pattern, read] of datePatterns) {
    const { rest: left, found } = takeOut(rest, pattern, read);
    rest = left;
    for (const { asked, value } of found) {
      dates.push(dateOf(asked, value));
    }
  }
  const all = [
    ...phrases.found.map(({ value }) => value),
    ...dates,
    ...idsOf(rest),
  ];
  const seen = new Set<string>();
  return all
    .filter(({ forms }) => {
      const key = JSON.stringify(forms);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, maxExacts);
};

/** Whether `words` hold `form`'s words in a row, in its order. */
const holdsInARow = (
  words: readonly string[],
  form: readonly string[]
): boolean => {
  for (let start = 0; start + form.length <= words.length; start += 1) {
    if (form.every((word, at) => words[start + at] === word)) {
      return true;
    }
  }
  return false;
};

/** Which of `exacts` (by index) `text` holds as written. */
export const foundIn = (
  text: string,
  exacts: readonly Exact[],
  among: readonly number[]
): number[] => {
  const words = sequenceOf(text);
  return among.filter((index) =>
    (exacts[index]?.forms ?? []).some((form) => holdsInARow(words, form))
  );
};
