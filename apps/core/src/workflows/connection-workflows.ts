import { workflowBindingTargetSchema } from "@grasp-os/shared/workflow-resources";
import type {
  ConnectionWorkflow,
  ConnectionWorkflows,
} from "@grasp-os/shared/workflows";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Member } from "../auth/identity.ts";
import {
  permissions,
  sdkResourceBindings,
  workflowBindingApprovals,
  workflowResources,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { listWorkflowResources } from "../workflow-resources.ts";

// Which independent workflows use each connection, for Integrations: each
// whose current version declares a connector binding that an active
// approval serves through the workflow's own active permission on it, as
// Grasp's admin reads what workflows need (admin-integrations.ts). Only the
// workflows the person can open (`listWorkflowResources`).

/** A binding the current version of a live workflow declares, with its approval's target, if any. */
export interface DeclaredBinding {
  workflowId: string;
  workflowName: string;
  alias: string;
  /** The approved target's permission; null while no approval serves it. */
  permissionId: string | null;
}

/**
 * Every connector binding the current version of each live workflow
 * declares, with the permission its active approval names, where an
 * admin approved one for that very declaration (`approvalServing`).
 */
export const connectorBindingsOf = async (
  env: Env
): Promise<DeclaredBinding[]> => {
  const db = drizzle(env.DB);
  const [declared, approvals] = await Promise.all([
    db
      .select({
        workflowId: workflowResources.id,
        workflowName: workflowResources.name,
        alias: sdkResourceBindings.alias,
        contractId: sdkResourceBindings.targetId,
        fingerprint: sdkResourceBindings.schemaHash,
      })
      .from(sdkResourceBindings)
      .innerJoin(
        workflowResources,
        and(
          eq(sdkResourceBindings.resourceId, workflowResources.id),
          eq(
            sdkResourceBindings.resourceVersion,
            workflowResources.currentVersion
          )
        )
      )
      .where(
        and(
          eq(sdkResourceBindings.kind, "connector"),
          isNull(workflowResources.deletedAt)
        )
      ),
    db
      .select({
        workflowId: workflowBindingApprovals.workflowResourceId,
        alias: workflowBindingApprovals.alias,
        contractId: workflowBindingApprovals.contractId,
        fingerprint: workflowBindingApprovals.fingerprint,
        target: workflowBindingApprovals.target,
      })
      .from(workflowBindingApprovals)
      .innerJoin(
        workflowResources,
        and(
          eq(workflowBindingApprovals.workflowResourceId, workflowResources.id),
          eq(
            workflowBindingApprovals.reviewedVersion,
            workflowResources.currentVersion
          )
        )
      )
      .where(
        and(
          eq(workflowBindingApprovals.kind, "connector"),
          eq(workflowBindingApprovals.status, "active")
        )
      ),
  ]);
  const served = new Map<string, string>();
  for (const approval of approvals) {
    const target = workflowBindingTargetSchema.safeParse(
      JSON.parse(approval.target)
    );
    if (target.data?.kind !== "connector") {
      continue;
    }
    served.set(
      JSON.stringify([
        approval.workflowId,
        approval.alias,
        approval.contractId,
        approval.fingerprint,
      ]),
      target.data.permissionId
    );
  }
  return declared.map((binding) => ({
    workflowId: binding.workflowId,
    workflowName: binding.workflowName,
    alias: binding.alias,
    permissionId:
      served.get(
        JSON.stringify([
          binding.workflowId,
          binding.alias,
          binding.contractId,
          binding.fingerprint,
        ])
      ) ?? null,
  }));
};

/**
 * The connection each of the workflows' own active connection
 * permissions `ids` is on: a revoked one serves no start, so it serves
 * nothing here either.
 */
export const connectionsOfPermissions = async (
  env: Env,
  ids: readonly string[]
): Promise<Map<string, string>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({ id: permissions.id, connectionId: permissions.objectId })
    .from(permissions)
    .where(
      and(
        inList(permissions.id, ids),
        eq(permissions.subjectType, "workflow"),
        eq(permissions.objectType, "connection"),
        eq(permissions.status, "active")
      )
    );
  return new Map(rows.map(({ id, connectionId }) => [id, connectionId]));
};

/** The independent workflows that use each connection, by their IDs. */
const independentWorkflowUses = async (
  env: Env
): Promise<Map<string, Set<string>>> => {
  const bindings = await connectorBindingsOf(env);
  const connections = await connectionsOfPermissions(env, [
    ...new Set(bindings.flatMap(({ permissionId }) => permissionId ?? [])),
  ]);
  const uses = new Map<string, Set<string>>();
  for (const { workflowId, permissionId } of bindings) {
    const connectionId =
      permissionId === null ? undefined : connections.get(permissionId);
    if (connectionId !== undefined) {
      const using = uses.get(connectionId) ?? new Set();
      using.add(workflowId);
      uses.set(connectionId, using);
    }
  }
  return uses;
};

/**
 * Every connection a workflow `by` can open uses, with those workflows by
 * name.
 */
export const connectionWorkflows = async (
  env: Env,
  by: Member
): Promise<ConnectionWorkflows[]> => {
  const uses = await independentWorkflowUses(env);
  const resources = uses.size === 0 ? [] : await listWorkflowResources(env, by);
  return [...uses].flatMap(([connectionId, using]) => {
    const workflows: ConnectionWorkflow[] = resources
      .filter(({ id }) => using.has(id))
      .map(({ id, name }) => ({ id, name }));
    return workflows.length === 0 ? [] : [{ connectionId, workflows }];
  });
};
