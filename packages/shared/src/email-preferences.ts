import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// Each person's own choice of the emails Grasp sends them, as the
// prototype's Settings → Notifications has it. Core keeps it in the
// person's Workspace object (core's email-preferences-rpc.ts), next to
// their dashboard; only they read or change it. A person who never
// changed theirs gets every email (`defaultEmailPreferences`).
//
// Core sends none of these emails yet: the choice is kept so that the
// sender of each, once there is one, asks it first.

/** Why a call on email preferences was refused. */
export const emailPreferenceErrors = defineErrorFamily({
  "email_preferences.invalid":
    "Those aren't email preferences: a yes or no for any of Grasp's emails, and nothing else.",
});

/** Which of Grasp's emails a person gets: a yes or no for each. */
export const emailPreferencesSchema = z.strictObject({
  /** When a workflow to check or approve, a run or a change to a live workflow waits on them. */
  needsYou: z.boolean(),
  /** Every Monday: hours, runs and what waits. */
  weeklySummary: z.boolean(),
  /**
   * When a payment fails or the card is about to run out. Only those who
   * can fix billing are asked, and only they would be sent it.
   */
  billingProblems: z.boolean(),
});
export type EmailPreferences = z.infer<typeof emailPreferencesSchema>;

/**
 * What a save changes: some of the emails, the others left as they were,
 * so two pages open at once never put back what the other changed.
 */
export const emailPreferenceChangesSchema = emailPreferencesSchema.partial();
export type EmailPreferenceChanges = z.infer<
  typeof emailPreferenceChangesSchema
>;

/** What a person who never changed theirs gets: every email, as in the prototype. */
export const defaultEmailPreferences: EmailPreferences = {
  needsYou: true,
  weeklySummary: true,
  billingProblems: true,
};

/** The signed-in person's own email preferences. */
export interface EmailPreferencesApi {
  /** Theirs as they last saved them, or the defaults when they never did. */
  get: () => Promise<EmailPreferences>;
  /** Saves the emails `changes` names; the others stay as they were. */
  save: (changes: EmailPreferenceChanges) => Promise<void>;
}
