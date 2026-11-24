/**
 * People v2 (GRA-1421): a practice person has a mix of tempers, not one,
 * and a state that changes while they talk. Patience, trust, energy and
 * focus each run from 0 to 1, start from the mix and the person's mark,
 * and drift by rules in code: a question asked again costs patience,
 * minutes past the tenth cost energy, a plain answer to "why do you ask"
 * and a question about one real case build trust, a wrong paraphrase
 * costs it, and being asked on after saying they must go costs patience
 * fast. The state shapes the answer: tired is shorter, low trust holds
 * back, low patience wants to finish and then leaves with nothing agreed.
 *
 * Pure: code and a seed decide all of it, so a run can be played again;
 * the model only words it (people-v2.ts).
 */
import type { Move } from "./moves.ts";
import { rollOf, tempers, tempersFor } from "./people.ts";
import type { Temper } from "./people.ts";
import type { Said } from "./person.ts";

/** How much of each temper someone has. The weights add up to 1. */
export type TemperMix = Readonly<Partial<Record<Temper, number>>>;

/** Where someone stands, from 0 to 1 each. */
export interface State {
  /** How much more of this they will take: below `wrapUpBelow` they want to finish, below `leaveBelow` they go. */
  patience: number;
  /** How much they believe this is safe and worth it: below `holdsBackBelow` they hold back what they know. */
  trust: number;
  /** How much they have left: below `tiredBelow` their answers get shorter. */
  energy: number;
  /** How well they keep to the question: below `wandersBelow` they drift off now and then. */
  focus: number;
}

export const wrapUpBelow = 0.3;
export const leaveBelow = 0.12;
export const holdsBackBelow = 0.35;
export const tiredBelow = 0.4;
export const wandersBelow = 0.3;
/** Trust at which someone guarded opens up. */
export const opensAt = 0.6;

/** What can move someone's state before an answer: what Stephen did in his last line, and how long it has taken. */
export interface Happened {
  /** His last question is one he asked before (`isRepeated`). */
  repeated: boolean;
  /** Minutes of talk so far (`talkMinutes`). */
  minutes: number;
  /** They asked what this is for, and his reply said so plainly. */
  purposeTold: boolean;
  /** He said back what they said, and got it wrong. */
  wrongParaphrase: boolean;
  /** He asked about one real, recent case. */
  concreteCase: boolean;
  /** They said they must go, and he asked on instead of finishing. */
  keptOn: boolean;
}

export const nothingHappened: Happened = {
  repeated: false,
  minutes: 0,
  purposeTold: false,
  wrongParaphrase: false,
  concreteCase: false,
  keptOn: false,
};

/**
 * The size of each drift rule. A cast sheet may set its own. One last
 * question after "I must go" is answered, a second one is too many: from
 * just under `wrapUpBelow`, two answers of `perAnswer + keptOn` go below
 * `leaveBelow`, one does not.
 */
export const driftRules = {
  perAnswer: 0.015,
  /** Added per answer for a temper that is all in a hurry, in proportion to its weight. */
  perAnswerRushed: 0.05,
  repeated: 0.12,
  keptOn: 0.08,
  /** Energy lost for each minute past the tenth. */
  perMinutePastTen: 0.05,
  purposeTold: 0.4,
  wrongParaphraseTrust: 0.2,
  wrongParaphrasePatience: 0.1,
  /** A concrete case opens someone guarded; for someone open it changes little. */
  concreteCaseGuarded: 0.2,
  concreteCaseOpen: 0.03,
  /** A rambler's focus wanders a little with every answer, in proportion to its weight. */
  perAnswerFocusRambler: 0.06,
} as const;
export type DriftRules = Readonly<Record<keyof typeof driftRules, number>>;

const clamp = (value: number): number =>
  Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;

const weightOf = (mix: TemperMix, temper: Temper): number => mix[temper] ?? 0;

