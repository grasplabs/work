import { z } from "zod";

import type { DirectoryPerson } from "./directory.ts";
import { defineErrorFamily } from "./errors.ts";

// Who leads which team, from the company's HR platform (GRA-371): in the
// onboarding's confirm step, the admin connects it, and its departments,
// people and who reports to whom come to the roster the admin then checks.
// A read-only connection of its own reads names, email addresses,
// departments, jobs and supervisors, and nothing else. Connect reads the
// platform and answers bounded rows, the same rows as a directory's
// (`./directory.ts`); the admin's browser makes them a roster the way it
// makes a staff list one.
//
// HiBob is the first platform: its people come in one request, with each
// person's department and supervisor, so a read is one call however large
// the company is. Another platform is one more provider here, in connect's
// providers.ts and in connect's hr.ts.

/** The HR platforms Grasp reads, by the name the onboarding shows. */
export const hrPlatformSchema = z.enum(["hibob"]);
export type HrPlatform = z.infer<typeof hrPlatformSchema>;

/** Each platform's read-only connection at connect. */
export const hrProviderSchema = z.enum(["hibob-hr"]);
export type HrProvider = z.infer<typeof hrProviderSchema>;

export const hrProviders: Readonly<Record<HrPlatform, HrProvider>> = {
  hibob: "hibob-hr",
};

/** The platform each connection reads. */
export const hrPlatformOf: Readonly<Record<HrProvider, HrPlatform>> = {
  "hibob-hr": "hibob",
};

/** Each platform's name, as people know it: not translated. */
export const hrPlatformNames: Readonly<Record<HrPlatform, string>> = {
  hibob: "HiBob",
};

/**
 * What a platform's API credentials hold: an ID and a secret, such as
 * HiBob's service user and its token. Printable ASCII, as they go into a
 * request header; the ID without a colon, which would split it.
 */
export const hrCredentialsSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[!-9;-~]+$/u, "Not an ID"),
  secret: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .regex(/^[!-~]+$/u, "Not a secret"),
});
export type HrCredentials = z.input<typeof hrCredentialsSchema>;

/** Bounds on what connect answers, so no platform can bloat a read. */
export const hrLimits = {
  /**
   * People one read takes: more than an onboarding takes (2000), with room
   * for people who aren't taking part. A company with more is refused, not
   * cut short.
   */
  peoplePerRead: 5000,
} as const;

/** One read of an HR platform: everyone it holds, as a directory's rows. */
export interface HrRead {
  people: DirectoryPerson[];
}

/** An HR platform's connection, as core finds it. */
export interface HrConnection {
  id: string;
  provider: HrProvider;
  status: "active" | "needs_reauth";
  /** ISO 8601. */
  connectedAt: string;
}

/** What core asks connect to read. */
export const hrReadRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
});
export type HrReadRequest = z.input<typeof hrReadRequestSchema>;

/** The HR platform the onboarding is connected to, as its admin sees it. */
export interface OnboardingHr {
  platform: HrPlatform;
  /** Needs connecting again: the platform stopped taking its credentials. */
  status: "active" | "needs_reauth";
}

/** Everyone in the onboarding's HR platform, read just now. */
export interface HrPeople {
  platform: HrPlatform;
  people: DirectoryPerson[];
}

/** The onboarding's HR platform, for the client's admin. */
export interface OnboardingHrApi {
  /** The HR platform connected for the onboarding; null before one is. */
  hrPlatform: () => Promise<OnboardingHr | null>;
  /** Connects `platform` with the API credentials the admin made there. */
  connectHrPlatform: (
    platform: HrPlatform,
    credentials: HrCredentials
  ) => Promise<OnboardingHr>;
  /** Reads everyone in the connected HR platform, on the record. */
  readHrPlatform: () => Promise<HrPeople>;
}

/** Why an HR platform couldn't be connected or read. */
export const hrErrors = defineErrorFamily({
  "hr.not_found":
    "There's no HR platform connection with that ID: a connection of another kind is read by nobody here.",
  "hr.not_connected": "No HR platform is connected yet.",
  "hr.refused":
    "The HR platform didn't take these credentials. Check the ID and the token, and that they may read people.",
  "hr.inactive":
    "This HR platform connection needs connecting again by an admin before it can be read.",
  "hr.throttled": "The HR platform is throttling reads: try again later.",
  "hr.provider_failed": "The HR platform didn't answer the read.",
  "hr.too_large":
    "This HR platform holds more people than an onboarding takes.",
  "hr.invalid": "That isn't a valid HR platform request.",
});
