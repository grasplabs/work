/**
 * People v2, played (GRA-1421). Before each answer the state drifts by
 * what happened (drift.ts), a temper is drawn from the mix and its v1 rule
 * gives the move (people.ts), and the state can overrule it: patience below
 * the line and they want to finish, then go; low trust holds back, low
 * energy shortens, low focus wanders. The lab reads Stephen's last line
 * once with a quick model call (did he speak plainly, say what it is for,
 * paraphrase wrongly, ask about a real case); code decides the rest, and
 * the model only words it.
 */
import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { z } from "zod";

import {
  drawTemper,
  drift,
  driftRules,
  freshState,
  holdsBackBelow,
  isRepeated,
  leaveBelow,
  opensAt,
  talkMinutes,
  tempersOf,
  tiredBelow,
  turnedOf,
  wandersBelow,
  wrapUpBelow,
} from "./drift.ts";
import type {
  DriftRules,
  Happened,
  State,
  TemperMix,
  Turned,
} from "./drift.ts";
import { nonsense } from "./moves.ts";
import type { Move } from "./moves.ts";
import {
  directionOf,
  freshMind,
  leavingSay,
  listensFor,
  mindAfter,
  rollOf,
} from "./people.ts";
import type { Direction, Mind, Temper } from "./people.ts";
import { told } from "./person.ts";
import type { Answer, Asker, At, Player, Said } from "./person.ts";
import { clean, typed } from "./surface.ts";
import type { Surface } from "./surface.ts";

/** Which practice people a run talked to: v1, one temper each that never changes; v2, a mix and a state that drifts. */
export const peopleVersions = ["v1", "v2"] as const;
export type PeopleVersion = (typeof peopleVersions)[number];

/** The people a command line asks for: v2 unless it says v1. */
export const peopleVersionOf = (value?: string): PeopleVersion =>
  value === "v1" ? "v1" : "v2";

/** Where someone v2 is in their own head: the v1 mind, the stage of each temper of theirs, and their state. */
export interface MindV2 extends Mind {
  /** Each temper keeps its own stage: a joker gets serious once, and stays so whichever temper leads an answer. */
  stages: Partial<Record<Temper, Mind["stage"]>>;
  state: State;
  /** Minutes of talk at the last answer. */
  minutes: number;
}

/** `start`: where the state starts, when a cast sheet sets it; otherwise from the mix and the mark. */
export const freshMindV2 = (
  mix: TemperMix,
  seed: string,
  start?: State
): MindV2 => {
  const ordered = tempersOf(mix);
  return {
    ...freshMind(ordered[0] ?? "plain"),
    stages: Object.fromEntries(
      ordered.map((temper) => [temper, freshMind(temper).stage])
    ),
    state: start ?? freshState(mix, seed),
    minutes: 0,
  };
};

const stageOf = (mind: MindV2, temper: Temper): Mind["stage"] =>
  mind.stages[temper] ?? "none";

/** The temper of a mix that waits to hear something in Stephen's last line, by its own stage (`listensFor`). */
const waitingTemper = (mix: TemperMix, mind: MindV2): Temper | undefined =>
  tempersOf(mix).find(
    (temper) =>
      listensFor(temper, { ...mind, stage: stageOf(mind, temper) }) !== null
  );

/** What someone v2 waits to hear, if anything. */
export const listensForV2 = (
  mix: TemperMix,
  mind: MindV2
): "plain word" | "purpose" | null => {
  const temper = waitingTemper(mix, mind);
  return temper === undefined
    ? null
    : listensFor(temper, { ...mind, stage: stageOf(mind, temper) });
};

const stateSay = {
  tired:
    "You are getting tired of this: fewer words than before, no detail that was not asked for.",
  holdsBack:
    'You do not trust this much: about what goes differently, how you decide, numbers and AI you say "depends" or "not sure", though you know. "said" is empty for those.',
  wanders:
    "Your mind is elsewhere: answer, and drift off into something beside the question in a sentence.",
} as const;

/** Moves that already say how long or how much someone answers: the state leaves them be. */
const shaped: ReadonlySet<Move> = new Set<Move>([
  "not an answer",
  "not an answer again",
  "few words",
  "why do you ask",
  "flood",
  "where to start",
  "wrap up",
]);

/** One answer of someone v2: what they do, which temper led it, and their state. */
export interface StepV2 {
  direction: Direction;
  temper: Temper;
  state: State;
  turned: Turned[];
  stages: MindV2["stages"];
}

/** What wanting to finish, and then going, looks like at this answer. */
const leavingDirection = (
  state: State,
  mind: MindV2,
  stage: Mind["stage"]
): Direction | null => {
  if (state.patience < leaveBelow) {
    return { move: null, text: leavingSay.gone, stage, leaves: true };
  }
  if (state.patience < wrapUpBelow) {
    const text = mind.done.includes("wrap up")
      ? leavingSay.mustGoNow
      : leavingSay.mustGo;
    return { move: "wrap up", text, stage };
  }
  return null;
};

