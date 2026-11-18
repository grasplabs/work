import { z } from "zod";

// What could be automated or improved in how the company works (GRA-1750):
// each of a team's routines (GRA-1749) as an opportunity, ranked by the
// hours a week it takes, with the evidence it rests on and the form Grasp
// proposes for it. For admins alone, as each may read the routines.

/** What an opportunity could become. */
export const opportunityForms = [
  "workflow",
  "app",
  "skill",
  "change",
  "connection",
] as const;
export type OpportunityForm = (typeof opportunityForms)[number];

/** Where an opportunity's evidence comes from: what people described in interviews, what was seen in activity, or both. */
export type OpportunityBasis = "described" | "observed" | "both";

/** A step of a routine seen in activity (GRA-1764). */
export interface SeenStep {
  /** The system it is in, by its catalog name. */
  system: string;
  /** What kind of step, as the system's tool names it. */
  step: string;
  /** How many hours after the step before it comes, as a team's people take it; none on the first. */
  hoursAfter: number | null;
  /** It writes into another system than the step before it: the same data copied, a friction. */
  copied: boolean;
}

/**
 * A routine as seen in a team's activity: its steps and variants, each
 * taken by at least five people of the team. Never who, nor how many.
 */
export interface SeenRoutine {
  steps: SeenStep[];
  /** A step some take instead of the next one: after which step (from 0), and what. */
  variants: { after: number; system: string; step: string }[];
}

/** An opportunity, as an admin reads it. */
export interface Opportunity {
  /** The routine it is: the onboarding's id for the team's piece of work. */
  routine: string;
  /** The evidence it rests on now: dismissing it is at this evidence. */
  evidence: string;
  /** The routine's name, and in its people's language where that differs. */
  name: string;
  local?: string;
  /** The team that does it: by its id on the staff list when described, else by its id in Settings › Members. */
  team: string;
  /** Its steps, in order, as described: none when it was only seen. */
  steps: string[];
  /** How many come in a week, for the whole team: none when nobody said. */
  casesPerWeek: number | null;
  /** The hours a week it takes, from how often and how long: what it is ranked by. */
  hoursPerWeek: number | null;
  /** Where its evidence comes from. */
  basis: OpportunityBasis;
  /** What was seen of it in activity: none when it was only described. */
  seen: SeenRoutine | null;
  /**
   * Where what was described and what was seen differ, by system: those
   * seen and not described, and those described and not seen. None
   * unless it was both.
   */
  differs: { seenOnly: string[]; toldOnly: string[] } | null;
  /**
   * What Grasp proposes: none until a model answered. It is asked apart
   * from any list, when the routine is noted, and tried again with
   * back-off; one given up is asked again once an admin lists.
   */
  form: OpportunityForm | null;
  /** An existing App that already covers it: then it points there, and proposes nothing new. */
  covers: { app: string; name: string } | null;
  /** Systems a step needs that aren't connected yet: each a setup step, never a lower rank. */
  setup: string[];
  /** The steps (from 1) that touch money, legal matters or customers: a person approves each. */
  personApproves: number[];
  /** Whether an admin dismissed it at this evidence: hidden for every admin until it changes, or until one restores it. */
  dismissed: boolean;
}

/** An opportunity to dismiss, at the evidence it was shown with. */
export const opportunityDismissalSchema = z.strictObject({
  routine: z.string().min(1).max(200),
  evidence: z.string().min(1).max(200),
});
export type OpportunityDismissal = z.infer<typeof opportunityDismissalSchema>;

/** Opportunities over `/rpc` (`session.opportunities`): for admins alone. */
export interface OpportunitiesApi {
  /** Every opportunity the admin may read, the largest first, the dismissed ones marked. */
  list: () => Promise<Opportunity[]>;
  /** Hides an opportunity for every admin until its evidence changes. */
  dismiss: (dismissal: OpportunityDismissal) => Promise<void>;
  /** Shows a dismissed opportunity again, for every admin. */
  restore: (dismissal: OpportunityDismissal) => Promise<void>;
}
