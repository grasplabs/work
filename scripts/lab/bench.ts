/**
 * The three benches (GRA-338): each gives Stephen the same fixed input
 * every time, so two runs differ only by the Stephen they ran. Notes: a
 * kept conversation, played back line by line, for what he writes down.
 * Next question: a moment, for the one line he says next. Drawing: the
 * agreed interviews of a practice company, for the work core draws from
 * them. Every turn and every drawing is core's own (`/api/lab`), and every
 * judgment the judge's, through core's gateway. A bench is handed what it
 * runs on (`Stand`), so the harness itself is tested with a model faked.
 * Ported from the prototype (grasplabs/prototype, packages/grasp:
 * lab/bench.ts).
 */
import { factTags } from "@grasp-os/shared/interview-links";
import type { InterviewFact } from "@grasp-os/shared/interview-links";
import { mistakesIn } from "@grasp-os/shared/interview-turn";
import type {
  InterviewPhase,
  InterviewTurnRequest,
  StephenTurn,
} from "@grasp-os/shared/interview-turn";
import type { LabWho } from "@grasp-os/shared/lab";
import type { InterviewLocale, Interviewer } from "@grasp-os/shared/onboarding";
import { z } from "zod";

import type { Transcript } from "./cases.ts";
import { inTurns } from "./core.ts";
import {
  drawingSchema,
  joinedCardOf,
  joinedScores,
  judgeJoined,
} from "./joined.ts";
import type { JoinedCard, Teller } from "./joined.ts";
import { judge } from "./judge.ts";
import type { CaseSet } from "./kept.ts";
import { keyOf } from "./keys/index.ts";
import { sliceOf } from "./keys/types.ts";
import type { AnswerKey } from "./keys/types.ts";
import { signalPlain, signalRules, signals } from "./moments.ts";
import type { Moment, Signal } from "./moments.ts";
import type { Asker, Said } from "./person.ts";
import { notesAfter } from "./play.ts";
import type { CaseScore } from "./results.ts";

/** A turn as Stephen is asked for it, without a link. */
export type TurnAsked = Omit<InterviewTurnRequest, "secret" | "key">;

/** What a bench runs on: the local core's turns, drawings and gateway, or fakes of them. */
export interface Stand {
  /** One of Stephen's turns on fixed input; with `lineOnly`, only his line and where he goes are waited for. */
  turn: (
    who: LabWho,
    turn: TurnAsked,
    options: { lineOnly: boolean }
  ) => Promise<StephenTurn>;
  /** The lab's own model calls: the judge, and whoever cuts or writes moments. */
  asker: Asker;
  /** Every piece of work of the local core, drawn again from what was agreed. */
  drawings: () => Promise<{ work: string; name: string; drawn: unknown }[]>;
  log: (line: string) => void;
}

export interface BenchOptions {
  set: CaseSet;
  interviewer: Interviewer;
  /** Keeps what one case wrote, and how it was judged, to read. Never for the hidden set. */
  keep: (id: string, value: unknown) => void;
}

const share = (count: number, of: number): number =>
  of === 0 ? 0 : count / of;

/** How many cases run at once, for each bench. */
const notesAtOnce = 4;
const momentsAtOnce = 6;
const judgedAtOnce = 6;
const writtenAtOnce = 4;

// Notes: a fixed conversation, played back -----------------------------------

/** Half a minute an answer: early enough that the time never sends him to the read-back. */
const minutesPerAnswer = 0.5;

/** The lines up to the read-back: what he writes down from. The read-back's own lines answer to what was read, which isn't the same twice. */
const beforeReadBack = (transcript: Transcript): Said[] =>
  transcript.lines.slice(0, transcript.readbackFrom ?? transcript.lines.length);

/**
 * The notes Stephen makes of a conversation given to him line by line, as
 * it was said: his own line is not used, only what he writes down.
 */
