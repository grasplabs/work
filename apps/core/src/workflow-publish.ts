import { createAuditEvent } from "@grasp-os/shared/audit";
import { draftErrors } from "@grasp-os/shared/drafts";
import { nextReleaseId, releaseMonthPrefix } from "@grasp-os/shared/release-id";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceVersion } from "@grasp-os/shared/workflow-resources";
import { and, eq, like, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { requireBoundAppsDeclare } from "./app-workflow-bindings.ts";
import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
} from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  auditOutbox,
  workflowBindingApprovals,
  workflowResources,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { retriedBatch } from "./db/d1.ts";
import { subjectEntry } from "./drafts.ts";
import type { Publishable } from "./publish.ts";
import { triggersMovedTo } from "./trigger-resources.ts";
import {
  bindingsOf,
  buildPublication,
  buildWorkflowVersion,
  checkPublication,
  liveWorkflow,
  requireWorkflowRole,
  workflowDraftKind,
  workflowFile,
} from "./workflow-resources.ts";

// Publishing an independent workflow (GRA-1665): its steps of publish.ts's
// publish and roll back (`workflowPublishing`). Its draft is one file,
// `workflow.json`; building it checks it as the profile and the catalog
// do and compiles it once into the version's sealed build
// (workflow-resources.ts, `buildWorkflowVersion`); activating a version
// makes it the one the workflow runs: what a start by hand, an App's
// binding and every enabled trigger start from then on.
//
// Threat model, and how each is closed:
//
// - Two publishes, or a publish and a roll back, at once: each makes its
//   version live only over the version live when it began, compared and
//   set in the statement that does it; the other is `draft.conflict`.
// - A run changing under its feet: a run keeps the version it started on
//   to its end, whatever goes live since; only new starts take the new
//   one.
// - A trigger left on a version nobody runs, or moved to one that doesn't
//   take its input: every enabled trigger moves onto the version in the
//   batch that makes it live, or none does, and a schedule's input is
//   checked against the version first (trigger-resources.ts,
//   `triggersMovedTo`).
// - New access without an admin: an approval serves the version it was
//   given for. Going live, a version takes over the live version's active
//   approvals of the bindings it declares exactly alike (alias, kind,
//   contract key and fingerprint), in the same batch, under the admin who
//   gave them: the code reaches nothing it couldn't reach before. A
//   binding it declares anew, or otherwise, waits for an admin's approval
//   (workflow-bindings.ts), and its starts are refused until then.
// - An App's pages naming what the workflow no longer takes: an App's
//   binding follows the workflow's live version, so a version whose
//   events, decisions or listen tasks differ from what an App binding it
//   declares never goes live (`workflow.app_binding_contract_changed`).
// - A batch whose answer was lost, tried again (`retriedBatch`): its event
//   is stored by the try that landed, and found by the one after; every
//   other statement holds only once, so the retry is answered as the
//   publish it is.

/**
 * The label the next version of workflow `id` to go live takes at `at`
 * (`YY.MM.N`, @grasp-os/shared/release-id), as an App's does.
 */
const nextLabel = async (env: Env, id: string, at: Date): Promise<string> => {
  const rows = await drizzle(env.DB)
    .select({ label: workflowResourceVersions.label })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, id),
        like(workflowResourceVersions.label, `${releaseMonthPrefix(at)}%`)
      )
    );
  return nextReleaseId(
    rows.flatMap(({ label }) => (label === null ? [] : [label])),
    at
  );
};

/**
 * The statements that give version `version` of workflow `id` the active
 * approvals of version `from` (none for a first version) of the bindings
 * it declares exactly alike, each only while `live` holds and the version
 * has none for that alias yet.
 */
const approvalsCarried = async (
  env: Env,
  id: string,
  { from, version }: { from: number | null; version: number },
  live: SQL
) => {
  if (from === null) {
    return [];
  }
  const db = drizzle(env.DB);
  const [held, declared] = await Promise.all([
    db
      .select()
      .from(workflowBindingApprovals)
      .where(
        and(
          eq(workflowBindingApprovals.workflowResourceId, id),
          eq(workflowBindingApprovals.reviewedVersion, from),
          eq(workflowBindingApprovals.status, "active")
        )
      )
      .all(),
    bindingsOf(env, id, version),
  ]);
  const same = new Set(
    (declared.get(version) ?? []).map(
      ({ alias, kind, contractId, fingerprint }) =>
        [alias, kind, contractId, fingerprint].join("\n")
    )
  );
  return held
    .filter(({ alias, kind, contractId, fingerprint }) =>
      same.has([alias, kind, contractId, fingerprint].join("\n"))
    )
    .map((approval) =>
      // In the table's column order.
      db.insert(workflowBindingApprovals).select(
        sql`SELECT ${crypto.randomUUID()}, ${id}, ${approval.alias},
          ${approval.kind}, ${approval.contractId}, ${approval.fingerprint},
          ${approval.target}, ${version}, 'active', ${approval.approvedBy},
          ${approval.approvedAt.getTime()}, NULL, NULL
        WHERE ${live}
          AND EXISTS (SELECT 1 FROM workflow_binding_approvals
            WHERE id = ${approval.id} AND status = 'active')
          AND NOT EXISTS (SELECT 1 FROM workflow_binding_approvals
            WHERE workflow_resource_id = ${id}
              AND reviewed_version = ${version}
              AND alias = ${approval.alias} AND status = 'active')`
      )
    );
};

