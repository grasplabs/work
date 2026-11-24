/**
 * What happens to people while they are interviewed (GRA-1425): they are
 * called away for a few minutes, they stop and come back through the same
 * link much later, they paste the wrong thing, they send one answer in two
 * messages, and they misread a question. Each practice person gets a
 * timetable of these, by minute on the lab's own interview clock, and
 * play.ts plays them.
 *
 * Pure: a person's mark and their place in the company decide all of it,
 * so a run can be played again. Code decides when and what; a model only
 * words the answers around it.
 */
import type { InterviewLocale } from "@grasp-os/shared/onboarding";

import { rollOf } from "./people.ts";

export const eventKinds = [
  "interrupted",
  "resumes later",
  "wrong paste",
  "split message",
  "misread",
] as const;
export type EventKind = (typeof eventKinds)[number];

/** One event on someone's timetable. */
export interface Planned {
  kind: EventKind;
  /** The minute of the interview, on the lab's clock, from which it happens: at the first answer from then on. */
  at: number;
  /** Interrupted: the minutes they are away. Resumes later: the hours. */
  away?: number;
  /** Which of its texts it uses: what they say, or what they paste. */
  pick?: number;
}

/** The earliest and latest minute an event is planned for: after the first questions, before the read-back. */
const firstMinute = 3;
const lastMinute = 16;
/** The chance someone has an event beside the one their place gives them. */
export const otherChance = 0.15;

/**
 * Someone's timetable. The person at `place` always has the kind of that
 * place (the first five places have each kind once, so every practice
 * company of five or more shows each), and each other kind by chance.
 * Earliest first; two events never fall on the same minute.
 */
export const timetableFor = (place: number, mark: string): Planned[] => {
  const roll = (at: number) => rollOf(`events:${mark}`, at);
  const own = eventKinds[place % eventKinds.length] ?? "interrupted";
  const taken = new Set<number>();
  return eventKinds
    .flatMap((kind, at): Planned[] => {
      if (kind !== own && roll(at) >= otherChance) {
        return [];
      }
      let minute =
        firstMinute + Math.floor(roll(10 + at) * (lastMinute - firstMinute));
      while (taken.has(minute)) {
        minute += 1;
      }
      taken.add(minute);
      const away =
        kind === "interrupted"
          ? 1 + Math.floor(roll(20 + at) * 4)
          : 2 + Math.floor(roll(20 + at) * 46);
      return [
        {
          kind,
          at: minute,
          ...(kind === "interrupted" || kind === "resumes later"
            ? { away }
            : {}),
          pick: Math.floor(roll(30 + at) * 3),
        },
      ];
    })
    .toSorted((a, b) => a.at - b.at);
};

/** Picks one of `texts`, by a planned event's pick. */
const picked = (texts: readonly string[], pick = 0): string =>
  texts[pick % texts.length] ?? texts[0] ?? "";

/** What someone types when they are called away. */
const stepsAway: Readonly<Record<"en" | "nl", readonly string[]>> = {
  en: [
    "sorry, phone, one sec",
    "hang on, someone at my desk. back in a few minutes",
    "brb, my manager is calling",
  ],
  nl: [
    "sorry, telefoon, momentje",
    "wacht even, er staat iemand aan mijn bureau. paar minuten",
    "ben zo terug, mijn leidinggevende belt",
  ],
};

/** What they type when they are called away, in their language. */
export const awayLine = (locale: InterviewLocale, pick?: number): string =>
  picked(locale === "nl" ? stepsAway.nl : stepsAway.en, pick);

/**
 * What someone pastes by mistake: a spreadsheet formula, a log from a
 * system, a paragraph of a letter to a client. None of it is about their
 * work as they would tell it, and none of it may become a note.
 */
