import { z } from "zod";

import {
  factTags,
  interviewFactSchema,
  interviewLimits,
  interviewLineSchema,
  interviewPhases,
  interviewSecretSchema,
  voiceTags,
} from "./interview-links.ts";
import { interviewerSchema, interviewLocaleSchema } from "./onboarding.ts";

// One turn of an interview with Stephen (core's onboarding/interview.ts):
// what the page sends, the events it gets back, and the checks both go
// through. The models write Stephen's line, but they don't get the last
// word: a line with two questions, praise or filler, or a tone he doesn't
// have is put right here before anyone hears it, and a fact whose words
// weren't said is left out. Ported from the prototype (grasplabs/prototype,
// packages/grasp: src/lib/interview-turn.ts), which the Stephen Lab
// measures: change the rules there and here together.

export const interviewTurnPath = "/api/interview/turn";

/**
 * What just happened: the interview starts; they answered; they came back
 * after leaving; they shared a file; they stayed quiet after stopping
 * mid-sentence; they answered to lines read back to them; or they came
 * back after agreeing to it all, to add something.
 */
export const interviewEvents = [
  "start",
  "answer",
  "resume",
  "file",
  "nudge",
  "readback",
  "add",
] as const;
export type InterviewEvent = (typeof interviewEvents)[number];

/** What Stephen waits for after his line. */
export const interviewWants = ["answer", "file", "readback", "end"] as const;
export type InterviewWants = (typeof interviewWants)[number];

export type InterviewPhase = (typeof interviewPhases)[number];
export type FactTag = (typeof factTags)[number];
export type VoiceTag = (typeof voiceTags)[number];

/** The most of the conversation a turn sends the models: its last lines. */
export const turnLinesMax = 160;
/** The longest answer the models read; a longer one keeps its start and end (`answerOf`). */
export const turnAnswerMax = 4000;
/** The longest line Stephen says: what his voice takes in one go. */
export const sayMax = 560;
/** The most words a question of his has. */
export const questionWordsMax = 15;
/** The most bytes one turn's request may carry. */
export const interviewTurnMaxBytes = 768 * 1024;

/**
 * What the page sends for one turn. Who they are, their team, their lead
 * and what Stephen knows come from the store, never from here: the page
 * sends only the conversation, which it holds, and what just happened.
 */
export const interviewTurnRequestSchema = z.strictObject({
  secret: interviewSecretSchema,
  key: interviewSecretSchema,
  event: z.enum(interviewEvents),
  locale: interviewLocaleSchema,
  /** Who holds the interview: the one they chose on the way in. */
  interviewer: interviewerSchema.default("stephen"),
  /** The conversation so far, oldest first; the last line is what they just said. */
  lines: z
    .array(
      interviewLineSchema.pick({
        from: true,
        text: true,
        typed: true,
        file: true,
      })
    )
    .max(interviewLimits.lines),
  facts: z
    .array(interviewFactSchema.pick({ id: true, tag: true, text: true }))
    .max(interviewLimits.facts),
  phase: z.enum(interviewPhases),
  /** Minutes since they pressed start. */
  minutes: z.number().min(0).max(240),
  /** With `readback`: the facts that were read back, by id. */
  reading: z.array(interviewFactSchema.shape.id).max(12).optional(),
  /** They agreed to the read-back before and are back to add something. */
  adding: z.boolean().default(false),
});
export type InterviewTurnRequest = z.output<typeof interviewTurnRequestSchema>;

/** What Stephen does next. */
export interface StephenTurn {
  /** What he says. Empty when he says nothing: they stopped mid-sentence, or simply agreed. */
  say: string;
  tone: VoiceTag | null;
  phase: InterviewPhase;
  /** What he wrote down from what was just said. */
  facts: { tag: FactTag; text: string; record: string; quote: string }[];
  /** Facts from before that what was just said puts right: a new text, or none to take it out. */
  changes: { id: string; text: string | null; record: string | null }[];
  wants: InterviewWants;
  /** They stopped mid-sentence: he waits for the rest. */
  more: boolean;
  /** They agreed to the lines read back. */
  approved: boolean;
}

