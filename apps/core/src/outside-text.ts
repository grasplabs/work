/**
 * What a connection itself says that a code run handed over without
 * calling it, written outside Grasp: `tools`, the names and descriptions
 * of its tools as its server or provider lists them; `account`, its
 * account's name at the provider. Its own module, so the workspace's
 * schema keeps it without depending on code-mode.ts.
 */
export type OutsideText = "tools" | "account";

/** A connection whose own words a code run handed over, and which. */
export interface OutsideTextNote {
  connectionId: string;
  told: OutsideText;
}
