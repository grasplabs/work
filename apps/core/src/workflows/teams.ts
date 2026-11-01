import { actorOf } from "@grasp-os/shared/audit";
import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import { requireBuilder, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { editableApp } from "../apps.ts";
import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { organizationId } from "../auth/auth.ts";
import { appVersions, teams, workflowTeams } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";

// The team that owns a workflow: one of the organization's teams (the
// teams its people are in), whose work the workflow does. The dashboard
// counts each team's workflows, and what they handled, by it (GRA-517).
// It is set explicitly rather than taken from the workflow's owner, who
// may be in several teams or none.
//
// Admins and the App's builders set it, as they set the owner (owners.ts),
// audited as `workflow.team.updated`; Grasp staff don't: whose work a
// client's workflow is, is the client's to say. The row is kept by App
// and workflow ID, so it holds across versions; a team that is deleted
// takes its rows with it.

/** The team that owns a workflow, as the lists show it. */
export interface WorkflowTeam {
  id: string;
  name: string;
}

/** A key of an App's workflow, for looking its team up. */
const keyOf = (app: string, workflow: string): string =>
  JSON.stringify([app, workflow]);

/** The key `teamsSet` holds an App workflow's team by. */
export const teamKey = keyOf;

/**
 * The teams set for the workflows of the Apps `appIds`, by App workflow
 * (`teamKey`): one read of the rows that start with those Apps.
 */
export const teamsSet = async (
  env: Env,
  appIds: readonly string[]
): Promise<Map<string, WorkflowTeam>> => {
  if (appIds.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({
      app: workflowTeams.appId,
      workflow: workflowTeams.workflowId,
      id: teams.id,
      name: teams.name,
    })
    .from(workflowTeams)
    .innerJoin(teams, eq(teams.id, workflowTeams.teamId))
    .where(inList(workflowTeams.appId, appIds));
  return new Map(
    rows.map(({ app, workflow, id, name }) => [
      keyOf(app, workflow),
      { id, name },
    ])
  );
};

/**
 * The organization's teams, by name, that a workflow's team may be set to:
 * for admins and builders, who set it (`setWorkflowTeam` says which
 * workflows); not Grasp staff, who never do.
 */
export const teamChoices = async (
  env: Env,
  by: Identity
): Promise<WorkflowTeam[]> => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  requireBuilder(by);
  return await drizzle(env.DB)
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.organizationId, organizationId))
    .orderBy(asc(teams.name), asc(teams.id));
};

const teamInputSchema = z.string().min(1).max(256).nullable();

/**
 * Makes `team` (one of the organization's teams, by ID; `null` for none)
 * the team that owns workflow `workflow` of App `app`'s current version,
 * for an admin or a builder of the App; not Grasp staff. A team that
 * isn't the organization's is `workflow.team_invalid`. The change and its
 * audit event, which names the team it replaced, are one batch.
 */
export const setWorkflowTeam = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  team: unknown
): Promise<{ app: AppId; workflow: WorkflowId }> => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const found = await editableApp(env, by, app);
  const workflowId = workflowErrors.parse(
    "workflow.invalid",
    workflowIdSchema,
    workflow
  );
  const teamId = workflowErrors.parse(
    "workflow.team_invalid",
    teamInputSchema,
    team
  );
  const db = drizzle(env.DB);
  const [current, chosen, previous] = await Promise.all([
    found.currentVersion === null
      ? undefined
      : db
          .select({ workflows: appVersions.workflows })
          .from(appVersions)
          .where(
            and(
              eq(appVersions.appId, found.id),
              eq(appVersions.version, found.currentVersion)
            )
          )
          .get(),
    teamId === null
      ? undefined
      : db
          .select({ id: teams.id })
          .from(teams)
          .where(
            and(eq(teams.id, teamId), eq(teams.organizationId, organizationId))
          )
          .get(),
    db
      .select({ teamId: workflowTeams.teamId })
      .from(workflowTeams)
      .where(
        and(
          eq(workflowTeams.appId, found.id),
          eq(workflowTeams.workflowId, workflowId)
        )
      )
      .get(),
  ]);
  if (current?.workflows.includes(workflowId) !== true) {
    throw workflowErrors.create("workflow.not_found");
  }
  if (teamId !== null && chosen === undefined) {
    throw workflowErrors.create("workflow.team_invalid");
  }
  const whose = and(
    eq(workflowTeams.appId, found.id),
    eq(workflowTeams.workflowId, workflowId)
  );
  await auditedBatch(env, db, [
    teamId === null
      ? db.delete(workflowTeams).where(whose)
      : db
          .insert(workflowTeams)
          .values({
            appId: found.id,
            workflowId,
            teamId,
            setBy: by.userId,
            setAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [workflowTeams.appId, workflowTeams.workflowId],
            set: { teamId, setBy: by.userId, setAt: new Date() },
          }),
    outboxed(db, {
      actor: actorOf(by),
      action: "workflow.team.updated",
      target: { type: "app", id: found.id },
      detail: {
        workflow: workflowId,
        team: teamId,
        previous: previous?.teamId ?? null,
      },
    }),
  ]);
  return { app: found.id, workflow: workflowId };
};