const pastes: Readonly<Record<"en" | "nl", readonly string[]>> = {
  en: [
    '=IFERROR(VLOOKUP($B14;Suppliers!$A:$F;4;FALSE);"not found")',
    "2026-10-28 07:41:12 WARN sync job 4471 retry 3/5: timeout after 30000 ms (endpoint /v2/batch)",
    "Dear Mr Peters, Thank you for your letter of 21 October. We have looked into your request and are pleased to confirm that the amount will be credited within 14 days. Kind regards,",
  ],
  nl: [
    '=ALS.FOUT(VERT.ZOEKEN($B14;Leveranciers!$A:$F;4;ONWAAR);"niet gevonden")',
    "28-10-2026 07:41:12 WAARSCHUWING synchronisatie 4471 poging 3/5: time-out na 30000 ms",
    "Geachte heer Peters, Hartelijk dank voor uw brief van 21 oktober. Wij hebben uw verzoek bekeken en bevestigen graag dat het bedrag binnen 14 dagen wordt teruggestort. Met vriendelijke groet,",
  ],
};

/** What they paste by mistake, in their language. */
export const pasteOf = (locale: InterviewLocale, pick?: number): string =>
  picked(locale === "nl" ? pastes.nl : pastes.en, pick);

/** What a player is asked for each event, in place of a plain answer. */
export const askedFor = {
  /** Back after being called away. */
  back: "You are back from the interruption. Say so in a word or two, then answer the question Stephen asked before you went, and nothing else:",
  /** After pasting the wrong thing. */
  afterPaste:
    "Just now you pasted the wrong thing by mistake. Say so in a few words, then answer Stephen's last line, and nothing else:",
  /** A question read wrongly. */
  misread:
    "You read Stephen's last question wrongly. If he asked how often or how many, you answer how long it takes; if he asked how long, you answer how often; if he asked two things, you answer only the second. Answer that question as you understood it, without saying you misread anything, and nothing else:",
} as const;

const wordPattern = /\S+/gu;
const howOften =
  /\b(?:how often|how many|how long|hoe vaak|hoeveel|hoe lang)\b/iu;
const doubleQuestion = /\?.*\?|\b(?:and|en)\b[^?]*\?$/iu;

/** Whether a line of his can be misread: it asks how often, how many or how long, or two things at once. */
export const misreadable = (line: string): boolean =>
  line.includes("?") && (howOften.test(line) || doubleQuestion.test(line));

/** Words a sentence leads on from: a message that ends on one is not done. */
const leadsOn: ReadonlySet<string> = new Set([
  "and",
  "then",
  "but",
  "because",
  "so",
  "en",
  "dan",
  "maar",
  "omdat",
  "dus",
]);

/** The fewest words an answer has before it is sent in two. */
const splitWordsLeast = 8;

/**
 * An answer sent in two messages: the first stops in the middle of a
 * sentence, where a word that leads on ends it or a comma did, near the
 * middle, and the second has the rest. None when the answer is too short
 * to split.
 */
export const splitOf = (say: string): [string, string] | null => {
  const words = say.match(wordPattern) ?? [];
  if (words.length < splitWordsLeast) {
    return null;
  }
  const middle = Math.floor(words.length / 2);
  const ends = (at: number) => {
    const word = words[at - 1] ?? "";
    return word.endsWith(",") || leadsOn.has(word.toLowerCase());
  };
  const near = Array.from({ length: words.length - 3 }, (_, at) => at + 2)
    .filter(ends)
    .toSorted((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
  const cut = near[0] ?? middle;
  const first = words
    .slice(0, cut)
    .join(" ")
    .replace(/[.,;:]$/u, "");
  return [first, words.slice(cut).join(" ")];
};

/** An event as it happened in a played interview: at which answer of theirs, and for a split message whether he waited for the rest. */
export interface Happened {
  kind: EventKind;
  /** The answer it happened at, from 1. */
  answer: number;
  /** Split message: he said nothing to the first part and waited for the rest. */
  waited?: boolean;
}
