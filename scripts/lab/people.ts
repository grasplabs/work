/**
 * People as they are. The lab's first practice people told all they knew
 * to whoever asked, in whole sentences. Nobody does, and it made every
 * score look better than it is. Measured against 451 people, a model that
 * plays a user gives a turn of three words or fewer 1 time in 100 where
 * people do 29 in 100, is polite three times as often, tells everything up
 * front and never gets annoyed (Mind the Sim2Real Gap, 2026). About one
 * person in ten answers a survey without care (Meade and Craig, 2012).
 * Experts leave out most of what they decide when they tell how they work
 * (Clark and others), people tell the procedure for what they do (work as
 * imagined, work as done), and a number someone gives for how many or how
 * long is often a guess.
 *
 * So a practice person has a temper: one of these ways of answering, on
 * top of what they know. What a temper does on which answer is decided
 * here, by code and a seed, so two runs of one practice company meet the
 * same people; the model only says it in their words. Pure, but for
 * `realPlayer` and what it asks a model. Ported from the prototype
 * (grasplabs/prototype, packages/grasp: lab/people.ts).
 */
import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { z } from "zod";

import { colleaguesOf, sliceOf } from "./keys/types.ts";
import type { AnswerKey, KeyEmployee, SliceFact } from "./keys/types.ts";
import { nonsense } from "./moves.ts";
import type { Move } from "./moves.ts";
import { languages, lineOf, told, whoIs } from "./person.ts";
import type { Answer, Asker, Player } from "./person.ts";

export const tempers = [
  "plain",
  "short",
  "official",
  "guesser",
  "rambler",
  "joker",
  "wary",
  "rushed",
] as const;
export type Temper = (typeof tempers)[number];

/** Each temper in a sentence, for whoever reads a score card. */
export const temperPlain: Readonly<Record<Temper, string>> = {
  plain: "Answers what is asked, in few words.",
  short: 'Says as little as possible: "the usual", "depends".',
  official: "Tells how it should go by the procedure, not what they do.",
  guesser: "Gives numbers they do not know, as guesses.",
  rambler: "Talks a lot, out of order, with side stories.",
  joker: "Types nonsense and jokes until told plainly to answer for real.",
  wary: "Holds back until told plainly what this is for.",
  rushed: "Has little time, and leaves when it takes too long.",
};

/** The moves a model may say it made by itself; the others only count when the lab asked for them. */
const ownMoves: readonly Move[] = [
  "do not know",
  "a guess",
  "the official way",
  "second hand",
  "few words",
];
/** Who agrees to a read-back without reading it. */
const agreesUnread: ReadonlySet<Temper> = new Set<Temper>([
  "rushed",
  "joker",
  "short",
]);

// The same people every time.

/* oxlint-disable no-bitwise, unicorn/prefer-math-trunc, unicorn/prefer-code-point -- a string hash and a seeded random are 32-bit arithmetic on UTF-16 units, as the prototype's: Math.trunc and codePointAt would change their numbers, and with them who comes back */

const hash = (text: string): number => {
  let value = 2_166_136_261;
  for (const letter of text) {
    value = Math.imul(value ^ letter.charCodeAt(0), 16_777_619);
  }
  return value >>> 0;
};

/** A number from 0 up to 1 that is the same for the same seed and place, and looks like chance. */
export const rollOf = (seed: string, at: number): number => {
  let value = (hash(`${seed}:${at}`) + 0x6d_2b_79_f5) | 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
};

/* oxlint-enable no-bitwise, unicorn/prefer-math-trunc, unicorn/prefer-code-point */

/** The hard ones first: a practice company of five has them all at seed 1. */
const order: readonly Temper[] = [
  "joker",
  "guesser",
  "official",
  "short",
  "wary",
  "rambler",
  "rushed",
  "plain",
];

/** Who has which temper in a practice company of `count` people: another mix for another seed. */
export const tempersFor = (count: number, seed: number): Temper[] =>
  Array.from(
    { length: count },
    (_, at) =>
      order[(at + (Math.max(seed, 1) - 1) * 3) % order.length] ?? "plain"
  );

/** A number someone does not really know: the amount they say anyway, and who would know. */
export interface Guess {
  says: string;
  who: string;
}

