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

/** What kind of group a directory group is. */
export const directoryGroupKinds = [
  "security",
  "microsoft_365",
  "distribution",
  "unknown",
] as const;
export type DirectoryGroupKind = (typeof directoryGroupKinds)[number];

/** Who decides a directory group's members. */
export const directoryGroupMembersFrom = [
  "owners",
  "rule",
  "on_premises",
  "privileged_admins",
  "unknown",
] as const;
export type DirectoryGroupMembersFrom =
  (typeof directoryGroupMembersFrom)[number];

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
  kind: DirectoryGroupKind;
  /**
   * Who decides its members: its owners (assigned membership), a rule
   * (dynamic membership), on-premises AD (synced), or only privileged
   * admins (role-assignable).
   */
  membersFrom: DirectoryGroupMembersFrom;
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

/** A group a search found, with the team it is mapped to, if any. */
export interface DirectoryGroupFound extends DirectoryGroup {
  teamId: string | null;
}

/**
 * A group as an admin weighs mapping it: as it is now, and how many it
 * holds. Counts only: never who.
 */
export interface DirectoryGroupPreview {
  group: DirectoryGroup;
  /** The team it is mapped to; null for none. */
  teamId: string | null;
  /** Users it holds, nested groups' included, each once. */
  people: number;
  /** Of them, how many are tied to a member here (the directory's read). */
  members: number;
  /** Groups it holds within, at any depth. */
  nestedGroups: number;
}

/**
 * Why the directory's daily read left a mapped group as it was: Microsoft
 * has no such group (`gone`), refused to read it (`refused`), it can't be
 * a team's now (`not_mappable`), or it lists nobody (`empty`).
 */
export const directoryGroupHelds = [
  "gone",
  "refused",
  "not_mappable",
  "empty",
] as const;
export type DirectoryGroupHeld = (typeof directoryGroupHelds)[number];

/** A directory group an admin mapped to a team (GRA-2056). */
export interface DirectoryGroupMapping {
  groupId: string;
  /** As the group was named when it was mapped, or last read. */
  name: string;
  kind: DirectoryGroup["kind"];
  membersFrom: DirectoryGroup["membersFrom"];
  teamId: string;
  /** ISO 8601. */
  mappedAt: string;
  /**
   * When the directory's daily read last read the group whole (ISO 8601):
   * until it has, the mapping places nobody. Null before then.
   */
  readAt: string | null;
  /** Why the last read left the group as it was; null when it didn't. */
  held: DirectoryGroupHeld | null;
}

/**
 * The directory's groups as teams' source, over `/rpc`, for the
 * organization's admins only (never Grasp staff): an admin maps a group
 * of the Entra directory to a members' team, and the daily read places the
 * group's members in it.
 */
export interface DirectoryGroupsApi {
  /** Groups whose name starts with `query`: one page, with whether more match. */
  search: (
    query: string
  ) => Promise<{ groups: DirectoryGroupFound[]; more: boolean }>;
  /** The group `groupId` as it is now, and how many it holds. */
  preview: (groupId: string) => Promise<DirectoryGroupPreview>;
  /**
   * Maps the group `groupId` to the team `teamId`, as Microsoft answers
   * the group now: refused for one with a refusal
   * (`directory.group_not_mappable`). A group mapped to another team moves.
   */
  mapToTeam: (
    groupId: string,
    teamId: string
  ) => Promise<DirectoryGroupMapping>;
  /** Unmaps the group `groupId`. Answers whether it was mapped. */
  unmap: (groupId: string) => Promise<{ unmapped: boolean }>;
  /** Every mapped group, by name. */
  list: () => Promise<DirectoryGroupMapping[]>;
}

/** The directory the onboarding is connected to, as its admin sees it. */
export interface OnboardingDirectory {
  suite: DirectorySuite;
  /** Needs reconnecting: its grant ran out, or now grants other access. */
  status: "active" | "needs_reauth";
}

/**
 * One account's directory connected for the onboarding's roster: the
 * company's own, or another of its accounts (a second Microsoft tenant, a
 * Google domain of a daughter company), read into the same roster only;
 * signing in stays the company's own account's.
 */
