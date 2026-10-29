import { collections } from "@grasp-os/brain/schema";
import { isAdmin } from "@grasp-os/shared/roles";
import { workflowBindingTargetSchema } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowActivity,
  WorkflowFile,
  WorkflowKnowledge,
} from "@grasp-os/shared/workflow-resources";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Acting } from "./auth/identity.ts";
import {
  permissions,
  workflowBindingApprovals,
  workflowResourceRuns,
  workflowResourceVersions,
  workflowRunFiles,
} from "./db/core/schema.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";

// A workflow's own knowledge, files and activity (GRA-515), for its page:
// the Knowledge collections it may read itself, the files its runs wrote,
// and what happened to it. Reads only, nothing audited, as reading the
// workflow's runs and versions isn't. From the threat model:
//
// - Someone with no role in the workflow learning of it: every read
//   starts from `requireWorkflowRole`, which answers one they have no role
//   in as one that doesn't exist.
// - A run's results reaching someone it didn't act for: a run's files can
//   hold what it read for its person, so they are listed as its results
//   are shown (`resourceRunFor`): to that person and the organization's
//   admins. A listing is what a file is, never its bytes: nothing serves
//   those outside the run's own actions (workflows/run-files.ts). Runs in
//   the activity are as `listResourceRuns` shows them: every one to the
//   workflow's builders, a user's own to a user.
// - A collection named that its readers can't see: only collections the
//   workflow itself holds an active read permission on are listed, never
//   one only its owner or only admins read, which no workflow may bind.

/** The most files and activity entries a read answers: the newest. */
const pageSize = 100;

/** The actions a permission row allows. */
const actionsOf = (json: string): string[] => {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed)
    ? parsed.filter((action): action is string => typeof action === "string")
    : [];
};

/** The collections workflow `id` may read itself, with the aliases of the active bindings that use each. */
export const workflowKnowledge = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowKnowledge[]> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const db = drizzle(env.DB);
  const [held, bindings] = await db.batch([
    db
      .select({
        id: permissions.id,
        objectId: permissions.objectId,
        actions: permissions.actions,
      })
      .from(permissions)
      .where(
        and(
          eq(permissions.subjectType, "workflow"),
          eq(permissions.subjectId, workflow.id),
          eq(permissions.objectType, "collection"),
          eq(permissions.status, "active"),
          isNull(permissions.chatId)
        )
      ),
    db
      .select({
        alias: workflowBindingApprovals.alias,
        target: workflowBindingApprovals.target,
      })
      .from(workflowBindingApprovals)
      .where(
        and(
          eq(workflowBindingApprovals.workflowResourceId, workflow.id),
          eq(workflowBindingApprovals.kind, "knowledge"),
          eq(workflowBindingApprovals.status, "active")
        )
      ),
  ]);
  const readable = held.flatMap((row) => {
    const actions = actionsOf(row.actions);
    return actions.includes("read") ? [{ ...row, actions }] : [];
  });
  if (readable.length === 0) {
    return [];
  }
  const named = await drizzle(env.KNOWLEDGE)
    .select({
      id: collections.id,
      name: collections.name,
      access: collections.access,
    })
    .from(collections)
    .where(
      inArray(
        collections.id,
        readable.map(({ objectId }) => objectId)
      )
    );
  const aliasesOf = (permissionId: string): string[] =>
    bindings
      .flatMap(({ alias, target }) => {
        const parsed = workflowBindingTargetSchema.safeParse(
          JSON.parse(target)
        );
        return parsed.success &&
          parsed.data.kind === "knowledge" &&
          parsed.data.permissionId === permissionId
          ? [alias]
          : [];
      })
      .filter((alias, at, all) => all.indexOf(alias) === at)
      .toSorted();
  return readable
    .flatMap((row): WorkflowKnowledge[] => {
      const collection = named.find(({ id: each }) => each === row.objectId);
      // Gone, or one no workflow may read: never named.
      if (
        collection === undefined ||
        collection.access === "me" ||
        collection.access === "admins"
      ) {
        return [];
      }
      return [
        {
          collectionId: collection.id,
          name: collection.name,
          actions: row.actions,
          aliases: aliasesOf(row.id),
        },
      ];
    })
    .toSorted((one, other) => one.name.localeCompare(other.name));
};

