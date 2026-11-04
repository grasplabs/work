import { collections } from "@grasp-os/brain/schema";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowBindingTargetSchema } from "@grasp-os/shared/workflow-resources";
import type { PendingWorkflowBindings } from "@grasp-os/shared/workflow-resources";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  permissions,
  workflowResourceLifecycles,
  workflowResources,
} from "./db/core/schema.ts";
import { modelSettings } from "./models.ts";
import { requireMemberAdmin } from "./permissions.ts";
import { templateVersionsOf } from "./resource-templates.ts";
import { approvalServing, requireTargetServes } from "./workflow-bindings.ts";
import { bindingsOf, requireWorkflowRole } from "./workflow-resources.ts";
import type { PinnedBinding } from "./workflow-resources.ts";

// The bindings that wait on an admin (`workflowResources.pendingBindings`,
// the waiting feed's `bindings`): every catalog binding of a workflow's
// live version, or of the version asked to go live, that no approval
// serves, so its starts are refused (workflow-starts.ts). What could go
// wrong, and what stops it:
//
// - Someone else learning which workflows reach what: the organization's
//   own admins only, never Grasp staff, as for approving one
//   (workflow-bindings.ts).
// - Offering a target that wouldn't serve: each offered target is checked
//   as an approval of it is (`requireTargetServes`), so approving one the
//   admin was offered passes that same check, read again as it lands.
// - Offering a choice core can't make: a decision's deciders are the
//   admin's to name, so none is offered; the binding is listed without
//   one, and the admin names them as they approve it (checked as any
//   approval is).
// - A long list of candidates: a connector's are the contracts connect
//   lists for each of the workflow's own connection grants, a store
//   operation's the paths each of its own store grants lists, a
//   template's the newest `templatesOffered` published versions; each
//   checked before it is offered.
// - A long read: at most `pendingWorkflowsMax` workflows, the most
//   recently created first.

/** Most workflows one read lists. */
const pendingWorkflowsMax = 50;

/** Most published template versions offered for one template binding: the newest. */
const templatesOffered = 20;

type CatalogBinding = Extract<PinnedBinding, { resourceId: null }>;

/** A target core offers, with what it names. */
type Offered = PendingWorkflowBindings["bindings"][number]["offered"][number];

/** The actions a permission row allows. */
const actionsOf = (json: string): string[] => {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed)
    ? parsed.filter((action): action is string => typeof action === "string")
    : [];
};

/** Workflow `id`'s own active permissions on objects of `type`, oldest first. */
const heldOf = async (
  env: Env,
  id: string,
  type: "collection" | "connection" | "store"
) =>
  await drizzle(env.DB)
    .select({
      id: permissions.id,
      objectId: permissions.objectId,
      actions: permissions.actions,
      binding: permissions.binding,
    })
    .from(permissions)
    .where(
      and(
        eq(permissions.subjectType, "workflow"),
        eq(permissions.subjectId, id),
        eq(permissions.objectType, type),
        eq(permissions.status, "active")
      )
    )
    .orderBy(asc(permissions.id));

/** The workflow's own active permissions to read a collection, as targets, by the collection's name. */
const knowledgeTargets = async (env: Env, id: string): Promise<Offered[]> => {
  const rows = await heldOf(env, id, "collection");
  const named =
    rows.length === 0
      ? []
      : await drizzle(env.KNOWLEDGE)
          .select({ id: collections.id, name: collections.name })
          .from(collections)
          .where(
            inArray(
              collections.id,
              rows.map(({ objectId }) => objectId)
            )
          );
  const names = new Map(named.map(({ id: each, name }) => [each, name]));
  return rows.map(({ id: permissionId, objectId }) => ({
    target: { kind: "knowledge", permissionId },
    label: names.get(objectId) ?? "",
  }));
};

/**
 * Each contract connect lists for each of the workflow's own connection
 * permissions, as targets, named by the permission's binding name and the
 * contract. A connection connect can't list now offers none.
 */
const connectorTargets = async (env: Env, id: string): Promise<Offered[]> => {
  const offered: Offered[] = [];
  for (const row of await heldOf(env, id, "connection")) {
    let contracts: string[] = [];
    try {
      // oxlint-disable-next-line no-await-in-loop -- one list per grant, few
      contracts = await env.CONNECT.connectorContracts({
        connectionId: row.objectId,
      });
    } catch (error) {
      if (!isExpectedError(error)) {
        throw error;
      }
    }
    for (const contract of contracts) {
      offered.push({
        target: { kind: "connector", permissionId: row.id, contract },
        label: `${row.binding}: ${contract}`,
      });
    }
  }
  return offered;
};

/**
 * Each path each of the workflow's own store permissions lists, as a
 * query and as a mutation: the store's release says which it is, so only
 * the one it serves is offered.
 */
const operationTargets = async (env: Env, id: string): Promise<Offered[]> => {
  const rows = await heldOf(env, id, "store");
  return rows.flatMap((row) =>
    actionsOf(row.actions).flatMap((operation) =>
      (["query", "mutation"] as const).map((operationKind): Offered => ({
        target: {
          kind: "storeOperation",
          permissionId: row.id,
          operation,
          operationKind,
        },
        label: `${row.binding}: ${operation}`,
      }))
    )
  );
};

/** The newest published template versions, each pinned by its content's hash. */
const templateTargets = async (env: Env): Promise<Offered[]> => {
  const published = await templateVersionsOf(env, undefined, templatesOffered);
  return published.map(
    ({ templateId, version, contract, contentHash }): Offered => ({
      target: { kind: "template", templateId, version, contentHash },
      label: `${contract} v${version}`,
    })
  );
};