/** Someone's state before the first answer: from their mix, and a little chance from their mark. */
export const freshState = (mix: TemperMix, seed: string): State => {
  const jitter = (at: number) => (rollOf(seed, 900 + at) - 0.5) * 0.1;
  return {
    patience: clamp(
      0.85 -
        0.35 * weightOf(mix, "rushed") -
        0.1 * weightOf(mix, "short") +
        jitter(0)
    ),
    trust: clamp(
      0.7 -
        0.45 * weightOf(mix, "wary") -
        0.15 * weightOf(mix, "joker") +
        jitter(1)
    ),
    energy: clamp(0.9 - 0.15 * weightOf(mix, "rushed") + jitter(2)),
    focus: clamp(0.85 - 0.4 * weightOf(mix, "rambler") + jitter(3)),
  };
};

/** The state after what happened before this answer: the drift rules, and nothing else. */
export const drift = (
  state: State,
  mix: TemperMix,
  happened: Happened,
  minutesBefore: number,
  rules: DriftRules = driftRules
): State => {
  const guarded = state.trust < opensAt;
  let { patience, trust, energy, focus } = state;
  patience -= rules.perAnswer + rules.perAnswerRushed * weightOf(mix, "rushed");
  if (happened.repeated) {
    patience -= rules.repeated;
  }
  if (happened.keptOn) {
    patience -= rules.keptOn;
  }
  // Only the minutes past the tenth that are new since the last answer cost energy.
  energy -=
    rules.perMinutePastTen *
    Math.max(0, happened.minutes - Math.max(10, minutesBefore));
  if (happened.purposeTold) {
    trust += rules.purposeTold;
  }
  if (happened.wrongParaphrase) {
    trust -= rules.wrongParaphraseTrust;
    patience -= rules.wrongParaphrasePatience;
  }
  if (happened.concreteCase) {
    trust += guarded ? rules.concreteCaseGuarded : rules.concreteCaseOpen;
  }
  focus -= rules.perAnswerFocusRambler * weightOf(mix, "rambler");
  return {
    patience: clamp(patience),
    trust: clamp(trust),
    energy: clamp(energy),
    focus: clamp(focus),
  };
};

/** What a change of state was, for whoever reads the interview. */
export type Turned =
  | "warmed up"
  | "closed up"
  | "tired"
  | "wants to finish"
  | "left";

/** The lines a state crossed between two answers. */
export const turnedOf = (before: State, after: State): Turned[] =>
  [
    before.trust < opensAt && after.trust >= opensAt && "warmed up",
    before.trust >= holdsBackBelow &&
      after.trust < holdsBackBelow &&
      "closed up",
    before.energy >= tiredBelow && after.energy < tiredBelow && "tired",
    before.patience >= wrapUpBelow &&
      after.patience < wrapUpBelow &&
      "wants to finish",
    before.patience >= leaveBelow && after.patience < leaveBelow && "left",
  ].filter((each): each is Turned => each !== false);

/** Weights as people read them: whole hundredths. */
const hundredths = (value: number): number => Math.round(value * 100) / 100;

/**
 * Who has which mix in a practice company: the v1 temper first
 * (`tempersFor`), and for two people in three a second temper beside it,
 * by the seed.
 */
export const mixesFor = (count: number, seed: number): TemperMix[] =>
  tempersFor(count, seed).map((temper, at) => {
    const mark = `mix:${seed}:${at}`;
    if (rollOf(mark, 0) < 1 / 3) {
      return { [temper]: 1 };
    }
    const others = tempers.filter((each) => each !== temper);
    const second =
      others[Math.floor(rollOf(mark, 1) * others.length)] ?? "plain";
    const weight = hundredths(0.25 + rollOf(mark, 2) * 0.2);
    return { [temper]: hundredths(1 - weight), [second]: weight };
  });

/** The tempers of a mix, most first. */
export const tempersOf = (mix: TemperMix): Temper[] =>
  tempers
    .filter((temper) => weightOf(mix, temper) > 0)
    .toSorted((a, b) => weightOf(mix, b) - weightOf(mix, a));