export const replayNotes = async (
  stand: Pick<Stand, "turn">,
  transcript: Transcript & { who: LabWho },
  interviewer: Interviewer
): Promise<InterviewFact[]> => {
  const lines = beforeReadBack(transcript);
  const theirs = lines.flatMap((line, at) =>
    line.from === "person" ? [at] : []
  );
  let facts: InterviewFact[] = [];
  let phase: InterviewPhase = "anchor";
  for (const [answered, at] of theirs.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- each turn writes down from the notes of the one before
    const turn = await stand.turn(
      transcript.who,
      {
        event: "answer",
        locale: transcript.locale,
        interviewer,
        lines: lines.slice(0, at + 1).map((line) => ({
          from: line.from,
          text: line.text,
          ...(line.from === "person" ? { typed: true as const } : {}),
        })),
        facts: facts
          .filter((fact) => fact.out !== true)
          .map(({ id, tag, text }) => ({ id, tag, text })),
        phase,
        minutes: (answered + 1) * minutesPerAnswer,
        adding: false,
      },
      { lineOnly: false }
    );
    facts = notesAfter(facts, turn);
    // The read-back is not a part to be in while the conversation still goes on.
    phase = turn.phase === "readback" ? phase : turn.phase;
  }
  return facts;
};

const hasWho = (
  transcript: Transcript
): transcript is Transcript & { who: LabWho } => transcript.who !== null;

/** One conversation played back and judged; none when its key or person is not there. */
const notesCase = async (
  stand: Stand,
  transcript: Transcript & { who: LabWho },
  { set, interviewer, keep }: BenchOptions
): Promise<CaseScore | null> => {
  const key = keyOf(transcript.key);
  const employee = key?.employees.find(
    (each) => each.id === transcript.employee
  );
  if (key === undefined || employee === undefined) {
    return null;
  }
  const facts = await replayNotes(stand, transcript, interviewer);
  const judged = await judge(
    stand.asker,
    sliceOf(key, employee),
    beforeReadBack(transcript),
    facts
  );
  const notes = facts.filter((fact) => fact.out !== true);
  const count = (verdict: string) =>
    judged.written.filter((each) => each.verdict === verdict).length;
  const held = transcript.said.filter(
    (id) =>
      (judged.known.find((each) => each.id === id)?.written.length ?? 0) > 0
  );
  if (set === "open") {
    keep(transcript.id, {
      transcript: transcript.id,
      notes: notes.map((fact) => ({
        id: fact.id,
        tag: fact.tag,
        record: fact.record,
        verdict: judged.written.find((each) => each.id === fact.id)?.verdict,
      })),
      lost: transcript.said.filter((id) => !held.includes(id)),
    });
  }
  stand.log(
    `  ${set === "open" ? transcript.id : "a hidden conversation"}: ${notes.length} notes`
  );
  return {
    id: transcript.id,
    scores: {
      written: share(held.length, transcript.said.length),
      supported: share(count("said"), notes.length),
      repeats: share(count("repeat"), notes.length),
      notSaid: share(count("not said"), notes.length),
      notes: notes.length,
    },
  };
};

/** The notes bench: every conversation played back, and what he wrote judged against the key. */
export const benchNotes = async (
  stand: Stand,
  transcripts: readonly Transcript[],
  options: BenchOptions
): Promise<CaseScore[]> => {
  const playable = transcripts.filter(hasWho);
  if (playable.length < transcripts.length) {
    stand.log(
      `  ${transcripts.length - playable.length} conversations were kept before who he talked with was kept with them: keep them again`
    );
  }
  stand.log(`Notes: ${playable.length} conversations played back`);
  const cases = await inTurns(
    playable,
    notesAtOnce,
    async (transcript) => await notesCase(stand, transcript, options)
  );
  return cases.flatMap((each) => (each === null ? [] : [each]));
};

// Next question: a fixed moment, and the one line he says ---------------------

