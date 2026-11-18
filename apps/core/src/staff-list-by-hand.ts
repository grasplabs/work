import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { retiredTeamIds, teamPrimaries } from "./db/core/schema.ts";

// What an admin's hand edit in Settings › Members tells the staff list's
// placing (GRA-2055, staff-list-teams.ts `placementOf`): apart from it, so
// the auth hooks that call it reach none of what placing imports.

/**
 * An admin adds `userId` to `teamId` by hand (Settings › Members), called
 * before Better Auth's insert: where that is the team the list gives them,
 * the membership is theirs from now on, and the list never takes it away
 * (`placementOf`), though the add fail or find it there already.
 */
export const addedByHand = async (
  env: Env,
  teamId: string,
  userId: string
): Promise<void> => {
  await drizzle(env.DB)
    .update(teamPrimaries)
    .set({ made: false })
    .where(
      and(eq(teamPrimaries.userId, userId), eq(teamPrimaries.teamId, teamId))
    );
};

/**
 * A members' team is being deleted in Settings › Members: its id is
 * retired, never to be made again by the staff list (`retired_team_ids`).
 * Called before Better Auth's delete, so a delete that succeeds never
 * skips it; one that then fails only keeps the list from making an id
 * whose team still exists, and is read as a members' team.
 */
export const retireTeamId = async (env: Env, teamId: string): Promise<void> => {
  await drizzle(env.DB)
    .insert(retiredTeamIds)
    .values({ id: teamId })
    .onConflictDoNothing();
};
