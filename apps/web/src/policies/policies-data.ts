import type { PolicyBook, PolicyFindings } from "@grasp-os/shared/policies";

import type { CoreConnection } from "../core-connection.ts";
import { readPeople } from "../directory.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// What the Policies pages read: the company's policies, the rules drawn
// from them and their exceptions, as core keeps them
// (`session.policies.book()`), and which apps the rules catch, as core
// works it out (`session.policies.findings()`). The Landscape reads the
// same, so the rules mark its apps there too.

/** The book while it couldn't be read: no rule marks an app. */
export const emptyBook: PolicyBook = {
  policies: [],
  rules: [],
  exceptions: [],
};

export const readPolicyBook = async (
  core: CoreConnection
): Promise<Loaded<PolicyBook>> =>
  await loadFromCore(core, async (session) => await session.policies.book());

/** The book as read, or the empty one when it couldn't be. */
export const bookOf = (loaded: Loaded<PolicyBook>): PolicyBook =>
  loaded.state === "ready" ? loaded.data : emptyBook;

/** Today, as an exception's last day is compared: "2026-09-28". */
export const policyToday = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

/** What core found while it couldn't be read: no rule catches an app. */
export const noFindings: PolicyFindings = { findings: [], proposals: [] };

export const readPolicyFindings = async (
  core: CoreConnection
): Promise<Loaded<PolicyFindings>> =>
  await loadFromCore(
    core,
    async (session) => await session.policies.findings()
  );

/** The findings as read, or none when they couldn't be. */
export const findingsOfLoaded = (
  loaded: Loaded<PolicyFindings>
): PolicyFindings => (loaded.state === "ready" ? loaded.data : noFindings);

/**
 * People's names by ID, for who made a rule or uploaded a policy: none
 * when the members can't be read, so a page never shows an ID instead.
 */
export const readPeopleOf = async (
  core: CoreConnection
): Promise<ReadonlyMap<string, string>> => {
  const read = await loadFromCore(core, readPeople);
  return read.state === "ready" ? read.data : new Map<string, string>();
};

/** What the Policies pages read: the book, which apps its rules catch, and people's names. */
export interface PoliciesData {
  book: Loaded<PolicyBook>;
  found: Loaded<PolicyFindings>;
  people: ReadonlyMap<string, string>;
}

export const loadPolicies = async (
  core: CoreConnection
): Promise<PoliciesData> => {
  const [book, found, people] = await Promise.all([
    readPolicyBook(core),
    readPolicyFindings(core),
    readPeopleOf(core),
  ]);
  return { book, found, people };
};