const lineJudge = `You check one line of an interviewer, Stephen, against one rule. You get the last lines of the conversation ("stephen" is him, "person" the one he interviews), the notes he has so far, the rule for what he should do now, and what he did: his line, and what he waits for next ("wants": an answer, a file, the read-back, or the end).

pass is true when his line does what the rule says. His line may be in another language than the rule: judge what it does, not its words. Judge only what the rule asks: add no demands of your own, and leave his tone and choice of words alone unless the rule names them. A line that does something the rule forbids does not pass.

single is true when his line asks one thing only. Two questions in one sentence, joined by "and" or a comma ("Who is that, and where do they keep it?"), are two. A line with no question is single.

Give "why" in at most 15 words.`;

const lineSchema = z.object({
  pass: z.boolean(),
  single: z.boolean(),
  why: z.string(),
});

/** How much of the conversation before a moment the judge reads. */
const momentLines = 4;

/** The rule a line is held to: the moment's own, or any one of them where their last line calls for more than one thing at once. */
export const ruleOf = (moment: Pick<Moment, "signal" | "also">): string => {
  const also = moment.also ?? [];
  if (also.length === 0) {
    return signalRules[moment.signal];
  }
  const rules = [moment.signal, ...also]
    .map((signal, at) => `(${at + 1}) ${signalRules[signal]}`)
    .join(" ");
  return `Their last line calls for more than one thing, and he can only ask one. His line is right when it follows any ONE of these rules: ${rules}`;
};

export interface Verdict {
  right: boolean;
  single: boolean;
  why: string;
}

/** Whether a line is the right one for its moment: by code where the rule can be checked so, by the judge otherwise. */
export const rightLine = async (
  asker: Asker,
  moment: Moment,
  turn: Pick<StephenTurn, "say" | "wants">
): Promise<Verdict> => {
  if (moment.signal === "mid sentence") {
    return turn.say === ""
      ? { right: true, single: true, why: "He waits." }
      : {
          right: false,
          single: true,
          why: "He spoke while they were mid-sentence.",
        };
  }
  if (turn.say === "") {
    return { right: false, single: true, why: "He said nothing." };
  }
  const judged = await asker({
    role: "careful",
    system: lineJudge,
    input: JSON.stringify({
      conversation: moment.lines.slice(-momentLines),
      ...(moment.spoken === true
        ? {
            "their last line":
              "said out loud, written as speech recognition heard it",
          }
        : {}),
      notes: moment.facts.map((fact) => fact.text),
      rule: ruleOf(moment),
      did: { line: turn.say, wants: turn.wants },
    }),
    schema: lineSchema,
    maxTokens: 400,
  });
  // Where the interview goes next is in the turn itself: no judge needed for that half of the rule.
  if (moment.signal === "wrap up" && turn.wants !== "readback") {
    return {
      right: false,
      single: judged.single,
      why: "He did not go to the read-back.",
    };
  }
  if (moment.signal === "wrap up early" && turn.wants === "readback") {
    return {
      right: false,
      single: judged.single,
      why: "He went to the read-back without their story.",
    };
  }
  return { right: judged.pass, single: judged.single, why: judged.why };
};

/**
 * What comes before every moment since the interview starts with the
 * person and AI: the three questions of that part, answered in a few words
 * by someone who has little to say about it (but never "I don't know":
 * that would make a later "no idea" look like one more), and the notes he
 * took. Without it he would rightly go back and ask, whatever the moment
 * is about. A moment keeps its own minute.
 */
const openings: Readonly<
  Record<"en" | "nl", { lines: Said[]; facts: Moment["facts"] }>
