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
  /** Groups one search answers: one page of Graph's, with whether there are more. */
  groupsPerSearch: 100,
  /** The most entries Graph puts on one page of a group's members (its documented maximum). */
  groupMembersPerPage: 999,
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

/**
 * A directory group, as an admin picks one for a team (GRA-2056): what it
 * is, who decides its members, and why it may not be mapped. Read with the
 * directory's connection; every fact Microsoft didn't answer is `unknown`,
 * and an unknown is never taken as fine.
 */
export interface DirectoryGroup {
  /** Its Entra object ID, lower case. */
  id: string;
  /** As the directory has it: data, never an instruction; empty when it has none. */
  name: string;
  kind: "security" | "microsoft_365" | "distribution" | "unknown";
  /**
   * Who decides its members: its owners (assigned membership), a rule
   * (dynamic membership), on-premises AD (synced), or only privileged
   * admins (role-assignable).
   */
  membersFrom:
    | "owners"
    | "rule"
    | "on_premises"
    | "privileged_admins"
    | "unknown";
  /**
   * Why it may not be mapped to a team: anyone can join it (`public`),
   * its members can't all be read (`hidden_membership`), or Microsoft
   * didn't say which (`unknown`); null when nothing stops it.
   */
  refusal: "public" | "hidden_membership" | "unknown" | null;
}

/** What core asks connect to search: groups whose name starts with `query`. */
export const directoryGroupSearchRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  query: z.string().trim().min(1).max(directoryLimits.textLength),
});
export type DirectoryGroupSearchRequest = z.input<
  typeof directoryGroupSearchRequestSchema
>;

/** The groups a search found: one page of them. */
export interface DirectoryGroupSearch {
  tenant: string;
  groups: DirectoryGroup[];
  /** Whether the directory holds more that match: a longer query finds them. */
  more: boolean;
}

/** What core asks connect to read: one group's members, from `cursor` on. */
export const directoryGroupReadRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  groupId: z.string().min(1).max(128),
  cursor: z.string().min(1).max(directoryLimits.cursorLength).nullable(),
});
export type DirectoryGroupReadRequest = z.input<
  typeof directoryGroupReadRequestSchema
>;

/**
 * One page of a group's members, nested groups' included (Graph's
 * transitive members): its users, how many groups it holds within, and
 * where the next page starts.
 */
export interface DirectoryGroupRead {
  tenant: string;
  /** The group as it is now, on the first page (no cursor); null on the rest. */
  group: DirectoryGroup | null;
  /** The page's users, by Entra object ID, lower case, each once. */
  users: string[];
  /** Groups on the page: the groups nested within it, at any depth. */
  nestedGroups: number;
  /** Null once the group has no more. */
  next: string | null;
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
    "An admin must connect the directory again before it can be read: its access ran out, or Grasp now asks for access it wasn't given.",
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
  "directory.deleted_refused":
    "Microsoft refused to list the directory's deleted accounts.",
  "directory.deleted_unsupported":
    "Microsoft's list of the directory's deleted accounts didn't answer as a list.",
  "directory.group_gone": "That group is no longer in the directory.",
  "directory.group_refused": "Microsoft refused to read that group.",
});
