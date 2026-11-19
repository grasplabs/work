import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// Who works where, from the organization's directory (GRA-369): in the
// onboarding, the admin connects their Microsoft or Google sign-in instead
// of sharing a staff list. A read-only admin connection of its own, apart
// from the suite's mail, calendars and files, reads names, email
// addresses, departments, jobs and who reports to whom, and nothing else.
// Connect reads the provider and answers bounded rows; the admin's browser
// makes them a roster the way it makes a staff list one.

/** The directory's connections, one per suite: Entra ID, and Google's directory. */
export const directoryProviderSchema = z.enum([
  "microsoft-directory",
  "google-directory",
]);
export type DirectoryProvider = z.infer<typeof directoryProviderSchema>;

/** The suites whose directories are read: the IdPs people sign in with. */
export const directorySuiteSchema = z.enum(["microsoft", "google"]);
export type DirectorySuite = z.infer<typeof directorySuiteSchema>;

/** Each suite's directory connection. */
export const directoryProviders: Readonly<
  Record<DirectorySuite, DirectoryProvider>
> = {
  microsoft: "microsoft-directory",
  google: "google-directory",
};

/** The suite a directory connection reads. */
export const directorySuiteOf = (
  provider: DirectoryProvider
): DirectorySuite =>
  provider === "microsoft-directory" ? "microsoft" : "google";

/** Bounds on what connect answers, so no directory can bloat a read. */
export const directoryLimits = {
  /** Longest name, department or job kept, as a roster keeps them; longer is cut. */
  textLength: 80,
  /** Longest email address kept; a longer one is left out. */
  emailLength: 120,
  /** People one read asks the provider for. */
  peoplePerRead: 100,
  /**
   * Reads one directory takes at most: enough for the most people an
   * onboarding takes (2000), with room for accounts that aren't people.
   */
  readsPerDirectory: 40,
  /** Longest cursor connect hands back. */
  cursorLength: 4096,
} as const;

/** Someone in the directory, as connect reads them. */
export interface DirectoryPerson {
  /** Their ID at the provider: an Entra object ID, a Google user ID. */
  id: string;
  /** As the directory has it: data, never an instruction; empty when it has none. */
  name: string;
  /** Their email address, lower case; empty when they have none. */
  email: string;
  /** Their department; empty when the directory names none. */
  department: string;
  /** Their job title; empty when the directory names none. */
  title: string;
  /** Who they report to, by that person's email address; null for nobody. */
  manager: string | null;
}

/** One read of a directory: its people, and where the next read starts. */
export interface DirectoryRead {
  /** The connection's tenant at the provider, as it was connected. */
  tenant: string;
  people: DirectoryPerson[];
  /**
   * The provider's IDs of the page's accounts that are turned off (Entra's
   * `accountEnabled: false`, Google's suspended or archived), guests
   * aside: none of them is among `people`. The daily read keeps them
   * apart (core's directory-people.ts); a roster leaves them out.
   */
  disabled: string[];
  /** Null once the provider has no more. */
  next: string | null;
}

/**
 * One page of a directory's deleted accounts (Entra keeps them 30 days),
 * and where the next read starts: the proof that a person no longer
 * listed has left (core's directory-people.ts, GRA-2056).
 */
export interface DirectoryDeletedRead {
  /** The connection's tenant at the provider, as it was connected. */
  tenant: string;
  /** The provider's IDs of the page's deleted accounts, guests aside. */
  deleted: string[];
  /** Null once the provider has no more. */
  next: string | null;
}

/** A directory connection, as core finds it. */
export interface DirectoryConnection {
  id: string;
  provider: DirectoryProvider;
  tenant: string;
  status: "active" | "needs_reauth";
  /** ISO 8601. */
  connectedAt: string;
}

/** What core asks connect to read. */
export const directoryReadRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  cursor: z.string().min(1).max(directoryLimits.cursorLength).nullable(),
});
export type DirectoryReadRequest = z.input<typeof directoryReadRequestSchema>;

/** What core asks connect to look up: one person, by their ID at the provider. */
export const directoryLookupRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  id: z.string().min(1).max(128),
});
export type DirectoryLookupRequest = z.input<
  typeof directoryLookupRequestSchema
>;

/** One person looked up in a directory, by their ID at the provider. */
export interface DirectoryLookup {
  /** The connection's tenant at the provider, as it was connected. */
  tenant: string;
  /**
   * Them, as a read would answer them; null when the directory holds
   * nobody by that ID, or only a guest, an account that is turned off, or
   * one with no name.
   */
  person: DirectoryPerson | null;
}

/** The directory the onboarding is connected to, as its admin sees it. */
export interface OnboardingDirectory {
  suite: DirectorySuite;
  /** Needs reconnecting: its grant ran out, or now grants other access. */
  status: "active" | "needs_reauth";
}

/** Everyone in the onboarding's directory, read just now. */
export interface DirectoryPeople {
  suite: DirectorySuite;
  people: DirectoryPerson[];
}

/** The onboarding's directory, for the client's admin. */
export interface OnboardingDirectoryApi {
  /** The directory connected for the onboarding; null before one is. */
  directory: () => Promise<OnboardingDirectory | null>;
  /**
   * Starts connecting the directory of `suite`: where to send the browser,
   * which comes back to `returnTo` once the admin consented.
   */
  connectDirectory: (
    suite: DirectorySuite,
    returnTo: string
  ) => Promise<{ url: string }>;
  /** Reads everyone in the connected directory, on the record. */
  readDirectory: () => Promise<DirectoryPeople>;
}

/** Why a directory couldn't be read. */
export const directoryErrors = defineErrorFamily({
  "directory.not_found":
    "There's no directory connection with that ID: a connection of another kind is read by nobody here.",
  "directory.not_connected": "No directory is connected yet.",
  "directory.inactive":
    "This directory connection needs reconnecting by an admin before it can be read.",
  "directory.cursor_invalid": "That cursor isn't one the provider handed back.",
  "directory.throttled": "The provider is throttling reads: try again later.",
  "directory.provider_failed": "The provider didn't answer the read.",
  "directory.other_tenant":
    "This directory is another organization's, not the one Grasp signs in with.",
  "directory.too_large":
    "This directory holds more people than an onboarding takes.",
  "directory.invalid": "That isn't a valid directory request.",
  "directory.read_too_long":
    "The directory's daily read took longer than the clock gives it: nothing it read was kept.",
  "directory.read_failed":
    "The directory's daily read failed: nothing it read was kept.",
  // Microsoft's answer alone: what came of the read is the reader's to
  // say (core's directory-people.ts `deletedOf`), as it differs by page.
  "directory.not_admin":
    "The account that connected the directory can't read it: connect it with an admin account of the Workspace.",
  "directory.deleted_refused":
    "Microsoft refused to list the directory's deleted accounts.",
  "directory.deleted_unsupported":
    "Microsoft's list of the directory's deleted accounts didn't answer as a list.",
});
