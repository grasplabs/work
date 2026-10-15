import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import { appExportsSchema } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema, identifierSchema } from "@grasp-os/shared/ids";
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
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { requireReleaseLoads } from "./app-releases.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { organizationId } from "./auth/auth.ts";
import type { Acting } from "./auth/identity.ts";
import { memberRole } from "./auth/identity.ts";
import {
  appVersions,
  permissions,
  sdkReleasePins,
  teams,
  workflowBindingApprovals,
} from "./db/core/schema.ts";
import { gatewaySettings } from "./models.ts";
import { requireMemberAdmin, stillAdminSql } from "./permissions.ts";
import { resolveCatalogKeys } from "./workflow-catalog.ts";
import {
  bindingsOf,
  nextGeneration,
  requireWorkflowRole,
} from "./workflow-resources.ts";
import type { PinnedBinding } from "./workflow-resources.ts";

// Approved bindings of independent workflows (platform specification 13.2):
// which concrete resource serves each catalog binding a workflow declares
// (an operation, connector, model or decision contract). A declaration is
// the workflow's requirement and grants nothing; an admin's approval, with
// the live grant it names, is what a start freezes and a run calls.
// Threat model, and how each is closed:
//
// - A declaration self-grants: an alias is served only by an active row
//   here, written by an admin of the organization (never Grasp staff or a
//   builder), re-checked in the writing statement, and audited.
// - A binding to a resource the workflow can't use: a connector or
//   operation target must be a permission the workflow itself holds
//   (subject the workflow, active, on that connection or App, allowing
//   every operation or the export), never its owner's, an App's or one of
//   another workflow; a model one the deployment allows; a decision's
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
//   would: an operation's exact release through the release loader's own
//   checks (sealed, not revoked, its manifest intact), a connector's
//   contract as connect generates it for that connection now. And it
//   compares the real shapes with the contract's exactly: each export's or
//   connector action's input and output JSON Schemas must be the contract
//   descriptors' exact JSON Schemas, so a workflow never calls it with
//   what it doesn't take or reads back what it doesn't return. There is no
//   looser compatibility rule to apply yet, so anything but the same shape
//   is refused.
// - An operation's code going away under an approval: it names an exact,
//   sealed release of the App, which the approval pins (`approval` in
//   `sdk_release_pins`) while it is active, so retention keeps that
//   release; revoking it, or deleting the workflow, releases the pin.
// - A start on authority that changed: approving or revoking moves the
//   workflow's policy generation, so a start decided before is refused;
//   one that changed nothing refuses nothing.

const approvalOf = (
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

/** `descriptor` (its JSON text) as the exact JSON Schema an export states. */
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
        sameShape(action.input, schemaOfDescriptor(shape.input)) &&
        sameShape(action.output, schemaOfDescriptor(shape.output))
      );
    });
  if (!serves) {
    throw invalid(
      "target.contract: The connection's actions aren't the contract's operations, each of its exact shape, allowed by the permission."
    );
  }
};

/**
 * Refuses an operation target the workflow may not call now, or that
 * doesn't take and return what the catalog contract `key` says: the App
 * version must load as a release does (sealed, not revoked, its manifest
 * intact: `requireReleaseLoads`), and its export's input and output must
 * be the contract's, exactly.
 */
const requireOperationServes = async (
  env: Env,
  id: string,
  key: string,
  target: Extract<WorkflowBindingTarget, { kind: "operation" }>
): Promise<void> => {
  const row = await workflowPermission(env, id, target.permissionId);
  if (row?.objectType !== "app") {
    throw invalid(
      "target.permissionId: The workflow holds no permission on that App's exports."
    );
  }
  const app = appIdSchema.safeParse(row.objectId);
  try {
    if (!app.success) {
      throw invalid("target.permissionId: It names no App.");
    }
    await requireReleaseLoads(env, app.data, target.appVersion);
  } catch (error) {
    if (isExpectedError(error)) {
      throw invalid(
        "target.appVersion: That release of the App doesn't load: it isn't sealed, it was revoked, or it no longer matches its seal."
      );
    }
    throw error;
  }
  const version = await drizzle(env.DB)
    .select({ exports: appVersions.exports })
    .from(appVersions)
    .where(
      and(
        eq(appVersions.appId, row.objectId),
        eq(appVersions.version, target.appVersion)
      )
    )
    .get();
  const exported = appExportsSchema.safeParse(version?.exports ?? {}).data?.[
    target.export
  ];
  const actions = actionsOf(row);
  if (
    exported === undefined ||
    !(actions.includes(target.export) || actions.includes(exported.access))
  ) {
    throw invalid(
      "target.export: That sealed App version exports no such function the workflow may call."
    );
  }
  const contracts = await resolveCatalogKeys(env, [key]);
  const contract = contracts.get(key)?.contract;
  if (
    !sameShape(exported.input, schemaOfDescriptor(contract?.input)) ||
    !sameShape(exported.output, schemaOfDescriptor(contract?.output))
  ) {
    throw invalid(
      "target.export: Its input and output aren't the operation contract's."
    );
  }
};