export interface OnboardingDirectoryAccount {
  id: string;
  suite: DirectorySuite;
  /** The tenant's id at Microsoft, or the domain at Google. */
  tenant: string;
  /** The company's own account, the one people sign in with. */
  own: boolean;
  status: "active" | "needs_reauth";
}

/** A domain as the admin names another account by: `acme.de`. */
export const accountDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);

/** Everyone in the onboarding's directory, read just now. */
export interface DirectoryPeople {
  suite: DirectorySuite;
  people: DirectoryPerson[];
}

/** The onboarding's directory, for the client's admin. */
export interface OnboardingDirectoryApi {
  /** The directory connected for the onboarding; null before one is. */
  directory: () => Promise<OnboardingDirectory | null>;
  /** Every account's directory connected for the onboarding's roster, the company's own first. */
  directoryAccounts: () => Promise<OnboardingDirectoryAccount[]>;
  /**
   * Starts connecting another account's directory of `suite`, named by its
   * `domain`, for the roster only: where to send the browser.
   */
  connectOtherDirectory: (
    suite: DirectorySuite,
    domain: string,
    returnTo: string
  ) => Promise<{ url: string }>;
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
  /** Reads everyone in the directory of connection `connectionId`, one of `directoryAccounts`, on the record. */
  readDirectoryAccount: (connectionId: string) => Promise<DirectoryPeople>;
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
  "directory.not_admin":
    "The account that connected the directory can't read it: connect it with an admin account of the Workspace.",
  // The directory's answer alone, Microsoft's or Google's: what came of the
  // read is the reader's to say (core's directory-people.ts `deletedOf`),
  // as it differs by page.
  "directory.deleted_refused":
    "The directory refused to list its deleted accounts.",
  "directory.deleted_unsupported":
    "The directory's list of its deleted accounts didn't answer as a list.",
  "directory.group_gone": "That group is no longer in the directory.",
  "directory.group_refused":
    "Microsoft refused to read the directory's groups for this connection.",
  "directory.groups_not_granted":
    "Grasp can't read your directory's groups yet: the directory was connected before Grasp asked for that permission. An admin connects the directory again from Settings › Members, with the same account, to grant it.",
  "directory.group_not_mappable":
    "That group can't be a team's: anyone can join it, its members can't all be read, or Microsoft didn't say which.",
  "directory.team_not_found": "There's no such team.",
  "directory.unknown_domain":
    "No account answers for that domain: check how it is spelled.",
});

/** A code of the directory's errors (`directoryErrors`). */
export type DirectoryErrorCode = NonNullable<
  ReturnType<(typeof directoryErrors)["codeOf"]>
>;

/**
 * Why a daily read of the directory failed, as core records it
 * (directory-people.ts): what the read itself, and connect's reads of the
 * people and the deleted accounts it makes, can throw. Any other error is
 * recorded as `directory.read_failed`. A code added to what those throw is
 * added here, and its advice to the admin follows (the web's
 * `adviceOf`, which fails to type-check until it is placed).
 */
export const directoryReadFailures = [
  "directory.not_connected",
  "directory.not_found",
  "directory.inactive",
  "directory.not_admin",
  "directory.cursor_invalid",
  "directory.throttled",
  "directory.provider_failed",
  "directory.other_tenant",
  "directory.too_large",
  "directory.read_too_long",
  "directory.read_failed",
  "directory.deleted_refused",
  "directory.deleted_unsupported",
] as const satisfies readonly DirectoryErrorCode[];
export type DirectoryReadFailure = (typeof directoryReadFailures)[number];

/** Whether `code` is one a daily read records as its failure. */
export const isDirectoryReadFailure = (
  code: string | undefined
): code is DirectoryReadFailure =>
  directoryReadFailures.some((failure) => failure === code);

/**
 * Why a daily read went on without the deleted accounts: their list's
 * first page refused, or not a list (core's directory-people.ts `deletedOf`).
 */
export const directoryDeletedFailures = [
  "directory.deleted_refused",
  "directory.deleted_unsupported",
] as const satisfies readonly DirectoryErrorCode[];
export type DirectoryDeletedFailure = (typeof directoryDeletedFailures)[number];

/** Whether `code` is one a daily read goes on without the deleted accounts for. */
export const isDirectoryDeletedFailure = (
  code: string | undefined
): code is DirectoryDeletedFailure =>
  directoryDeletedFailures.some((failure) => failure === code);
