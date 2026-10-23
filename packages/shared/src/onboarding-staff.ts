import { z } from "zod";

import { SETTLERS } from "./admin/onboarding-admin.ts";
import type { OrgRules } from "./admin/onboarding-admin.ts";
import type { WorkRecord } from "./admin/org-record.ts";
import type { InterviewProgress } from "./interview-links.ts";
import type { InterviewPhase } from "./interview-turn.ts";
import { answerMaxLength, kickoffTeamNameMaxLength } from "./kickoff.ts";
import { interviewLocaleSchema } from "./onboarding.ts";
import type {
  Agreements,
  InterviewKind,
  InterviewLocale,
  Interviewer,
} from "./onboarding.ts";

// Grasp's onboarding area (core's onboarding/staff-area.ts): what a Grasp
// consultant in a client's deployment sees of its onboarding. Where it
// stands, as stages to tick off; what needs Grasp, the most pressing
// first; Grasp's own notes; the log of what happened; how Stephen and
// Claire are doing; and the AI the onboarding used. For staff
// sessions only (`onboardingStaff`), on the onboarding scope or a full one.

/** The stages of an onboarding, in order. */
export const staffStages = [
  "kickoff",
  "agreements",
  "people",
  "leads",
  "interviews",
  "open",
] as const;
export type StaffStage = (typeof staffStages)[number];

/** Done; the one the onboarding is at now; or still to come. */
export type StageStatus = "done" | "now" | "later";

/** One thing a stage asks for, done or not, and how far it is. */
export type StageTodo =
  | {
      kind:
        | "kickoff"
        | "processing"
        | "assessment"
        | "council"
        | "people"
        | "leadsNamed"
        | "plan"
        | "go";
      done: boolean;
    }
  | {
      kind: "leadsTalked" | "linksOut" | "talked";
      done: boolean;
      count: number;
      of: number;
    }
  | { kind: "known"; done: boolean; known: number; threshold: number };

export interface StageView {
  stage: StaffStage;
  status: StageStatus;
  todos: StageTodo[];
}

/** Something that needs a person at Grasp, as the area lists it. */
export type StaffNeed =
  | { kind: "agreement"; what: "processing" | "assessment" | "council" }
  | { kind: "paused" }
  /**
   * A lead hasn't talked days after their link went out: their team's
   * interviews go ahead without the lead's map of its work.
   */
  | { kind: "lead"; team: string; teamName: string; lead: string }
  /** Enough is known: the company comes in once Grasp gives its go. */
  | { kind: "go"; known: number; threshold: number }
  /** The interviews are over and too little is known: Grasp decides. */
  | { kind: "short"; known: number; threshold: number };

/** One of Grasp's notes. */
export interface StaffNote {
  id: number;
  /** ISO 8601. */
  at: string;
  /** The staff member who wrote it, by their user id. */
  by: string;
  text: string;
}

/** Who did something in the log. */
export const logActors = ["staff", "company", "person", "grasp"] as const;
export type LogActor = (typeof logActors)[number];

/** One thing that happened in the onboarding. */
export interface StaffLogEntry {
  seq: number;
  /** ISO 8601. */
  at: string;
  actor: LogActor;
  /** What happened, as a dotted name: `interview.completed`, `onboarding.paused`. */
  what: string;
  /** The person it is about, and their team, while they are on the roster. */
  person: { id: string; name: string } | null;
  team: string | null;
}

/** The log as one read gives it: its entries, and the teams to narrow it by. */
export interface StaffLog {
  entries: StaffLogEntry[];
  /** The roster's teams, by id and name. */
  teams: { id: string; name: string }[];
}

/** What the log can be narrowed to. */
export const logFilterSchema = z.strictObject({
  actor: z.enum(logActors).optional(),
  /** The start of what happened: `interview`, `onboarding.links`. */
  what: z
    .string()
    .regex(/^[a-z_.]{1,64}$/u)
    .optional(),
  team: z.string().max(64).optional(),
  /** An ISO day. */
  day: z.iso.date().optional(),
});
export type LogFilter = z.input<typeof logFilterSchema>;

/** The most log entries one read returns, the newest first. */
export const logPageMax = 500;

/** Where the onboarding stands, for Grasp. */
export interface StaffOverview {
  stages: StageView[];
  needs: StaffNeed[];
  notes: StaffNote[];
}

/** Someone's interview, as Grasp's staff read it: every read is on record. */
export interface StaffTranscript {
  person: string;
  name: string;
  team: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: InterviewProgress | null;
  /** Who held it: whoever they chose on the way in; null before anything was kept. */
  interviewer: Interviewer | null;
  /**
   * The marks of the interviewer's texts it was held with
   * (`interviewerTextMarkSchema`), the first one first: one, unless the
   * text changed while it went on.
   */
  texts: string[];
}

/** The longest note. */
export const noteMaxLength = 2000;

/** Where the agreements stand, as Grasp's staff keep them. */
export interface StaffAgreements {
  /** As staff last said; null before they said anything. */
  agreements: Agreements | null;
  /** All are in: links open and go out by the plan. */
  agreed: boolean;
  /**
   * The team is told: links went out, so what was agreed stays as it was.
   * Staff pause the interviews instead.
   */
  told: boolean;
  /** How many links went out, and how many wait (taking part, not out yet). */
  out: number;
  waiting: number;
}

