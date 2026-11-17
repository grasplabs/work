import { isAdmin } from "@grasp-os/shared/roles";
import { workflowOwnListed } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowActivity,
  WorkflowFile,
} from "@grasp-os/shared/workflow-resources";
import { and, desc, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Acting } from "./auth/identity.ts";
import {
  workflowBindingApprovals,
  workflowResourceRuns,
  workflowResourceVersions,
  workflowRunFiles,
} from "./db/core/schema.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";
import { runEvidenceHolds } from "./workflows/resource-reads.ts";

// A workflow's own files and activity (GRA-515), for its page: the files
// its runs wrote, and what happened to it. Reads only, nothing audited, as
// reading the workflow's runs and versions isn't. From the threat model:
//
// - Someone with no role in the workflow learning of it: every read
//   starts from `requireWorkflowRole`, which answers one they have no role
//   in as one that doesn't exist.
// - A run's results reaching someone it didn't act for: a run's files can
//   hold what it read for its person, so they are listed as its results
//   are shown (`resourceRunFor`): to that person and the organization's
//   admins. A listing is what a file is, never its bytes: nothing serves
//   those outside the run itself (workflows/run-files.ts). Nor of a run
//   that may no longer read what it read (a source erased, a memory a
//   person's erasure took: GRA-1985): its files are left out, as its
//   result is withheld. Runs in
//   the activity are as `listResourceRuns` shows them: every one to the
//   workflow's builders, a user's own to a user.

/** The most files and activity entries a read answers: the newest. */
const pageSize = workflowOwnListed;

/**
 * The files workflow `id`'s runs wrote, newest first, of the runs `by` may
 * see the results of, and only while each run may still read what it
 * read (resource-reads.ts `runEvidenceHolds`, GRA-1985): a withheld run's
 * files are left out and the page filled past them, so it answers as if
 * that run wrote none, each run checked once.
 */
export const workflowFiles = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowFile[]> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const files = workflowRunFiles;
  const runs = workflowResourceRuns;
  const db = drizzle(env.DB);
  /** A page of the files after `after` (by when finished, then ID), newest first. */
  const pageAfter = async (after?: { at: Date; id: string }) =>
    await db
      .select({
        id: files.id,
        runId: files.runId,
        principalId: runs.principalId,
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
          isAdmin(by.role) ? undefined : eq(runs.principalId, by.userId),
          after === undefined
            ? undefined
            : or(
                lt(files.finishedAt, after.at),
                and(eq(files.finishedAt, after.at), lt(files.id, after.id))
              )
        )
      )
      .orderBy(desc(files.finishedAt), desc(files.id))
      .limit(pageSize);
  const holds = new Map<string, Promise<boolean>>();
  const listed: WorkflowFile[] = [];
  let after: { at: Date; id: string } | undefined;
  while (listed.length < pageSize) {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time, as filled
    const rows = await pageAfter(after);
    for (const row of rows) {
      if (row.finishedAt === null || listed.length >= pageSize) {
        continue;
      }
      const run =
        holds.get(row.runId) ??
        runEvidenceHolds(env, {
          runId: row.runId,
          workflowId: workflow.id,
          principal: row.principalId,
        });
      holds.set(row.runId, run);
      // oxlint-disable-next-line no-await-in-loop -- each run once, in order
      if (await run) {
        listed.push({
          id: row.id,
          runId: row.runId,
          name: row.name,
          type: row.type,
          size: row.size,
          writtenAt: row.finishedAt.toISOString(),
        });
      }
    }
    const last = rows.at(-1);
    if (
      rows.length < pageSize ||
      last === undefined ||
      last.finishedAt === null
    ) {
      break;
    }
    after = { at: last.finishedAt, id: last.id };
  }
  return listed;
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
