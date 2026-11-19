import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import type { Roster } from "@grasp-os/shared/onboarding";
import { teamNameKey } from "@grasp-os/shared/onboarding";
import { eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { organizationId } from "./auth/membership-sql.ts";
import { retiredTeamIds, staffListSynced, teams } from "./db/core/schema.ts";
import { onboardingStore } from "./onboarding/store.ts";

// One list of teams with one id (GRA-2055): the onboarding's staff list
// names the members' teams (Better Auth's `teams`), never teams of its
// own. Its people stay its own, and so do a team's lead, its description
// and whether it takes part, kept by the onboarding store beside the team
// under the team's id. A confirm changes no membership: who is in which
// team stays the admin's, in Settings › Members. What can go wrong, and
// what stops each:
//
// - A deleted team's id coming back with what was shared with it: a
//   team's id is a members' team's, or one core made for the list
//   (`crypto.randomUUID`, marked `minted` in the store), never one a
//   request sent; a team is made only under an id D1 never retired: a
//   trigger retires every deleted team's id (`retired_team_ids`),
//   whichever release's code deleted it, checked in the statement that
//   makes a team.
// - A rename or a confirm splitting what one team holds: a team keeps one
//   id from the first save that names it, and everything keys by it.
// - Two confirms, or a confirm and a rename in Settings, leaving a team's
//   name in Settings other than the list's: each sync claims the store's
//   version in the batch that writes, only when newer (`syncTeams`).
// - A team the admin only drafted: made at the confirm, never before, so a
//   draft fixed before it leaves no team behind.

/** What a team change the list makes records as how it was made. */
const via = "staffList";

/** A team of the staff list the onboarding's store holds now. */
export interface HeldTeam {
  id: string;
  name: string;
  /** Whether core made its id for the list (`teams.minted`). */
  minted: boolean;
}

/**
 * `roster` with each of its teams under the one id it keeps for good
 * (GRA-2055): a members' team's, or one core made for the list (`minted`)
 * that the onboarding's store holds (`held`), by its id, else by its name
 * (trimmed, any case) where one alone has it and no other team on the list
 * took it; else a new id core makes, never the one the request sent. A held
 * id that is neither (a members' team deleted while a save ran) is never
 * kept: no deleted team's id comes back, with what was shared with it. The
 * id never changes after: a team new on a draft is kept under it in the
 * store, and once the admin confirms the list its members' team is made
 * under that same id, and named as the list names it, by that version's
 * sync (`syncTeams`), never here: nothing is written here, so a draft put
 * right before the confirm leaves no team in Settings › Members. Answers
 * the roster as the store keeps it, and the ids core made for it
 * (`minted`).
 */
export const intoMembersTeams = async (
  env: Env,
  roster: Roster,
  {
    held: heldNow,
  }: {
    /** The store's teams, read only after the members' teams are. */
    held: () => Promise<readonly HeldTeam[]>;
  }
): Promise<{ roster: Roster; minted: Set<string> }> => {
  const db = drizzle(env.DB);
  // The members' teams first, then the store's: a team deleted in between
  // is missing from the first read and so never kept by the second. No
  // test can pin this order; the insert's own guard (`syncTeams`) is what holds.
  const [existing, retired] = await db.batch([
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(eq(teams.organizationId, organizationId)),
    db.select({ id: retiredTeamIds.id }).from(retiredTeamIds),
  ]);
  const held = await heldNow();
  const known = new Map(existing.map(({ id, name }) => [id, name]));
  // A minted id whose team was deleted (retired) is never kept, and its
  // team gets a new id. What the store holds under the old id is left on
  // purpose: that team was deleted, and nothing of it may reach the new one.
  const deleted = new Set(retired.map(({ id }) => id));
  const mintedHeld = held.filter(
    ({ id, minted }) => minted && !known.has(id) && !deleted.has(id)
  );
  const kept = new Set([...known.keys(), ...mintedHeld.map(({ id }) => id)]);
  const byName = new Map<string, Set<string>>();
  for (const { id, name } of [...existing, ...mintedHeld]) {
    const key = teamNameKey(name);
    byName.set(key, (byName.get(key) ?? new Set()).add(id));
  }
  // Ids first, then names, so a team the list holds by its id is never
  // taken by another of the list's teams through its name.
  const taken = new Set(
    roster.teams.flatMap(({ id }) => (kept.has(id) ? [id] : []))
  );
  const idOf = new Map<string, string>();
  const mintedNow = new Set<string>();
  for (const team of roster.teams) {
    if (kept.has(team.id)) {
      idOf.set(team.id, team.id);
      continue;
    }
    const [named, ...others] = [
      ...(byName.get(teamNameKey(team.name)) ?? []),
    ].filter((id) => !taken.has(id));
    const id =
      named !== undefined && others.length === 0 ? named : crypto.randomUUID();
    if (id !== named) {
      mintedNow.add(id);
    }
    taken.add(id);
    idOf.set(team.id, id);
  }
  // A members' team's name is its own, in Settings › Members (the one
  // owner of it): the list follows it, so a rename there whose copy here
  // was lost comes back at the next save. Only a name the admin changed on
  // the list since the store kept it is the list's own, which a confirm
  // then gives the members' team (`syncTeams`).
  const heldName = new Map(held.map(({ id, name }) => [id, name]));
  const listed = roster.teams.map((team) => {
    const id = idOf.get(team.id) ?? team.id;
    const own = known.get(id);
    const renamedOnList = heldName.has(id) && heldName.get(id) !== team.name;
    return {
      ...team,
      id,
      name: own === undefined || renamedOnList ? team.name : own,
    };
  });
  const wasMinted = new Set(mintedHeld.map(({ id }) => id));
  return {
    roster: {
      teams: listed,
      people: roster.people.map((person) => ({
        ...person,
        team: idOf.get(person.team) ?? person.team,
      })),
    },
    minted: new Set(
      listed.flatMap(({ id }) =>
        mintedNow.has(id) || wasMinted.has(id) ? [id] : []
      )
    ),
  };
};

/**
 * Makes and names the members' teams as the list the admin last confirmed
 * has them (GRA-2055), from the onboarding store's confirmed teams, never
 * from a request: each team the members' teams don't have yet is made
 * under its id, as Better Auth's own create-team makes a team, and only
 * under an id never retired, checked in the statement itself; each one
 * named otherwise takes the list's name. None is ever deleted here, as one
 * may hold what was shared with it. One batch, one transaction: it claims
 * the store's version (`staff_list_synced`) only when it is newer than the
 * one claimed, and every write in it holds only while the row names that
 * version, so an older confirm, or a confirm that read a name a rename in
 * Settings has since changed, writes nothing after a newer one. Called by
 * each confirm and each rename in Settings; idempotent.
 */
export const syncTeams = async (env: Env, actor: AuditActor): Promise<void> => {
  const confirmed = await onboardingStore(env).confirmedTeams();
  if (confirmed === null) {
    return;
  }
  const { version } = confirmed;
  const db = drizzle(env.DB);
  const existing = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.organizationId, organizationId));
  const known = new Map(existing.map(({ id, name }) => [id, name]));
  const holds = sql`EXISTS (SELECT 1 FROM ${staffListSynced} WHERE ${staffListSynced.organizationId} = ${organizationId} AND ${staffListSynced.version} = ${version})`;
  const now = Date.now();
  const entry = (action: string, id: string): AuditEntry => ({
    actor,
    action,
    target: { type: "team", id },
    detail: { via },
  });
  const writes = confirmed.teams.flatMap(
    ({ id, name }): BatchItem<"sqlite">[] => {
      const was = known.get(id);
      if (was === undefined) {
        return [
          db
            .insert(teams)
            .select(
              sql`SELECT ${id}, ${name}, 0, ${organizationId}, ${now}, ${now}
                WHERE ${holds}
                  AND NOT EXISTS (SELECT 1 FROM ${retiredTeamIds} WHERE ${retiredTeamIds.id} = ${id})`
            )
            .onConflictDoNothing(),
          outboxedIfChanged(db, entry("team.created", id)),
        ];
      }
      return was === name
        ? []
        : [
            db
              .update(teams)
              .set({ name, updatedAt: new Date(now) })
              .where(
                sql`${teams.id} = ${id} AND ${teams.organizationId} = ${organizationId} AND ${holds}`
              ),
            outboxedIfChanged(db, entry("team.updated", id)),
          ];
    }
  );
  await auditedBatch(env, db, [
    db
      .insert(staffListSynced)
      .values({ organizationId, version })
      .onConflictDoUpdate({
        target: staffListSynced.organizationId,
        set: { version },
        setWhere: sql`${staffListSynced.version} < ${version}`,
      }),
    ...writes,
  ]);
};
