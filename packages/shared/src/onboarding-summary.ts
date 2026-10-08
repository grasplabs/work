import { z } from "zod";

// What the console reads of a client's onboarding (core's
// onboarding/summary.ts), for the card on its grid: where the onboarding
// stands, in numbers only. No name, no team, nothing anyone said: the
// console holds no client data, and this keeps it so. Only the console
// reads it: the request is signed with the key both derive from the
// client's auth secret, as platform updates are (`platform-change.ts`).

/** Where the console asks core for the summary. Behind the router-secret check. */
export const onboardingSummaryPath = "/platform/onboarding";

/** The purpose the request's signing key is derived for (`hkdfHmacKey`). */
export const onboardingSummaryPurpose = "grasp-os onboarding summary key";

/** How far from core's clock a request may have been sent. */
export const onboardingSummaryMaxSkewMs = 5 * 60 * 1000;

/** The most bytes a request's body may have. */
export const onboardingSummaryMaxBytes = 1024;

/** What the console sends: when, so a request caught on its way can't be sent later. */
export const onboardingSummaryRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
});
export type OnboardingSummaryRequest = z.infer<
  typeof onboardingSummaryRequestSchema
>;

/**
 * Where a client's onboarding stands: none begun; being prepared (closed
 * to the company, interviews not started); the interviews running;
 * waiting for Grasp's go (interviews over, or enough known); open.
 */
export const onboardingStages = [
  "none",
  "preparing",
  "interviews",
  "waiting",
  "open",
] as const;

/** A client's onboarding, as the console shows it: numbers only. */
export const onboardingSummarySchema = z.strictObject({
  stage: z.enum(onboardingStages),
  /** The day of the interviews it is on, from 1; null outside them. */
  day: z.int().min(1).nullable(),
  /** How many days the interviews run; null without a plan. */
  days: z.int().min(1).nullable(),
  /** How much Grasp knows, in percent. */
  known: z.int().min(0).max(100),
  /** How many things wait on Grasp's staff. */
  needs: z.int().min(0),
});
export type OnboardingSummary = z.infer<typeof onboardingSummarySchema>;
