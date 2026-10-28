import type { PolicyBook, PolicyFindings } from "@grasp-os/shared/policies";

import type { CoreConnection } from "../core-connection.ts";
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

/** What the Policies pages read: the book, and which apps its rules catch. */
export interface PoliciesData {
  book: Loaded<PolicyBook>;
  found: Loaded<PolicyFindings>;
}

export const loadPolicies = async (
  core: CoreConnection
): Promise<PoliciesData> => {
  const [book, found] = await Promise.all([
    readPolicyBook(core),
    readPolicyFindings(core),
  ]);
  return { book, found };
};
