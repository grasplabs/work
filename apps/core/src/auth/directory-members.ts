import { createAuditEvent } from "@grasp-os/shared/audit";
import type { DirectoryPerson } from "@grasp-os/shared/directory";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch } from "../audit-outbox.ts";
import {
  accounts,
  auditOutbox,
  members,
  organizations,
  users,
} from "../db/core/schema.ts";
import { uuidSql } from "../db/d1.ts";
import { entraSubject, isErasedSubject } from "../erased-people.ts";
import { mayAct, organizationId } from "./auth.ts";
import { directoryProviderId, signInConfig } from "./config.ts";

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
//   admins, and take up no invitation (invitations are by email) until
//   their first sign-in brings their address.
//
// The daily read makes its people members by the same statements
// (directory-people.ts), each listed person it places in a team.

/**
 * The domain of the address a member made from the directory has until
 * they sign in (after their lower-case ID): none, no mail reaches it.
 */
const placeholderDomain = "@directory.invalid";

/** Whether `email` is such a placeholder: an address no mail reaches. */
export const isPlaceholderEmail = (email: string): boolean =>
  email.endsWith(placeholderDomain);

/** `email`, or null for a placeholder (`isPlaceholderEmail`). */
export const realEmail = (email: string): string | null =>
  isPlaceholderEmail(email) ? null : email;

/**
 * One person the directory makes a member: the provider's ID of them, the
 * new user's ID, their name as the directory gives it.
 */
export type Made = [string, string, string];

/** That the user a `Made` entry (`value`) names exists now: made by this batch, as its ID is new. */
const madeNow = sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = value ->> 1)`;

/**
 * The statements that make each person of `made` (a JSON array of `Made`,
 * each read as `value`) a member, where `makeable` holds of them as the
 * first runs: a user with their name and a placeholder address, an
 * account of the directory's own (`directoryProviderId`) carrying the
 * provider's ID as `oid` and `tenant` as the tenant it was read in, and a
 * membership as `user`. Each holds only for a user the first made, by the
 * new ID the entry gives it.
 */
export const madeMemberStatements = (
  db: DrizzleD1Database,
  made: string,
  tenant: string | null,
  makeable: SQL,
  now: number
) =>
  [
    db
      .insert(users)
      .select(
        sql`SELECT value ->> 1, value ->> 2, lower(value ->> 0) || ${placeholderDomain}, 0, NULL, ${now}, ${now}
          FROM json_each(${made}) WHERE ${makeable}`
      )
      .onConflictDoNothing(),
    db
      .insert(accounts)
      .select(
        sql`SELECT ${uuidSql}, value ->> 0, ${directoryProviderId}, value ->> 1,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, value ->> 0, NULL, NULL, ${tenant},
          ${now}, ${now}
          FROM json_each(${made}) WHERE ${madeNow}`
      )
      .onConflictDoNothing(),
    db
      .insert(members)
      .select(
        sql`SELECT ${uuidSql}, ${organizationId}, value ->> 1, 'user', ${now}, NULL, NULL, NULL
          FROM json_each(${made}) WHERE ${madeNow} AND ${mayAct(sql`value ->> 1`)}`
      )
      .onConflictDoNothing(),
  ] as const;

/**
 * The statement that records each person of `made` the batch made a
 * member and kept (`member.joined_from_directory`, the system's): run
 * after whatever may have taken a made member back in the same batch.
 */
export const madeMembersRecorded = (
  db: DrizzleD1Database,
  made: string,
  now: number
) => {
  const entry = JSON.stringify(
    createAuditEvent(
      {
        actor: { type: "system" },
        action: "member.joined_from_directory",
        target: { type: "user", id: "user" },
      },
      "core"
    )
  );
  return db.insert(auditOutbox).select(
    sql`SELECT id, json_set(${entry}, '$.id', id, '$.target.id', user_id), ${now}
      FROM (
        SELECT ${uuidSql} AS id, value ->> 1 AS user_id FROM json_each(${made})
        WHERE ${madeNow}
      )`
  );
};

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
  // or none; nothing at all when another message made them first. The
  // tenant is the deployment's own, the only one its directory is read in
  // (onboarding/directory.ts `connectionOf`), so the daily read ties them.
  const entry: Made = [oid, userId, person.name];
  const entries = JSON.stringify([entry]);
  await auditedBatch(env, db, [
    ...madeMemberStatements(
      db,
      entries,
      signInConfig(env)?.entra?.tenantId?.toLowerCase() ?? null,
      sql`NOT ${madeAlready}`,
      now.getTime()
    ),
    madeMembersRecorded(db, entries, now.getTime()),
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
        mayAct(made.userId)
      )
    );
  return member === undefined ? null : made.userId;
};
