import { allOf, foldForSearch, isStopWord, sequenceOf } from "./words.ts";

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
// 4. Names: two or more words in a row, each capitalised, none a stop word
//    and none holding a digit (Anna Jansen, Rotterdam Warehouse). A guess:
//    a German noun is capitalised too, so a name only ranks, and is never
//    reported as not found.
//
// Each part of the question is read by the first rule that takes it, and
// then is no longer there for the next.
//
// What the word index holds of a chunk is its distinct words, so it finds
// the chunks holding every word of a part (`query`), and the order is
// checked here, against the chunk's text (`foundIn`).

/** A part of the question to find as written. */
export interface Exact {
  /** The part as the question wrote it. */
  asked: string;
  /** The ways it may be written, each as its words in order (`sequenceOf`). */
  forms: string[][];
  /** An FTS5 query finding the chunks that may hold one of its forms. */
  query: string;
  /**
   * Which rule read it: a pack says when no chunk holds a phrase, a date
   * or an ID, never a name, a guess. A date or an ID stands for its words:
   * a pack never says them apart (recall.ts).
   */
  kind: "phrase" | "date" | "id" | "name";
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

/** A word that starts with a capital. */
const capitalised = /^[\p{Lu}\p{Lt}]/u;

/** Ends a sentence, so a name never runs on past it. */
const sentenceEnd = /[.!?;:]$/u;

const digit = /\p{N}/u;
const letter = /\p{L}/u;
const threeDigits = /(?:\p{N}[^\p{N}]*){3}/u;

/**
 * An exact part written one way, `words`, or none when it holds no word:
 * the chunks holding all its words may hold it.
 */
const exactOf = (
  asked: string,
  words: string[],
  kind: "phrase" | "id" | "name"
): Exact | undefined =>
  words.length === 0
    ? undefined
    : { asked, forms: [words], query: allOf(words), kind };

/**
 * A date as an exact part: the chunks holding its year and its day, with
 * or without a leading zero, may hold one of its forms.
 */
const dateOf = (asked: string, day: Day): Exact => ({
  asked,
  forms: formsOfDay(day),
  query: `"${day.year}" AND (${padded(day.day)
    .map((written) => `"${written}"`)
    .join(" OR ")})`,
  kind: "date",
});

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

/** Whether a word, as the question wrote it, may be part of a name (rule 4). */
const inName = (word: string): boolean =>
  capitalised.test(word) &&
  !digit.test(word) &&
  !sequenceOf(word).every((folded) => isStopWord(folded));

/** The IDs and names among `text`'s words, in order (rules 3 and 4). */
const idsAndNames = (text: string): Exact[] => {
  const found: Exact[] = [];
  let name: string[] = [];
  const endName = (): void => {
    if (name.length >= 2) {
      const asked = name.join(" ");
      const exact = exactOf(asked, sequenceOf(asked), "name");
      if (exact !== undefined) {
        found.push(exact);
      }
    }
    name = [];
  };
  for (const written of text.split(/\s+/u)) {
    const word = written.replaceAll(aroundWord, "");
    if (word === "") {
      endName();
    } else if (isId(word)) {
      endName();
      const exact = exactOf(word, sequenceOf(word), "id");
      if (exact !== undefined) {
        found.push(exact);
      }
    } else if (inName(word)) {
      name.push(word);
      if (sentenceEnd.test(written)) {
        endName();
      }
    } else {
      endName();
    }
  }
  endName();
  return found;
};

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
    ...idsAndNames(rest),
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
