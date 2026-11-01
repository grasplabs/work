import type { DirectoryPerson } from "@grasp-os/shared/directory";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "../audit-outbox.ts";
import { accounts, members, organizations, users } from "../db/core/schema.ts";
import { entraSubject, isErasedSubject } from "../erased-people.ts";
import { notRemoved, organizationId } from "./auth.ts";
import { directoryProviderId } from "./config.ts";

// Members made from the organization's directory (GRA-748), so Stephen
// knows the client's people before anyone signs in (D7). The ways it can
// fail, and what stops each (threat model R15):
//
// - Someone taken for another by name or email: a member is made only
//   from the Entra object id their chat platform verified (Teams'
//   `from.aadObjectId`), looked up in the read-only directory connection
//   of the deployment's own tenant (onboarding/directory.ts). Nothing is
//   ever matched by email: the member's address is a placeholder no mail
//   reaches and no sign-in matches, until their own sign-in brings theirs.
// - A guest, a disabled account, or someone the directory no longer holds:
//   connect answers nobody for them (connect's directory.ts), and a member
//   made from the directory is checked against it again before they are
//   answered (channels/door.ts).
// - Someone an admin removed comes back from the directory: a removal is
//   kept after the membership goes, and every insert here checks it.
// - Someone an admin removed and then erased comes back from the
//   directory: their accounts went, so the directory would make them a
//   new member; the keyed hash of their object id kept by the erasure
//   (erased-people.ts) is checked first, and makes nobody.
// - Two people for one: the directory's account is unique per object id
//   (`accounts_provider_account_idx`), so two first messages make one
//   member. Their first Microsoft sign-in, whose verified ID token names
//   the same object id, is folded into that member (`adoptDirectoryMember`
//   in auth.ts) rather than making a second.
// - An admin made from the directory: members made here are users, never
//   admins, and take up no invitation (invitations are by email).

/** The address a member made from the directory has until they sign in: none. */
const placeholderEmail = (oid: string): string =>
  `${oid.toLowerCase()}@directory.invalid`;

/**
 * Makes the person the directory holds under `oid` a member, unless the
 * directory made them already or an admin removed them. Answers the
 * member's user id, or null for someone removed or erased.
 */
export const memberFromDirectory = async (
  env: Env,
  oid: string,
  person: DirectoryPerson,
  now = new Date()
): Promise<string | null> => {
  if (await isErasedSubject(env, [entraSubject(oid)])) {
    return null;
  }
  const db = drizzle(env.DB);
  const userId = crypto.randomUUID();
  const madeAlready = sql`EXISTS (
    SELECT 1 FROM ${accounts}
    WHERE ${accounts.providerId} = ${directoryProviderId}
      AND ${accounts.accountId} = ${oid}
  )`;
  await db
    .insert(organizations)
    .values({
      id: organizationId,
      name: "Organization",
      slug: organizationId,
      createdAt: now,
    })
    .onConflictDoNothing();
  // One batch: the user, their account and membership, and its event, all
  // or none; nothing at all when another message made them first.
  await auditedBatch(env, db, [
    db
      .insert(users)
      .select(
        sql`SELECT ${userId}, ${person.name}, ${placeholderEmail(oid)}, 0, NULL,
          ${now.getTime()}, ${now.getTime()}
          WHERE NOT ${madeAlready}`
      )
      .onConflictDoNothing(),
    db
      .insert(accounts)
      .select(
        sql`SELECT ${crypto.randomUUID()}, ${oid}, ${directoryProviderId}, ${userId},
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${oid},
          ${now.getTime()}, ${now.getTime()}
          WHERE EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${userId})`
      )
      .onConflictDoNothing(),
    db
      .insert(members)
      .select(
        sql`SELECT ${crypto.randomUUID()}, ${organizationId}, ${userId}, 'user',
          ${now.getTime()}
          WHERE EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${userId})
            AND ${notRemoved(userId)}`
      )
      .onConflictDoNothing(),
    outboxedIfChanged(db, {
      actor: { type: "system" },
      action: "member.joined_from_directory",
      target: { type: "user", id: userId },
    }),
  ]);
  const [made] = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        eq(accounts.providerId, directoryProviderId),
        eq(accounts.accountId, oid)
      )
    );
  if (made === undefined) {
    return null;
  }
  const [member] = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.organizationId, organizationId),
        eq(members.userId, made.userId),
        notRemoved(made.userId)
      )
    );
  return member === undefined ? null : made.userId;
};