/** The v1 rule of one temper, with what v2 changes about it. */
const temperDirection = (
  temper: Temper,
  mind: MindV2,
  stage: Mind["stage"],
  turn: { phase: At["phase"]; roll: number; heard: boolean }
): Direction => {
  const ruled = directionOf(temper, { ...mind, stage }, turn);
  // In v2 someone in a hurry leaves when patience runs out, not at a fixed answer.
  const hurried =
    temper === "rushed" && (ruled.leaves === true || ruled.move === "wrap up");
  return hurried
    ? { move: null, text: leavingSay.terse, stage: ruled.stage }
    : ruled;
};

/** What the state adds to an answer it does not overrule. */
const stateNotes = (state: State, wander: boolean): string[] =>
  [
    state.trust < holdsBackBelow ? stateSay.holdsBack : "",
    state.energy < tiredBelow ? stateSay.tired : "",
    state.focus < wandersBelow && wander ? stateSay.wanders : "",
  ].filter(Boolean);

/**
 * What someone v2 does in their next answer. The state drifts first, from
 * `happened`; then `draw` picks the temper that leads, and `roll` is that
 * temper's chance (`directionOf`). `heard` is whether Stephen's last line
 * said what the waiting temper waits for.
 */
export const directionOfV2 = (
  mix: TemperMix,
  mind: MindV2,
  {
    phase,
    roll,
    draw,
    heard,
    happened,
    rules = driftRules,
  }: {
    phase: At["phase"];
    roll: number;
    draw: number;
    heard: boolean;
    happened: Happened;
    rules?: DriftRules;
  }
): StepV2 => {
  // Someone who said they must go and is asked on loses patience fast.
  const state = drift(
    mind.state,
    mix,
    { ...happened, keptOn: happened.keptOn || mind.last === "wrap up" },
    mind.minutes,
    rules
  );
  const turned = turnedOf(mind.state, state);
  const temper = drawTemper(mix, draw);
  // What he said reaches the temper that waited for it, even when another leads this answer.
  const waiting = waitingTemper(mix, mind);
  const stages =
    waiting !== undefined && waiting !== temper && heard
      ? {
          ...mind.stages,
          [waiting]: directionOf(
            waiting,
            { ...mind, stage: stageOf(mind, waiting) },
            { phase, roll, heard }
          ).stage,
        }
      : mind.stages;
  const result = (direction: Direction): StepV2 => ({
    direction,
    temper,
    state,
    turned,
    stages: { ...stages, [temper]: direction.stage },
  });
  const own = stages[temper] ?? "none";
  const leaving = leavingDirection(state, mind, own);
  if (leaving !== null) {
    return result(leaving);
  }
  // A wary temper that has come to trust opens up, whatever his last line was.
  const stage = temper === "wary" && state.trust >= opensAt ? "open" : own;
  const direction = temperDirection(temper, mind, stage, {
    phase,
    roll,
    heard,
  });
  if (direction.move !== null && shaped.has(direction.move)) {
    return result(direction);
  }
  const notes = stateNotes(
    state,
    direction.move === null && rollOf(String(draw), 7) < 0.4
  );
  return result(
    notes.length === 0
      ? direction
      : { ...direction, text: `${direction.text} ${notes.join(" ")}` }
  );
};

/** Their v2 mind after an answer. */
export const mindAfterV2 = (
  mind: MindV2,
  step: Pick<StepV2, "direction" | "state" | "stages">,
  move: Move | null,
  minutes: number
): MindV2 => {
  // A guarded person who warms up past `opensAt` is open from then on, by the code and not the model.
  const warmed =
    step.stages.wary === "guarded" && step.state.trust >= opensAt
      ? { wary: "open" as const }
      : {};
  return {
    ...mindAfter(mind, step.direction, move),
    stages: { ...step.stages, ...warmed },
    state: step.state,
    minutes,
  };
};

// Played by a model.

const hearsV2 = `You read the end of an interview: the person's lines and the interviewer's last reply. Say for that last reply only:
- "plainWord": it tells the person plainly that their answer was not usable, or that he needs a real answer, or asks them to answer for real.
- "purpose": the person had asked what this is for or who reads it, and the reply itself says so plainly (not only pointing to a screen, not only saying it is a fair question).
- "wrongParaphrase": it says back what the person said, in other words, and gets something of it wrong: another number, another step, another person, or something they did not say.
- "concreteCase": it asks about one real case: the last time, one particular one, what they did with a recent one. A question about how it goes in general is not.
Each is false unless the reply clearly does it.`;

const heardSchema = z.object({
  plainWord: z.boolean(),
  purpose: z.boolean(),
  wrongParaphrase: z.boolean(),
  concreteCase: z.boolean(),
});
type HeardV2 = z.output<typeof heardSchema>;

