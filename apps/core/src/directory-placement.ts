import type {
  DirectoryMover,
  DirectoryPlacement,
  PlacedMember,
  TeamName,
  TeamPin,
  UnplacedMember,
} from "@grasp-os/shared/members";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { mayAct, organizationId } from "./auth/membership-sql.ts";
import {
  directoryDepartments,
  directoryMemberships,
  directoryPeople,
  members,
  teamMembers,
  teamPins,
  teams,
  users,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { directoryKinds } from "./directory-ties.ts";

// What the directory leaves for an admin to place, and what admins placed
// by hand (GRA-2056, slice 4; GRA-2110, GRA-2135): read for Settings ›
// Members › Teams, whose admin places people by hand through Better
// Auth's team routes, which pin the pair (auth.ts), and releases a pin
// with `releaseTeamPin` (members.ts). It writes nothing. The caller checks
// the role. All of it is read in one batch, one snapshot, from the tables
// the daily read writes (directory-people.ts, directory-teams.ts):
//
// - Not in a team: a member who may act (a suspended one can't, and the
//   read places nobody turned off) and is in no team at all.
// - Team doesn't match the directory: a membership the read made (only
//   those it ever takes away, `directory_memberships`) whose team their
//   department no longer fills. The read moves someone only into the team
//   their department fills, never into none, so they stay until an admin
//   acts. Not a pair an admin kept in by hand: that is the admin's choice.
// - Pins: those on a member tied to the directory, whom the read places;
//   on anyone else a pin changes nothing the read does.

/** A member tied to the directory: their department there, and the team it fills. */
interface Tie {
  department: string;
  departmentTeam: TeamName | null;
}

const byName = (one: PlacedMember, other: PlacedMember): number =>
  one.name.localeCompare(other.name) || one.userId.localeCompare(other.userId);

/** Who the directory leaves for an admin to place, and the hand pins. */
export const directoryPlacementOf = async (
  env: Pick<Env, "DB">
): Promise<DirectoryPlacement> => {
  const db = drizzle(env.DB);
  const providers = directoryKinds.map(({ provider }) => provider);
  const [acting, tied, memberships, pins] = await db.batch([
    db
      .select({ userId: users.id, name: users.name, email: users.email })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(
        and(eq(members.organizationId, organizationId), mayAct(members.userId))
      ),
    // One account each (accounts are never linked); ordered all the same.
    db
      .select({
        userId: sql<string>`${directoryPeople.userId}`,
        department: directoryPeople.department,
        teamId: teams.id,
        teamName: teams.name,
      })
      .from(directoryPeople)
      .leftJoin(
        directoryDepartments,
        and(
          eq(directoryDepartments.provider, directoryPeople.provider),
          eq(directoryDepartments.department, directoryPeople.department)
        )
      )
      .leftJoin(teams, eq(teams.id, directoryDepartments.teamId))
      .where(
        and(
          isNotNull(directoryPeople.userId),
          inList(directoryPeople.provider, providers)
        )
      )
      .orderBy(
        asc(directoryPeople.provider),
        asc(directoryPeople.tenant),
        asc(directoryPeople.accountId)
      ),
    db
      .select({
        userId: teamMembers.userId,
        teamId: teams.id,
        teamName: teams.name,
        madeByRead: sql<number>`${teamMembers.membershipKey} IN (
          SELECT ${directoryMemberships.membershipKey} FROM ${directoryMemberships}
        )`,
      })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(eq(teams.organizationId, organizationId)),
    db
      // D1 answers a batch's rows by column name: the team's name is
      // given one of its own, apart from the person's.
      .select({
        userId: teamPins.userId,
        name: users.name,
        email: users.email,
        teamId: teamPins.teamId,
        teamName: sql<string>`${teams.name}`.as("team_name"),
        kept: teamPins.kept,
        pinnedAt: teamPins.pinnedAt,
      })
      .from(teamPins)
      .innerJoin(users, eq(users.id, teamPins.userId))
      .innerJoin(teams, eq(teams.id, teamPins.teamId))
      // A removal and an erasure delete the person's pins (members.ts,
      // person-erasure.ts), and a pin is written only for an active member.
      .where(eq(teams.organizationId, organizationId))
      .orderBy(asc(teams.name), asc(users.name), asc(users.id)),
  ]);
  const ties = new Map<string, Tie>();
  for (const { userId, department, teamId, teamName } of tied) {
    if (!ties.has(userId)) {
      ties.set(userId, {
        department,
        departmentTeam:
          teamId === null || teamName === null
            ? null
            : { id: teamId, name: teamName },
      });
    }
  }
  const keptIn = new Set(
    pins
      .filter(({ kept }) => kept)
      .map(({ userId, teamId }) => `${userId} ${teamId}`)
  );
  const inATeam = new Set(memberships.map(({ userId }) => userId));
  const unplaced: UnplacedMember[] = acting
    .filter(({ userId }) => !inATeam.has(userId))
    .map((member) => {
      const tie = ties.get(member.userId);
      return {
        ...member,
        department: tie?.department ?? null,
        departmentTeam: tie?.departmentTeam ?? null,
      };
    })
    .toSorted(byName);
  const actingById = new Map(acting.map((member) => [member.userId, member]));
  const movers: DirectoryMover[] = memberships
    .flatMap(({ userId, teamId, teamName, madeByRead }) => {
      const member = actingById.get(userId);
      const tie = ties.get(userId);
      const mismatched =
        madeByRead === 1 &&
        tie !== undefined &&
        tie.departmentTeam?.id !== teamId &&
        !keptIn.has(`${userId} ${teamId}`);
      return member === undefined || tie === undefined || !mismatched
        ? []
        : [{ ...member, team: { id: teamId, name: teamName }, ...tie }];
    })
    .toSorted(byName);
  const shownPins: TeamPin[] = pins
    .filter(({ userId }) => ties.has(userId))
    .map(({ teamId, teamName, pinnedAt, ...pin }) => ({
      ...pin,
      team: { id: teamId, name: teamName },
      pinnedAt: pinnedAt.toISOString(),
    }));
  return { unplaced, movers, pins: shownPins };
};