/** His line, known before the rest of his turn: what he says and how. */
export interface EarlyLine {
  say: string;
  tone: VoiceTag | null;
}

/** Where the interview goes from his line on, known a moment after it. */
export interface EarlyNext {
  phase: InterviewPhase | null;
  wants: InterviewWants;
}

/**
 * A turn as it comes back, a line of JSON at a time: the first sentence of
 * his line while the rest is still being written (`earlyOpening`); his
 * line as soon as it is written; where the interview goes from there
 * (`earlyNext`); then the whole turn; or that it failed, and how.
 */
export type TurnEvent =
  | { opening: EarlyLine }
  | { line: EarlyLine }
  | { next: EarlyNext }
  | { turn: StephenTurn }
  | { error: string; status: number };

const isVoiceTag = (value: unknown): value is VoiceTag =>
  voiceTags.some((tag) => tag === value);

const phaseOf = (value: unknown): InterviewPhase | undefined =>
  interviewPhases.find((phase) => phase === value);

const wantsOf = (value: unknown): InterviewWants | undefined =>
  interviewWants.find((wants) => wants === value);

const textOf = (value: unknown, most: number): string =>
  typeof value === "string" ? value.trim().slice(0, most) : "";

/** What stands where the middle of an answer was left out. */
export const leftOut = " […] ";

/**
 * An answer no longer than `most`. A longer one keeps its start and its
 * end, with a mark where the middle was left out: what someone puts right
 * comes last, and must never be the part that is lost.
 */
export const answerOf = (said: string, most = turnAnswerMax): string => {
  const trimmed = said.trim();
  if (trimmed.length <= most) {
    return trimmed;
  }
  const tail = Math.floor(most / 3);
  const head = trimmed.slice(0, most - tail - leftOut.length).trimEnd();
  return `${head}${leftOut}${trimmed.slice(-tail).trimStart()}`;
};

/**
 * Phrases Stephen never says, whatever the model wrote: praise of an
 * answer, filler, and claims to know how someone feels. A sentence with
 * one of them is left out of his line.
 */
const banned = [
  /\bgreat (?:question|answer|point)\b/iu,
  /\b(?:good|excellent|awesome|amazing|perfect|fantastic|wonderful) (?:question|answer|point)\b/iu,
  /\babsolutely\b/iu,
  /\btotally\b/iu,
  /\b(?:super|so|really|very) interesting\b/iu,
  /\bi (?:completely|totally|fully) understand\b/iu,
  /\bno worries\b/iu,
  /\bi know (?:exactly )?how you feel\b/iu,
  /\bas an ai (?:language )?model\b/iu,
  /\b(?:goede|mooie|uitstekende) (?:vraag|antwoord)\b/iu,
  /\bhelemaal goed\b/iu,
  /\bsuper interessant\b/iu,
  /\bik begrijp (?:het )?(?:helemaal|volledig)\b/iu,
  /\b(?:gute|tolle|super) (?:frage|antwort)\b/iu,
  /\b(?:excellente|bonne|très bonne) (?:question|réponse)\b/iu,
  /\b(?:buena|excelente|gran) (?:pregunta|respuesta)\b/iu,
];

const sentenceEnd = /(?<=[.?!…])\s+/u;
const spaces = /\s+/gu;

const sentencesOf = (line: string): string[] =>
  line.trim().split(sentenceEnd).filter(Boolean);

/** The words a question starts with, in the languages he speaks. */
const asks = [
  "what|where|who|whom|whose|how|why|when|which",
  "wat|waar|waarom|waarmee|waarin|waarvoor|waarop|waardoor|waarna|waarvan|waarheen|wie|hoe|hoeveel|wanneer|welke?",
  "was|wo|wohin|woher|womit|wofür|wozu|wer|wem|wen|warum|wann|wieviele?|welche[rsmn]?",
  "que|quoi|où|qui|comment|pourquoi|quand|combien|quel(?:le)?s?",
  "qué|dónde|quién(?:es)?|cómo|cuándo|cuál(?:es)?|por qué|cuánt[oa]s?",
].join("|");