const amountPattern = /(?<amount>\d+(?:[.,]\d+)?)/u;

/**
 * The numbers a guesser does not really know: up to three of their own,
 * each with a wrong amount that is far enough off to matter (about half,
 * or about double).
 */
export const guessesFor = (
  slice: SliceFact[],
  who: string,
  seed: string
): Record<string, Guess> => {
  const amounts = slice.flatMap((fact) => {
    const found = amountPattern.exec(
      fact.remembered ?? fact.howOften ?? fact.howLong ?? ""
    )?.groups?.amount;
    return found === undefined
      ? []
      : [
          {
            id: fact.id,
            amount: Number(found.replace(",", ".")),
            system: fact.system,
          },
        ];
  });
  const picked = amounts
    .toSorted((a, b) => rollOf(seed, hash(a.id)) - rollOf(seed, hash(b.id)))
    .slice(0, 3);
  return Object.fromEntries(
    picked.map((each, at) => {
      const factor = rollOf(seed, at + 100) < 0.5 ? 0.5 : 2.2;
      const wrong = Math.max(
        Math.round(each.amount * factor),
        each.amount === 1 ? 3 : 1
      );
      return [
        each.id,
        {
          says: String(wrong === each.amount ? wrong + 2 : wrong),
          who:
            each.system === undefined
              ? `${who} would know`
              : `${each.system} would have it`,
        },
      ];
    })
  );
};

// What they do on which answer.

/** Where someone is in their own head: what the next answer follows from. */
export interface Mind {
  /** Answers given so far. */
  answers: number;
  /** A joker fools around, tests once more, then gets serious. A wary one is guarded until told what this is for. */
  stage: "fooling" | "testing" | "serious" | "guarded" | "open" | "none";
  /** Answers so far that were no answer at all. */
  wasted: number;
  /** What they did in their last answer. */
  last: Move | null;
  /** Every move so far. */
  done: Move[];
}

const firstStage = (temper: Temper): Mind["stage"] => {
  if (temper === "joker") {
    return "fooling";
  }
  return temper === "wary" ? "guarded" : "none";
};

export const freshMind = (temper: Temper): Mind => ({
  answers: 0,
  stage: firstStage(temper),
  wasted: 0,
  last: null,
  done: [],
});

export interface Direction {
  /** The move the lab asks for; none when they answer their own way. */
  move: Move | null;
  /** What they are told for this answer. */
  text: string;
  stage: Mind["stage"];
  /** They go now: this is their last line, and nothing is agreed to. */
  leaves?: boolean;
}

const isNonsense = (move: Move | null): boolean =>
  move !== null && nonsense.includes(move);

/** What a temper waits to hear in Stephen's last line, when what they do next depends on it. */
export const listensFor = (
  temper: Temper,
  mind: Mind
): "plain word" | "purpose" | null => {
  if (temper === "joker" && mind.stage !== "serious" && isNonsense(mind.last)) {
    return "plain word";
  }
  if (
    temper === "wary" &&
    mind.stage === "guarded" &&
    mind.last === "why do you ask"
  ) {
    return "purpose";
  }
  return null;
};

