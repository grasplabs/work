import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { triggerIdSchema } from "@grasp-os/shared/ids";
import type { TriggerId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { isAdmin, requireBuilder } from "@grasp-os/shared/roles";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  triggerResources,
  triggerResourceVersions,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { notNullFailed } from "./db/d1.ts";
import { requireNotStaff } from "./sharing.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";
import { quotaPolicy } from "./workflows/quotas.ts";

// Independent triggers (platform specification 15, 24): each a resource of
// its own that starts one exact workflow version on its own. This is their
// registry: creating one, moving it to another version of its workflow,
// disabling and deleting it. What it may start is decided as for any other
// subject, by a permission of its own (`start` on the workflow), granted
// by an admin, and checked at every start (workflow-starts.ts).
//
// Threat model, and how each is closed:
//
// - A trigger acting as the workflow's owner. Its starts act for the
//   person bound when it was created (`principal_binding`): whoever created
//   it, never the workflow's owner, and only while they are still in the
//   organization.
// - A trigger following "latest". Each trigger version pins an exact,
//   published workflow version; publishing a new workflow version changes
//   no trigger. Moving a trigger to another version is a new trigger
//   version, audited, of the same workflow only.
// - Creating a trigger grants it something. Nothing: its creator must
//   build the workflow, and its starts still need a permission an admin
//   grants, naming the workflow it pins.
// - A trigger nobody may stop: the workflow's builders, and admins, may
//   disable or delete any trigger that starts it; only its owner moves or
//   re-enables it. Only an enabled trigger holding an active `start`
//   grant keeps the workflow from being deleted.
// - A trigger acting for someone who lost access: each start requires its
//   person to still have a role in the workflow (workflow-starts.ts).
// - Triggers piling up: a person has at most the quota policy's
//   `triggerResourcesPerPerson` live triggers.
// - Disabling or deleting it under a start. Every start reads the trigger
//   live and enabled in the statement that admits it, so one admitted
//   after either never lands. Runs already started go on (spec 15.3).
// - Grasp staff deciding what starts a client's workflow: they never
//   create, change or delete a trigger.

/** The kinds of trigger: what each is started by. */
export const triggerKinds = [
  "system",
  "connector",
  "webhook",
  "schedule",
] as const;

const createTriggerSchema = z.strictObject({
  kind: z.enum(triggerKinds),
  workflowId: z.string().min(1).max(128),
  version: z.number().int().positive(),
  /** The trigger's own configuration: its schedule, event type, mapping. */
  config: z.json(),
});

/** A trigger, as its registry answers it. */
export interface TriggerResource {
  id: TriggerId;
  kind: (typeof triggerKinds)[number];
  owner: string;
  version: number;
  workflowId: string;
  workflowVersion: number;
  principal: string;
  enabled: boolean;
}

const unavailable = () =>
  workflowResourceErrors.create("workflow.trigger_unavailable");

const entry = (
  by: Acting,
  action: string,
  id: string,
  detail: AuditEntry["detail"] = {}
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action,
  target: { type: "trigger", id },
  detail,
});

/** Refuses a workflow version that wasn't published. */
const requirePublished = async (
  env: Env,
  workflowId: string,
  version: number
): Promise<void> => {
  const row = await drizzle(env.DB)
    .select({ version: workflowResourceVersions.version })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, workflowId),
        eq(workflowResourceVersions.version, version)
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
};

/**
 * Creates a trigger of `input.kind` that starts exactly version
 * `input.version` of workflow `input.workflowId`, acting for `by`, who must
 * build the workflow. It may start nothing until an admin grants it
 * `start` on the workflow. A person has at most the quota policy's
 * `triggerResourcesPerPerson` live triggers (`workflow.trigger_limit`),
 * counted in the insert; the workflow must be live as it lands.
 */
export const createTriggerResource = async (
  env: Env,
  by: Acting,
  input: unknown
): Promise<TriggerResource> => {
  requireBuilder(by);
  requireNotStaff(by);
  const { kind, workflowId, version, config } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    createTriggerSchema,
    input
  );
  const workflow = await requireWorkflowRole(env, by, workflowId, "builder");
  await requirePublished(env, workflow.id, version);
  const id = triggerIdSchema.parse(crypto.randomUUID());
  const configHash = await sha256Hex(canonicalJson(config));
  const policy = await quotaPolicy(env);
  const cap = policy.limits.triggerResourcesPerPerson;
  const now = new Date();
  const db = drizzle(env.DB);
  const batch = auditedBatch(env, db, [
    db.insert(triggerResources).values({
      // Only while `by` is under the cap, counted in this statement:
      // otherwise NULL, which fails the batch.
      id: sql`(SELECT ${id} WHERE (SELECT COUNT(*) FROM trigger_resources
        WHERE owner_id = ${by.userId} AND deleted_at IS NULL) < ${cap})`,
      ownerId: by.userId,
      kind,
      currentVersion: 1,
      enabled: true,
      createdAt: now,
    }),
    db.insert(triggerResourceVersions).values({
      triggerId: id,
      version: 1,
      // Only while the workflow is live: otherwise NULL, which fails the
      // batch, so a deletion and a new trigger never both land.
      workflowResourceId: sql`(SELECT id FROM workflow_resources
        WHERE id = ${workflow.id} AND deleted_at IS NULL)`,
      workflowResourceVersion: version,
      configHash,
      principalBinding: by.userId,
      createdAt: now,
    }),
    outboxed(
      db,
      entry(by, "trigger.created", id, {
        kind,
        workflowId: workflow.id,
        workflowVersion: version,
        configHash,
      })
    ),
  ]);
  try {
    await batch;
  } catch (error) {
    if (notNullFailed(error, "trigger_resources.id")) {
      throw workflowResourceErrors.create("workflow.trigger_limit");
    }
    if (
      notNullFailed(error, "trigger_resource_versions.workflow_resource_id")
    ) {
      throw workflowResourceErrors.create("workflow.resource_unavailable");
    }
    throw error;
  }
  return {
    id,
    kind,
    owner: by.userId,
    version: 1,
    workflowId: workflow.id,
    workflowVersion: version,
    principal: by.userId,
    enabled: true,
  };
};

