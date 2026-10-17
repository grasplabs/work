import { listeningAt } from "./onboarding.ts";
import type { DirectoryTeam } from "./onboarding.ts";

/**
 * Stephen's interviews: what one interview fills in, where everyone invited stands, and when a
 * workflow has been heard often enough to count as known. A fact counts only once the person who
 * said it has approved it. Pure, with the sample client's teams as mock data.
 */

/** What one interview fills in about a piece of work. A question that fills none of these is not asked. */
export const RECORD_FIELDS = [
  "trigger",
  "done",
  "steps",
  "handoffs",
  "waits",
  "exceptions",
  "decisions",
  "workarounds",
  "volume",
  "time",
  "rework",
  "result",
  "cases",
  "terms",
  "next",
] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];

/**
 * The nine parts of an employee interview, in order, with how many minutes each takes at least and
 * at most. It starts with the person (`you`): whether they use AI already, how that goes, what
 * worries them and what they wish for. Only then their work.
 */
export const PHASES = [
  "open",
  "you",
  "anchor",
  "story",
  "steps",
  "exceptions",
  "numbers",
  "result",
  "readback",
] as const;
export type Phase = (typeof PHASES)[number];

/** What Stephen marks in what someone says: each mark becomes one fact. */
export const TAGS = [
  "step",
  "system",
  "handoff",
  "wait",
  "exception",
  "rule",
  "judgment",
  "workaround",
  "ai",
  "wish",
  "number",
  "done",
  "stop",
  "case",
  "term",
  "next",
  "work",
] as const;
export type Tag = (typeof TAGS)[number];

/**
 * How Stephen may sound, in the voice's own directions: these and no others. His feelings stay
 * small, so a line led by anything else is said without it.
 */
export const VOICE_TAGS = [
  "warm, relaxed",
  "sincere, steady",
  "curious, gently",
  "softly",
  "interested, a little lighter",
  "patient",
  "neutral, light",
  "upbeat, understanding",
  "upbeat, reassuring",
  "sincere, steady, reassuring",
  "amused, soft chuckle",
  "warm",
  "easy, light",
  "clear, measured pace",
  "warm, grateful",
  "warm, kind",
] as const;
export type VoiceTag = (typeof VOICE_TAGS)[number];

/** A question is one sentence of at most this many words. */
export const QUESTION_WORDS = 15;

/** How many words the last sentence of a line has: the question Stephen ends on. */
export const questionWords = (line: string): number => {
  const last =
    line
      .trim()
      .split(/(?<=[.?!…])\s+/u)
      .at(-1) ?? "";
  return last.split(/\s+/u).filter(Boolean).length;
};

/**
 * Where someone invited stands. Everyone has exactly one of these. Nobody has to say no: whoever
 * does not want to talk closes the link, and stays at opened.
 */
export const PERSON_STATES = [
  "invited",
  "opened",
  "progress",
  "incomplete",
  "completed",
  "expired",
] as const;
export type PersonState = (typeof PERSON_STATES)[number];
export type StateCounts = Record<PersonState, number>;

/** The company sees numbers only for groups of at least this many people. */
export const MIN_GROUP = 5;

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(Math.max(value, min), max);

/**
 * Where everyone in each team stands at `progress` of the listening weeks, 0 to 1. Those who
 * talked are complete; of the rest some stopped halfway, some are talking now, and the others
 * have opened their link or not yet. Once the weeks are over, a link that was not used to the
 * end has expired.
 */
export const teamStates = (
  progress: number,
  teams: DirectoryTeam[]
): StateCounts[] => {
  const p = clamp(progress);
  const listening = listeningAt(p, teams);
  return teams.map((team, index) => {
    const completed =
      p === 0 ? 0 : Math.min(listening.heard[index] ?? 0, team.people);
    let left = team.people - completed;
    const take = (count: number) => {
      const taken = Math.max(0, Math.min(Math.round(count), left));
      left -= taken;
      return taken;
    };
    const incomplete = take(left * 0.18 * p);
    const talking = take(p > 0 && p < 1 ? Math.min(2, left * 0.1) : 0);
    const opened = take(p > 0 && p < 1 ? left * 0.35 : 0);
    return {
      invited: p < 1 ? left : 0,
      opened,
      progress: talking,
      incomplete,
      completed,
      expired: p < 1 ? 0 : left,
    };
  });
};

