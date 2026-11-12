import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/runtime/host";
import { actorOf } from "@grasp-os/shared/audit";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import { identifierSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  workflowBindingApprovalSchema,
  workflowBindingTargetSchema,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowBindingApproval,
  WorkflowBindingTarget,
} from "@grasp-os/shared/workflow-resources";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { organizationId } from "./auth/auth.ts";
import { memberRole } from "./auth/identity.ts";
import {
  eventSources,
  permissions,
  teams,
  workflowBindingApprovals,
} from "./db/core/schema.ts";
import { modelSettings } from "./models.ts";
import { requireMemberAdmin, stillAdminSql } from "./permissions.ts";
import { resolveCatalogKeys } from "./workflow-catalog.ts";
import {
  bindingsOf,
  nextGeneration,
  requireWorkflowRole,
} from "./workflow-resources.ts";
import type { PinnedBinding } from "./workflow-resources.ts";
import { envelopedSchemaText } from "./workflows/connector-schemas.ts";
import { sourcedTypesOf } from "./workflows/event-waits.ts";

// Approved bindings of independent workflows (platform specification 13.2):
// which concrete resource serves each catalog binding a workflow declares
// (a connector, model, decision or event contract). A declaration is
// the workflow's requirement and grants nothing; an admin's approval, with
// the live grant it names, is what a start freezes and a run calls.
// Threat model, and how each is closed:
//
// - A declaration self-grants: an alias is served only by an active row
//   here, written by an admin of the organization (never Grasp staff or a
//   builder), re-checked in the writing statement, and audited.
// - A binding to a resource the workflow can't use: a connector target
//   must be a permission the workflow itself holds (subject the workflow,
//   active, on that connection, allowing every operation), never its owner's, an App's or one of another
//   workflow; a model one the deployment allows; a decision's
//   deciders people still in the organization, its teams or roles. A start
//   re-reads the permission as it admits (workflow-starts.ts), so revoking
//   it stops the next start.
// - An approval serving more than was reviewed: a row pins the alias's
//   declaration in the version the admin reviewed (its kind, contract key
//   and fingerprint) and serves that version alone. A version a builder
//   publishes later, declaring the alias the same, is code nobody reviewed
//   with that target (it could send what the connector reads anywhere),
//   and so is one published before: each needs its own approval. A start
//   requires the approval of its exact version as it is admitted.
// - A target that can't serve its contract, now or later: one function
//   answers whether it can (`requireTargetServes`), at approval and again
//   each time a start freezes its bindings (workflow-starts.ts), so an
//   approval never outlives its target. It loads the target as a call
//   would: a connector's contract as connect generates it for that
//   connection now. And it compares the real shapes with the contract's
//   exactly: each connector action's input and output JSON Schemas must
//   be the contract
//   descriptors' exact JSON Schemas, so a workflow never calls it with
//   what it doesn't take or reads back what it doesn't return. There is no
//   looser compatibility rule to apply yet, so anything but the same shape
//   is refused.
// - An App's store or functions: no target reaches them. Each App's store
//   is its own (data-stores.ts), and no workflow binding serves it.
// - A start on authority that changed: approving or revoking moves the
//   workflow's policy generation, so a start decided before is refused;
//   one that changed nothing refuses nothing.

export const approvalOf = (
  row: typeof workflowBindingApprovals.$inferSelect
): WorkflowBindingApproval => ({
  id: row.id,
  alias: row.alias,
  kind: row.kind,
  contractId: row.contractId,
  fingerprint: row.fingerprint,
  target: workflowBindingTargetSchema.parse(JSON.parse(row.target)),
  reviewedVersion: row.reviewedVersion,
  status: row.status,
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt.toISOString(),
});

const invalid = (issue: string) =>
  workflowResourceErrors.create("workflow.binding_invalid", {
    issues: [issue],
  });

/** An active permission of workflow `id`, if `permissionId` names one. */
const workflowPermission = async (env: Env, id: string, permissionId: string) =>
  await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(
      and(
        eq(permissions.id, permissionId),
        eq(permissions.subjectType, "workflow"),
        eq(permissions.subjectId, id),
        eq(permissions.status, "active")
      )
    )
    .get();

/** The actions a permission row allows. */
const actionsOf = (row: { actions: string }): string[] => {
  const parsed: unknown = JSON.parse(row.actions);
  return Array.isArray(parsed)
    ? parsed.filter((action): action is string => typeof action === "string")
    : [];
};

/**
 * Refuses a brain target unless it names a permission workflow `id`
 * itself holds, active, to read the Brain (`{ type: "platform" }`,
 * `brain`). Each recall checks it again, and reads as the person its run
 * acts for (workflows/brain-calls.ts).
 */