const say = {
  normal: "Answer in one short sentence: fifteen words at most.",
  brief: "Answer in three words or fewer.",
  nonsense:
    'Give no real answer: a few random letters, a joke, or something silly. Nothing in it is true or about the work. At most six words. "said" is empty.',
  again:
    'You heard him, and you try him once more: another silly answer that is no answer, different from your last one. At most six words. "said" is empty.',
  serious:
    'He means it. Say in a word or two that you will be serious ("ok ok", "fair"), and answer his question for real, in one short sentence. From now on you answer for real.',
  careless:
    'Answer with two or three careless words that tell nothing: "the usual", "whatever", "depends". "said" is empty.',
  purpose:
    'Do not answer his question yet. Ask what this is for and who reads your answers, in a few words of your own. "said" is empty.',
  trusts:
    "He gave you a straight answer, and that is enough for you. From now on you answer normally. Answer his question in one short sentence.",
  guarded:
    'You got no straight answer on what this is for, so you stay careful: a few words at most. About what goes differently, your own lists, how you decide, AI tools and numbers you say "depends" or "no idea", though you know. "said" is empty for those.',
  terse:
    "Answer in as few words as you can. You have little time, and it shows.",
  mustGo:
    "Answer in a few words, then say you have to go in two minutes and ask whether he can finish.",
  mustGoNow:
    "Answer in three words at most, and say again that you really have to go.",
  gone: 'Say in a few words that you have to go now, and nothing else. "said" is empty.',
  procedure:
    'Tell how it should go by the written procedure, and say that it is the procedure ("according to the procedure…", "officially…", "we are supposed to…"). Nothing of what you did yourself with the last one. "said" holds only the facts of yours that the procedure states too.',
  twice:
    "Answer, and in passing say a number again that you gave earlier in this interview, but a clearly different amount, as if you never said the first. When you gave no number yet, only answer.",
  flood:
    'Tell five or six things about this work at once and out of order, in one long run-on sentence of 60 to 90 words: steps, something that goes differently, something that annoys you. "said" holds the facts you really stated.',
  detour:
    "Answer in a few words, then wander off into a side story that says nothing about how the work goes: the office, the old system, lunch. About fifty words.",
  hearsay:
    "Answer, and add what you think a colleague does with it after you, in their own part of the work, and that you are not sure of it.",
  long: "Answer at length: thirty to fifty words, with a detail or two that was not asked for.",
  whereTo:
    'Do not tell your story yet. Ask where he wants you to start, or what he wants to hear, in a few words. "said" is empty.',
} as const;

/** How often an answer of someone with nothing to make of it is a word or two, as people's are. */
const briefShare = 0.29;

/** How someone with no move to make answers: now and then in a word or two, as people do. */
const own = (roll: number, stage: Mind["stage"]): Direction => ({
  move: null,
  text: roll < briefShare ? say.brief : say.normal,
  stage,
});

/** What happened so far, as a temper decides by. */
interface Turn {
  nth: number;
  did: (move: Move) => number;
  phase: InterviewPhase;
  roll: number;
  heard: boolean;
}

const jokerDirection = (mind: Mind, turn: Turn): Direction => {
  const { nth, roll, heard } = turn;
  const fooled = isNonsense(mind.last);
  if (mind.stage === "serious") {
    return own(roll, "serious");
  }
  if (nth === 1) {
    return { move: null, text: say.brief, stage: "fooling" };
  }
  if (mind.stage === "testing") {
    return heard
      ? { move: null, text: say.serious, stage: "serious" }
      : { move: "few words", text: say.careless, stage: "fooling" };
  }
  // Told plainly: half of them try once more, the others get serious at once.
  if (fooled && heard) {
    return roll < 0.5
      ? { move: "not an answer again", text: say.again, stage: "testing" }
      : { move: null, text: say.serious, stage: "serious" };
  }
  // He let it pass: they go on, three times at most in a row, and then every third answer.
  if (nth === 2 || (fooled && mind.wasted < 3) || nth % 3 === 0) {
    return { move: "not an answer", text: say.nonsense, stage: "fooling" };
  }
  return { move: "few words", text: say.careless, stage: "fooling" };
};

const waryDirection = (mind: Mind, turn: Turn): Direction => {
  const { nth, did, roll, heard } = turn;
  if (mind.stage === "open") {
    return own(roll, "open");
  }
  if (nth === 1) {
    return { move: null, text: say.brief, stage: "guarded" };
  }
  if (mind.last === "why do you ask" && heard) {
    return { move: null, text: say.trusts, stage: "open" };
  }
  if (nth === 2 || (nth === 6 && did("why do you ask") < 2)) {
    return { move: "why do you ask", text: say.purpose, stage: "guarded" };
  }
  return { move: null, text: say.guarded, stage: "guarded" };
};

/** How many answers someone rushed gives before they say they must go, say it again, and go. */
const rushedMustGo = 9;
const rushedMustGoNow = 10;
const rushedGone = 12;

const rushedDirection = ({ nth }: Turn): Direction => {
  if (nth >= rushedGone) {
    return { move: null, text: say.gone, stage: "none", leaves: true };
  }
  if (nth >= rushedMustGoNow) {
    return { move: "wrap up", text: say.mustGoNow, stage: "none" };
  }
  if (nth === rushedMustGo) {
    return { move: "wrap up", text: say.mustGo, stage: "none" };
  }
  return { move: null, text: say.terse, stage: "none" };
};