/**
 * Two questions joined into one sentence, as in "Who sends it back, and
 * why?": a question word, then a comma, "and", and a question word once
 * more, perhaps after a few words that lead in. Someone answers the
 * second, and the first is lost.
 */
const joined = new RegExp(
  String.raw`^(?<asked>(?:[^?,:]*[,:] )?¿?(?:${asks})(?=[\s,?'’])[^?]*?), (?:and|en|und|et|y) ¿?(?:${asks})(?=[\s,?'’])[^?]*?(?<mark>\s?\?)$`,
  "iu"
);

/**
 * A line of Stephen's as he may say it: without a sentence that praises
 * or fills, with only its first question (one question a turn), and no
 * longer than his voice takes in one go.
 */
export const asStephenSays = (line: string): string => {
  const kept: string[] = [];
  for (const sentence of sentencesOf(line.replace(spaces, " "))) {
    if (banned.some((phrase) => phrase.test(sentence))) {
      continue;
    }
    const question = sentence.endsWith("?");
    kept.push(
      question ? sentence.replace(joined, "$<asked>$<mark>") : sentence
    );
    // What comes after his question isn't said: he asks, and then he stops.
    if (question) {
      break;
    }
  }
  let said = kept.join(" ");
  while (said.length > sayMax && kept.length > 1) {
    kept.shift();
    said = kept.join(" ");
  }
  return said.slice(0, sayMax);
};

export type LineMistake =
  | "two questions"
  | "long question"
  | "praise or filler";

/** What a line of his got wrong by his own rules, before it was put right: nothing when it is fine. */
export const mistakesIn = (line: string): LineMistake[] => {
  const sentences = sentencesOf(line);
  const questions = sentences.filter((each) => each.endsWith("?"));
  return [
    ...(questions.length > 1 ? (["two questions"] as const) : []),
    ...(questions.some((each) => each.split(spaces).length > questionWordsMax)
      ? (["long question"] as const)
      : []),
    ...(sentences.some((each) => banned.some((phrase) => phrase.test(each)))
      ? (["praise or filler"] as const)
      : []),
  ];
};

/**
 * His line written as plain lines, one thing to a line, each named: the
 * shape the quick model answers in, because it has the line out sooner
 * that way than in JSON. In the order they are written.
 */
const plain = {
  tone: "TONE",
  say: "SAY",
  phase: "PART",
  wants: "WANTS",
  more: "MORE",
  approved: "AGREED",
} as const;

/**
 * What the model that says his line is told last: the plain lines it
 * answers in, and that what he writes down is asked of another.
 */
export const onlyLine = `Answer with your line only, in exactly these six lines and nothing else:
TONE: how you say it: one of your tones, or none
SAY: what you say now, all of it on this one line; nothing after the colon when you say nothing
PART: the part of the interview your line belongs to
WANTS: answer, file, readback or end
MORE: yes when they stopped mid-sentence and you wait for the rest, else no
AGREED: yes when they agreed to the lines you read back, else no
What you write down is asked of you separately.`;

/** What the model that writes down what was said is told last. */
export const onlyNotes =
  "Answer only with what you write down from what they just said: the facts, and the changes to facts from before. Your line is said separately; when they said nothing new about the work, both are empty.";

const nameLines = new Map(
  Object.values(plain).flatMap((name) => [
    [
      `${name}:whole`,
      new RegExp(String.raw`^${name}:[ \t]*(?<value>.*)\n`, "imu"),
    ],
    [
      `${name}:part`,
      new RegExp(String.raw`^${name}:[ \t]*(?<value>.*)$`, "imu"),
    ],
  ])
);

/**
 * What stands after a name in what was written: the rest of its line.
 * None when that line isn't there, or, with `whole`, not finished yet.
 */
const named = (lines: string, name: string, whole = false): string | null => {
  const found = nameLines
    .get(`${name}:${whole ? "whole" : "part"}`)
    ?.exec(lines);
  return found?.groups?.value?.trim() ?? null;
};

/**
 * Stephen's line out of plain lines the model is still writing, as he may
 * say it. `null` while it isn't finished; `false` when he says nothing
 * before the whole turn is in.
 */