/** The temper that leads one answer, drawn from the mix by that answer's roll. */
export const drawTemper = (mix: TemperMix, roll: number): Temper => {
  const ordered = tempersOf(mix);
  let sum = 0;
  for (const temper of ordered) {
    sum += weightOf(mix, temper);
    if (roll < sum) {
      return temper;
    }
  }
  return ordered.at(-1) ?? "plain";
};

/** A mix in words, for a log or a score card: "official 60%, rushed 40%". */
export const mixLine = (mix: TemperMix): string =>
  tempersOf(mix)
    .map((temper) => `${temper} ${Math.round(weightOf(mix, temper) * 100)}%`)
    .join(", ");

// A question asked again.

const wordPattern = /[\p{L}\p{N}]+/gu;
const sentenceEnd = /(?<=[.!?])\s+/u;

/**
 * Words that say nothing about what a question is about: small words, and
 * the frame every number question shares ("how many … your whole team …
 * in a normal week"). Two number questions about different things are not
 * one question asked twice.
 */
const smallWords: ReadonlySet<string> = new Set([
  "your",
  "what",
  "which",
  "that",
  "this",
  "with",
  "have",
  "does",
  "there",
  "they",
  "them",
  "then",
  "when",
  "from",
  "about",
  "would",
  "like",
  "just",
  "into",
  "were",
  "will",
  "jouw",
  "welke",
  "deze",
  "waar",
  "wanneer",
  "heeft",
  "hebben",
  "doet",
  "voor",
  "naar",
  "over",
  "werk",
  "work",
  "many",
  "much",
  "long",
  "often",
  "normal",
  "typical",
  "usual",
  "week",
  "month",
  "whole",
  "team",
  "roughly",
  "minutes",
  "hours",
  "days",
  "take",
  "takes",
  "hoeveel",
  "vaak",
  "lang",
  "normale",
  "gewone",
  "maand",
  "hele",
  "ongeveer",
  "minuten",
  "uren",
  "dagen",
  "duurt",
  "kost",
]);

/** The words of a line that say what it is about. */
const wordsOf = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(wordPattern) ?? []).filter(
      (word) => word.length > 3 && !smallWords.has(word)
    )
  );

/** The question in a line of his: its last sentence that asks, without what he said before it ("That one I can't use."). */
const questionOf = (text: string): string | undefined =>
  text.split(sentenceEnd).findLast((sentence) => sentence.trim().endsWith("?"));

/** Answers after which asking the same again is fair: they gave no real answer, or asked something back. */
const fairToAskAgain: ReadonlySet<Move> = new Set<Move>([
  "not an answer",
  "not an answer again",
  "few words",
  "why do you ask",
  "where to start",
]);

/**
 * Whether Stephen's last question asks again what one of his questions
 * before it asked: at least three words that say what it is about, and
 * most of them, were in it. Asking again after an answer that was no
 * answer (`last`) is fair, and costs nothing.
 */
export const isRepeated = (
  lines: readonly Said[],
  last: Move | null = null
): boolean => {
  if (last !== null && fairToAskAgain.has(last)) {
    return false;
  }
  const his = lines.filter(({ from }) => from === "stephen");
  const now = questionOf(his.at(-1)?.text ?? "");
  if (now === undefined) {
    return false;
  }
  const words = wordsOf(now);
  if (words.size < 3) {
    return false;
  }
  return his.slice(0, -1).some((before) => {
    const asked = questionOf(before.text);
    if (asked === undefined) {
      return false;
    }
    const then = wordsOf(asked);
    const shared = [...words].filter((word) => then.has(word)).length;
    return shared >= 3 && shared / Math.min(words.size, then.size) >= 0.7;
  });
};

const wordCount = (text: string): number =>
  text.trim().split(/\s+/u).filter(Boolean).length;

/**
 * Minutes of talk the lines took two people, by the sum `play.ts` keeps
 * its "talk" clock by: what the person feels, whatever the model took.
 */
export const talkMinutes = (lines: readonly Said[]): number =>
  lines.reduce(
    (seconds, { from, text }) =>
      seconds +
      (from === "stephen"
        ? wordCount(text) * 0.4 + 2.3
        : 6 + wordCount(text) * 1.2),
    0
  ) / 60;