/**
 * The most lines in each of Stephen's lists, and the longest line: as long
 * as what the kickoff suggests can be (the sponsor's answer, a team's
 * name), so a suggestion is kept whole, never cut, when staff save it.
 */
export const stephenLimitsMax = 30;
export const stephenTermsMax = 100;
export const stephenLimitMaxLength = answerMaxLength;
export const stephenTermMaxLength = kickoffTeamNameMaxLength;

const linesOf = (most: number, longest: number) =>
  z
    .array(z.string().trim().min(1).max(longest))
    .max(most)
    .refine((lines) => new Set(lines).size === lines.length, {
      message: "A line twice",
    });

/**
 * How Stephen is set up for this deployment, in every interview he holds:
 * the languages he interviews in, what he leaves alone, and the words he
 * has to know to hear them right (tools, products, the company's terms).
 */
export const stephenSetupSchema = z.strictObject({
  languages: z
    .array(interviewLocaleSchema)
    .min(1)
    .refine((languages) => new Set(languages).size === languages.length, {
      message: "A language twice",
    }),
  limits: linesOf(stephenLimitsMax, stephenLimitMaxLength),
  terms: linesOf(stephenTermsMax, stephenTermMaxLength),
});
export type StephenSetup = z.output<typeof stephenSetupSchema>;

/** Stephen's setup as staff see it. */
export interface StephenSetupView {
  /** What holds in every interview: staff's, or else what the kickoff suggests. */
  setup: StephenSetup;
  /** Staff changed it; null-saving takes it back to `suggested`. */
  changed: boolean;
  /** What the kickoff suggests: its limits, and the teams it named as words. */
  suggested: StephenSetup;
  /** What the kickoff said of the languages and the tools, to set him by. */
  kickoff: { languages: string | null; systems: string | null };
}

/** What people who finished thought of their interview, from 1 to 5. */
export interface StaffRating {
  /** How many said. */
  count: number;
  /** Their average; null while nobody said. */
  average: number | null;
  /** How many gave 1, 2, 3, 4 and 5, in that order. */
  by: number[];
}

/** The interviews that ran on one text of Stephen's or Claire's. */
export interface StaffInterviewerText {
  /** The text's mark (`interviewerTextMarkSchema`); null for interviews from before marks were kept. */
  mark: string | null;
  kind: InterviewKind | null;
  locale: InterviewLocale | null;
  started: number;
  finished: number;
  rating: StaffRating;
}

/** How one of the interviewers is doing: numbers only, never who said what. */
export interface StaffInterviewer {
  interviewer: Interviewer;
  /** Interviews started with them, and those people agreed to the read-back of. */
  started: number;
  finished: number;
  /** Started, not finished, and not saved for a while: where each stopped. */
  stopped: number;
  stops: Record<InterviewPhase, number>;
  rating: StaffRating;
  /** How long a finished interview took on average, in minutes: a lead's and someone's own; null without one. */
  minutes: { lead: number | null; own: number | null };
  /** How many finished interviews took up to so many minutes; the last has no top. */
  lengths: { upTo: number | null; count: number }[];
  /** The share of what they wrote down in people's own interviews that people left in; null before one finished. */
  leftIn: number | null;
  /** The share of finished interviews held by voice; null before one finished. */
  byVoice: number | null;
  /** The texts the interviews ran on, the most interviews first. */
  texts: StaffInterviewerText[];
}

/** One day's wait for Stephen's voice, in ms: the middle answer's, and the one nine in ten were faster than. */
export interface StaffAnswerDay {
  day: string;
  answers: number;
  middle: number;
  slow: number;
}

/** How Stephen and Claire are doing in this onboarding. */
export interface StaffInterviewers {
  interviewers: StaffInterviewer[];
  /** The days with answers measured, the oldest first. */
  answers: StaffAnswerDay[];
}

/** What the onboarding counts AI use under. */
export const aiPurposes = ["reading", "interviews", "drawing"] as const;
export type AiPurpose = (typeof aiPurposes)[number];

/** The AI one model did for one purpose on one day, as the onboarding counted it. */
export interface StaffAiUseRow {
  day: string;
  purpose: AiPurpose;
  /** The model as the gateway names it, or `voice` for Stephen's. */
  model: string;
  calls: number;
  /** Tokens read, of them from a cache, and written. */
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  /** Seconds of voice. */
  seconds: number;
}

/**
 * When a piece of work counts as known at this organization, as staff set
 * it (`OrgRules`): how many people must have told a step, how many
 * interviews before it is checked, the share of new facts under which it
 * stops, after how many it is better split in two, how many of the last
 * interviews are looked at, and who settles a difference nobody can
 * explain.
 */
export const orgRulesSchema = z.strictObject({
  people: z.int().min(1).max(10),
  minInterviews: z.int().min(1).max(30),
  stopShare: z.number().min(0).max(1),
  maxInterviews: z.int().min(1).max(50),
  run: z.int().min(1).max(10),
  settles: z.enum(SETTLERS),
}) satisfies z.ZodType<OrgRules>;

/**
 * Every piece of work as staff see it: as each team's map holds it, with
 * its drawing (each person's own numbers in `drawn.told`, and what the
 * next interviews still need to ask in `drawn.open`), this organization's
 * rules, and the pieces Grasp counts as known by hand.
 */
export interface StaffWorks {
  works: WorkRecord[];
  rules: OrgRules;
  /** Pieces of work Grasp counts as known by hand, by id. */
  counted: string[];
}
