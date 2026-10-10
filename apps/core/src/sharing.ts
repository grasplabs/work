import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { canBuild, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { activeMember, organizationId } from "./auth/auth.ts";
import { memberRole } from "./auth/identity.ts";
import { teams } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// Sharing a resource with people and teams of the organization, the same
// for every kind that is shared (Apps, app-members.ts; business stores,
// data-stores.ts): who a member row is, who is still a member, whom a
// resource can be shared with, that Grasp staff never share, and what the
// audit log records. Each kind keeps its own table of members, with a
// `member_type` and a `member_id` column.

/** A member table's columns that say whom a row shares with. */
export interface MemberColumns {
  memberType: SQLiteColumn;
  memberId: SQLiteColumn;
}

/** Whom a resource is shared with: a person or a team. */
export interface MemberRef {
  type: "person" | "team";
  id: string;
}

/** The member rows that are `by`'s: their own, or one of their teams'. */
export const rowsOf = (
  columns: MemberColumns,
  by: Pick<Identity, "userId" | "teams">
): SQL =>
  or(
    and(eq(columns.memberType, "person"), eq(columns.memberId, by.userId)),
    by.teams.length === 0
      ? undefined
      : and(
          eq(columns.memberType, "team"),
          inList(
            columns.memberId,
            by.teams.map(({ id }) => id)
          )
        )
  ) ?? sql`0`;

/**
 * The member rows that still reach someone: a person in the organization
 * now, or a team that still exists. The rest reach nothing.
 */
export const stillMembers = (columns: MemberColumns): SQL =>
  or(
    and(eq(columns.memberType, "person"), activeMember(columns.memberId)),
    and(
      eq(columns.memberType, "team"),
      sql`EXISTS (SELECT 1 FROM ${teams} WHERE ${teams.id} = ${columns.memberId} AND ${teams.organizationId} = ${organizationId})`
    )
  ) ?? sql`0`;

/** Refuses Grasp staff: they never decide whom a client's resource reaches. */
export const requireNotStaff = (by: Pick<Identity, "staff">): void => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
};

/** What `requireSharable` refuses with, worded for the kind of resource. */
export interface SharingRules {
  /** Its owner, who never needs sharing with. */
  owner: string;
  /** Whether the member must be in a role that builds. */
  builds: boolean;
  /** The refusal's error, with its issue. */
  invalid: (issue: string) => Error;
  /** The issue for sharing with the owner. */
  ownerIssue: string;
  /** The issue for sharing with someone whose role doesn't build. */
  buildsIssue: string;
}

/**
 * Refuses sharing with `member`: only with someone in the organization
 * now, or one of its teams; never with the owner; and, where the share
 * needs it, only with someone whose role in the organization builds. A
 * team can be shared with whatever its people's roles: each acts only as
 * their own role allows.
 */
export const requireSharable = async (
  env: Pick<Env, "DB">,
  member: MemberRef,
  rules: SharingRules
): Promise<void> => {
  if (member.type === "team") {
    const team = await drizzle(env.DB)
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(eq(teams.id, member.id), eq(teams.organizationId, organizationId))
      )
      .get();
    if (!team) {
      throw rules.invalid("id: There's no such team.");
    }
    return;
  }
  if (member.id === rules.owner) {
    throw rules.invalid(rules.ownerIssue);
  }
  const role = await memberRole(env.DB, member.id);
  if (role === undefined) {
    throw rules.invalid("id: There's no such member of the organization.");
  }
  if (rules.builds && !canBuild(role)) {
    throw rules.invalid(rules.buildsIssue);
  }
};

/**
 * The audit entry of a change by `by` to whom `target` is shared with.
 * The role is the one they have now, or had until unshared.
 */
export const memberEntry = (
  by: Pick<Identity, "userId" | "staff">,
  action: string,
  target: { type: string; id: string },
  member: MemberRef & { role: string }
): AuditEntry => ({
  actor: actorOf(by),
  action,
  target,
  detail: { memberType: member.type, member: member.id, role: member.role },
});
