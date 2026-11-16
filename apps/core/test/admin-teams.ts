import { z } from "zod";

import { callAuth, unique } from "./sign-in.ts";

/**
 * A new team with `members`, made by `admin` through sign-in's own
 * endpoints, as the admin pages make one; returns its ID.
 */
export const newTeam = async (
  admin: { session: string },
  members: { userId: string }[]
): Promise<string> => {
  const created = await callAuth("/organization/create-team", admin.session, {
    name: `Team ${unique()}`,
  });
  const { id } = z.object({ id: z.string() }).parse(await created.json());
  for (const member of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    const added = await callAuth(
      "/organization/add-team-member",
      admin.session,
      {
        teamId: id,
        userId: member.userId,
      }
    );
    if (!added.ok) {
      throw new Error(`Adding ${member.userId} to the team failed`);
    }
  }
  return id;
};