export const earlyPlainLine = (lines: string): EarlyLine | false | null => {
  const tone = named(lines, plain.tone, true);
  const said = named(lines, plain.say, true);
  if (tone === null || said === null) {
    return null;
  }
  const say = asStephenSays(said);
  return say === "" ? false : { say, tone: isVoiceTag(tone) ? tone : null };
};

const firstSentence = /^(?<first>.*?[.!…])\s+\S/u;

/**
 * The first sentence of his line while the rest of it is still to come,
 * so he can begin to say it: the model writes about forty words a second,
 * so a short first sentence ("Okay.") is there half a second before the
 * question after it. Only a sentence he may say as it is, and never a
 * question: his question is the last thing he says. `null` otherwise, also
 * once his line is whole (`earlyPlainLine`).
 */
export const earlyOpening = (lines: string): EarlyLine | null => {
  const tone = named(lines, plain.tone, true);
  if (tone === null || named(lines, plain.say, true) !== null) {
    return null;
  }
  const first = firstSentence.exec(named(lines, plain.say) ?? "")?.groups
    ?.first;
  if (first === undefined || asStephenSays(first) !== first) {
    return null;
  }
  return { say: first, tone: isVoiceTag(tone) ? tone : null };
};

/**
 * Where the interview goes from his line on: the part and what he waits
 * for, once both are written. `null` before that, or when what he waits
 * for is nothing he can wait for.
 */
export const earlyNext = (lines: string): EarlyNext | null => {
  const phase = named(lines, plain.phase, true)?.toLowerCase();
  const wants = wantsOf(named(lines, plain.wants, true)?.toLowerCase());
  if (phase === undefined || wants === undefined) {
    return null;
  }
  return { phase: phaseOf(phase) ?? null, wants };
};

const yes = /^(?:yes|true)\b/iu;

/** Whether he waits for the rest of what they say, as far as it is written. */
export const waitsForMore = (lines: string): boolean =>
  yes.test(named(lines, plain.more) ?? "");

/** His line as it was written in plain lines, whole, in the shape a turn is checked in (`checkedTurn`). */
export const plainLine = (lines: string): Record<string, unknown> => ({
  tone: named(lines, plain.tone) ?? undefined,
  say: named(lines, plain.say) ?? "",
  phase: named(lines, plain.phase)?.toLowerCase(),
  wants: named(lines, plain.wants)?.toLowerCase(),
  more: yes.test(named(lines, plain.more) ?? ""),
  approved: yes.test(named(lines, plain.approved) ?? ""),
});

/**
 * What the model that writes down what was said answers: the facts, and
 * the changes to facts from before. Checked loosely here, and every fact
 * again against what was said (`checkedTurn`).
 */
export const notesSchema = z.object({
  facts: z.array(
    z.object({
      tag: z.string(),
      text: z.string(),
      record: z.string(),
      quote: z.string(),
    })
  ),
  changes: z.array(
    z.object({ id: z.string(), text: z.string(), record: z.string() })
  ),
});