/** A step is known once this many people who do the work described it. */
export const EVIDENCE_PEOPLE = 3;
/** A workflow is checked for being complete from this many approved interviews. */
export const MIN_INTERVIEWS = 5;
/** Complete once the last two interviews added less than this share of new facts. */
export const STOP_SHARE = 0.05;
/** Still not complete after this many: probably two workflows in one. */
export const MAX_INTERVIEWS = 12;

/** What is known about one workflow from the interviews so far. */
export interface WorkflowEvidence {
  id: string;
  team: string;
  /** Interviews whose facts the person approved. */
  approved: number;
  /** The share of facts in the last two interviews that were new, 0 to 1. */
  lastNew: number;
  steps: number;
  /** Steps described by enough people, or by fewer and a document or a log. */
  evidenced: number;
  /** Steps that go two ways, each way explained. */
  variants: number;
  /** Differences nobody could explain yet. */
  unexplained: number;
}

export type WorkflowState =
  | "mapping"
  | "saturating"
  | "complete"
  | "variants"
  | "blocked";

/** When a workflow counts as known. The values above are where every organization starts; Grasp tunes them per organization. */
export interface WorkflowRules {
  /** People who do the work themselves that must have described a step; one fewer with a document, a log or an example. */
  people: number;
  /** Approved interviews before a workflow is checked for being complete. */
  minInterviews: number;
  /** Complete once the last interviews added less than this share of new facts, 0 to 1. */
  stopShare: number;
  /** Still not complete after this many: probably two workflows in one. */
  maxInterviews: number;
}

export const STARTING_RULES: WorkflowRules = {
  people: EVIDENCE_PEOPLE,
  minInterviews: MIN_INTERVIEWS,
  stopShare: STOP_SHARE,
  maxInterviews: MAX_INTERVIEWS,
};

/**
 * Where a workflow stands. A difference nobody can explain blocks it; one that is explained
 * does not. Otherwise it is complete once every step has its evidence and new interviews stop
 * adding facts.
 */
export const workflowState = (
  workflow: WorkflowEvidence,
  rules: WorkflowRules = STARTING_RULES
): WorkflowState => {
  if (workflow.approved < rules.minInterviews) {
    return "mapping";
  }
  if (workflow.unexplained > 0) {
    return "blocked";
  }
  if (
    workflow.evidenced < workflow.steps ||
    workflow.lastNew >= rules.stopShare
  ) {
    return "saturating";
  }
  return workflow.variants > 0 ? "variants" : "complete";
};

/** Whether a workflow has had so many interviews without settling that it is better split in two. */
export const needsSplit = (
  workflow: WorkflowEvidence,
  rules: WorkflowRules = STARTING_RULES
): boolean => {
  const state = workflowState(workflow, rules);
  return (
    workflow.approved > rules.maxInterviews &&
    (state === "saturating" || state === "blocked")
  );
};

/** What the first conversation with the sponsor has to bring, field by field. */
export const VISION_FIELDS = [
  "business",
  "teams",
  "goals",
  "success",
  "stakeholders",
  "pain",
  "limits",
  "sensitivities",
  "systems",
  "languages",
] as const;
export type VisionField = (typeof VISION_FIELDS)[number];

/** What the sample client's first conversation left open, as Stephen read it: he points it out, and the sponsor is asked. */
export const VISION_OPEN: VisionField[] = ["languages"];

export type HypothesisState = "hypothesis" | "confirmed" | "dropped";

/** The ways an interviewer goes wrong, by kind: each guards a question before it is asked and scores the transcript after. */
export const MISTAKES: Record<
  | "formulation"
  | "order"
  | "omission"
  | "communication"
  | "behaviour"
  | "interaction"
  | "planning",
  number
> = {
  formulation: 7,
  order: 3,
  omission: 3,
  communication: 2,
  behaviour: 2,
  interaction: 4,
  planning: 1,
};

/** Stephen may talk at most this share of an interview. */
export const TALK_SHARE = 0.2;
