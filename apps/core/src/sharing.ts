import { actorOf } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { canBuild, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ShareCandidates } from "@grasp-os/shared/subject-members";
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { activeMember, notRemoved, organizationId } from "./auth/auth.ts";
import { memberRole } from "./auth/identity.ts";
import { members, projects, teams, users } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { buildsProjectsOf, requireProjectRole } from "./project-access.ts";
import type { Person } from "./project-access.ts";
import { viaProjectSql } from "./project-sql.ts";

// Sharing a resource with people and teams of the organization, the same
// for every kind that is shared (Apps, app-members.ts; workflows,
// workflow-resources.ts): who a member row is, who is still a member, whom a
// resource can be shared with, that Grasp staff never share, and what the
// audit log records. Each kind keeps its own table of members, with a
// `member_type` and a `member_id` column. Apps and workflows may also be
// shared with everyone in a project (`project`, projects.ts): such a row
// is `by`'s while they are in the project, read in the statement
// (project-access.ts).

/** A member table's columns that say whom a row shares with. */
export interface MemberColumns {
  memberType: SQLiteColumn;
  memberId: SQLiteColumn;
}

/** Whom a resource is shared with: a person, a team or a project. */
export interface MemberRef {
  type: "person" | "team" | "project";
  id: string;
}

/** Whom a resource that is never shared with a project is shared with. */
export interface PersonOrTeam extends MemberRef {
  type: "person" | "team";
}

/**
 * The member rows that are `by`'s: their own, one of their teams', or one
 * of a project they are in.
 */
export const rowsOf = (
  columns: MemberColumns,
  by: Pick<Identity, "userId" | "teams">
): SQL =>
  or(
    and(eq(columns.memberType, "person"), eq(columns.memberId, by.userId)),
    viaProjectSql(columns.memberType, columns.memberId, by.userId),
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
 * now, a team or a project that still exists. The rest reach nothing.
 */
export const stillMembers = (columns: MemberColumns): SQL =>
  or(
    and(eq(columns.memberType, "person"), activeMember(columns.memberId)),
    and(
      eq(columns.memberType, "project"),
      sql`EXISTS (SELECT 1 FROM ${projects} WHERE ${projects.id} = ${columns.memberId})`
    ),
    and(
      eq(columns.memberType, "team"),
      sql`EXISTS (SELECT 1 FROM ${teams} WHERE ${teams.id} = ${columns.memberId} AND ${teams.organizationId} = ${organizationId})`
    )
  ) ?? sql`0`;

/** A role in a shared resource: using it, or building it too. */
export type SharedRole = "user" | "builder";

/** The highest role `by`'s organization role lets them have in a resource. */
export const ceilingOf = (by: Pick<Identity, "role">): SharedRole =>
  canBuild(by.role) ? "builder" : "user";

/**
 * `by`'s role from the member rows that are theirs (their own, their
 * teams'), given by `roles`: the highest of them, capped by their ceiling.
 * Undefined when there are none.
 */
export const roleFromMembers = (
  by: Pick<Identity, "role">,
  roles: readonly SharedRole[]
): SharedRole | undefined => {
  if (roles.length === 0) {
    return undefined;
  }
  return roles.includes("builder") ? ceilingOf(by) : "user";
};

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
 * now, one of its teams, or a project `by` builds; never with the owner; and, where the share
 * needs it, only with someone whose role in the organization builds. A
 * team can be shared with whatever its people's roles: each acts only as
 * their own role allows.
 */
export const requireSharable = async (
  env: Pick<Env, "DB">,
  member: MemberRef,
  rules: SharingRules,
  /**
   * Who shares: needed to share with a project, which only its builders
   * share with, so whoever decides whom it reaches also decides who is in
   * it. Kinds that are never shared with a project leave it out.
   */
  by?: Person
): Promise<void> => {
  if (member.type === "project") {
    if (by === undefined) {
      throw rules.invalid("type: It can't be shared with a project.");
    }
    // Checked again in the share's own write (`projectStillBuiltSql`).
    await requireProjectRole(env, by, member.id, "builder");
    return;
  }
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
  by: Pick<Identity, "userId" | "staff"> & { actor?: AuditActor },
  action: string,
  target: { type: string; id: string },
  member: MemberRef & { role: string }
): AuditEntry => ({
  // Whoever acts: an agent acting for the person when one does (an
  // `Acting`'s actor), the person themselves otherwise.
  actor: by.actor ?? actorOf(by),
  action,
  target,
  detail: { memberType: member.type, member: member.id, role: member.role },
});

/**
 * The organization's people, members now, and its teams, each by name and
 * ID alone, by name: whom an App or a workflow is shared with, and whom a
 * workflow's start names where its input takes a person
 * (workflow-start-form.ts).
 */
export const organizationPeopleAndTeams = async (
  env: Env
): Promise<Pick<ShareCandidates, "people" | "teams">> => {
  const db = drizzle(env.DB);
  const [people, organizationTeams] = await Promise.all([
    db
      .select({ id: users.id, name: users.name })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(
        and(
          eq(members.organizationId, organizationId),
          notRemoved(members.userId)
        )
      )
      .orderBy(asc(users.name), asc(users.id)),
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.organizationId, organizationId))
      .orderBy(asc(teams.name), asc(teams.id)),
  ]);
  return { people, teams: organizationTeams };
};

/**
 * Whom `by` may share an App or a workflow with (its Share dialog, for
 * whoever may share it, which each kind checks first): the organization's
 * people and teams (`organizationPeopleAndTeams`) and the projects `by`
 * builds, as a project's name is its members' alone. A builder needn't be
 * an admin, so this, not the organization's member list, is what they pick
 * from; it says no more of a person than a share names: no address, no
 * organization role, nor a team's members. A share core then refuses (a
 * builder's role for someone who doesn't build, the owner) is offered
 * all the same, and refused by the share, which decides.
 */
export const shareCandidates = async (
  env: Env,
  by: Identity
): Promise<ShareCandidates> => {
  const [{ people, teams: organizationTeams }, builtProjects] =
    await Promise.all([
      organizationPeopleAndTeams(env),
      buildsProjectsOf(env, by),
    ]);
  return { people, teams: organizationTeams, projects: builtProjects };
};