const requireBrainServes = async (
  env: Env,
  id: string,
  target: Extract<WorkflowBindingTarget, { kind: "brain" }>
): Promise<void> => {
  const row = await workflowPermission(env, id, target.permissionId);
  if (
    row?.objectType !== "platform" ||
    row.chatId !== null ||
    !actionsOf(row).includes("brain")
  ) {
    throw invalid(
      "target.permissionId: The workflow holds no permission to read the Brain."
    );
  }
};

/**
 * That a decision's deciders name people, teams and roles that exist: the
 * organization's members, its teams, and roles.
 */
const requireDeciders = async (
  env: Env,
  deciders: readonly string[]
): Promise<void> => {
  for (const decider of deciders) {
    const [type, id = ""] = decider.split(":", 2);
    if (type === "role") {
      if (!roleSchema.safeParse(id).success) {
        throw invalid("deciders: There's no such role.");
      }
      continue;
    }
    if (type === "team") {
      // oxlint-disable-next-line no-await-in-loop -- one point lookup per decider
      const team = await drizzle(env.DB)
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, id), eq(teams.organizationId, organizationId)))
        .get();
      if (team === undefined) {
        throw invalid("deciders: There's no such team.");
      }
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    if ((await memberRole(env.DB, id)) === undefined) {
      throw invalid("deciders: There's no such member of the organization.");
    }
  }
};

/** `descriptor` (its JSON text) as its exact JSON Schema. */
const schemaOfDescriptor = (
  descriptor: string | undefined
): string | undefined => {
  if (descriptor === undefined) {
    return undefined;
  }
  try {
    return canonicalJson(
      jsonSchemaOf(schemaFromDescriptor(descriptor).descriptor, {
        exact: true,
      })
    );
  } catch {
    return undefined;
  }
};

/**
 * A connector operation's shape as its exact JSON Schema: the connector's
 * own schema it holds (connector-schemas.ts), or its descriptor's.
 */
const connectorShapeOf = (text: string): string | undefined =>
  envelopedSchemaText(text) ?? schemaOfDescriptor(text);

/** That a JSON Schema (as data or JSON text) is exactly `expected`. */
const sameShape = (schema: unknown, expected: string | undefined): boolean => {
  if (expected === undefined) {
    return false;
  }
  try {
    const value: unknown =
      typeof schema === "string" ? JSON.parse(schema) : schema;
    return canonicalJson(z.json().parse(value)) === expected;
  } catch {
    return false;
  }
};

/**
 * Refuses a connector target that can't serve the catalog contract `key`
 * now: the workflow's own connection permission, and the contract connect
 * generates for that connection (`target.contract`), read now as a call
 * reads it. Every operation the catalog contract names must be an action
 * of it, which the permission allows, of exactly the contract's input and
 * output shapes. A connection that is gone, a contract it no longer
 * serves, or a server that can't list it now is refused: nothing is
 * approved, or started, on a shape nobody could read.
 */
const requireConnectorServes = async (
  env: Env,
  id: string,
  key: string,
  target: Extract<WorkflowBindingTarget, { kind: "connector" }>
): Promise<void> => {
  const row = await workflowPermission(env, id, target.permissionId);
  if (row?.objectType !== "connection") {
    throw invalid(
      "target.permissionId: The workflow holds no such connection permission."
    );
  }
  const contracts = await resolveCatalogKeys(env, [key]);
  const operations = Object.entries(
    contracts.get(key)?.contract.operations ?? {}
  );
  let served: ConnectorContract;
  try {
    served = await env.CONNECT.connectorContract({
      contract: target.contract,
      connectionId: row.objectId,
    });
  } catch (error) {
    if (isExpectedError(error)) {
      throw invalid(
        "target.contract: The connection doesn't serve that contract now."
      );
    }
    throw error;
  }
  const allowed = actionsOf(row);
  const actions = Object.values(served.actions);
  const serves =
    operations.length > 0 &&
    operations.every(([operation, shape]) => {
      const action = actions.find(({ tool }) => tool === operation);
      return (
        action !== undefined &&
        allowed.includes(action.tool) &&
        sameShape(action.input, connectorShapeOf(shape.input)) &&
        sameShape(action.output, connectorShapeOf(shape.output)) &&
        // A file answer, or attaching files (GRA-887), that the contract
        // records is the connector's too. One it doesn't record, the
        // connector may offer: the contract never asks for it (a call's
        // `into`, or `from`, is refused unless the sealed contract records
        // it, resource-calls.ts), and its shapes are compared above all
        // the same.
        (shape.answersFile !== true || action.answersFile === true) &&
        (shape.takesFiles !== true || action.takesFiles === true)
      );
    });
  if (!serves) {
    throw invalid(
      "target.contract: The connection's actions aren't the contract's operations, each of its exact shape, allowed by the permission."
    );
  }
};