/** The files workflow `id`'s runs wrote, newest first, of the runs `by` may see the results of. */
export const workflowFiles = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowFile[]> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const files = workflowRunFiles;
  const runs = workflowResourceRuns;
  const rows = await drizzle(env.DB)
    .select({
      id: files.id,
      runId: files.runId,
      name: files.name,
      type: files.type,
      size: files.size,
      finishedAt: files.finishedAt,
    })
    .from(files)
    .innerJoin(runs, eq(runs.id, files.runId))
    .where(
      and(
        eq(files.workflowResourceId, workflow.id),
        eq(files.state, "done"),
        isNotNull(files.finishedAt),
        // A run's results: its person's and admins' (`resourceRunFor`).
        isAdmin(by.role) ? undefined : eq(runs.principalId, by.userId)
      )
    )
    .orderBy(desc(files.finishedAt), desc(files.id))
    .limit(pageSize);
  return rows.flatMap((row) =>
    row.finishedAt === null
      ? []
      : [
          {
            id: row.id,
            runId: row.runId,
            name: row.name,
            type: row.type,
            size: row.size,
            writtenAt: row.finishedAt.toISOString(),
          },
        ]
  );
};

/** What happened to workflow `id`, newest first, as `by` may see it. */
export const workflowActivity = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowActivity[]> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const db = drizzle(env.DB);
  const approvals = workflowBindingApprovals;
  const runs = workflowResourceRuns;
  const [versions, bindings, runRows] = await db.batch([
    db
      .select({
        version: workflowResourceVersions.version,
        by: workflowResourceVersions.authorId,
        at: workflowResourceVersions.createdAt,
      })
      .from(workflowResourceVersions)
      .where(eq(workflowResourceVersions.workflowResourceId, workflow.id))
      .orderBy(desc(workflowResourceVersions.createdAt))
      .limit(pageSize),
    db
      .select()
      .from(approvals)
      .where(eq(approvals.workflowResourceId, workflow.id))
      .orderBy(desc(approvals.approvedAt))
      .limit(pageSize),
    db
      .select({
        id: runs.id,
        version: runs.version,
        principal: runs.principalId,
        status: runs.status,
        createdAt: runs.createdAt,
        endedAt: runs.endedAt,
      })
      .from(runs)
      .where(
        and(
          eq(runs.workflowResourceId, workflow.id),
          // As `listResourceRuns` shows them.
          workflow.role === "builder"
            ? undefined
            : eq(runs.principalId, by.userId)
        )
      )
      .orderBy(
        desc(sql`coalesce(${runs.endedAt}, ${runs.createdAt})`),
        desc(runs.id)
      )
      .limit(pageSize),
  ]);
  const entries: WorkflowActivity[] = [
    ...versions.map((row): WorkflowActivity => ({
      kind: "version",
      at: row.at.toISOString(),
      by: row.by,
      version: row.version,
    })),
    ...bindings.flatMap((row): WorkflowActivity[] => {
      const binding = {
        kind: "binding",
        alias: row.alias,
        bindingKind: row.kind,
        version: row.reviewedVersion,
      } as const;
      return [
        {
          ...binding,
          at: row.approvedAt.toISOString(),
          by: row.approvedBy,
          change: "approved",
        },
        ...(row.revokedAt === null || row.revokedBy === null
          ? []
          : [
              {
                ...binding,
                at: row.revokedAt.toISOString(),
                by: row.revokedBy,
                change: "revoked" as const,
              },
            ]),
      ];
    }),
    ...runRows.flatMap((row): WorkflowActivity[] => {
      const run = {
        kind: "run",
        runId: row.id,
        principal: row.principal,
        version: row.version,
        status: row.status,
      } as const;
      return [
        { ...run, at: row.createdAt.toISOString(), change: "started" },
        ...(row.endedAt === null
          ? []
          : [
              {
                ...run,
                at: row.endedAt.toISOString(),
                change: "ended" as const,
              },
            ]),
      ];
    }),
  ];
  return entries
    .toSorted((one, other) => other.at.localeCompare(one.at))
    .slice(0, pageSize);
};
