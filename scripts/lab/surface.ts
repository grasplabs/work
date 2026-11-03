import type { AnswerKey } from "./keys/types.ts";
/**
 * How someone types (GRA-1426): noise put on an answer after the model has
 * written it, before it goes to the app. Asked for typos, a model makes
 * neat ones; real typing is messier, so code adds it: letters swapped,
 * left out or doubled, a phone's autocorrect taking the wrong word, capitals
 * always, rarely or never, full stops left off, an answer sent in two or
 * three messages, and for some people the work terms in Dutch while they
 * answer in English.
 *
 * Pure: a profile and a seed decide all of it, so a run can be played
 * again. It never changes what the answer key scores by: a word with a
 * digit in it, and any word of a name, a system, a role or a term
 * (`protectedOf`), is kept as written.
 */
import { rollOf } from "./people.ts";

/** How one person types. */
export interface Surface {
  /** The chance a word of theirs gets a typo: two letters swapped, one left out, or a key pressed twice. */
  typos: number;
  /** They type on a phone, whose autocorrect now and then takes the wrong word. */
  phone: boolean;
  /** Whether a sentence starts with a capital. */
  capitals: "always" | "rarely" | "never";
  /** The chance a full stop at the end of a sentence is left off. */
  dropsStops: number;
  /** The chance an answer of two sentences or more is sent as two or three messages. */
  splits: number;
  /** They answer in English but say their work terms in Dutch. */
  mixesDutch: boolean;
}

/** Someone who types as a model writes: no noise. */
export const clean: Surface = {
  typos: 0,
  phone: false,
  capitals: "always",
  dropsStops: 0,
  splits: 0,
  mixesDutch: false,
};

/** About one in five people type with a lot of noise; the rest with a little. */
export const messyShare = 0.2;

/** Capitals: someone messy never or rarely, most others always. */
const capitalsOf = (messy: boolean, roll: number): Surface["capitals"] => {
  if (messy) {
    return roll < 0.5 ? "never" : "rarely";
  }
  return roll < 0.8 ? "always" : "rarely";
};

/**
 * Someone's profile, drawn by their mark: most people a little noise,
 * about one in five a lot. A cast sheet may set its own instead.
 */
export const surfaceFor = (mark: string): Surface => {
  const roll = (at: number) => rollOf(`surface:${mark}`, at);
  const messy = roll(0) < messyShare;
  const phone = roll(1) < (messy ? 0.6 : 0.3);
  return {
    typos: messy ? 0.06 + roll(3) * 0.04 : roll(3) * 0.015,
    phone,
    capitals: capitalsOf(messy, roll(2)),
    dropsStops: messy ? 0.7 : 0.15,
    splits: messy ? 0.5 : 0.1,
    mixesDutch: roll(4) < 0.25,
  };
};

const wordPattern = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const digit = /\p{N}/u;
const lettersOnly = /^\p{L}+$/u;

/**
 * The words the answer key scores by, and so the words noise never
 * touches: every word of the company, its offices, the people and their
 * roles, and the systems, places and terms of its facts. Lower case.
 */
export const protectedOf = (key: AnswerKey): ReadonlySet<string> => {
  const phrases = [
    key.company.name,
    ...key.company.offices,
    ...key.employees.map(({ name }) => name),
    ...Object.values(key.roles).flatMap((role) => [
      role.name,
      role.team,
      ...(role.aliases ?? []),
    ]),
    ...key.facts.flatMap((fact) => [
      fact.system ?? "",
      fact.where ?? "",
      fact.term ?? "",
    ]),
  ];
  return new Set(
    phrases.flatMap((phrase) =>
      (phrase.toLowerCase().match(wordPattern) ?? []).filter(Boolean)
    )
  );
};

/** Whether noise must leave this word alone. */
const kept = (word: string, guarded: ReadonlySet<string>): boolean =>
  digit.test(word) || guarded.has(word.toLowerCase());

/** The wrong words a phone's autocorrect takes for the right ones, by language. */
const autocorrected: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  en: {
    close: "clothes",
    form: "from",
    from: "form",
    their: "there",
    loan: "lone",
    were: "we're",
    lose: "loose",
    week: "weak",
    sent: "scent",
    later: "latte",
    whole: "hole",
  },
  nl: {
    wordt: "word",
    dat: "dan",
    zei: "zij",
    heb: "hen",
    week: "weel",
  },
};