> = {
  en: {
    lines: [
      {
        from: "stephen",
        text: "First a few questions about you and AI, then your work. Do you already use AI in your work, like ChatGPT or Copilot?",
      },
      { from: "person", text: "no, not really" },
      {
        from: "stephen",
        text: "Okay. Does anything about AI at work worry you?",
      },
      { from: "person", text: "not really" },
      {
        from: "stephen",
        text: "Right. What would you like taken off your hands, if you could choose?",
      },
      { from: "person", text: "less retyping would be nice" },
    ],
    facts: [
      { id: "a1", tag: "ai", text: "You do not use AI in your work." },
      { id: "a2", tag: "ai", text: "Nothing about AI at work worries you." },
      { id: "a3", tag: "wish", text: "You would like less retyping." },
    ],
  },
  nl: {
    lines: [
      {
        from: "stephen",
        text: "Eerst een paar vragen over jou en AI, daarna over je werk. Gebruik je AI al in je werk, zoals ChatGPT of Copilot?",
      },
      { from: "person", text: "nee, niet echt" },
      { from: "stephen", text: "Oké. Maakt iets je zorgen bij AI op je werk?" },
      { from: "person", text: "niet echt" },
      {
        from: "stephen",
        text: "Helder. Wat zou je het liefst uit handen geven, als je mocht kiezen?",
      },
      { from: "person", text: "minder overtypen zou fijn zijn" },
    ],
    facts: [
      { id: "a1", tag: "ai", text: "Je gebruikt geen AI in je werk." },
      {
        id: "a2",
        tag: "ai",
        text: "Niets aan AI op het werk maakt je zorgen.",
      },
      { id: "a3", tag: "wish", text: "Je zou graag minder overtypen." },
    ],
  },
};

const openingOf = (locale: InterviewLocale) =>
  locale === "nl" ? openings.nl : openings.en;

/** The turn a moment asks for: the opening, then the moment, typed but for a last line said out loud. */
export const momentTurn = (
  moment: Moment,
  interviewer: Interviewer
): TurnAsked => {
  const opening = openingOf(moment.locale);
  const last = moment.lines.length - 1;
  return {
    event: "answer",
    locale: moment.locale,
    interviewer,
    lines: [
      ...opening.lines.map((line) => ({
        ...line,
        ...(line.from === "person" ? { typed: true as const } : {}),
      })),
      ...moment.lines.map((line, at) => ({
        from: line.from,
        text: line.text,
        ...(line.from === "person" && !(moment.spoken === true && at === last)
          ? { typed: true as const }
          : {}),
      })),
    ],
    facts: [...opening.facts, ...moment.facts],
    phase: moment.phase,
    minutes: moment.minutes,
    adding: false,
  };
};

/** One moment: his line, held to its rule. */
const askCase = async (
  stand: Stand,
  moment: Moment,
  { set, interviewer, keep }: BenchOptions
): Promise<CaseScore> => {
  // Only his line is judged: what he would write down is never waited for, but where they stopped mid-sentence, since he then says nothing and the whole turn tells.
  const turn = await stand.turn(moment.who, momentTurn(moment, interviewer), {
    lineOnly: moment.signal !== "mid sentence",
  });
  const { right, single, why } = await rightLine(stand.asker, moment, turn);
  const mistakes = mistakesIn(turn.say).length > 0 ? 1 : 0;
  if (set === "open") {
    keep(moment.id, {
      moment: moment.id,
      signal: moment.signal,
      said: moment.lines.at(-1)?.text ?? "",
      line: turn.say,
      wants: turn.wants,
      right,
      single,
      why,
    });
  }
  return {
    id: moment.id,
    scores: { right: right ? 1 : 0, single: single ? 1 : 0, mistakes },
  };
};

/** The next-question bench: every moment, his one line, judged by its rule. */
export const benchAsk = async (
  stand: Stand,
  moments: readonly Moment[],
  options: BenchOptions
): Promise<CaseScore[]> => {
  stand.log(`Next question: ${moments.length} moments`);
  return await inTurns(
    moments,
    momentsAtOnce,
    async (moment) => await askCase(stand, moment, options)
  );
};

// Moments cut from interviews a model played ----------------------------------

/** The kinds a line of the person shows by itself: what a model can find in a transcript without knowing the work. */
const foundInALine = [
  "generalization",
  "vague amount",
  "vague time",
  "no base",
  "hidden actor",
  "they",
  "unknown term",
  "merged step",
  "judgment word",
  "look it up",
  "then done",
  "do not know",
] as const satisfies readonly Signal[];

