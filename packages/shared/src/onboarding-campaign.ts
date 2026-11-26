import { z } from "zod";

import { gateThresholds } from "./onboarding-gate.ts";
import { rosterPersonSchema, rosterTeamSchema } from "./onboarding.ts";

// The campaign, as the company's admin reads it while the interviews run
// (core's `onboarding.campaign`): how the days stand, each team in numbers,
// what needs the admin, and how much Grasp knows against its go. Numbers
// only, and never more of anyone than the admin's own view tells
// (`OnboardingView.progress`, `LinkToSend`): a team's numbers show by the
// same rules (`minTeamShown`, `minTalkedShown`), as of the start of today,
// and nothing anyone said is in it.

/** A team's or a person's id, as the staff list has them. */
const idSchema = rosterPersonSchema.shape.id;

/** One team that takes part, as the admin may see it. */
export const campaignTeamSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  /** Whether it has a lead, as the staff list says. */
  led: z.boolean(),
  /** Whether one of its leads has talked, as `TeamProgress.leadTalked`. */
  leadTalked: z.boolean(),
  /** How many were asked, its leads apart; null for a team under `minTeamShown`. */
  asked: z.int().min(0).nullable(),
  /**
   * How many of those talked, how many started and haven't finished, and
   * how many haven't started: null with `asked`, and while fewer than
   * `minTalkedShown` talked, as each of the three would give that away.
   */
  talked: z.int().min(0).nullable(),
  inProgress: z.int().min(0).nullable(),
  notStarted: z.int().min(0).nullable(),
  /**
   * How many finished on each day of the plan, from its first: null with
   * `talked`. A day from today on counts nothing yet.
   */
  byDay: z.array(z.int().min(0)).nullable(),
  /**
   * Nobody in it has started, `remindAfterWorkingDays` working days after
   * it was asked: only for a team whose numbers show.
   */
  quiet: z.boolean(),
});
export type CampaignTeam = z.infer<typeof campaignTeamSchema>;

/** Something only the admin can do. */
export const campaignAskSchema = z.discriminatedUnion("kind", [
  /** A quiet team, to nudge (`onboarding.nudge`). */
  z.strictObject({
    kind: z.literal("quiet"),
    team: idSchema,
    name: z.string(),
    /** How many of it are still to talk. */
    waiting: z.int().min(0),
    /** The admin nudged it today: the next nudge is tomorrow's. */
    nudged: z.boolean(),
  }),
  /**
   * Someone whose link mail failed for good (`LinkToSend.mailFailed`), to
   * correct their address (`onboarding.correctAddress`): who, and the
   * address as the staff list has it.
   */
  z.strictObject({
    kind: z.literal("mail"),
    person: idSchema,
    name: z.string(),
    /** Their team's name. */
    team: z.string(),
    email: z.string(),
  }),
]);
export type CampaignAsk = z.infer<typeof campaignAskSchema>;

export const campaignSchema = z.strictObject({
  /** The plan's first day, how many days it runs, and its last day (ISO days). */
  start: z.iso.date(),
  days: z.int().min(1),
  closes: z.iso.date(),
  /** Today, as core counts days (UTC): the numbers are of its start. */
  today: z.iso.date(),
  /**
   * Everyone the admin may count, as `OnboardingProgress`: the teams whose
   * numbers show together, and the teams with a lead apart.
   */
  asked: z.int().min(0),
  talked: z.int().min(0),
  leads: z.int().min(0),
  leadsTalked: z.int().min(0),
  /** The teams that take part, in the staff list's order. */
  teams: z.array(campaignTeamSchema),
  /** What needs the admin: the quiet teams first, then the mails that failed. */
  asks: z.array(campaignAskSchema),
  /** How much Grasp knows, in percent, against the go (`GateView`). */
  known: z.int().min(0).max(100),
  threshold: z.union(gateThresholds.map((value) => z.literal(value))),
  /** Grasp knows enough, or the interviews are over: staff may give the go. */
  ready: z.boolean(),
});
export type Campaign = z.infer<typeof campaignSchema>;

/** What a nudge answers: how many of the team were mailed. */
export interface Nudged {
  mailed: number;
}

/** The team the admin nudges, by its id. */
export const nudgeSchema = rosterTeamSchema.shape.id;

/** What the admin sends to correct someone's address: an address as the staff list takes one, and not none. */
export const correctAddressSchema = z.strictObject({
  person: idSchema,
  email: z.email().max(120),
});