/**
 * Makes `version` of workflow `id` live for `by`, who builds it, over
 * `basedOn`, the version live when the publish began, audited as
 * `action`, with `alongside` in the batch (`PublishSteps.activate`): its
 * label, given now the first time it goes live; its enabled triggers
 * moved onto it; the live version's approvals carried over. A version
 * live already is answered its label.
 */
const activate = async (
  env: Env,
  by: Acting,
  id: string,
  {
    version,
    basedOn,
    action,
    alongside,
  }: {
    version: number;
    basedOn: number | null;
    action: "version.published" | "version.rolled_back";
    alongside: (live: SQL) => Promise<BatchItem<"sqlite">[]>;
  }
): Promise<string> => {
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const row = await drizzle(env.DB)
    .select({ label: workflowResourceVersions.label })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, workflow.id),
        eq(workflowResourceVersions.version, version)
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  if (workflow.currentVersion === version && row.label !== null) {
    return row.label;
  }
  if (workflow.currentVersion !== basedOn) {
    throw draftErrors.create("draft.conflict");
  }
  await requireBoundAppsDeclare(env, workflow.id, version);
  const at = new Date();
  const label = row.label ?? (await nextLabel(env, workflow.id, at));
  const event = createAuditEvent(
    subjectEntry(
      by,
      action,
      { kind: "workflow", id: workflow.id },
      { version, label, previous: basedOn }
    ),
    "core"
  );
  const live = storedEvent(event.id);
  const db = drizzle(env.DB);
  const triggers = await triggersMovedTo(env, workflow.id, version, live, at);
  const statements = [
    db
      .update(workflowResources)
      .set({ currentVersion: version })
      .where(
        and(
          eq(workflowResources.id, workflow.id),
          sql`${workflowResources.currentVersion} IS ${basedOn}`,
          sql`${workflowResources.deletedAt} IS NULL`
        )
      )
      .returning({ id: workflowResources.id }),
    outboxedEventWhere(db, event, sql`changes() > 0`),
    db
      .update(workflowResourceVersions)
      .set({ label })
      .where(
        and(
          eq(workflowResourceVersions.workflowResourceId, workflow.id),
          eq(workflowResourceVersions.version, version),
          sql`${workflowResourceVersions.label} IS NULL`,
          live
        )
      ),
    ...(await approvalsCarried(
      env,
      workflow.id,
      { from: basedOn, version },
      live
    )),
    ...triggers.statements,
    ...(await alongside(live)),
  ] as const;
  const [changed] = await retriedBatch(
    async () => await auditedBatch(env, db, statements)
  );
  if (changed.length > 0) {
    return label;
  }
  // Only this call's batch stores its event, and only if it made the
  // version live: found stored, an earlier try landed and its answer was
  // lost. Once the outbox drained it, the version found live is answered
  // as made live all the same: what was asked holds.
  const ours = await db
    .select({ id: auditOutbox.id })
    .from(auditOutbox)
    .where(eq(auditOutbox.id, event.id))
    .get();
  const now = await liveWorkflow(env, workflow.id);
  if (now === undefined) {
    throw workflowResourceErrors.create("workflow.resource_unavailable");
  }
  if (ours !== undefined || now.currentVersion === version) {
    const kept = await db
      .select({ label: workflowResourceVersions.label })
      .from(workflowResourceVersions)
      .where(
        and(
          eq(workflowResourceVersions.workflowResourceId, workflow.id),
          eq(workflowResourceVersions.version, version)
        )
      )
      .get();
    return kept?.label ?? label;
  }
  throw draftErrors.create("draft.conflict");
};

/** How a workflow's draft is published (publish.ts). */
export const workflowPublishing: Publishable = {
  draft: workflowDraftKind,
  steps: {
    check: async (env, by, id, _draft, files) => {
      const workflow = await requireWorkflowRole(env, by, id, "builder");
      await checkPublication(env, by, workflow, files.get(workflowFile) ?? "");
    },
    build: async (env, by, id, { files }) => {
      const workflow = await requireWorkflowRole(env, by, id, "builder");
      const built = await buildWorkflowVersion(
        env,
        by,
        workflow,
        files.get(workflowFile) ?? ""
      );
      return built.version;
    },
    activate,
  },
};

/**
 * Publishes `input` (a definition, and the live version it built on) as
 * workflow `id`'s next version and makes it live, for `by`, who builds it
 * (workflow-resources.ts, `buildPublication`, then `activate`): what
 * app-blueprints.ts makes a blueprint's workflows with, outside any
 * draft. A retry of one that landed answers the version it made live;
 * one that lost a race to another is `workflow.version_conflict`, the
 * version it built left unlabelled, never live.
 */
export const publishWorkflowVersion = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowResourceVersion> => {
  const { workflow, version } = await buildPublication(env, by, id, input);
  try {
    const label = await activate(env, by, workflow.id, {
      version: version.version,
      basedOn: workflow.currentVersion,
      action: "version.published",
      alongside: async () => await Promise.resolve([]),
    });
    return { ...version, label };
  } catch (error) {
    // Another version went live over the one it built on.
    if (draftErrors.codeOf(error) === "draft.conflict") {
      throw workflowResourceErrors.create("workflow.version_conflict");
    }
    throw error;
  }
};