const officialDirection = ({ nth, did, phase, roll }: Turn): Direction => {
  const toldIt = did("the official way");
  const again =
    nth >= 7 && toldIt === 1 && (phase === "steps" || phase === "exceptions");
  if ((phase === "story" && toldIt === 0) || again) {
    return { move: "the official way", text: say.procedure, stage: "none" };
  }
  return own(roll, "none");
};

const ramblerDirection = ({ nth, did, phase }: Turn): Direction => {
  if (phase === "steps" && did("flood") === 0) {
    return { move: "flood", text: say.flood, stage: "none" };
  }
  if (nth >= 6 && did("detour") === 0) {
    return { move: "detour", text: say.detour, stage: "none" };
  }
  if (nth >= 8 && did("second hand") === 0) {
    return { move: "second hand", text: say.hearsay, stage: "none" };
  }
  return { move: null, text: say.long, stage: "none" };
};

const shortDirection = (mind: Mind, { nth, did, phase }: Turn): Direction => {
  if (phase === "story" && did("where to start") === 0) {
    return { move: "where to start", text: say.whereTo, stage: "none" };
  }
  if ((nth === 5 || nth === 9) && mind.last !== "few words") {
    return { move: "few words", text: say.careless, stage: "none" };
  }
  return { move: null, text: say.brief, stage: "none" };
};

/** The answer a guesser says a number of again, differently. */
const guesserTwice = 10;

const guesserDirection = ({ nth, did, roll }: Turn): Direction =>
  nth === guesserTwice && did("two versions") === 0
    ? { move: "two versions", text: say.twice, stage: "none" }
    : own(roll, "none");

/** What each temper does on an answer. */
const directions: Readonly<
  Record<Temper, (mind: Mind, turn: Turn) => Direction>
> = {
  plain: (_mind, { roll }) => own(roll, "none"),
  short: shortDirection,
  official: (_mind, turn) => officialDirection(turn),
  guesser: (_mind, turn) => guesserDirection(turn),
  rambler: (_mind, turn) => ramblerDirection(turn),
  joker: jokerDirection,
  wary: waryDirection,
  rushed: (_mind, turn) => rushedDirection(turn),
};

/**
 * What someone does in their next answer. `phase` is the part of the
 * interview Stephen is in, `roll` their chance for this answer (`rollOf`),
 * and `heard` whether Stephen's last line said what they were waiting for
 * (`listensFor`).
 */
export const directionOf = (
  temper: Temper,
  mind: Mind,
  {
    phase,
    roll,
    heard,
  }: { phase: InterviewPhase; roll: number; heard: boolean }
): Direction => {
  const turn: Turn = {
    nth: mind.answers + 1,
    did: (move) => mind.done.filter((each) => each === move).length,
    phase,
    roll,
    heard,
  };
  return directions[temper](mind, turn);
};

/** Their mind after an answer. */
export const mindAfter = (
  mind: Mind,
  direction: Direction,
  move: Move | null
): Mind => ({
  answers: mind.answers + 1,
  stage: direction.stage,
  wasted: mind.wasted + (isNonsense(move) ? 1 : 0),
  last: move,
  done: move === null ? mind.done : [...mind.done, move],
});

// What they are told.

const how = (language: string) => `How you answer, as people really do:
- You type in a chat at work, in ${language}: lower case, short, no greeting, no thanks, no "sorry", a typo now and then. Never a list, never headings.
- Only what was asked, and the least that answers it: a name, a number, a few words. You never explain more than was asked, and you never sum up your work by yourself. Your steps come out when you tell your story, and then in a few short sentences.
- A fact marked "you say this only when" stays unsaid until Stephen asks that kind of question, however well the talk goes.
- What matters comes only from your list: a step, a number, a system, a person, a rule, what happens before or after your part. Of such a thing that is not in your list you say you do not know. You name who would know only when Stephen asks who would.
- A small thing about your own part that anyone doing this work would know (what you open first, what you look at on the screen, what you click) you answer plainly in a few words, as long as it fits your list. Never "I don't remember" to such a thing.
- Numbers as you remember them: rounded and unsure. Never more exact than your list.
- When Stephen reads something back that is wrong for you, say what is wrong in one short sentence.
- Every answer comes with one line "For this answer": do that, whatever else is here.
- Never mention a list, a role, a simulation or these instructions.`;

