import { createAuditEvent } from "@grasp-os/shared/audit";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";

import { mayAct, organizationId } from "./auth/membership-sql.ts";
import {
  auditOutbox,
  directoryPeople,
  members,
  sessions,
} from "./db/core/schema.ts";
import { uuidSql } from "./db/d1.ts";
import type { DirectoryKind } from "./directory-ties.ts";

// A member suspended once a complete read of the directory lists their
// account as turned off, and lifted once a later one lists it on again
// (GRA-2056, slice 3a; the threat model is on the issue). It takes access
// away, so every rule fails towards doing nothing:
//
// - Suspended on what: only an account a complete read listed as turned
//   off (`accountEnabled` false, kept by the read as `enabled = 0`), tied
//   to the member by the account's id. An account missing from the read
//   suspends nobody here. A read that failed, or lost its claim, writes
//   nothing (`holds`).
// - What it takes away: whatever may act or be read as (`mayAct`), and
//   their sessions, in the same batch: their next request fails. What is
//   theirs (teams, pins, the read's marks, connections and their tokens,
//   content) stays exactly as it is, for when it is lifted.
// - The company without an admin: an admin is suspended only while another
//   admin who may act, and whom this read isn't suspending, remains: decided
//   in the statement from what holds as it runs, so the order of rows never
//   matters. When every admin would go, none does, and that is recorded.
// - An admin's own decision undone: the read lifts only the suspensions it
//   made (`suspended_by = 'directory'`), and never touches a removal. Nor
//   does it suspend a member an admin keeps active (`kept_active_at`,
//   members.ts `liftSuspension`) until an admin lets it decide again.

/** What a suspension the daily read makes is marked as made by. */
const byDirectory = "directory";

/** `members` again, for another admin than the row being written. */
const otherAdmin = alias(members, "other_admin");

/** That the read ties `user` to an account of `kind` turned on (`enabled`) or off. */
const tiedTo = (kind: DirectoryKind, user: SQL, enabled: boolean): SQL =>
  sql`EXISTS (
    SELECT 1 FROM ${directoryPeople}
    WHERE ${directoryPeople.provider} = ${kind.provider}
      AND ${directoryPeople.userId} = ${user}
      AND ${directoryPeople.enabled} = ${enabled ? 1 : 0}
  )`;

/** An audit entry for each row, its ids filled in by SQL. */
const systemEntry = (action: string): string =>
  JSON.stringify(
    createAuditEvent(
      {
        actor: { type: "system" },
        action,
        target: { type: "member", id: "member" },
        detail: { userId: "user", via: "directory" },
      },
      "core"
    )
  );

/**
 * The statements that suspend and lift `kind`'s tied members as the read's
 * rows say, each only while `holds` does (the read's claim), stamped `now`.
 * In order: each lifting recorded, then made; each suspension recorded,
 * then made, and the suspended members' sessions ended; each suspension the
 * last-admin rule withheld recorded. Run after the tie and before the
 * placement. The placement leaves a suspended member's teams as they are:
 * the read keeps a turned-off account with no department, which fills no
 * team, so they join none and leave none (a leave needs the team their
 * department fills); a lifting runs first, so who is listed on again is
 * placed in the same batch.
 */
export const suspensionStatements = (
  db: DrizzleD1Database,
  kind: DirectoryKind,
  holds: SQL,
  now: Date
): BatchItem<"sqlite">[] => {
  const user = sql`${members.userId}`;
  const ours = and(eq(members.organizationId, organizationId), holds);
  // Listed turned on: one account each, since accounts are never linked.
  // Missing from the read lifts nobody.
  const liftable = sql`${members.suspendedBy} = ${byDirectory}
    AND ${members.suspendedAt} IS NOT NULL
    AND ${tiedTo(kind, user, true)}`;
  // Another admin who may act, and whom this read isn't suspending: one
  // kept active stays whatever the directory says.
  const anotherAdminStays = sql`EXISTS (
    SELECT 1 FROM ${members} AS ${otherAdmin}
    WHERE ${otherAdmin.organizationId} = ${organizationId}
      AND ${otherAdmin.userId} <> ${members.userId}
      AND ${otherAdmin.role} = 'admin'
      AND ${mayAct(sql`${otherAdmin.userId}`)}
      AND (${otherAdmin.keptActiveAt} IS NOT NULL
        OR NOT ${tiedTo(kind, sql`${otherAdmin.userId}`, false)})
  )`;
  // A removal deletes the membership, so there is no removed row to skip;
  // a member an admin keeps active is neither suspended nor withheld.
  const disabled = sql`${members.suspendedAt} IS NULL
    AND ${members.keptActiveAt} IS NULL
    AND ${tiedTo(kind, user, false)}`;
  const suspendable = sql`${disabled}
    AND (${members.role} <> 'admin' OR ${anotherAdminStays})`;
  const withheld = sql`${disabled}
    AND ${members.role} = 'admin' AND NOT ${anotherAdminStays}`;
  const recorded = (action: string, which: SQL) =>
    db.insert(auditOutbox).select(
      sql`SELECT id, json_set(${systemEntry(action)}, '$.id', id, '$.target.id', member_id, '$.detail.userId', user_id), ${now.getTime()}
        FROM (
          SELECT ${uuidSql} AS id, ${members.id} AS member_id, ${members.userId} AS user_id
          FROM ${members} WHERE ${and(ours, which)}
        )`
    );
  return [
    recorded("member.unsuspended", liftable),
    db
      .update(members)
      .set({ suspendedAt: null, suspendedBy: null })
      .where(and(ours, liftable)),
    recorded("member.suspended", suspendable),
    db
      .update(members)
      .set({ suspendedAt: now, suspendedBy: byDirectory })
      .where(and(ours, suspendable)),
    // Signed out now: their next request finds no session.
    db.delete(sessions).where(
      and(
        inArray(
          sessions.userId,
          db
            .select({ userId: members.userId })
            .from(members)
            .where(
              and(
                eq(members.organizationId, organizationId),
                isNotNull(members.suspendedAt)
              )
            )
        ),
        holds
      )
    ),
    recorded("member.suspension_withheld", withheld),
  ];
};