/** Work terms someone who mixes says in Dutch, in an English answer. */
const dutchTerms: Readonly<Record<string, string>> = {
  invoice: "factuur",
  invoices: "facturen",
  quote: "offerte",
  quotes: "offertes",
  approval: "akkoord",
  customer: "klant",
  customers: "klanten",
  supplier: "leverancier",
  suppliers: "leveranciers",
  maintenance: "onderhoud",
  mortgage: "hypotheek",
  claim: "schademelding",
  appraisal: "taxatie",
  colleague: "collega",
  colleagues: "collega’s",
  overview: "overzicht",
};

/** One typo in a word: two letters swapped, one left out, or a key pressed twice. */
const typoOf = (word: string, kind: number, where: number): string => {
  const at = 1 + Math.floor(where * (word.length - 2));
  if (kind < 1 / 3) {
    return `${word.slice(0, at)}${word[at + 1] ?? ""}${word[at] ?? ""}${word.slice(at + 2)}`;
  }
  if (kind < 2 / 3) {
    return `${word.slice(0, at)}${word.slice(at + 1)}`;
  }
  return `${word.slice(0, at + 1)}${word[at] ?? ""}${word.slice(at + 1)}`;
};

/** Keeps the capital of the word it replaces. */
const asCased = (was: string, now: string): string => {
  const first = was.charAt(0);
  return first === first.toLowerCase()
    ? now
    : `${now.charAt(0).toUpperCase()}${now.slice(1)}`;
};

const sentenceStart = /(?<before>^|[.!?]\s+|\n+)(?<letter>\p{Lu})/gu;
const stopAtEnd = /(?<=\p{L})\.(?=\s|$)/gu;
const sentenceEnd = /(?<=[.!?])\s+/u;

/** How many messages an answer of `sentences` sentences goes in: one, or two or three when it is split. */
const messagesOf = (
  sentences: number,
  splits: number,
  roll: (at: number) => number
): number => {
  if (sentences < 2 || roll(7000) >= splits) {
    return 1;
  }
  return sentences >= 3 && roll(7001) < 0.5 ? 3 : 2;
};

/** What someone typed: the answer with their noise, and the messages they sent it in. */
export interface Typed {
  text: string;
  /** One message, or two or three when they split it. Together they are `text`. */
  parts: string[];
}

/**
 * An answer as `surface` types it. The same answer, profile and seed type
 * the same every time. Words in `guarded`, and any word with a digit in
 * it, are kept as written.
 */
export const typed = (
  say: string,
  surface: Surface,
  seed: string,
  {
    guarded = new Set<string>(),
    locale = "en",
  }: { guarded?: ReadonlySet<string>; locale?: string } = {}
): Typed => {
  const roll = (at: number) => rollOf(`typed:${seed}`, at);
  const wrongWords = autocorrected[locale] ?? {};
  let nth = 0;
  const worded = say.replaceAll(wordPattern, (word) => {
    nth += 1;
    if (kept(word, guarded)) {
      return word;
    }
    const lower = word.toLowerCase();
    const dutch = dutchTerms[lower];
    if (surface.mixesDutch && locale === "en" && dutch !== undefined) {
      return asCased(word, dutch);
    }
    const wrong = wrongWords[lower];
    if (surface.phone && wrong !== undefined && roll(1000 + nth) < 0.25) {
      return asCased(word, wrong);
    }
    if (
      word.length >= 4 &&
      lettersOnly.test(word) &&
      roll(2000 + nth) < surface.typos
    ) {
      return typoOf(word, roll(3000 + nth), roll(4000 + nth));
    }
    return word;
  });
  let start = 0;
  const cased =
    surface.capitals === "always"
      ? worded
      : worded.replaceAll(
          sentenceStart,
          (all: string, before: string, letter: string, at: number) => {
            start += 1;
            const word =
              worded.slice(at + before.length).match(wordPattern)?.[0] ?? "";
            const lowers =
              surface.capitals === "never" || roll(5000 + start) < 0.7;
            return lowers && !kept(word, guarded)
              ? `${before}${letter.toLowerCase()}`
              : all;
          }
        );
  const lowered =
    surface.capitals === "never" && locale === "en"
      ? cased.replaceAll(/\bI\b/gu, "i")
      : cased;
  // Split first, while every sentence still ends in its stop.
  const sentences = lowered.split(sentenceEnd).filter(Boolean);
  const count = messagesOf(sentences.length, surface.splits, roll);
  const size = Math.ceil(sentences.length / count);
  let stop = 0;
  const parts = Array.from({ length: count }, (_, at) =>
    sentences.slice(at * size, (at + 1) * size).join(" ")
  )
    .filter(Boolean)
    .map((part) =>
      part.replaceAll(stopAtEnd, () => {
        stop += 1;
        return roll(6000 + stop) < surface.dropsStops ? "" : ".";
      })
    );
  return { text: parts.join(" "), parts };
};
