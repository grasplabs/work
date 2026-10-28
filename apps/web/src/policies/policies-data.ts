import type { PolicyBook } from "@grasp-os/shared/policies";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// What the Policies pages read: the company's policies, the rules drawn
// from them and their exceptions, as core keeps them
// (`session.policies.book()`). The Landscape reads the same book, so the
// rules mark its apps there too.

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

/** Today, as the rules compare an exception's last day: "2026-09-28". */
export const policyToday = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};
