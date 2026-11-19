import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { teamPrimaries } from "./db/core/schema.ts";

// What an admin's hand edit in Settings › Members tells the staff list's
// placing (GRA-2055, staff-list-teams.ts `placementOf`): apart from it, so
// the auth hooks that call it reach none of what placing imports.

/**
 * An admin adds `userId` to `teamId` by hand (Settings › Members), called
 * before Better Auth's insert and again after it: where that is the team
 * the list gives them, the membership is theirs from now on, and the list
 * never takes it away (`placementOf`), though the add fail or find it
 * there already; nor does the list add it again itself, as the admin has
 * decided (no longer `pending`).
 */
export const addedByHand = async (
  env: Env,
  teamId: string,
  userId: string
): Promise<void> => {
  await drizzle(env.DB)
    .update(teamPrimaries)
    .set({ made: false, pending: false })
    .where(
      and(eq(teamPrimaries.userId, userId), eq(teamPrimaries.teamId, teamId))
    );
};

/**
 * An admin takes `userId` out of `teamId` by hand, called before Better
 * Auth's delete and again after it: where that is the team the list gives
 * them, its row stays as the marker that they did, and the list doesn't
 * add the membership again until it gives them another team, also when it
 * was still to add once they are proved (no longer `pending`).
 */
export const removedByHand = async (
  env: Env,
  teamId: string,
  userId: string
): Promise<void> => {
  await drizzle(env.DB)
    .update(teamPrimaries)
    .set({ pending: false })
    .where(
      and(eq(teamPrimaries.userId, userId), eq(teamPrimaries.teamId, teamId))
    );
};
