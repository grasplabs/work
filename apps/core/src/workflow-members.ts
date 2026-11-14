import {
  newSubjectMemberSchema,
  subjectMemberRefSchema,
} from "@grasp-os/shared/subject-members";
import type {
  ShareCandidates,
  SubjectMember,
  SubjectMemberRef,
  SubjectMembersApi,
} from "@grasp-os/shared/subject-members";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { teams, users, workflowResourceMembers } from "./db/core/schema.ts";
import { notNullFailed } from "./db/d1.ts";
import { namedProjectsFor, requireStillBuilt } from "./project-access.ts";
import { projectStillBuiltSql } from "./project-sql.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  memberEntry,
  requireNotStaff,
  requireSharable,
  shareCandidates,
  stillMembers,
} from "./sharing.ts";
import {
  nextGeneration,
  previousChanged,
  requireWorkflowRole,
} from "./workflow-resources.ts";

// Sharing a workflow, as an App is shared (app-members.ts): whom it is
// open to besides its owner and the admins, and in which role. Its
// builders share it with people, teams and projects of the organization,
// change their role and unshare it; everyone with a role in it sees whom
// it is shared with. Every change is audited, in the same batch as the
// change, with who made it, and moves the workflow's generation on, so a
// start decided before it is decided again. Grasp staff never share a
// workflow: whom a client's data reaches is the client's decision.

/**
 * Whom workflow `id` is shared with, for anyone with a role in it, each
 * by name, as an App's members are (app-members.ts): the people still in
 * the organization, the teams that still exist and the projects, in the
 * order they were shared. A project's name only for someone in it: to
 * anyone else it stays unnamed.
 */
export const workflowMembers = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<SubjectMember[]> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const rows = await drizzle(env.DB)
    .select({
      row: workflowResourceMembers,
      person: users.name,
      team: teams.name,
    })
    .from(workflowResourceMembers)
    .leftJoin(
      users,
      and(
        eq(workflowResourceMembers.memberType, "person"),
        eq(users.id, workflowResourceMembers.memberId)
      )
    )
    .leftJoin(
      teams,
      and(
        eq(workflowResourceMembers.memberType, "team"),
        eq(teams.id, workflowResourceMembers.memberId)
      )
    )
    .where(
      and(
        eq(workflowResourceMembers.workflowResourceId, workflow.id),
        stillMembers(workflowResourceMembers)
      )
    )
    .orderBy(
      asc(workflowResourceMembers.addedAt),
      asc(workflowResourceMembers.memberType),
      asc(workflowResourceMembers.memberId)
    );
  const projectNames = await namedProjectsFor(
    env,
    by,
    rows
      .filter(({ row }) => row.memberType === "project")
      .map(({ row }) => row.memberId)
  );
  return rows.map(({ row, person, team }) => ({
    type: row.memberType,
    id: row.memberId,
    name:
      row.memberType === "project"
        ? (projectNames.get(row.memberId) ?? null)
        : (person ?? team),
    role: row.role,
    addedBy: row.addedBy,
    addedAt: row.addedAt.toISOString(),
  }));
};

/**
 * Shares workflow `id` with a person or team in a role, for `by`, who must
 * build it and isn't Grasp staff: never with its owner; as a builder, only
 * with someone whose organization role builds. Sharing again changes the
 * role, and records only a change.
 */