/**
 * Releases the pins of workflow `id`'s approvals that no longer serve: as
 * a statement for the batch that revokes them.
 */
export const approvalPinsReleased = (
  db: ReturnType<typeof drizzle>,
  id: string
) =>
  db.delete(sdkReleasePins).where(
    and(
      eq(sdkReleasePins.holderKind, "approval"),
      sql`${sdkReleasePins.holderId} IN (SELECT approval.id
          FROM workflow_binding_approvals AS approval
          JOIN workflow_resources AS workflow ON workflow.id = approval.workflow_resource_id
          WHERE approval.workflow_resource_id = ${id}
            AND (approval.status = 'revoked' OR workflow.deleted_at IS NOT NULL))`
    )
  );

/**
 * Refuses `target` unless it can serve `declared` for workflow `id` now,
 * as the threat model above says (`workflow.binding_invalid`, naming why):
 * the one answer approving and starting both take.
 */
export const requireTargetServes = async (
  env: Env,
  id: string,
  declared: Extract<PinnedBinding, { resourceId: null }>,
  target: WorkflowBindingTarget
): Promise<void> => {
  if (target.kind !== declared.kind) {
    throw invalid("target: Its kind isn't the binding's.");
  }
  switch (target.kind) {
    case "model": {
      if (!gatewaySettings(env).models.includes(target.model)) {
        throw invalid("target.model: The deployment doesn't allow it.");
      }
      return;
    }
    case "connector": {
      await requireConnectorServes(env, id, declared.contractId, target);
      return;
    }
    case "operation": {
      await requireOperationServes(env, id, declared.contractId, target);
      return;
    }
    case "decision": {
      await requireDeciders(env, target.deciders);
      return;
    }
    default: {
      target satisfies never;
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
  if (declared === undefined || declared.resourceId !== null) {
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
      },
    }),
    nextGeneration(
      db,
      workflow.id,
      sql`EXISTS (SELECT 1 FROM workflow_binding_approvals WHERE id = ${row.id})`
    ),
    // An operation's release, kept while the approval serves.
    ...(target.kind === "operation"
      ? [
          db.insert(sdkReleasePins).select(
            sql`SELECT manifest.app_id, manifest.version, 'approval', ${row.id},
                NULL, ${row.approvedAt.getTime()}
              FROM sdk_release_manifests AS manifest
              JOIN permissions AS held ON held.id = ${target.permissionId}
              WHERE manifest.app_id = held.object_id
                AND manifest.version = ${target.appVersion}
                AND EXISTS (SELECT 1 FROM workflow_binding_approvals
                  WHERE id = ${row.id})`
          ),
        ]
      : []),
    approvalPinsReleased(db, workflow.id),
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
    nextGeneration(
      db,
      workflow.id,
      sql`EXISTS (SELECT 1 FROM ${workflowBindingApprovals}
        WHERE ${eq(workflowBindingApprovals.id, parsed.data)}
          AND ${eq(workflowBindingApprovals.status, "revoked")}
          AND ${eq(workflowBindingApprovals.revokedAt, revokedAt)})`
    ),
    approvalPinsReleased(db, workflow.id),
  ]);
};

/** Workflow `id`'s active approvals, by alias, for anyone with a role. */
export const listWorkflowBindings = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowBindingApproval[]> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowBindingApprovals)
    .where(
      and(
        eq(workflowBindingApprovals.workflowResourceId, workflow.id),
        eq(workflowBindingApprovals.status, "active")
      )
    )
    .orderBy(asc(workflowBindingApprovals.alias));
  return rows.map(approvalOf);
};

/**
 * The active approval serving `binding` of version `version` of workflow
 * `id`, if there is one: given for that exact version and declaration.
 */
export const approvalServing = async (
  env: Env,
  id: string,
  version: number,
  binding: Extract<PinnedBinding, { resourceId: null }>
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
