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

/**
 * The browser and system a session signed in from, as its user agent
 * names them: enough to tell one's devices apart, never the user agent
 * itself. Either is `null` when the user agent names none Grasp knows.
 */
export interface SessionDevice {
  /** The browser, such as "Chrome" or "Safari". */
  browser: string | null;
  /** The operating system or device, such as "macOS", "Windows" or "iPhone". */
  system: string | null;
  /** A phone or tablet, rather than a computer. */
  mobile: boolean;
}

/**
 * One of the person's own sessions: a browser they are signed in on. Never
 * its token, which is what its cookie holds, nor the address it signed in
 * from.
 */
export interface OwnSession {
  /** Names the session for {@link SessionsApi.end}; opaque, and not its token. */
  id: string;
  /** What it signed in on, from the user agent it sent then. */
  device: SessionDevice;
  /** When they signed in (ISO 8601). */
  signedInAt: string;
  /**
   * When it was last active (ISO 8601), as far as core keeps it: when the
   * session last changed. Sessions aren't refreshed by use (core's
   * auth.ts), so for most this is when they signed in.
   */
  lastActiveAt: string;
  /** When it ends (ISO 8601). */
  expiresAt: string;
  /** The session this connection is signed in with: "This device". */
  current: boolean;
}

/** Most of a person's own sessions listed at once: the latest active. */
export const ownSessionsListed = 50;

/**
 * What ending a session came to. `ended`: it was theirs, and is over:
 * every connection on it closes within seconds. `current`: it is the one
 * this connection is signed in with, which signing out ends instead.
 * `not_found`: they hold no such session, whether it ended already or was
 * never theirs.
 */
export type EndedSession = "ended" | "current" | "not_found";

/** The person's own sessions, over `/rpc`; never anyone else's. */
export interface SessionsApi {
  /** Their sessions that haven't expired, latest active first, at most {@link ownSessionsListed}. */
  list: () => Promise<OwnSession[]>;
  /** Ends one of their other sessions, by its {@link OwnSession.id}; audited. */
  end: (id: string) => Promise<EndedSession>;
}