/**
 * Refuses an event binding's target naming `source` unless it serves
 * `declared`: a live event source for a contract that takes types from
 * one, none for any other.
 */
const requireSourceServes = async (
  env: Env,
  declared: PinnedBinding,
  source: string | undefined
): Promise<void> => {
  const sourced = await sourcedTypesOf(env, declared);
  if (sourced.length === 0) {
    if (source !== undefined) {
      throw invalid(
        "target.source: Its contract takes no events from a webhook source."
      );
    }
    return;
  }
  if (source === undefined) {
    throw invalid(
      "target.source: Name the webhook source whose events its contract takes."
    );
  }
  const live = await drizzle(env.DB)
    .select({ id: eventSources.id })
    .from(eventSources)
    .where(and(eq(eventSources.id, source), isNull(eventSources.deletedAt)))
    .get();
  if (live === undefined) {
    throw invalid("target.source: No such webhook source.");
  }
};

/**
 * Refuses `target` unless it can serve `declared` for workflow `id` now,
 * as the threat model above says (`workflow.binding_invalid`, naming why):
 * the one answer approving and starting both take.
 */
export const requireTargetServes = async (
  env: Env,
  id: string,
  declared: PinnedBinding,
  target: WorkflowBindingTarget
): Promise<void> => {
  if (target.kind !== declared.kind) {
    throw invalid("target: Its kind isn't the binding's.");
  }
  switch (target.kind) {
    case "model": {
      const { models: allowed } = await modelSettings(env);
      if (!allowed.includes(target.model)) {
        throw invalid("target.model: The deployment doesn't allow it.");
      }
      break;
    }
    case "connector": {
      await requireConnectorServes(env, id, declared.contractId, target);
      break;
    }
    case "decision": {
      await requireDeciders(env, target.deciders);
      break;
    }
    case "event": {
      // An event's contract says which types it admits and with what
      // data, and every send is checked on its own. One whose contract
      // takes types from a webhook source names the live source whose
      // events reach it, and only such a one names a source
      // (event-waits.ts).
      await requireSourceServes(env, declared, target.source);
      break;
    }
    case "files": {
      // Nothing outside the run serves its own files (GRA-724).
      break;
    }
    case "brain": {
      await requireBrainServes(env, id, target);
      break;
    }
    default: {
      target satisfies never;
    }
  }
};

/**
 * What the audit log records of an approval's target: what serves the
 * binding, by its IDs, never a decision's deciders.
 */
const targetDetail = (
  target: WorkflowBindingTarget
): Record<string, string | number> => {
  switch (target.kind) {
    case "model": {
      return { targetKind: target.kind, model: target.model };
    }
    case "connector": {
      return {
        targetKind: target.kind,
        permissionId: target.permissionId,
        targetContract: target.contract,
      };
    }
    case "decision": {
      return { targetKind: target.kind, deciders: target.deciders.length };
    }
    case "event": {
      return {
        targetKind: target.kind,
        ...(target.source === undefined ? {} : { source: target.source }),
      };
    }
    case "brain": {
      return { targetKind: target.kind, permissionId: target.permissionId };
    }
    case "files": {
      return { targetKind: target.kind };
    }
    default: {
      return target satisfies never;
    }
  }
};

/**
 * Approves `input` for workflow `id`, for `by`, one of the organization's
 * own admins: the alias, its target and the version they reviewed, which
 * must declare the alias as a catalog binding of the target's kind, and
 * which alone it serves. Revokes that version's earlier approval of the
 * alias in the same batch.
 */
