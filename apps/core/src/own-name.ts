import { actorOf } from "@grasp-os/shared/audit";
import { authErrors } from "@grasp-os/shared/errors";
import { memberErrors, personNameSchema } from "@grasp-os/shared/members";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember } from "./auth/membership-sql.ts";
import { users } from "./db/core/schema.ts";

// A person's own name. Their sign-in sets it when their user is made (or,
// for someone the directory made a member, when they first sign in:
// auth.ts takes the sign-in's name then); Better Auth's SSO plugin leaves
// it after (`overrideUserInfo` is off), so a name they give themselves
// stays through every later sign-in, whatever the IdP calls them.
//
// It is kept once, on their user: every member list, mention, share and
// the agent read it from there when asked, and the audit log keeps user
// IDs alone, so a change shows everywhere with no copy left behind.

/** Whether `userId` is a member who may act now (`activeMember`). */
const stillMember = async (env: Env, userId: string): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ member: number }>(
    sql`SELECT ${activeMember(userId)} AS member`
  );
  return row.member === 1;
};

/**
 * Sets `person`'s own name, audited as theirs once, when it changed: the
 * event names who, never the name. Who may ask is the caller's to check
 * (`SessionRpc.setName`: a member, for themselves); the write holds only
 * while they still are one, so someone removed, suspended or made a guest
 * since their session was read changes nothing (`auth.unauthenticated`,
 * as their next reading answers).
 */
export const setOwnName = async (
  env: Env,
  person: Identity,
  name: unknown
): Promise<void> => {
  const parsed = personNameSchema.safeParse(name);
  if (!parsed.success) {
    throw memberErrors.create("member.name_invalid");
  }
  const db = drizzle(env.DB);
  const [changed] = await auditedBatch(env, db, [
    db
      .update(users)
      .set({ name: parsed.data, updatedAt: new Date() })
      .where(
        and(
          eq(users.id, person.userId),
          ne(users.name, parsed.data),
          activeMember(person.userId)
        )
      )
      .returning({ id: users.id }),
    outboxedIfChanged(db, {
      actor: actorOf(person),
      action: "member.name.updated",
      target: { type: "user", id: person.userId },
    }),
  ]);
  // Nothing changed: it already was their name, or they stopped being a
  // member since their session was read.
  if (changed.length === 0 && !(await stillMember(env, person.userId))) {
    throw authErrors.create("auth.unauthenticated");
  }
};
