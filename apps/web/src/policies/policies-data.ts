import type { PolicyDocument, PolicyException, PolicyRule } from "./policy.ts";

// What the Policies pages read. In the prototype the company's policies,
// the rules drawn from them and their exceptions live in its workspace
// store; Grasp keeps none of them yet (no table, no RPC), so the pages
// show their empty states until core keeps them. The pages read this one
// book, so filling it is all that changes then.

/** The company's policies, its rules and their exceptions. */
export interface PolicyBook {
  policies: PolicyDocument[];
  rules: PolicyRule[];
  exceptions: PolicyException[];
}

/** What Grasp keeps of the company's policies today: nothing yet. */
export const policyBook: PolicyBook = {
  policies: [],
  rules: [],
  exceptions: [],
};

/** Today, as the rules compare an exception's last day: "2026-09-28". */
export const policyToday = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};