const nothingHeard: HeardV2 = {
  plainWord: false,
  purpose: false,
  wrongParaphrase: false,
  concreteCase: false,
};

const answerSchema = z.object({
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

const readBackSchema = z.object({ say: z.string() });

/** The moves a model may say it made by itself; the others only count when the lab asked for them. */
const ownMoves: readonly Move[] = [
  "do not know",
  "a guess",
  "the official way",
  "second hand",
  "few words",
];

/** Who agrees to a read-back without reading it, by the temper that leads their mix. */
const agreesUnread: ReadonlySet<Temper> = new Set<Temper>([
  "rushed",
  "joker",
  "short",
]);

/** What someone v2 was at each answer, for the score card: the temper that led it, their state after it, and what turned. */
export interface StateAt {
  temper: Temper;
  state: State;
  turned: Turned[];
}

/** What Stephen's last line held, for someone who waits for it. */
const heardIn = (waits: "plain word" | "purpose" | null, heard: HeardV2) => {
  if (waits === "plain word") {
    return heard.plainWord;
  }
  return waits === "purpose" ? heard.purpose : false;
};

/**
 * Someone v2, played by a model. `system` is what they are told
 * (`realSystem` with the other tempers of their mix as `also`).
 */
export const realPlayerV2 = ({
  asker,
  name,
  system,
  known,
  mix,
  seed,
  locale,
  start,
  rules = driftRules,
  surface = clean,
  guarded = new Set<string>(),
}: {
  asker: Asker;
  name: string;
  system: string;
  known: readonly string[];
  mix: TemperMix;
  seed: string;
  locale: InterviewLocale;
  /** A cast sheet's own start state and drift rules. */
  start?: State;
  rules?: DriftRules;
  /** How they type (surface.ts), put on each answer after the model wrote it; clean when not set. */
  surface?: Surface;
  /** The words the answer key scores by, which their typing leaves alone (`protectedOf`). */
  guarded?: ReadonlySet<string>;
}): Player & { states: StateAt[] } => {
  let mind = freshMindV2(mix, seed, start);
  const states: StateAt[] = [];
  const [leading] = tempersOf(mix);
  return {
    name,
    states,
    answer: async (lines: Said[], asked: string, at: At): Promise<Answer> => {
      if (at.readback) {
        // In a hurry, never cared, or had enough: they agree without reading it.
        const unread =
          (leading !== undefined && agreesUnread.has(leading)) ||
          mind.state.patience < wrapUpBelow;
        if (unread) {
          return {
            say: locale === "nl" ? "Ja, klopt." : "Yes, that’s right.",
            said: [],
          };
        }
        const reply = await asker({
          role: "quick",
          system,
          input: `The interview so far:\n${told(lines)}\n\n${asked}`,
          schema: readBackSchema,
          maxTokens: 600,
        });
        return { say: reply.say.trim() || "…", said: [] };
      }
      const minutes = talkMinutes(lines);
      const heard =
        mind.answers === 0
          ? nothingHeard
          : await asker({
              role: "quick",
              system: hearsV2,
              input: told(lines.slice(-4), "Person", "Interviewer"),
              schema: heardSchema,
              maxTokens: 200,
            });
      const waits = listensForV2(mix, mind);
      const step = directionOfV2(mix, mind, {
        phase: at.phase,
        roll: rollOf(seed, mind.answers),
        draw: rollOf(seed, 500 + mind.answers),
        heard: heardIn(waits, heard),
        happened: {
          repeated: isRepeated(lines, mind.last),
          minutes,
          purposeTold: mind.last === "why do you ask" && heard.purpose,
          wrongParaphrase: heard.wrongParaphrase,
          concreteCase: heard.concreteCase,
          keptOn: false,
        },
        rules,
      });
      const answer = await asker({
        role: "quick",
        system,
        input: `The interview so far:\n${told(lines)}\n\n${asked}\nFor this answer: ${step.direction.text}`,
        schema: answerSchema,
        maxTokens: 800,
      });
      // The model writes it clean; how they type it is code's (surface.ts).
      const say =
        typed(answer.say.trim(), surface, `${seed}:${mind.answers}`, {
          guarded,
          locale,
        }).text || "…";
      const move =
        step.direction.move ??
        ownMoves.find((each) => each === answer.move) ??
        null;
      mind = mindAfterV2(mind, step, move, minutes);
      const left = step.direction.leaves === true;
      states.push({
        temper: step.temper,
        state: step.state,
        turned:
          left && !step.turned.includes("left")
            ? [...step.turned, "left"]
            : step.turned,
      });
      const empty = move !== null && nonsense.includes(move);
      return {
        say,
        said: [...new Set(answer.said.filter((id) => known.includes(id)))],
        move,
        // An answer that was no answer is not true either: no note may come of it.
        untrue: empty
          ? [`(no answer at all) ${say}`]
          : answer.untrue.map((each) => each.trim()).filter(Boolean),
        ...(left ? { left: true } : {}),
      };
    },
  };
};
