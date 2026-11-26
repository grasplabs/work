import {
  answerOf,
  fileCalled,
  notesSchema,
  onlyNotes,
  turnLinesMax,
} from "@grasp-os/shared/interview-turn";
import type {
  InterviewEvent,
  InterviewTurnRequest,
} from "@grasp-os/shared/interview-turn";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import { companyNameOf } from "@grasp-os/shared/organization";

import { models } from "../models.ts";
import type { ModelCall } from "../models.ts";
import { readOrganization } from "../organization.ts";
import { stillOpen } from "./still-open.ts";
import type { Took, TurnContext } from "./store.ts";

// What Stephen is told about an interview, and what he writes down from
// it. Every interview is one live conversation with Grasp's ElevenLabs
// agent (voice.ts), which says his lines; after each answer core's notes'
// model, Mistral's on Grasp's own key (src/platform-ai.ts) whatever
// provider the organization connected, writes down what was said, as
// checked JSON, from the brief made here. Ported from the prototype
// (grasplabs/prototype, packages/grasp: worker/interview.ts).
//
// What it must not do, from the threat model (GRA-307), and what stops it:
//
// - Let the page say who it is or what Stephen knows: who they are, their
//   team, their lead and what Stephen knows come from the store
//   (`turnContext`), on their own link and account. The page sends only
//   the conversation, which it holds.
// - Tell the company who talked, and when: every gateway call is made by
//   the system for `onboarding.interview`, never in anyone's name, and
//   onboarding calls always count as carrying sensitive data
//   (model-rules.ts), so only models the rules allow for that are used.
// - Write down what wasn't said: a fact whose words weren't said is left
//   out (`checkedTurn`), and counted in the log, never with its words.
//
// The Stephen Lab still holds turns of its own from the same brief, his
// line written by a model (lab-turn.ts): a local stack's alone.

/** What the gateway is told every call of an interview is for. */
const purpose = "onboarding.interview";

/** The most the notes' model writes: the facts of one answer. */
const notesTokens = 4000;

/**
 * What Stephen is told a brief from: the conversation, what he wrote down
 * and what just happened. The notes step fills it from a live
 * conversation (voice.ts), the lab's turns from fixed input (lab-turn.ts).
 */
export type TurnAsked = InterviewTurnRequest;

/** What happened, as Stephen is told it, for someone called `name`. */
const happenedOf = (
  turn: TurnAsked,
  name: string
): Record<InterviewEvent, string> => {
  const last = turn.lines.at(-1);
  return {
    start: `The interview starts now. ${name} has just pressed start. Say your first line.`,
    answer:
      last?.typed === true
        ? `${name} typed their answer.`
        : `${name} answered out loud; it is written as speech recognition heard it.`,
    resume: `${name} left and has just come back. Say in one short sentence where you were, then ask what comes next.`,
    file: `${name} shared a file. You see only what it is called, not what kind of file it is or what is in it. Speak of it by that name with the word for a file, as "the workflow file"; never say a file ending such as pdf. Say in a few words what you see, thank them, and ask whether it is a normal one or a difficult one.`,
    nudge: `${name} stopped mid-sentence and has stayed quiet since. Answer with what there is.`,
    readback: `You read these lines back to ${name}: ${(turn.reading ?? []).join(", ")}. Their last line is their answer to that.`,
    add: `${name} agreed to the read-back earlier and has just come back on their link to add something. Ask what they would like to add or put right.`,
  };
};

/** Their work as a whole takes 4 minutes at most: a talker can fill the whole interview with it. */
const weekPartMinutes = 4;

/** What of a turn tells where the interview stands, without its conversation. */
type Situation = Pick<TurnAsked, "phase" | "minutes" | "adding" | "facts">;

/**
 * What the record still misses, as Stephen is told it each turn
 * (`stillOpen`), as what was said about the work, never an order to him.
 * Not once the interview is at the read-back or they are back to add
 * something: nothing more is asked for then.
 */
const openOf = (turn: Situation, kind: TurnContext["kind"]): string[] => {
  if (turn.phase === "readback" || turn.adding) {
    return [];
  }
  const open = stillOpen(kind, turn.facts, turn.phase);
  // In the part about AI nothing is listed, and he is not sent on either:
  // the one follow-up his script allows there is his to ask.
  if (open.length === 0 && turn.phase === "you") {
    return [];
  }
  return [
    "",
    "What is still open, most important first:",
    open.length === 0
      ? "Nothing: go to the read-back."
      : open.map((each) => `- ${each}`).join("\n"),
  ];
};

/**
 * Where the interview stands, as Stephen is told it: who he talks to and
 * about what, what Grasp knows already, how long it has run, what he
 * wrote down and what is still open. Who they are comes from the store.
 * The first part of every turn's brief (`briefOf`).
 */
