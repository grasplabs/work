import type { WorkflowShareCandidates } from "@grasp-os/shared/workflow-resources";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { notRemoved, organizationId } from "./auth/auth.ts";
import type { Acting } from "./auth/identity.ts";
import { members, teams, users } from "./db/core/schema.ts";
import { requireNotStaff } from "./sharing.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";

// Whom an independent workflow can be shared with (GRA-1304), for its
// Share dialog: the organization's people, members now, and its teams,
// each by name and ID alone, as an App's are (app-members.ts,
// `shareCandidates`). A workflow's builder needn't be an admin, so this,
// not the organization's member list, is what they pick from. What could
// go wrong, and what stops it:
//
// - Someone learning who is in the organization, or of the workflow, who
//   may not share it: only whoever may share it (`shareWorkflowResource`)
//   reads this, a builder of the workflow, never Grasp staff; anyone
//   without a role is told the workflow doesn't exist, as everywhere.
// - Saying more of a person than a share names: their name and ID only,
//   no address, no organization role, nor a team's members.
// - Offering a share core then refuses (a builder's role to someone who
//   doesn't build, the owner): offered anyway, and refused by the share,
//   which decides; the dialog says why.

/** Whom workflow `id` may be shared with, for `by`, who may share it. */
export const workflowShareCandidates = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowShareCandidates> => {
  requireNotStaff(by);
  await requireWorkflowRole(env, by, id, "builder");
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