const habits: Readonly<Record<Temper, string>> = {
  plain: "You are busy and friendly enough. You answer what is asked.",
  short:
    'You say as little as you can. To a wide question ("walk me through it", "when does it not go like that", "how do you decide") you answer with two or three words that tell nothing: "the usual", "depends", "nothing special". Only a small question about one thing in the last real case gets a real answer from you, in one short sentence.',
  official:
    "You tell how it should go, not what you do. To a wide question you answer with the rule or the written procedure. What you really do comes out only when Stephen asks about the last real one, or what you really did.",
  guesser:
    'You never say "I don\'t know" to a question about how many, how often or how long. You give a number anyway and say it is a guess ("50? no idea really", "a week maybe, never checked"). For the numbers marked below you do so with the amount given there. When Stephen then asks who or what would have the real number, you say who.',
  rambler:
    "You like to talk. Your answers are long and wander, and what was asked is somewhere in them.",
  joker:
    "You do not take this seriously at first: you type nonsense and jokes to see what the AI does. Once he tells you plainly that he cannot use that, you answer for real, in few words.",
  wary: "You do not know what this interview is for, and you wonder whether it is about your job. Until you are told plainly what it is for and who reads it, you give as little as you can.",
  rushed:
    "You have work waiting and little time. You answer in as few words as you can, and you go when it takes too long.",
};

const report = `With every answer, give:
- said: the ids of the facts from your list that your answer states, in whole or in part; also one you only guessed at. An answer that states none has an empty "said".
- move: what you did beside answering, when it is one of these: "do not know" (you said you do not know, and named nobody who would), "a guess" (you gave a number and said it is a guess), "the official way" (you told how it should go, not what you do), "second hand" (you said what a colleague does in their own part, and that you are not sure), "few words" (two or three words that tell nothing). Otherwise "answer".
- untrue: each thing you said in this answer that is not how it really is for you: a number you guessed, a rule you do not follow. A few words each. Mostly empty.`;

/**
 * How someone stands towards AI: what they answer when the interview
 * starts with them and AI. No answer key holds this, so it is dealt out by
 * the same mark that deals out the tempers: two runs of one practice
 * company meet the same people.
 */
const aiStances = [
  "You use ChatGPT now and then for emails. It saves you time, but you check everything, since it once got a fact wrong. Nothing about it worries you. You would like the dullest typing in your work gone.",
  "You do not use AI at work and never tried it. You have no opinion about it and no worry. No wish comes to mind, at most less retyping.",
  "You tried ChatGPT once and found it too vague, so you do not use it. You worry a little that AI will take work like yours. You would like the checking and chasing in your work gone.",
  "You use Copilot to sum up long emails. That goes well, though it sometimes misses a detail. You worry about data of customers or suppliers ending up in such tools. You would like to stop copying things from one system into another.",
  "You use AI a lot, for texts and for spreadsheet formulas, and you like it. It sometimes makes things up. Nothing worries you. You would like it to do whole tasks by itself.",
  "You are not sure AI is allowed at work, so you do not use it there. You would like to know the rules. No wish comes to mind.",
] as const;

/** The stance of one person, from their mark. */
export const stanceFor = (seed: string): string => {
  let sum = 0;
  for (const letter of seed) {
    sum = (sum * 31 + (letter.codePointAt(0) ?? 0)) % 9973;
  }
  return aiStances[sum % aiStances.length] ?? aiStances[0];
};

/** What someone with a temper is told: who they are, how they answer, their habit, and the facts they know. */
export const realSystem = ({
  key,
  employee,
  lead,
  locale,
  temper,
  seed,
}: {
  key: AnswerKey;
  employee: KeyEmployee;
  lead: string;
  locale: InterviewLocale;
  temper: Temper;
  seed: string;
}): string => {
  const colleagues = colleaguesOf(key, employee);
  const slice = sliceOf(key, employee);
  const guesses = temper === "guesser" ? guessesFor(slice, lead, seed) : {};
  const procedure =
    temper === "official"
      ? `\nThe written procedure, which is what you tell first: ${key.procedure}\n`
      : "";
  return `${whoIs(key, employee, lead)}

${how(languages[locale])}

You and AI, for when Stephen asks about that (it is not in your list, and it is how it is for you): ${stanceFor(seed)}

Who you are in this talk: ${habits[temper]}

The people you work with: ${colleagues.length > 0 ? colleagues.join("; ") : "nobody in particular"}.
${procedure}
What you know about the work, each with its id. It is your own work, as you see it from where you sit:
${slice.map((fact) => lineOf(fact, guesses[fact.id])).join("\n")}

${report}`;
};

