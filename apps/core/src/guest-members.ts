import { actorOf } from "@grasp-os/shared/audit";
import type { CodedError } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import { memberErrors } from "@grasp-os/shared/members";
import type { Guest } from "@grasp-os/shared/members";
import { canBuild, guestRole, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import {
  activeMember,
  notRemoved,
  openInvitationAt,
  organizationId,
} from "./auth/auth.ts";
import { signInConfig } from "./auth/config.ts";
import { guestNow } from "./auth/membership-sql.ts";
import {
  invitations,
  memberRemovals,
  members,
  organizations,
  personErasures,
  users,
} from "./db/core/schema.ts";
import { emailHashOf, erasedAddress } from "./erased-people.ts";

// Guests (roles.ts `guestRole`, GRA-2235): someone outside the company an
// admin or a builder invites by address, who signs in with a code mailed
// to them (auth/guest-codes.ts) and reaches nothing of the company
// (identity.ts, membership-sql.ts `mayAct`). Inviting makes their Better
// Auth user and a `guest` membership at once, as the directory makes a
// member (auth/directory-members.ts): no invitation row, and no user made
// at sign-in. What stops each way it could be misused (the threat model
// is on the issue):
//
// - Taking a colleague's address, to lock them out of their own sign-in
//   (account linking is off, so their SSO would find someone else's user)
//   or to sign in as them: refused for any address a user holds already
//   (a member, suspended, removed, someone signed in for an interview,
//   Grasp staff who signed in), an erased person's, one an open member
//   invitation names, a configured admin's, and any at the company's own
//   sign-in domains or Grasp staff's.
// - Someone who may not build inviting: admins and builders who may act
//   alone, checked in the statement that makes the guest.
// - Unseen: inviting is audited as the inviter, by the guest's user ID.
//
// A guest stays a guest: no role change makes one a member (members.ts).
// An admin removes a guest as any member, which ends their sessions.

const guestEmailSchema = z.email().max(254).toLowerCase();

/** That someone holds `email` as their user's address, as SQL. */
const isUserEmail = (email: string): SQL => sql`EXISTS (
  SELECT 1 FROM ${users} WHERE lower(${users.email}) = ${email}
)`;

/** That an admin removed whoever held `email`, as SQL. */
const isRemovedEmail = (email: string): SQL => sql`EXISTS (
  SELECT 1 FROM ${memberRemovals}
    JOIN ${users} ON ${users.id} = ${memberRemovals.userId}
  WHERE ${memberRemovals.organizationId} = ${organizationId}
    AND lower(${users.email}) = ${email}
)`;

/** Logs a refusal, IDs only, and hands back the error to throw. */
const refusal = (by: Identity, error: CodedError): CodedError => {
  log.warn("guest.refused", { actor: by.userId, reason: error.code });
  return error;
};

/** Whether `email` is the company's or Grasp's own, by its config. */
const companyOrStaffAddress = (env: Env, email: string): boolean => {
  const config = signInConfig(env);
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return (
    config === undefined ||
    config.domains.includes(domain) ||
    (config.staff?.domains ?? []).includes(domain) ||
    config.admins.includes(email)
  );
};

/** The guest who holds `email` now, if one does. */
const guestHolding = async (
  env: Env,
  email: string
): Promise<string | undefined> => {
  const [guest] = await drizzle(env.DB)
    .select({ userId: users.id })
    .from(users)
    .where(and(eq(users.email, email), guestNow(users.id)));
  return guest?.userId;
};

/** Why inviting `email` as a guest made nobody, read after the fact. */
const inviteRefusal = async (
  env: Env,
  email: string,
  erased: SQL
): Promise<CodedError> => {
  const row = await drizzle(env.DB).get<{
    user: number;
    removed: number;
    erased: number;
  }>(
    sql`SELECT ${isUserEmail(email)} AS user, ${isRemovedEmail(email)} AS removed, ${erased} AS erased`
  );
  if (row.removed === 1 || row.erased === 1) {
    return memberErrors.create("member.invite_removed");
  }
  return row.user === 1
    ? memberErrors.create("member.guest_refused")
    : roleErrors.create("role.forbidden");
};

/**
 * Invites `email` as a guest: makes their user and their `guest`
 * membership, audited, in one batch, while nobody holds the address and
 * the inviter still may build. Answers the guest's user ID; for an address
 * that is a guest's already, that guest's, with nothing changed.
 */
export const inviteGuest = async (
  env: Env,
  by: Identity,
  email: unknown
): Promise<{ userId: string }> => {
  if (by.staff || !canBuild(by.role)) {
    throw refusal(by, roleErrors.create("role.forbidden"));
  }
  const address = guestEmailSchema.safeParse(
    typeof email === "string" ? email.trim() : email
  );
  if (!address.success) {
    throw refusal(by, memberErrors.create("member.guest_email"));
  }
  if (companyOrStaffAddress(env, address.data)) {
    throw refusal(by, memberErrors.create("member.guest_refused"));
  }
  const already = await guestHolding(env, address.data);
  if (already !== undefined) {
    return { userId: already };
  }
  const db = drizzle(env.DB);
  // Someone erased: their address is gone from `users`, kept only as a
  // keyed hash (person-erasure.ts). Checked by the insert itself, as the
  // member invitation does (members.ts).
  const erased = sql`EXISTS (
    SELECT 1 FROM ${personErasures}
    WHERE ${erasedAddress(await emailHashOf(env, address.data))}
  )`;
  const now = Date.now();
  const userId = crypto.randomUUID();
  await db
    .insert(organizations)
    .values({
      id: organizationId,
      name: "Organization",
      slug: organizationId,
      createdAt: new Date(now),
    })
    .onConflictDoNothing();
  const madeNow = sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${userId})`;
  await auditedBatch(env, db, [
    // Their address unproven until a code they were mailed signs them in.
    // No name: a guest is shown by their address while they have one
    // (`email`), and a name is kept after an erasure, so it never holds
    // the address.
    db
      .insert(users)
      .select(
        sql`SELECT ${userId}, '', ${address.data}, 0, NULL, ${now}, ${now}
          WHERE NOT ${isUserEmail(address.data)}
            AND NOT ${erased}
            AND NOT EXISTS (
              SELECT 1 FROM ${invitations}
              WHERE ${invitations.email} = ${address.data}
                AND ${openInvitationAt(now)}
            )
            AND ${activeMember(by.userId, ["admin", "builder"])}`
      )
      .onConflictDoNothing(),
    db
      .insert(members)
      .select(
        sql`SELECT ${crypto.randomUUID()}, ${organizationId}, ${userId}, ${guestRole}, ${now}, NULL, NULL, NULL
          WHERE ${madeNow} AND ${notRemoved(userId)}`
      )
      .onConflictDoNothing(),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "member.guest_invited",
      target: { type: "user", id: userId },
    }),
  ]);
  const made = await guestHolding(env, address.data);
  if (made !== undefined) {
    return { userId: made };
  }
  throw refusal(by, await inviteRefusal(env, address.data, erased));
};

/** The organization's guests, by address. For admins. */
export const guestsOf = async (env: Env): Promise<Guest[]> => {
  const rows = await drizzle(env.DB)
    .select({
      userId: members.userId,
      email: users.email,
      invitedAt: members.createdAt,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, organizationId),
        eq(members.role, guestRole),
        notRemoved(members.userId)
      )
    )
    .orderBy(asc(users.email));
  return rows.map(({ invitedAt, ...guest }) => ({
    ...guest,
    invitedAt: invitedAt.toISOString(),
  }));
};