/** The parts of an interview in which he does not follow up yet. */
const listens: ReadonlySet<InterviewPhase> = new Set([
  "open",
  "you",
  "anchor",
  "story",
]);

const miner = `You read an interview about someone's work and find the moments where what the person just said leaves out one particular thing, so that a good interviewer would ask for exactly that next. A line counts only when that thing is really missing: not in the line itself, not in the question it answers, and not anywhere earlier in the conversation. The signals, each with what must be missing:
- generalization: they say how it usually goes ("normally we…") where a real case was asked for, and say nothing of the real case.
- vague amount: "sometimes", "a lot", "often", and no number at all for that amount. Not when they say they cannot give a number: that is "do not know".
- vague time: "a while", "ages", "quickly", and no length of time at all for it. "One to three days" and "about five minutes" are not vague. Not when they say they cannot give a time: that is "do not know".
- no base: a bare number with nothing it is per, in the line or in the question ("about thirty"). "A hundred a week" has its base.
- hidden actor: something is done and nobody is named or plain from the lines before as the one who does it ("it gets approved").
- they: "they" or "them" where the lines before do not tell who.
- unknown term: a word of their own or an abbreviation that was never explained, and that is not a common word or the name of a well-known product.
- merged step: several actions said as one, with none of them named ("then I process it").
- judgment word: a judgment with no word on what they look at ("if it looks okay").
- look it up: they look something up or check something and name no system, file or person as where.
- then done: their story stops at their own last step, and nothing was said yet on who gets the work next.
- do not know: they say they do not know something, and name nobody who would know.

Give at most three moments, only where you are sure, each of a different signal where you can: the number of the person's line, and the signal. Few interviews have three. None is a good answer.`;

const minedSchema = z.object({
  moments: z.array(z.object({ line: z.int(), signal: z.enum(foundInALine) })),
});

/** The most moments cut from one interview. */
const mostCut = 3;
/** Minutes into an interview, an answer at a time, for a cut moment. */
const minutesPerCut = 0.6;

const numbered = (lines: readonly Said[], person = "Person"): string =>
  lines
    .map(
      (line, at) =>
        `${at} ${line.from === "stephen" ? "Stephen" : person}: ${line.text}`
    )
    .join("\n");

/**
 * Moments cut from the conversations a model played: the conversation up
 * to a line where something is missing, with the notes he had then. None
 * from where he only listens, but for a word he does not know.
 */
export const mineMoments = async (
  asker: Asker,
  transcripts: readonly Transcript[]
): Promise<Moment[]> => {
  const minable = transcripts.flatMap((each) =>
    each.who === null || each.notesAt === null || each.phaseAt === null
      ? []
      : [
          {
            ...each,
            who: each.who,
            notesAt: each.notesAt,
            phaseAt: each.phaseAt,
          },
        ]
  );
  const found = await inTurns(minable, 3, async (transcript) => {
    const lines = beforeReadBack(transcript);
    const answer = await asker({
      role: "careful",
      system: miner,
      input: numbered(lines),
      schema: minedSchema,
      effort: "medium",
      maxTokens: 1000,
    });
    const personLines = lines.flatMap((line, at) =>
      line.from === "person" ? [at] : []
    );
    return answer.moments.slice(0, mostCut).flatMap((each): Moment[] => {
      const nth = personLines.indexOf(each.line);
      const phase = transcript.phaseAt[nth] ?? "steps";
      // While they tell their story he only listens, and before it he asks for it.
      if (
        nth === -1 ||
        (listens.has(phase) && each.signal !== "unknown term")
      ) {
        return [];
      }
      return [
        {
          id: `${transcript.id}-${each.line}`,
          signal: each.signal,
          locale: transcript.locale,
          who: transcript.who,
          lines: lines.slice(0, each.line + 1),
          facts: transcript.notes.slice(0, transcript.notesAt[nth] ?? 0),
          phase,
          minutes: (nth + 1) * minutesPerCut,
        },
      ];
    });
  });
  return found.flat();
};