/** The targets core can pick for `binding` of workflow `id`, before they are checked. */
const candidatesOf = async (
  env: Env,
  id: string,
  binding: CatalogBinding
): Promise<Offered[]> => {
  switch (binding.kind) {
    case "model": {
      const { models } = await modelSettings(env);
      return models.map((model) => ({
        target: { kind: "model", model },
        label: model,
      }));
    }
    case "event": {
      return [{ target: { kind: "event" }, label: "" }];
    }
    case "files": {
      return [{ target: { kind: "files" }, label: "" }];
    }
    case "knowledge": {
      return await knowledgeTargets(env, id);
    }
    case "connector": {
      return await connectorTargets(env, id);
    }
    case "operation": {
      return await operationTargets(env, id);
    }
    case "template": {
      return await templateTargets(env);
    }
    // Who answers is the admin's to name, as they approve it.
    case "decision": {
      return [];
    }
    default: {
      return binding.kind satisfies never;
    }
  }
};

/** Those of the candidates for `binding` that would serve it now. */
const offeredFor = async (
  env: Env,
  id: string,
  binding: CatalogBinding
): Promise<Offered[]> => {
  const offered: Offered[] = [];
  for (const candidate of await candidatesOf(env, id, binding)) {
    // One an approval couldn't take as written (a path no operation could
    // have) is never offered.
    if (!workflowBindingTargetSchema.safeParse(candidate.target).success) {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one check per candidate, few
      await requireTargetServes(env, id, binding, candidate.target);
      offered.push(candidate);
    } catch (error) {
      if (!isExpectedError(error)) {
        throw error;
      }
    }
  }
  return offered;
};

/** Version `version` of workflow `id`'s catalog bindings no approval serves, with what core offers. */
const unapprovedOf = async (
  env: Env,
  id: string,
  version: number
): Promise<PendingWorkflowBindings["bindings"]> => {
  const versions = await bindingsOf(env, id, version);
  const unapproved: PendingWorkflowBindings["bindings"] = [];
  for (const binding of versions.get(version) ?? []) {
    if (binding.resourceId !== null) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one point lookup per binding
    if ((await approvalServing(env, id, version, binding)) !== undefined) {
      continue;
    }
    unapproved.push({
      alias: binding.alias,
      kind: binding.kind,
      contractId: binding.contractId,
      // oxlint-disable-next-line no-await-in-loop -- one binding at a time
      offered: await offeredFor(env, id, binding),
    });
  }
  return unapproved;
};

/**
 * Of workflow `row`'s version `live` (the one that runs) and `goLive` (the
 * one asked to go live), those with catalog bindings no approval serves.
 */
const waitingOf = async (
  env: Env,
  row: { id: string; name: string; live: number | null; goLive: number | null }
): Promise<PendingWorkflowBindings[]> => {
  const versions = [
    ...(row.live === null ? [] : [{ version: row.live, live: true }]),
    ...(row.goLive === null || row.goLive === row.live
      ? []
      : [{ version: row.goLive, live: false }]),
  ];
  const pending: PendingWorkflowBindings[] = [];
  for (const { version, live } of versions) {
    // oxlint-disable-next-line no-await-in-loop -- one workflow version at a time, two at most
    const bindings = await unapprovedOf(env, row.id, version);
    if (bindings.length > 0) {
      pending.push({
        workflow: { id: row.id, name: row.name },
        version,
        live,
        bindings,
      });
    }
  }
  return pending;
};

/**
 * The live versions of workflows, and those asked to go live, whose
 * catalog bindings no approval serves, for `by`, one of the
 * organization's own admins.
 */
export const pendingWorkflowBindings = async (
  env: Env,
  by: Identity
): Promise<PendingWorkflowBindings[]> => {
  requireMemberAdmin(by);
  const rows = await drizzle(env.DB)
    .select({
      id: workflowResources.id,
      name: workflowResources.name,
      live: workflowResourceLifecycles.liveVersion,
      goLive: workflowResourceLifecycles.goLiveVersion,
    })
    .from(workflowResources)
    .innerJoin(
      workflowResourceLifecycles,
      eq(workflowResourceLifecycles.workflowResourceId, workflowResources.id)
    )
    .where(
      and(
        isNull(workflowResources.deletedAt),
        or(
          isNotNull(workflowResourceLifecycles.liveVersion),
          isNotNull(workflowResourceLifecycles.goLiveVersion)
        )
      )
    )
    .orderBy(desc(workflowResources.createdAt), desc(workflowResources.id))
    .limit(pendingWorkflowsMax);
  const pending: PendingWorkflowBindings[] = [];
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one workflow at a time, bounded
    pending.push(...(await waitingOf(env, row)));
  }
  return pending;
};

/**
 * Workflow `id`'s versions whose catalog bindings no approval serves, for
 * `by`, one of the organization's own admins, to approve on its page: the
 * version a start runs now (the live one, or before any went live the one
 * published last, as a start from its page takes it), and the one asked
 * to go live.
 */
export const workflowPendingBindings = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<PendingWorkflowBindings[]> => {
  requireMemberAdmin(by);
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const lifecycle = await drizzle(env.DB)
    .select({
      live: workflowResourceLifecycles.liveVersion,
      goLive: workflowResourceLifecycles.goLiveVersion,
    })
    .from(workflowResourceLifecycles)
    .where(eq(workflowResourceLifecycles.workflowResourceId, workflow.id))
    .get();
  return await waitingOf(env, {
    id: workflow.id,
    name: workflow.name,
    live: lifecycle?.live ?? workflow.currentVersion,
    goLive: lifecycle?.goLive ?? null,
  });
};