/**
 * The live trigger `id`, if `by` may act on it as `as` says, never Grasp
 * staff: to `manage` it (see it, disable or delete it), its owner, an
 * admin, or a builder of the workflow it starts, so no trigger keeps a
 * workflow's builders from stopping it; to `own` it (move it to another
 * version, enable it again), its owner alone, whose person it acts for.
 * Anyone else gets `workflow.trigger_unavailable`, as for one that
 * doesn't exist.
 */
export const requireTriggerManager = async (
  env: Env,
  by: Acting,
  id: unknown,
  as: "manage" | "own" = "manage"
): Promise<TriggerResource> => {
  requireNotStaff(by);
  const parsed = triggerIdSchema.safeParse(id);
  if (!parsed.success) {
    throw unavailable();
  }
  const row = await drizzle(env.DB)
    .select({
      kind: triggerResources.kind,
      owner: triggerResources.ownerId,
      version: triggerResources.currentVersion,
      enabled: triggerResources.enabled,
      workflowId: triggerResourceVersions.workflowResourceId,
      workflowVersion: triggerResourceVersions.workflowResourceVersion,
      principal: triggerResourceVersions.principalBinding,
    })
    .from(triggerResources)
    .innerJoin(
      triggerResourceVersions,
      and(
        eq(triggerResourceVersions.triggerId, triggerResources.id),
        eq(triggerResourceVersions.version, triggerResources.currentVersion)
      )
    )
    .where(
      and(
        eq(triggerResources.id, parsed.data),
        isNull(triggerResources.deletedAt)
      )
    )
    .get();
  if (row === undefined) {
    throw unavailable();
  }
  if (row.owner === by.userId) {
    return { id: parsed.data, ...row };
  }
  if (as === "own") {
    throw unavailable();
  }
  if (isAdmin(by.role)) {
    return { id: parsed.data, ...row };
  }
  try {
    await requireWorkflowRole(env, by, row.workflowId, "builder");
  } catch (error) {
    if (isExpectedError(error)) {
      throw unavailable();
    }
    throw error;
  }
  return { id: parsed.data, ...row };
};

/**
 * Moves trigger `id` to version `version` of its own workflow, for `by`,
 * its owner, who must still have a role in the workflow: a new trigger
 * version, audited, used by future starts only. Its principal stays.
 */
export const updateTriggerVersion = async (
  env: Env,
  by: Acting,
  id: unknown,
  version: unknown
): Promise<TriggerResource> => {
  const trigger = await requireTriggerManager(env, by, id, "own");
  const target = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    z.number().int().positive(),
    version
  );
  await requireWorkflowRole(env, by, trigger.workflowId, "user");
  await requirePublished(env, trigger.workflowId, target);
  const next = trigger.version + 1;
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db.insert(triggerResourceVersions).values({
      triggerId: trigger.id,
      version: next,
      workflowResourceId: trigger.workflowId,
      workflowResourceVersion: target,
      configHash: sql`(SELECT config_hash FROM trigger_resource_versions
        WHERE trigger_id = ${trigger.id} AND version = ${trigger.version})`,
      principalBinding: trigger.principal,
      createdAt: new Date(),
    }),
    db
      .update(triggerResources)
      .set({ currentVersion: next })
      .where(eq(triggerResources.id, trigger.id)),
    outboxed(
      db,
      entry(by, "trigger.updated", trigger.id, {
        version: next,
        workflowVersion: target,
      })
    ),
  ]);
  return { ...trigger, version: next, workflowVersion: target };
};

/**
 * Disables trigger `id` for `by`, who manages it, or enables it again for
 * its owner: disabled, it starts nothing more; runs it started go on.
 */
export const setTriggerEnabled = async (
  env: Env,
  by: Acting,
  id: unknown,
  enabled: boolean
): Promise<void> => {
  const trigger = await requireTriggerManager(
    env,
    by,
    id,
    enabled ? "own" : "manage"
  );
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(triggerResources)
      .set({ enabled })
      .where(
        and(
          eq(triggerResources.id, trigger.id),
          eq(triggerResources.enabled, !enabled)
        )
      ),
    outboxedIfChanged(
      db,
      entry(by, enabled ? "trigger.enabled" : "trigger.disabled", trigger.id)
    ),
  ]);
};

/** Deletes trigger `id` for `by`, who manages it: it starts nothing more. */
export const deleteTriggerResource = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<void> => {
  const trigger = await requireTriggerManager(env, by, id);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(triggerResources)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(triggerResources.id, trigger.id),
          isNull(triggerResources.deletedAt)
        )
      ),
    outboxedIfChanged(db, entry(by, "trigger.deleted", trigger.id)),
  ]);
};
