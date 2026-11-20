import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import type { Roster } from "@grasp-os/shared/onboarding";
import { noTeamId, teamNameKey } from "@grasp-os/shared/onboarding";
import { eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { organizationId } from "./auth/membership-sql.ts";
import { retiredTeamIds, staffListSynced, teams } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
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
// - A team's name written from two sides, a stale copy over the other: a
//   members' team's name changes in Settings › Members alone, and the
//   list takes it from there at every save (`intoMembersTeams`).
// - An older confirm making a team after a newer one: each sync claims
//   the store's version in the batch that writes, only when newer
//   (`syncTeams`).
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
    // The list's team for people it gives no team keeps its own id: it is
    // never a members' team (`syncTeams`), whatever its name.
    if (team.id === noTeamId || kept.has(team.id)) {
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
  // A members' team's name changes in Settings › Members alone (Better
  // Auth's update-team, the one path): the list takes it as it is there,
  // whatever the request says, so a rename there whose copy here was lost
  // comes back at the next save, and a page opened before it never writes
  // the old name back. A team only on the list keeps the list's name until
  // the confirm makes it.
  const listed = roster.teams.map((team) => {
    const id = idOf.get(team.id) ?? team.id;
    return {
      ...team,
      id,
      name: id === noTeamId ? team.name : (known.get(id) ?? team.name),
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
 * Makes the members' teams the list the admin last confirmed names and
 * Settings › Members doesn't have yet (GRA-2055), from the onboarding
 * store's confirmed teams, never from a request: each under its id, as
 * Better Auth's own create-team makes a team, with the list's name, and
 * only under an id never retired, checked in the statement itself. It
 * renames none: a members' team's name changes in Settings alone. None is
 * ever deleted here, as one may hold what was shared with it. One batch,
 * one transaction: it claims the store's version (`staff_list_synced`)
 * only when it is newer than the one claimed, and every insert in it holds
 * only while the row names that version, so an older confirm makes nothing
 * after a newer one. Idempotent. Never the list's team for people it
 * gives no team (`noTeamId`): no directory fills it. Answers whether it
 * made any.
 */
export const syncTeams = async (
  env: Env,
  actor: AuditActor
): Promise<boolean> => {
  const confirmed = await onboardingStore(env).confirmedTeams();
  if (confirmed === null) {
    return false;
  }
  const { version } = confirmed;
  const db = drizzle(env.DB);
  const existing = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.organizationId, organizationId));
  const known = new Set(existing.map(({ id }) => id));
  const holds = sql`EXISTS (SELECT 1 FROM ${staffListSynced} WHERE ${staffListSynced.organizationId} = ${organizationId} AND ${staffListSynced.version} = ${version})`;
  const now = Date.now();
  const entry = (action: string, id: string): AuditEntry => ({
    actor,
    action,
    target: { type: "team", id },
    detail: { via },
  });
  const writes = confirmed.teams.flatMap(
    ({ id, name }): BatchItem<"sqlite">[] =>
      known.has(id) || id === noTeamId
        ? []
        : [
            db
              .insert(teams)
              .select(
                sql`SELECT ${id}, ${name}, 0, ${organizationId}, ${now}, ${now}
                  WHERE ${holds}
                    AND NOT EXISTS (SELECT 1 FROM ${retiredTeamIds} WHERE ${retiredTeamIds.id} = ${id})`
              )
              .onConflictDoNothing()
              .returning({ id: teams.id }),
            outboxedIfChanged(db, entry("team.created", id)),
          ]
  );
  const results = await auditedBatch(env, db, [
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
  // Each team's insert answers the row it made, if it made one.
  return results.some((result) => Array.isArray(result) && result.length > 0);
};

/**
 * Whether the saved or the confirmed staff list gives a team it hasn't
 * made in Settings › Members yet the name `name` (by `teamNameKey`): then
 * a team made there under it would be a second one of that name once the
 * list is confirmed, which keeps its own team by its id (GRA-2055).
 */
export const namedOnListUnmade = async (
  env: Env,
  name: string
): Promise<boolean> => {
  const store = onboardingStore(env);
  const [held, confirmed] = await Promise.all([
    store.heldTeams(),
    store.confirmedTeams(),
  ]);
  const key = teamNameKey(name);
  const named = [...held, ...(confirmed?.teams ?? [])].filter(
    (team) => team.id !== noTeamId && teamNameKey(team.name) === key
  );
  if (named.length === 0) {
    return false;
  }
  const made = await drizzle(env.DB)
    .select({ id: teams.id })
    .from(teams)
    .where(
      sql`${teams.organizationId} = ${organizationId} AND ${inList(
        teams.id,
        named.map(({ id }) => id)
      )}`
    );
  const madeIds = new Set(made.map(({ id }) => id));
  return named.some(({ id }) => !madeIds.has(id));
};
