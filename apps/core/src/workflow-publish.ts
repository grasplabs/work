import { createAuditEvent } from "@grasp-os/shared/audit";
import { draftErrors } from "@grasp-os/shared/drafts";
import { nextReleaseId, releaseMonthPrefix } from "@grasp-os/shared/release-id";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
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
  workflowResources,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { retriedBatch } from "./db/d1.ts";
import { subjectEntry } from "./drafts.ts";
import type { PublishSteps } from "./publish.ts";
import { triggersFollowing } from "./trigger-resources.ts";
import {
  buildWorkflowVersion,
  definitionProblems,
  liveWorkflow,
  requireWorkflowRole,
  workflowFile,
} from "./workflow-resources.ts";

// Publishing an independent workflow (GRA-1665): its steps of
// publish.ts's publish and roll back (`workflowSteps`). Its draft is one
// file, `workflow.json`; building it checks it as the profile and the catalog
// do and compiles it once into the version's sealed build
// (workflow-resources.ts, `buildWorkflowVersion`); activating a version
// makes it the one the workflow runs: what a start by hand, an agent's,
// an App's binding and its triggers start from then on, for everyone.
//
// Threat model, and how each is closed:
//
// - Two publishes, or a publish and a roll back, at once: each makes its
//   version live only over the version live when it began, compared and
//   set in the statement that does it; the other is `draft.conflict`.
// - A run changing under its feet: a run keeps the version it started on
//   to its end, whatever goes live since; only new starts take the new
//   one.
// - Another builder changing what runs as a trigger's person: a trigger
//   starts the version live (trigger-resources.ts), so making one live
//   changes what each trigger runs as its owner. Allowed, and audited for
//   each trigger it affects, by whoever made it live, in the batch that
//   does; each owner other than them is told (`triggersFollowing`).
// - New access without an admin: an approval is of one binding (alias,
//   kind, contract key and fingerprint), whichever version declares it
//   (workflow-bindings.ts), so going live copies nothing: a version that
//   declares a binding no active approval serves waits for an admin's,
//   and its starts are refused until then; a revoked one stays revoked
//   for every version, a roll back included.
// - An App's pages naming what the workflow no longer takes: an App's
//   binding follows the workflow's live version, so a version whose
//   events, decisions or listen tasks differ from what an App binding it
//   declares never goes live (`workflow.app_binding_contract_changed`),
//   checked against each bound App's current version and required still
//   so in the batch that makes it live, as an App's publish requires the
//   workflow's live version it checked (app-workflow-bindings.ts). An App
//   with no current version declares nothing yet: its first publish
//   checks its declaration against the version live then.
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
 * Makes `version` of workflow `id` live for `by`, who builds it, over
 * `basedOn`, the version live when the publish began, audited as
 * `action`, with `alongside` in the batch (`PublishSteps.activate`): its
 * label, given now the first time it goes live; its triggers' owners
 * told. A version live already is answered its label.
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
  const appsDeclare = await requireBoundAppsDeclare(env, workflow.id, version);
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
  const triggers = await triggersFollowing(
    env,
    by,
    workflow.id,
    { version, previous: basedOn },
    live
  );
  const statements = [
    db
      .update(workflowResources)
      .set({ currentVersion: version })
      .where(
        and(
          eq(workflowResources.id, workflow.id),
          sql`${workflowResources.currentVersion} IS ${basedOn}`,
          sql`${workflowResources.deletedAt} IS NULL`,
          // An App bound, or a bound App's version made current, since
          // its declaration was checked.
          appsDeclare
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
    ...triggers,
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
  // An App bound since whose declaration this version doesn't fit: named.
  await requireBoundAppsDeclare(env, workflow.id, version);
  throw draftErrors.create("draft.conflict");
};

/**
 * How a workflow's draft is published (publish.ts): its one file,
 * `workflow.json`, checked as the profile and the catalog take it
 * (`definitionProblems`), built as its next version
 * (`buildWorkflowVersion`), made live by `activate`.
 */
export const workflowSteps: PublishSteps = {
  check: async (env, by, id, { files }) => {
    const problems = await definitionProblems(
      env,
      by,
      files.get(workflowFile) ?? "",
      id
    );
    return {
      passed: problems.length === 0,
      problems: problems.map(({ pointer, message }) => ({
        at: pointer,
        line: null,
        message,
      })),
    };
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
};