// Played by a model.

const hears = {
  "plain word":
    'You read the last two lines of an interview: what a person said, and the interviewer\'s reply. "yes" is true when the reply tells the person plainly that their answer was not usable, or that he needs a real answer, or asks them to answer for real or stop. It is false when the reply only asks a question again, laughs along, or goes on to something else.',
  purpose:
    'You read the last two lines of an interview: a person asked what this is for or who reads it, and the interviewer replied. "yes" is true when the reply itself answers what they asked: it says plainly what the interview is for, and, when they asked who reads it, who does or does not see what they said. It is false when the reply dodges, points to a screen or a note for the answer, only says the question is fair, or goes on with the work.',
} as const;

const heardSchema = z.object({ yes: z.boolean() });

const realAnswerSchema = z.object({
  say: z.string(),
  said: z.array(z.string()),
  move: z.enum([
    "answer",
    "do not know",
    "a guess",
    "the official way",
    "second hand",
    "few words",
  ]),
  untrue: z.array(z.string()),
});

const readBackAnswerSchema = z.object({ say: z.string() });

/** What someone who agrees to a read-back without reading it says. */
const agreedUnread = (locale: InterviewLocale): string =>
  locale === "nl" ? "Ja, klopt." : "Yes, that’s right.";

/** The move an answer counts as: the one the lab asked for, or one the model says it made by itself. */
const moveOf = (direction: Direction, reported: string): Move | null =>
  direction.move ?? ownMoves.find((each) => each === reported) ?? null;

/**
 * Someone with a temper, played by a model: what they do in each answer
 * is decided by `directionOf`, and the model says it in their words and
 * reports which facts were in it.
 */
export const realPlayer = ({
  asker,
  name,
  system,
  known,
  temper,
  seed,
  locale,
}: {
  asker: Asker;
  name: string;
  system: string;
  known: readonly string[];
  temper: Temper;
  seed: string;
  locale: InterviewLocale;
}): Player => {
  let mind = freshMind(temper);
  return {
    name,
    answer: async (lines, asked, at): Promise<Answer> => {
      if (at.readback) {
        // Whoever is in a hurry, or never cared, agrees to what is read back without reading it.
        if (agreesUnread.has(temper)) {
          return { say: agreedUnread(locale), said: [] };
        }
        const reply = await asker({
          role: "quick",
          system,
          input: `The interview so far:\n${told(lines)}\n\n${asked}`,
          schema: readBackAnswerSchema,
          maxTokens: 600,
        });
        return { say: reply.say.trim() || "…", said: [] };
      }
      const waits = listensFor(temper, mind);
      let heard = false;
      if (waits !== null) {
        const reply = await asker({
          role: "quick",
          system: hears[waits],
          input: told(lines.slice(-2), "Person", "Interviewer"),
          schema: heardSchema,
          maxTokens: 200,
        });
        heard = reply.yes;
      }
      const direction = directionOf(temper, mind, {
        phase: at.phase,
        roll: rollOf(seed, mind.answers),
        heard,
      });
      const answer = await asker({
        role: "quick",
        system,
        input: `The interview so far:\n${told(lines)}\n\n${asked}\nFor this answer: ${direction.text}`,
        schema: realAnswerSchema,
        maxTokens: 800,
      });
      const said = answer.say.trim() || "…";
      const move = moveOf(direction, answer.move);
      mind = mindAfter(mind, direction, move);
      return {
        say: said,
        said: [...new Set(answer.said.filter((id) => known.includes(id)))],
        move,
        // An answer that was no answer is not true either: no note may come of it.
        untrue: isNonsense(move)
          ? [`(no answer at all) ${said}`]
          : answer.untrue.map((each) => each.trim()).filter(Boolean),
        ...(direction.leaves === true ? { left: true } : {}),
      };
    },
  };
};