const checker = `You check one moment cut from an interview about someone's work. You get the conversation up to the person's last line, and a claim about that last line: a signal, with what must be missing for it to count.

plain is true only when the last line really shows the signal and the thing that must be missing is given nowhere: not in that line, not in the question it answers, not earlier in the conversation. A person who says they cannot give a number or a time shows "do not know", not a vague amount or a vague time. A person who names who would know does not show "do not know". When you are not sure, plain is false.`;

const plainSchema = z.object({ plain: z.boolean() });

/** A moment a model wrote: it had its own second look when it was written. */
export const writtenPrefix = "w-";

/**
 * A second look at the moments a model cut: each is checked on its own by
 * the careful model. What stands in for reading them where nobody may: the
 * hidden set. Says which are plain and which are not; a written moment had
 * its own second look, and is left out.
 */
export const checkMoments = async (
  asker: Asker,
  moments: readonly Moment[]
): Promise<{ plain: Moment[]; not: Moment[] }> => {
  const cut = moments.filter((moment) => !moment.id.startsWith(writtenPrefix));
  const looked = await inTurns(cut, judgedAtOnce, async (moment) => {
    const answer = await asker({
      role: "careful",
      system: checker,
      input: JSON.stringify({
        conversation: moment.lines.map(
          (line) =>
            `${line.from === "stephen" ? "Stephen" : "Person"}: ${line.text}`
        ),
        claim: { signal: moment.signal, rule: signalRules[moment.signal] },
      }),
      schema: plainSchema,
      effort: "medium",
      maxTokens: 2000,
    });
    return { moment, plain: answer.plain };
  });
  return {
    plain: looked.filter((each) => each.plain).map((each) => each.moment),
    not: looked.filter((each) => !each.plain).map((each) => each.moment),
  };
};

// Moments a model writes: the kinds no interview played by a model shows --------

/**
 * The kinds of moment that come from how people really answer: no
 * interview a model played has them, so none can be cut. For the open set
 * they are written by hand (moments.ts). For the hidden set a model writes
 * them, in settings of its own, and nobody reads them: they say whether a
 * change to Stephen holds outside the moments he was changed on.
 */
export const writtenKinds: readonly Signal[] = [
  "not an answer",
  "not an answer again",
  "few words",
  "a guess",
  "the official way",
  "two versions",
  "second hand",
  "why do you ask",
  "flood",
  "where to start",
  "no idea again",
];

/** Where a written moment plays, so that no two are alike. Never invoices: those are Stephen's own examples. */
const sectors = [
  "a bicycle shop chain",
  "a town hall permit desk",
  "a dental lab",
  "a plumbing wholesaler",
  "a school office",
  "a travel agency",
  "a print shop",
  "a housing association",
  "a car leasing company",
  "a hospital laundry",
  "a flower exporter",
  "a furniture maker",
  "a pharmacy",
  "a moving company",
  "a ferry operator",
  "a brewery",
];

