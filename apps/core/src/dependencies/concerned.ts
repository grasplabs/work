import type { DependencySubject } from "@grasp-os/shared/dependencies";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  appMembers,
  apps,
  dependencyRequests,
  members,
  teamMembers,
  workflowResourceMembers,
  workflowResources,
} from "../db/core/schema.ts";

// Whom a revocation of reported malware tells (requests.ts), as core,
// not a person, revokes it: the people who build the App or workflow,
// who must remove the package, and those who approved what was revoked,
// who approved it as safe. Read just before the batch that revokes; each
// notice there lands only while its person is still an active member
// (notifications.ts), so this reads roles alone.

/**
 * The people who build `subject` now: its owner and whom it is shared
 * with as a builder, as a person or through a team, whose role in the
 * organization builds (a builder or an admin).
 */
const buildersOf = (subject: DependencySubject) => {
  if (subject.type === "app") {
    return sql`SELECT ${apps.ownerId} AS person FROM ${apps} WHERE ${apps.id} = ${subject.id} AND ${apps.removedAt} IS NULL
      UNION SELECT ${appMembers.memberId} FROM ${appMembers} WHERE ${appMembers.appId} = ${subject.id} AND ${appMembers.role} = 'builder' AND ${appMembers.memberType} = 'person'
      UNION SELECT ${teamMembers.userId} FROM ${appMembers} INNER JOIN ${teamMembers} ON ${teamMembers.teamId} = ${appMembers.memberId} WHERE ${appMembers.appId} = ${subject.id} AND ${appMembers.role} = 'builder' AND ${appMembers.memberType} = 'team'`;
  }
  return sql`SELECT ${workflowResources.ownerId} AS person FROM ${workflowResources} WHERE ${workflowResources.id} = ${subject.id} AND ${workflowResources.deletedAt} IS NULL
    UNION SELECT ${workflowResourceMembers.memberId} FROM ${workflowResourceMembers} WHERE ${workflowResourceMembers.workflowResourceId} = ${subject.id} AND ${workflowResourceMembers.role} = 'builder' AND ${workflowResourceMembers.memberType} = 'person'
    UNION SELECT ${teamMembers.userId} FROM ${workflowResourceMembers} INNER JOIN ${teamMembers} ON ${teamMembers.teamId} = ${workflowResourceMembers.memberId} WHERE ${workflowResourceMembers.workflowResourceId} = ${subject.id} AND ${workflowResourceMembers.role} = 'builder' AND ${workflowResourceMembers.memberType} = 'team'`;
};

/**
 * Whom a revocation of `subject`'s approvals `approvalIds` as malware
 * tells: the people who build it now, and the members who approved those
 * approvals, whatever their role now.
 */
export const concernedWith = async (
  env: Env,
  subject: DependencySubject,
  approvalIds: readonly string[]
): Promise<string[]> => {
  const builders = sql.raw("builders");
  const approved = sql`(SELECT value FROM json_each(${JSON.stringify(approvalIds)}))`;
  const rows = await drizzle(env.DB).all<{ person: string }>(
    sql`WITH ${builders} AS (${buildersOf(subject)})
      SELECT person FROM ${builders} WHERE EXISTS (SELECT 1 FROM ${members} WHERE ${members.userId} = ${builders}.person AND ${members.role} IN ('builder', 'admin'))
      UNION SELECT ${dependencyRequests.decidedBy} AS person FROM ${dependencyRequests}
        WHERE ${dependencyRequests.id} IN ${approved} AND ${dependencyRequests.decidedBy} IS NOT NULL`
  );
  return rows.map(({ person }) => person);
};