export const shareWorkflowResource = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<SubjectMember> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const { role, ...member } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    newSubjectMemberSchema,
    input
  );
  await requireSharable(
    env,
    member,
    {
      owner: workflow.owner,
      builds: role === "builder",
      invalid: (issue) =>
        workflowResourceErrors.create("workflow.resource_invalid", {
          issues: [issue],
        }),
      ownerIssue: "id: The workflow's owner always has it.",
      buildsIssue:
        "role: Only the organization's admins and builders build workflows.",
    },
    by
  );
  // A share with a project: the project, while `by` still builds it.
  const toProject =
    member.type === "project"
      ? projectStillBuiltSql(member.id, by.userId)
      : undefined;
  const addedAt = new Date();
  const db = drizzle(env.DB);
  const batch = auditedBatch(env, db, [
    db
      .insert(workflowResourceMembers)
      .values({
        // Only while the workflow is live: otherwise NULL, which fails the
        // batch, so a share racing a deletion writes nothing.
        // A share with a project, also only while it is there and `by`
        // builds it, read here: a builder taken out meanwhile shares
        // nothing.
        workflowResourceId: sql`(SELECT id FROM workflow_resources
          WHERE id = ${workflow.id} AND deleted_at IS NULL
            AND ${toProject === undefined ? sql`1` : sql`${toProject} IS NOT NULL`})`,
        memberType: member.type,
        memberId: member.id,
        role,
        addedBy: by.userId,
        addedAt,
      })
      .onConflictDoUpdate({
        target: [
          workflowResourceMembers.workflowResourceId,
          workflowResourceMembers.memberType,
          workflowResourceMembers.memberId,
        ],
        set: { role, addedBy: by.userId, addedAt },
        // Live already: a deleted workflow's ID is NULL above, which
        // fails the insert before any conflict is looked for.
        setWhere: sql`${workflowResourceMembers.role} <> ${role}`,
      }),
    // Only when the share changed something (a role the member already
    // has changes nothing): a start decided meanwhile is still good.
    nextGeneration(db, workflow.id, previousChanged),
    outboxedIfChanged(
      db,
      memberEntry(
        by,
        "workflow.member.added",
        { type: "workflow_resource", id: workflow.id },
        { ...member, role }
      )
    ),
  ]);
  try {
    await batch;
  } catch (error) {
    if (
      notNullFailed(error, "workflow_resource_members.workflow_resource_id")
    ) {
      // The project's guard, if that was what held it back, says why.
      if (toProject !== undefined) {
        await requireStillBuilt(env, member.id, by.userId);
      }
      throw workflowResourceErrors.create("workflow.resource_unavailable");
    }
    throw error;
  }
  const shared = await workflowMembers(env, by, workflow.id);
  const added = shared.find(
    (each) => each.type === member.type && each.id === member.id
  );
  if (added === undefined) {
    throw workflowResourceErrors.create("workflow.resource_unavailable");
  }
  return added;
};

/**
 * Stops sharing workflow `id` with a person or team, for `by`, who must
 * build it and isn't Grasp staff. Unsharing someone it isn't shared with
 * changes and records nothing.
 */
export const unshareWorkflowResource = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<void> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const member: SubjectMemberRef = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    subjectMemberRefSchema,
    input
  );
  const db = drizzle(env.DB);
  const ofMember = and(
    eq(workflowResourceMembers.workflowResourceId, workflow.id),
    eq(workflowResourceMembers.memberType, member.type),
    eq(workflowResourceMembers.memberId, member.id)
  );
  // The role it had, for the event, which only the deletion stores.
  const row = await db
    .select({ role: workflowResourceMembers.role })
    .from(workflowResourceMembers)
    .where(ofMember)
    .get();
  if (row === undefined) {
    return;
  }
  await auditedBatch(env, db, [
    db.delete(workflowResourceMembers).where(ofMember),
    nextGeneration(db, workflow.id, previousChanged),
    outboxedIfChanged(
      db,
      memberEntry(
        by,
        "workflow.member.removed",
        { type: "workflow_resource", id: workflow.id },
        { ...member, role: row.role }
      )
    ),
  ]);
};

/** A signed-in person's `workflowResources.members`. */
export class WorkflowMembersRpc
  extends CoreRpcTarget
  implements SubjectMembersApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(id: string): Promise<SubjectMember[]> {
    return await withPerson(
      this.#check,
      async (person) => await workflowMembers(this.#env, person, id)
    );
  }

  async add(id: string, member: unknown): Promise<SubjectMember> {
    return await withPerson(
      this.#check,
      async (person) =>
        await shareWorkflowResource(this.#env, person, id, member)
    );
  }

  async remove(id: string, member: unknown): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await unshareWorkflowResource(this.#env, person, id, member);
    });
  }

  /** For whoever may share it: a builder, never Grasp staff. */
  async candidates(id: string): Promise<ShareCandidates> {
    return await withPerson(this.#check, async (person) => {
      requireNotStaff(person);
      await requireWorkflowRole(this.#env, person, id, "builder");
      return await shareCandidates(this.#env, person);
    });
  }
}