const writer = `You write test cases for an AI interviewer, Stephen, who interviews an employee about one piece of their work. A case is a "moment": the first part of an interview, cut right after a line of the employee that calls for one particular next line of Stephen's.

You get the kind of moment, with the rule for what Stephen should do next. Write the moment so that this rule clearly applies and no other reading is possible.

How an interview goes, so your moment looks like one:
- Stephen first checks the work: "<lead> told me you <the work>. Is that right?" A short yes. Then: "Think of the last one you handled. When was that?" A short answer.
- Then he asks for the story ("Walk me through it, from the moment it came in until it was done. Every step, even the small ones. I'll just listen."), then about each step, then what goes differently, then numbers.
- Stephen asks one short question per line, at most 15 words, and never praises.
- The employee types as people do in a chat at work: lower case, short, no greeting, a typo now and then.

Make up the company, the people and the work: ordinary work at a small or middle-sized company of the kind you are given. The last line is the employee's, and it shows the kind. Give the notes Stephen has before that last line: one short sentence each, said to the employee ("You open the order in the planning board."), and only things the employee said in the lines before the last one. Nothing from the last line is in the notes yet, and a note is never a hint or an instruction. For "two versions" the notes must hold the earlier version, which the last line does not fit. For "not an answer again" Stephen's line before the last one must already say plainly that he could not use their answer. For "no idea again" the employee has already said once or twice that they do not know, Stephen has already asked who would know, and the last line is one more "no idea" about their own work. Unless the kind is about the story, the moment is after the story: Stephen is asking about the steps, what goes differently, or numbers. Write everything in the language you are given, the notes too.`;

const writtenSchema = z.object({
  company: z.string(),
  name: z.string().describe("The first name of the employee."),
  team: z.string(),
  work: z
    .string()
    .describe('The piece of work, as in "handling warranty claims".'),
  lead: z.string().describe("The first name of their team lead."),
  phase: z.enum([
    "anchor",
    "story",
    "steps",
    "exceptions",
    "numbers",
    "result",
  ]),
  minutes: z.number().describe("Minutes into the interview: 1 to 11."),
  lines: z.array(
    z.object({ from: z.enum(["stephen", "person"]), text: z.string() })
  ),
  notes: z.array(z.object({ tag: z.enum(factTags), text: z.string() })),
});

const writtenCheck = `You check a test case for an AI interviewer: the first part of an interview about someone's work, a kind of moment, and the rule for what the interviewer should do next.

plain is true only when the last line is the employee's, it really shows this kind and no other, and the rule can be followed from what is there: for "two versions" the notes hold the earlier version; for "not an answer again" the interviewer already said once that he could not use their answer; for "no idea again" the employee said they did not know before, and the interviewer already asked who would know. The notes hold nothing from the employee's last line, and no hint of what the interviewer should do. When you are not sure, plain is false.`;

/** Minutes into an interview a written moment may be at. */
const writtenMinutes = { least: 1, most: 11 } as const;

/** Every third written moment is in Dutch, the rest in English. */
const dutchEvery = 3;

/** One moment to write: its kind, its number, where it plays and in which language. */
interface Wanted {
  signal: Signal;
  nth: number;
  sector: string;
  locale: "en" | "nl";
}

/** The moments to write: `each` of every kind, numbered on from `from`, in settings that differ between the sets. */
export const wantedMoments = (
  set: CaseSet,
  kinds: readonly Signal[],
  each: number,
  from: number
): Wanted[] =>
  kinds.flatMap((signal, kind) =>
    Array.from({ length: each }, (_, at): Wanted => {
      const nth = from + at;
      const sector =
        sectors[
          (kind * 3 + nth * 5 + (set === "hidden" ? 7 : 0)) % sectors.length
        ] ?? "a print shop";
      return {
        signal,
        nth,
        sector,
        locale: (kind + nth) % dutchEvery === dutchEvery - 1 ? "nl" : "en",
      };
    })
  );

