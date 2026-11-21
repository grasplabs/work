import { actorOf } from "@grasp-os/shared/audit";
import { memberErrors, personNameSchema } from "@grasp-os/shared/members";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
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

/**
 * Sets `person`'s own name, audited as theirs once, when it changed: the
 * event names who, never the name. Who may ask is the caller's to check
 * (`SessionRpc.setName`: a member, for themselves).
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
  await auditedBatch(env, db, [
    db
      .update(users)
      .set({ name: parsed.data, updatedAt: new Date() })
      .where(and(eq(users.id, person.userId), ne(users.name, parsed.data))),
    outboxedIfChanged(db, {
      actor: actorOf(person),
      action: "member.name.updated",
      target: { type: "user", id: person.userId },
    }),
  ]);
};
