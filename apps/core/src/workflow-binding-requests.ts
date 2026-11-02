import { collections } from "@grasp-os/brain/schema";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
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
import { approvalServing, requireTargetServes } from "./workflow-bindings.ts";
import { bindingsOf } from "./workflow-resources.ts";
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
// - Offering a choice core can't make: a target that needs more than core
//   can pick (a connector's contract, a store operation, deciders, a
//   template version) isn't offered; the binding is listed without it, to
//   approve where its target is chosen in full.
// - A long read: at most `pendingWorkflowsMax` workflows, the most
//   recently created first.

/** Most workflows one read lists. */
const pendingWorkflowsMax = 50;

type CatalogBinding = Extract<PinnedBinding, { resourceId: null }>;

/** A target core offers, with what it names. */
type Offered = PendingWorkflowBindings["bindings"][number]["offered"][number];

/** The workflow's own active permissions to read a collection, as targets, by the collection's name. */
const knowledgeTargets = async (env: Env, id: string): Promise<Offered[]> => {
  const rows = await drizzle(env.DB)
    .select({ id: permissions.id, collection: permissions.objectId })
    .from(permissions)
    .where(
      and(
        eq(permissions.subjectType, "workflow"),
        eq(permissions.subjectId, id),
        eq(permissions.objectType, "collection"),
        eq(permissions.status, "active")
      )
    )
    .orderBy(asc(permissions.id));
  const named =
    rows.length === 0
      ? []
      : await drizzle(env.KNOWLEDGE)
          .select({ id: collections.id, name: collections.name })
          .from(collections)
          .where(
            inArray(
              collections.id,
              rows.map(({ collection }) => collection)
            )
          );
  const names = new Map(named.map(({ id: each, name }) => [each, name]));
  return rows.map(({ id: permissionId, collection }) => ({
    target: { kind: "knowledge", permissionId },
    label: names.get(collection) ?? "",
  }));
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
    // Each needs more than core can pick: a connector's contract on a
    // permission, a store operation and its kind, deciders, a template
    // version.
    case "connector":
    case "operation":
    case "decision":
    case "template": {
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
    const versions = [
      ...(row.live === null ? [] : [{ version: row.live, live: true }]),
      ...(row.goLive === null || row.goLive === row.live
        ? []
        : [{ version: row.goLive, live: false }]),
    ];
    for (const { version, live } of versions) {
      // oxlint-disable-next-line no-await-in-loop -- one workflow version at a time, bounded
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
  }
  return pending;
};