/** One moment written by a model, with its second look: kept only when it is plain. */
const writeOne = async (
  asker: Asker,
  { signal, nth, sector, locale }: Wanted
): Promise<{ moment: Moment; plain: boolean }> => {
  const made = await asker({
    role: "careful",
    system: writer,
    input: JSON.stringify({
      kind: signal,
      "what the employee does and what Stephen should do then":
        signalPlain[signal],
      rule: signalRules[signal],
      "kind of company": sector,
      language: locale === "nl" ? "Dutch" : "English",
    }),
    schema: writtenSchema,
    effort: "medium",
    maxTokens: 3000,
  });
  const moment: Moment = {
    id: `${writtenPrefix}${signal.replaceAll(" ", "-")}-${nth + 1}`,
    signal,
    locale,
    who: {
      company: made.company,
      name: made.name,
      team: made.team,
      lead: made.lead,
      work: made.work,
      known: "",
    },
    lines: made.lines,
    facts: made.notes.map((note, at) => ({
      id: `f${at + 1}`,
      tag: note.tag,
      text: note.text,
    })),
    phase: made.phase,
    minutes: Math.min(
      Math.max(made.minutes, writtenMinutes.least),
      writtenMinutes.most
    ),
  };
  if (moment.lines.at(-1)?.from !== "person") {
    return { moment, plain: false };
  }
  const checked = await asker({
    role: "careful",
    system: writtenCheck,
    input: JSON.stringify({
      conversation: moment.lines.map(
        (line) =>
          `${line.from === "stephen" ? "Stephen" : "Employee"}: ${line.text}`
      ),
      notes: moment.facts.map((fact) => fact.text),
      kind: signal,
      rule: signalRules[signal],
    }),
    schema: plainSchema,
    effort: "medium",
    maxTokens: 2000,
  });
  return { moment, plain: checked.plain };
};

/**
 * Has a model write the moments `wanted`, each with a second look. Says
 * which are plain, to keep, and how many were not.
 */
export const writeMoments = async (
  asker: Asker,
  wanted: readonly Wanted[]
): Promise<{ plain: Moment[]; not: number }> => {
  const written = await inTurns(
    wanted,
    writtenAtOnce,
    async (each) => await writeOne(asker, each)
  );
  return {
    plain: written.filter((each) => each.plain).map((each) => each.moment),
    not: written.filter((each) => !each.plain).length,
  };
};

/** Whether `kind` names a kind of moment there is a rule for. */
export const isSignal = (kind: string): kind is Signal =>
  signals.some((each) => each === kind);

// Drawing: the interviews of a practice company, drawn again --------------------

/** A practice company whose interviews are drawn again: its key, who told, and what of the key they said. */
export interface Drawn {
  id: string;
  key: AnswerKey;
  tellers: Teller[];
  /** The facts of the key someone said in their interview, by id; null when that wasn't judged. */
  said: string[] | null;
}

/**
 * The drawing bench: the local core's pieces of work drawn again from what
 * its people agreed to, each judged against the key. The drawing that
 * rests on most of the key's people is the key's piece of work. Says its
 * card too, to read.
 */
export const benchDraw = async (
  stand: Stand,
  practice: Drawn,
  { set, keep }: Pick<BenchOptions, "set" | "keep">
): Promise<{ cases: CaseScore[]; card: JoinedCard | null }> => {
  stand.log("Drawing: the practice company's work drawn again");
  const people = new Set(practice.tellers.map((teller) => teller.person));
  const all = await stand.drawings();
  const drawings = all.flatMap((each) => {
    const parsed = drawingSchema.safeParse(each.drawn);
    return parsed.success ? [{ ...each, drawn: parsed.data }] : [];
  });
  const [best] = drawings.toSorted(
    (a, b) =>
      b.drawn.from.filter((id) => people.has(id)).length -
      a.drawn.from.filter((id) => people.has(id)).length
  );
  if (best === undefined || !best.drawn.from.some((id) => people.has(id))) {
    stand.log("  nothing was drawn from its people");
    return { cases: [], card: null };
  }
  const tellers = practice.tellers.filter((teller) =>
    best.drawn.from.includes(teller.person)
  );
  const { judged, numbers } = await judgeJoined(
    stand.asker,
    practice.key,
    best.drawn,
    tellers
  );
  const card = joinedCardOf(
    practice.key,
    best.drawn,
    judged,
    numbers,
    practice.said
  );
  if (set === "open") {
    keep(practice.id, { practice: practice.id, work: best.name, card });
  }
  stand.log(
    `  ${set === "open" ? practice.id : "a hidden practice company"}: ${card.steps} steps`
  );
  return { cases: [{ id: practice.id, scores: joinedScores(card) }], card };
};
