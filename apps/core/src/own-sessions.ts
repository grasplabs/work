import { actorOf } from "@grasp-os/shared/audit";
import { identifierSchema } from "@grasp-os/shared/ids";
import { ownSessionsListed } from "@grasp-os/shared/sign-in";
import type {
  EndedSession,
  OwnSession,
  SessionsApi,
} from "@grasp-os/shared/sign-in";
import { and, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { sessions } from "./db/core/schema.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { deviceOf } from "./user-agent.ts";

// A person's own sessions, over `/rpc`: the browsers they are signed in
// on, and ending one, say on a device they lost. Only their own, as the
// session check hands them over: another's session reads as no session at
// all. A session's token is what its cookie holds, so it never leaves
// core; its ID only names it, nor does the address it signed in from.
// Better Auth's own session routes answer with tokens, so they are closed
// (auth/routes.ts).
//
// Ending one deletes it: every connection on it is refused at its next
// reading of the session (rpc.ts), within seconds, and closes. Audited as
// an admin's revoking is (members.ts): it signs someone out. Not the one
// this connection is on: that is signing out, which also clears the
// browser's cookie.

/** The signed-in person's own sessions. */
export class SessionsRpc extends CoreRpcTarget implements SessionsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  readonly #current: string;

  /** `current`: the ID of the session this connection is signed in with. */
  constructor(env: Env, check: SessionCheck, current: string) {
    super();
    this.#env = env;
    this.#check = check;
    this.#current = current;
  }

  async list(): Promise<OwnSession[]> {
    return await withPerson(this.#check, async ({ userId }) => {
      const rows = await drizzle(this.#env.DB)
        .select({
          id: sessions.id,
          userAgent: sessions.userAgent,
          signedInAt: sessions.createdAt,
          lastActiveAt: sessions.updatedAt,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .where(
          and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date()))
        )
        .orderBy(desc(sessions.updatedAt), desc(sessions.id))
        .limit(ownSessionsListed);
      return rows.map((row) => ({
        id: row.id,
        device: deviceOf(row.userAgent),
        signedInAt: row.signedInAt.toISOString(),
        lastActiveAt: row.lastActiveAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        current: row.id === this.#current,
      }));
    });
  }

  async end(id: string): Promise<EndedSession> {
    return await withPerson(this.#check, async (person) => {
      // Anything but an identifier names no session, and the audit log takes it.
      const parsed = identifierSchema.safeParse(id);
      if (!parsed.success) {
        return "not_found";
      }
      if (parsed.data === this.#current) {
        return "current";
      }
      const db = drizzle(this.#env.DB);
      const [ended] = await auditedBatch(this.#env, db, [
        db
          .delete(sessions)
          .where(
            and(
              eq(sessions.id, parsed.data),
              eq(sessions.userId, person.userId)
            )
          )
          .returning({ id: sessions.id }),
        outboxedIfChanged(db, {
          actor: actorOf(person),
          action: "session.ended",
          target: { type: "session", id: parsed.data },
        }),
      ]);
      return ended.length === 0 ? "not_found" : "ended";
    });
  }
}
