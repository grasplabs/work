// A refused sign-in lands on the frontend with `?error=<code>`, and the
// frontend has a message for each code. These are every code it can get.

/** Why core refused a sign-in: its check of the IdP's claims, or the method. */
const signInRefusals = [
  "provider_unknown",
  "tenant_mismatch",
  "guest_not_allowed",
  "email_unverified",
  "domain_not_allowed",
  "staff_not_listed",
  "staff_window_closed",
  "method_not_allowed",
  // The deployment is onboarding: only its admins and Grasp's staff come in
  // until Grasp's go (core's onboarding/gate.ts).
  "not_open_yet",
] as const;
export type SignInRefusal = (typeof signInRefusals)[number];

/** The codes Better Auth itself sends for a sign-in that failed. */
const betterAuthSignInErrors = [
  "account not linked",
  "state_mismatch",
  "state_not_found",
  "unable to create session",
] as const;

/** Every code a failed sign-in comes back with. */
export type SignInErrorCode =
  | SignInRefusal
  | (typeof betterAuthSignInErrors)[number];

/** One of the person's own sessions: a browser they are signed in on. */
export interface OwnSession {
  /** The session's ID, never its token. */
  id: string;
  /** The browser's user agent, as it sent it when signing in. */
  device: string | null;
  /** When they signed in (ISO 8601). */
  signedInAt: string;
  /** When the session was last refreshed (ISO 8601). */
  refreshedAt: string;
  /** When it ends unless refreshed (ISO 8601). */
  expiresAt: string;
  /** The session this connection is signed in with. */
  current: boolean;
}

/** Most of a person's own sessions listed at once: the latest refreshed. */
export const ownSessionsListed = 50;

/**
 * What ending a session came to. `ended`: it was theirs, and is over:
 * every connection on it closes within seconds. `not_found`: they hold no
 * such session, whether it ended already or was never theirs.
 */
export type EndedSession = "ended" | "not_found";

/** The person's own sessions, over `/rpc`. */
export interface SessionsApi {
  /** Their sessions that haven't expired, latest refreshed first, at most {@link ownSessionsListed}. */
  list: () => Promise<OwnSession[]>;
  /** Ends one of their own sessions, this one too; audited. */
  end: (id: string) => Promise<EndedSession>;
}
