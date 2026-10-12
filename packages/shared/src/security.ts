import { z } from "zod";

/** The ways into a deployment: the client's IdP, or Grasp's for staff. */
export const signInProviderSchema = z.enum([
  "microsoft",
  "google",
  "grasp-staff",
]);
export type SignInProvider = z.infer<typeof signInProviderSchema>;

/** How the person signed in, as the Security section shows it. */
export interface SignInMethod {
  /** Where they last signed in; `null` when core has no record of it. */
  provider: SignInProvider | null;
  email: string;
  /** When this session ends and they sign in again (ISO 8601). */
  sessionEndsAt: string;
}

/**
 * One of the person's own sessions that hasn't ended: what they need to
 * recognise it, never its token.
 */
export interface ActiveSession {
  id: string;
  /** When they signed in (ISO 8601). */
  startedAt: string;
  /** When it ends (ISO 8601). */
  endsAt: string;
  /** The browser's own description of itself, as it sent it, if it did. */
  userAgent: string | null;
  /** Whether it is the session this connection runs on. */
  current: boolean;
}

/**
 * The person's own sign-in and sessions, over `/rpc`, read only: signing
 * out goes through sign-in's own routes.
 */
export interface SecurityApi {
  signIn: () => Promise<SignInMethod>;
  sessions: () => Promise<ActiveSession[]>;
}
