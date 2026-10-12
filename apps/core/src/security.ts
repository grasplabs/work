import type { Identity } from "@grasp-os/shared/rpc";
import { signInProviderSchema } from "@grasp-os/shared/security";
import type {
  ActiveSession,
  SecurityApi,
  SignInMethod,
} from "@grasp-os/shared/security";
import { and, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { providerIds } from "./auth/config.ts";
import { accounts, sessions } from "./db/core/schema.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The prototype's Security section (`routes/settings/security.tsx`): how
// the person signs in and where they are signed in. Read only, and only
// their own: sessions are Better Auth's, which ends them through its own
// routes (`/sign-out`, `/revoke-other-sessions`), and never hands out a
// token here.

/** Longest user agent handed back: enough to tell a browser apart. */
const userAgentMaxLength = 256;

/** How `person` signed in: where their account last signed in from. */
const signInOf = async (env: Env, person: Identity): Promise<SignInMethod> => {
  const [account] = await drizzle(env.DB)
    .select({ providerId: accounts.providerId })
    .from(accounts)
    .where(eq(accounts.userId, person.userId))
    .orderBy(desc(accounts.updatedAt))
    .limit(1);
  const provider = person.staff
    ? providerIds.staff
    : signInProviderSchema.safeParse(account?.providerId).data;
  return {
    provider: provider ?? null,
    email: person.email,
    sessionEndsAt: person.expiresAt,
  };
};

/**
 * `person`'s sessions that haven't ended, newest first. The one this
 * connection runs on is told by its end: sessions are never extended, so
 * each ends at the moment its own sign-in set, the one the session check
 * read (`Identity.expiresAt`).
 */
const sessionsOf = async (
  env: Env,
  person: Identity
): Promise<ActiveSession[]> => {
  const rows = await drizzle(env.DB)
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, person.userId),
        gt(sessions.expiresAt, new Date())
      )
    )
    .orderBy(desc(sessions.createdAt), desc(sessions.id));
  const current = Date.parse(person.expiresAt);
  return rows.map((row) => ({
    id: row.id,
    startedAt: row.createdAt.toISOString(),
    endsAt: row.expiresAt.toISOString(),
    userAgent: row.userAgent?.slice(0, userAgentMaxLength) ?? null,
    current: row.expiresAt.getTime() === current,
  }));
};

/** A signed-in person's `security`: their own sign-in and sessions. */
export class SecurityRpc extends CoreRpcTarget implements SecurityApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async signIn(): Promise<SignInMethod> {
    return await withPerson(
      this.#check,
      async (person) => await signInOf(this.#env, person)
    );
  }

  async sessions(): Promise<ActiveSession[]> {
    return await withPerson(
      this.#check,
      async (person) => await sessionsOf(this.#env, person)
    );
  }
}