export const approveWorkflowBinding = async (
  env: Env,
  by: Identity,
  id: unknown,
  input: unknown
): Promise<WorkflowBindingApproval> => {
  requireMemberAdmin(by);
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const { alias, target, reviewed } = workflowResourceErrors.parse(
    "workflow.binding_invalid",
    workflowBindingApprovalSchema,
    input
  );
  const versions = await bindingsOf(env, workflow.id);
  const declared = versions
    .get(reviewed.version)
    ?.find((binding) => binding.alias === alias);
  if (declared === undefined) {
    throw invalid(
      "alias: The version reviewed declares no such catalog binding."
    );
  }
  await requireTargetServes(env, workflow.id, declared, target);
  const row: typeof workflowBindingApprovals.$inferSelect = {
    id: crypto.randomUUID(),
    workflowResourceId: workflow.id,
    alias,
    kind: declared.kind,
    contractId: declared.contractId,
    fingerprint: declared.fingerprint,
    target: JSON.stringify(target),
    reviewedVersion: reviewed.version,
    status: "active",
    approvedBy: by.userId,
    approvedAt: new Date(),
    revokedBy: null,
    revokedAt: null,
  };
  // Only while `by` is still an admin and the workflow is live, read in
  // the batch. Versions never change, so the one reviewed stays the one
  // served, whichever is current.
  const holds = sql`${stillAdminSql(by)} AND EXISTS (SELECT 1 FROM workflow_resources
    WHERE id = ${workflow.id} AND deleted_at IS NULL)`;
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(workflowBindingApprovals)
      .set({
        status: "revoked",
        revokedBy: by.userId,
        revokedAt: row.approvedAt,
      })
      .where(
        and(
          eq(workflowBindingApprovals.workflowResourceId, workflow.id),
          eq(workflowBindingApprovals.reviewedVersion, reviewed.version),
          eq(workflowBindingApprovals.alias, alias),
          eq(workflowBindingApprovals.status, "active"),
          holds
        )
      ),
    db.insert(workflowBindingApprovals).select(
      sql`SELECT ${row.id}, ${row.workflowResourceId}, ${row.alias}, ${row.kind},
        ${row.contractId}, ${row.fingerprint}, ${row.target}, ${row.reviewedVersion},
        'active', ${row.approvedBy}, ${row.approvedAt.getTime()}, NULL, NULL
        WHERE ${holds}`
    ),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "workflow.binding.approved",
      target: { type: "workflow_resource", id: workflow.id },
      detail: {
        approval: row.id,
        alias,
        kind: row.kind,
        contract: row.contractId,
        fingerprint: row.fingerprint,
        reviewedVersion: reviewed.version,
        ...targetDetail(target),
      },
    }),
    nextGeneration(
      db,
      workflow.id,
      sql`EXISTS (SELECT 1 FROM workflow_binding_approvals WHERE id = ${row.id})`
    ),
  ]);
  const stored = await drizzle(env.DB)
    .select()
    .from(workflowBindingApprovals)
    .where(eq(workflowBindingApprovals.id, row.id))
    .get();
  if (stored === undefined) {
    // `by` stopped being an admin, or the workflow was deleted, as it ran.
    throw workflowResourceErrors.create("workflow.resource_unavailable");
  }
  return approvalOf(stored);
};

/**
 * Revokes approval `approval` of workflow `id`, for `by`, one of the
 * organization's own admins: the next start of a version that needs it is
 * refused. Revoking one already revoked changes nothing.
 */
export const revokeWorkflowBinding = async (
  env: Env,
  by: Identity,
  id: unknown,
  approval: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const parsed = identifierSchema.safeParse(approval);
  if (!parsed.success) {
    throw invalid("approval: There's no such approval.");
  }
  const db = drizzle(env.DB);
  const revokedAt = new Date();
  const revoked = sql`EXISTS (SELECT 1 FROM ${workflowBindingApprovals}
        WHERE ${eq(workflowBindingApprovals.id, parsed.data)}
          AND ${eq(workflowBindingApprovals.status, "revoked")}
          AND ${eq(workflowBindingApprovals.revokedAt, revokedAt)})`;
  await auditedBatch(env, db, [
    db
      .update(workflowBindingApprovals)
      .set({ status: "revoked", revokedBy: by.userId, revokedAt })
      .where(
        and(
          eq(workflowBindingApprovals.id, parsed.data),
          eq(workflowBindingApprovals.workflowResourceId, workflow.id),
          eq(workflowBindingApprovals.status, "active"),
          stillAdminSql(by)
        )
      ),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "workflow.binding.revoked",
      target: { type: "workflow_resource", id: workflow.id },
      detail: { approval: parsed.data },
    }),
    nextGeneration(db, workflow.id, revoked),
  ]);
};

/**
 * The active approval serving `binding` of version `version` of workflow
 * `id`, if there is one: given for that exact version and declaration.
 */
export const approvalServing = async (
  env: Env,
  id: string,
  version: number,
  binding: PinnedBinding
): Promise<WorkflowBindingApproval | undefined> => {
  const row = await drizzle(env.DB)
    .select()
    .from(workflowBindingApprovals)
    .where(
      and(
        eq(workflowBindingApprovals.workflowResourceId, id),
        eq(workflowBindingApprovals.reviewedVersion, version),
        eq(workflowBindingApprovals.alias, binding.alias),
        eq(workflowBindingApprovals.kind, binding.kind),
        eq(workflowBindingApprovals.contractId, binding.contractId),
        eq(workflowBindingApprovals.fingerprint, binding.fingerprint),
        eq(workflowBindingApprovals.status, "active")
      )
    )
    .get();
  return row === undefined ? undefined : approvalOf(row);
};