const situationOf = (
  turn: Situation,
  context: TurnContext,
  company: string
): string[] => {
  const { name, team, lead, work, kind, known } = context;
  const toLearn =
    work === ""
      ? "The work to learn about: not named yet. In part 3, take the piece that repeats most and costs them most time, by what they said in part 2, and learn that one."
      : `The work to learn about: ${work}.`;
  const teamLead =
    lead === null
      ? ' You do not know who their team lead is: say "I was told" instead.'
      : ` Their team lead, who pointed you to them: ${lead}.`;
  return [
    `The company: ${company === "" ? "the company" : company}.`,
    kind === "lead"
      ? `You talk with: ${name}, who leads ${team === "" ? "the team" : team}. This is the interview about the work of the whole team.`
      : `You talk with: ${name}${team === "" ? "" : `, ${team}`}.${teamLead}`,
    kind === "lead"
      ? "The work to learn about: everything the team does, and who does which."
      : toLearn,
    ...(known === "" ? [] : ["", "What Grasp knows already:", known]),
    `Minutes since they pressed start: ${turn.minutes.toFixed(1)}. The part you were in: ${turn.phase}.`,
    ...(kind === "own" &&
    turn.phase === "week" &&
    turn.minutes > weekPartMinutes
      ? [
          "Part 2 has taken more than 4 minutes. Your next line starts part 3: name the piece you now look at up close, and ask about it.",
        ]
      : []),
    ...(turn.adding
      ? [
          "They agreed to everything you wrote down before, and are back to add something: stay with that, then read back only what is new.",
        ]
      : []),
    "",
    "What you wrote down so far:",
    turn.facts.length === 0
      ? "(nothing yet)"
      : turn.facts
          .map((fact) => `- [${fact.id}] ${fact.tag}: ${fact.text}`)
          .join("\n"),
    ...openOf(turn, kind),
  ];
};

/**
 * What Stephen is told: where the interview stands (`situationOf`), the
 * conversation, and what just happened. The conversation comes from the
 * page, as it heard a live conversation with the agent (voice.ts), or
 * from the lab (lab-turn.ts).
 */
export const briefOf = (
  turn: TurnAsked,
  context: TurnContext,
  company: string
): string => {
  const self = interviewerNames.stephen;
  const lines = turn.lines.slice(-turnLinesMax);
  return [
    ...situationOf(turn, context, company),
    "",
    "The conversation so far:",
    lines.length === 0
      ? "(nothing yet)"
      : lines
          .map(
            (line) =>
              `${line.from === "stephen" ? self : context.name}: ${answerOf(line.text)}${line.file === undefined ? "" : ` [shared a file called "${fileCalled(line.file)}"]`}`
          )
          .join("\n"),
    "",
    `What just happened: ${happenedOf(turn, context.name)[turn.event]}`,
  ].join("\n");
};

/** Why a turn went wrong, as the page is told it. */
export class TurnFailedError extends Error {
  override name = "TurnFailedError";
  readonly status: number;

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

export const lostThread = (): TurnFailedError =>
  new TurnFailedError("Stephen lost his thread. Say it once more.", 502);

/** Grasp has no key for the interview's provider here, or it has no host. */
const notSetUp = new Set(["model.not_allowed", "model.unconfigured"]);

/**
 * What a gateway refusal tells the page: busy is worth a retry; an
 * interview that isn't set up (Grasp's key is missing) is not, and the
 * rest may be.
 */
export const refusalOf = (code: string | undefined): TurnFailedError => {
  // Which refusal it was is kept for whoever looks into it; the person is told only what to do.
  log.warn("interview.model_refused", { code: code ?? "unknown" });
  if (code === "model.rate_limited") {
    return new TurnFailedError("Stephen is busy. Try again in a minute.", 429);
  }
  return notSetUp.has(code ?? "")
    ? new TurnFailedError("The interview is not set up yet.", 503)
    : new TurnFailedError("Stephen could not be reached. Try again.", 502);
};

/** What every call of an interview tells the gateway. */
export const session = (model: string) =>
  ({
    model,
    purpose,
    trigger: { type: "system" },
    work: { onboarding: true },
    effort: "low",
  }) as const;

/** What the notes' model is asked with. */
export interface Writing {
  env: Env;
  system: string;
  brief: string;
  signal: AbortSignal;
  count: (took: Took | null) => void;
}

/**
 * Asks the notes' model what to write down from what was just said: after
 * each answer of a live conversation (voice.ts), and in a turn of the
 * lab's (lab-turn.ts).
 */
export const write = async (
  { env, system, brief, signal, count }: Writing,
  model: string
): Promise<unknown> => {
  const call: ModelCall<unknown> = {
    ...session(model),
    system,
    input: `${brief}\n\n${onlyNotes}`,
    schema: notesSchema,
    maxTokens: notesTokens,
    signal,
  };
  try {
    const { output, usage } = await models(env).interview.call(call);
    count({
      purpose: "interviews",
      model,
      tokensIn: usage.inputTokens,
      tokensCached: usage.cacheRead,
      tokensOut: usage.outputTokens,
    });
    return output;
  } catch (error) {
    const code = modelErrors.codeOf(error);
    if (code === undefined) {
      log.warn("interview.notes_lost", {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
    throw code === undefined ? lostThread() : refusalOf(code);
  }
};

/**
 * The company's name, as Stephen is told it: never the placeholder core
 * made the organization with (`companyNameOf`); empty when nothing names it.
 */
export const companyOf = async (env: Env): Promise<string> => {
  const { name, signInDomains } = await readOrganization(env);
  return companyNameOf(name, signInDomains) ?? "";
};