const quoteMarks = /[‘’`´]/gu;
const doubleMarks = /[“”„«»]/gu;
const ends = /^[\s.,;:!?"'…-]+|[\s.,;:!?"'…-]+$/gu;

/** Words as they are compared: small letters, plain quote marks, one space, no punctuation at the ends. */
const plainWords = (said: string): string =>
  said
    .toLowerCase()
    .replace(quoteMarks, "'")
    .replace(doubleMarks, '"')
    .replace(spaces, " ")
    .replace(ends, "");

/** Whether the words a fact is said to come from stand in the answer. Two letters are no words to stand on. */
const saidIn = (answer: string, quote: string): boolean => {
  const wanted = plainWords(quote);
  return wanted.length >= 3 && plainWords(answer).includes(wanted);
};

const looseObject = z.record(z.string(), z.unknown());

/** Where a quote stands in what was said, whatever its capitals; none when the words aren't there. */
export const spanOf = (
  said: string,
  quote: string
): [number, number] | null => {
  const wanted = quote.trim();
  if (wanted === "") {
    return null;
  }
  const at = said.toLowerCase().indexOf(wanted.toLowerCase());
  return at === -1 ? null : [at, at + wanted.length];
};

const asRecord = (value: unknown): Record<string, unknown> =>
  looseObject.safeParse(value).data ?? {};

const listOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/**
 * What the models gave back, checked against what was said: his line as
 * he may say it, a tone he has, and only facts whose words are really in
 * the answer. A fact that names no words of the answer, or words that
 * aren't there, is left out: nothing is written down that the person
 * didn't say. The one fact that needs no words is the example they shared
 * without saying anything. `answer` is what they just said, `known` the
 * ids of the facts so far, and `phase` the part the interview was in,
 * which it stays in when the model names none.
 */
export const checkedTurn = (
  value: unknown,
  {
    answer,
    known,
    phase,
  }: { answer: string; known: readonly string[]; phase: InterviewPhase }
): StephenTurn => {
  const body = asRecord(value);
  const more = body.more === true;
  return {
    say: more ? "" : asStephenSays(textOf(body.say, 2000)),
    tone: isVoiceTag(body.tone) ? body.tone : null,
    phase: phaseOf(body.phase) ?? phase,
    facts: more
      ? []
      : listOf(body.facts).flatMap((each) => {
          const fact = asRecord(each);
          const tag = factTags.find((known_) => known_ === fact.tag);
          const said = textOf(fact.text, interviewLimits.fact);
          const quote = textOf(fact.quote, interviewLimits.fact);
          const shared = tag === "case" && answer.trim() === "";
          if (
            tag === undefined ||
            said === "" ||
            !(saidIn(answer, quote) || shared)
          ) {
            return [];
          }
          return [
            {
              tag,
              text: said,
              record: textOf(fact.record, interviewLimits.fact) || said,
              // Marked in the answer only where it stands letter for letter.
              quote: spanOf(answer, quote) === null ? "" : quote,
            },
          ];
        }),
    changes: listOf(body.changes).flatMap((each) => {
      const change = asRecord(each);
      const id = textOf(change.id, 20);
      if (!known.includes(id)) {
        return [];
      }
      const said = textOf(change.text, interviewLimits.fact);
      return [
        {
          id,
          text: said === "" ? null : said,
          record:
            said === ""
              ? null
              : textOf(change.record, interviewLimits.fact) || said,
        },
      ];
    }),
    wants: wantsOf(body.wants) ?? "answer",
    more,
    approved: body.approved === true,
  };
};

const ending = /^[a-z0-9]{1,5}$/iu;
const wordMarks = /[_-]+/gu;

/**
 * What a shared file is called when it is spoken of: its name without the
 * ending that says what kind of file it is, and with the marks people put
 * between words read as spaces. "workflow.pdf" is "workflow". Nobody says
 * "dot pdf" out loud, so the interviewer never sees the ending.
 */
export const fileCalled = (name: string): string => {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf(".");
  const stem =
    dot > 0 && ending.test(trimmed.slice(dot + 1))
      ? trimmed.slice(0, dot)
      : trimmed;
  const spoken = stem.replace(wordMarks, " ").replace(spaces, " ").trim();
  return spoken === "" ? trimmed : spoken;
};

const turnEventSchema: z.ZodType<TurnEvent> = z.union([
  z.object({
    opening: z.object({ say: z.string(), tone: z.enum(voiceTags).nullable() }),
  }),
  z.object({
    line: z.object({ say: z.string(), tone: z.enum(voiceTags).nullable() }),
  }),
  z.object({
    next: z.object({
      phase: z.enum(interviewPhases).nullable(),
      wants: z.enum(interviewWants),
    }),
  }),
  z.object({
    turn: z.custom<StephenTurn>(
      (value) => typeof value === "object" && value !== null
    ),
  }),
  z.object({ error: z.string(), status: z.number() }),
]);

/**
 * The events in what has come in of a turn so far, one to every line that
 * is whole; `rest` is the start of a line that isn't, to put before what
 * comes in next. A line that is no event is left out.
 */
export const turnEvents = (
  arrived: string
): { events: TurnEvent[]; rest: string } => {
  const lines = arrived.split("\n");
  const rest = lines.pop() ?? "";
  const events = lines.flatMap((line) => {
    try {
      const parsed = turnEventSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
  return { events, rest };
};
