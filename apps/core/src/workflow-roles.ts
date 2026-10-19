import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { activeMember, organizationId } from "./auth/auth.ts";

// Who has a role in an independent workflow, as SQL read in the statement
// that decides: what a start requires of the person it acts for
// (workflow-starts.ts), and what every call of a run requires of its
// principal again (workflows/resource-authority.ts).

/**
 * That `person` has a role in workflow `id` now, as SQL: an admin of the
 * organization, its owner, or someone it is shared with, as a person or
 * through a team they are in now (Better Auth's `team_members`, read in
 * this statement, never the session's list of teams). Only while they
 * are an active member.
 */
export const workflowRoleSql = (
  person: string,
  id: string
): SQL => sql`(${activeMember(person)}
  AND (${activeMember(person, ["admin"])}
    OR EXISTS (SELECT 1 FROM workflow_resources AS owned
      WHERE owned.id = ${id} AND owned.owner_id = ${person})
    OR EXISTS (SELECT 1 FROM workflow_resource_members AS shared
      WHERE shared.workflow_resource_id = ${id}
        AND shared.member_type = 'person' AND shared.member_id = ${person})
    OR EXISTS (SELECT 1 FROM workflow_resource_members AS shared
      JOIN teams ON teams.id = shared.member_id
        AND teams.organization_id = ${organizationId}
      JOIN team_members ON team_members.team_id = shared.member_id
        AND team_members.user_id = ${person}
      WHERE shared.workflow_resource_id = ${id}
        AND shared.member_type = 'team')))`;
