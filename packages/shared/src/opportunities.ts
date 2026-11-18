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

/** An opportunity, as an admin reads it. */
export interface Opportunity {
  /** The routine it is: the onboarding's id for the team's piece of work. */
  routine: string;
  /** The evidence it rests on now: dismissing it is at this evidence. */
  evidence: string;
  /** The routine's name, and in its people's language where that differs. */
  name: string;
  local?: string;
  /** The team that does it, by its id on the staff list. */
  team: string;
  /** Its steps, in order. */
  steps: string[];
  /** How many come in a week, for the whole team: none when nobody said. */
  casesPerWeek: number | null;
  /** The hours a week it takes, from how often and how long: what it is ranked by. */
  hoursPerWeek: number | null;
  /** Where its evidence comes from: what people described in interviews. */
  basis: "described";
  /** What Grasp proposes: none while it couldn't ask a model (none set up, or the call failed); asked again at the next list. */
  form: OpportunityForm | null;
  /** An existing App that already covers it: then it points there, and proposes nothing new. */
  covers: { app: string; name: string } | null;
  /** Systems a step needs that aren't connected yet: each a setup step, never a lower rank. */
  setup: string[];
  /** The steps (from 1) that touch money, legal matters or customers: a person approves each. */
  personApproves: number[];
}

/** An opportunity to dismiss, at the evidence it was shown with. */
export const opportunityDismissalSchema = z.strictObject({
  routine: z.string().min(1).max(200),
  evidence: z.string().min(1).max(200),
});
export type OpportunityDismissal = z.infer<typeof opportunityDismissalSchema>;

/** Opportunities over `/rpc` (`session.opportunities`): for admins alone. */
export interface OpportunitiesApi {
  /** Every opportunity the admin may read, the largest first, dismissed ones left out. */
  list: () => Promise<Opportunity[]>;
  /** Hides an opportunity until its evidence changes. */
  dismiss: (dismissal: OpportunityDismissal) => Promise<void>;
}
