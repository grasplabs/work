import { isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  catalogBindingKinds,
  workflowBindingTargetSchema,
} from "@grasp-os/shared/workflow-resources";
import type {
  EventIngressKind,
  ListedWorkflowBindingApproval,
  PendingWorkflowBindings,
  WorkflowBindingTarget,
} from "@grasp-os/shared/workflow-resources";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Acting } from "./auth/identity.ts";
import {
  eventSources,
  permissions,
  workflowBindingApprovals,
  workflowResources,
} from "./db/core/schema.ts";
import { modelSettings } from "./models.ts";
import { requireMemberAdmin } from "./permissions.ts";
import {
  approvalOf,
  approvalServing,
  requireTargetServes,
} from "./workflow-bindings.ts";
import { bindingsOf, requireWorkflowRole } from "./workflow-resources.ts";
import type { PinnedBinding } from "./workflow-resources.ts";
import { sourcedTypesOf } from "./workflows/event-waits.ts";
import { ingressOf } from "./workflows/run-inboxes.ts";

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
// - A long or slow read: a connector's candidates are the contracts
//   connect lists for each of the workflow's own connection grants (a
//   Composio one read from its server), each checked before it is
//   offered. So they are offered on one workflow's own read alone, never
//   across workflows, where connectors list without offers.
// - A long read: at most `pendingWorkflowsMax` workflows, the most
//   recently created first.

/** Most workflows one read lists. */
const pendingWorkflowsMax = 50;

/** A target core offers, with what it names. */
type Offered = PendingWorkflowBindings["bindings"][number]["offered"][number];

/** Workflow `id`'s own active permissions on objects of `type`, oldest first. */
const heldOf = async (env: Env, id: string, type: "platform" | "connection") =>
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

/**
 * What `target` names, as an offer of it and an approval of it are
 * listed: a connector's by `grant`, the name of the
 * workflow's own grant it goes through (its binding name), the Brain by
 * the binding name of its grant, a model by its ID; empty where it names
 * nothing, or its grant is gone.
 */
const labelOf = (target: WorkflowBindingTarget, grant?: string): string => {
  switch (target.kind) {
    case "model": {
      return target.model;
    }
    case "connector": {
      return grant === undefined ? "" : `${grant}: ${target.contract}`;
    }
    case "brain": {
      return grant ?? "";
    }
    case "decision":
    case "event":
    case "files": {
      return "";
    }
    default: {
      return target satisfies never;
    }
  }
};

/**
 * What an event binding's offer says outsiders may send it, by where
 * from: a run's inbox takes whatever reaches it (run-inboxes.ts); a
 * webhook source's offers name the source (`sourceTargets`).
 */
const ingressLabels = {
  email: "Replies to the run's mail, from anyone it reaches",
  webhook: "Events from a webhook source",
} as const satisfies Record<EventIngressKind, string>;

/** Each live event source, as an event binding's target, by its name. */
const sourceTargets = async (env: Env): Promise<Offered[]> => {
  const sources = await drizzle(env.DB)
    .select({ id: eventSources.id, name: eventSources.name })
    .from(eventSources)
    .where(isNull(eventSources.deletedAt))
    .orderBy(asc(eventSources.createdAt), asc(eventSources.id));
  return sources.map(({ id, name }) => ({
    target: { kind: "event", source: id },
    // What approving it lets the workflow see: anything the source sends
    // of the types its contract takes, each run handed what matches it.
    label: `Any event ${name} sends of the types its contract takes, each run handed those matching what it waits for`,
  }));
};

/** The actions a permission row allows, as it keeps them (JSON). */
const actionsOf = (actions: string): string[] => {
  const parsed: unknown = JSON.parse(actions);
  return Array.isArray(parsed)
    ? parsed.filter((action): action is string => typeof action === "string")
    : [];
};

/** The workflow's own active permissions to read the Brain, as targets. */
const brainTargets = async (env: Env, id: string): Promise<Offered[]> => {
  const rows = await heldOf(env, id, "platform");
  return rows
    .filter(({ actions }) => actionsOf(actions).includes("brain"))
    .map(({ id: permissionId, binding }) => {
      const target = { kind: "brain", permissionId } as const;
      return { target, label: labelOf(target, binding) };
    });
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
      const target = {
        kind: "connector",
        permissionId: row.id,
        contract,
      } as const;
      offered.push({ target, label: labelOf(target, row.binding) });
    }
  }
  return offered;
};

/**
 * The targets core can pick for `binding` of workflow `id`, before they
 * are checked; a connector's only when `everyKind` (one workflow's own
 * read).
 */
const candidatesOf = async (
  env: Env,
  id: string,
  binding: PinnedBinding,
  everyKind: boolean
): Promise<Offered[]> => {
  if (!everyKind && binding.kind === "connector") {
    return [];
  }
  switch (binding.kind) {
    case "model": {
      const { models } = await modelSettings(env);
      return models.map((model) => {
        const target = { kind: "model", model } as const;
        return { target, label: labelOf(target) };
      });
    }
    // Who sends its events from outside, when its contract takes any
    // (run-inboxes.ts, event-waits.ts): what approving it lets outsiders
    // do. One taking a webhook source's types is offered each live
    // source, as the one whose events reach it.
    case "event": {
      const sourced = await sourcedTypesOf(env, binding);
      if (sourced.length > 0) {
        return await sourceTargets(env);
      }
      const ingress = await ingressOf(env, binding);
      return [
        {
          target: { kind: "event" },
          label: ingress === undefined ? "" : ingressLabels[ingress],
        },
      ];
    }
    case "files": {
      return [{ target: { kind: "files" }, label: "" }];
    }
    case "brain": {
      return await brainTargets(env, id);
    }
    case "connector": {
      return await connectorTargets(env, id);
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

/**
 * What one workflow's read has offered so far, by binding kind and
 * contract: the same for each of its versions that declares it.
 */
type Offers = Map<string, Promise<Offered[]>>;

/** Those of the candidates for `binding` that would serve it now. */
const offeredFor = async (
  env: Env,
  id: string,
  binding: PinnedBinding,
  everyKind: boolean
): Promise<Offered[]> => {
  const offered: Offered[] = [];
  for (const candidate of await candidatesOf(env, id, binding, everyKind)) {
    // One an approval couldn't take as written is never offered.
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

/** What `offers` holds for `binding`, worked out by `offer` the first time. */
const offersOf = async (
  offers: Offers,
  binding: PinnedBinding,
  offer: () => Promise<Offered[]>
): Promise<Offered[]> => {
  const key = `${binding.kind}:${binding.contractId}`;
  const known = offers.get(key) ?? offer();
  offers.set(key, known);
  return await known;
};

/** Version `version` of workflow `id`'s catalog bindings no approval serves, with what core offers. */
const unapprovedOf = async (
  env: Env,
  id: string,
  version: number,
  everyKind: boolean,
  offers: Offers
): Promise<PendingWorkflowBindings["bindings"]> => {
  const versions = await bindingsOf(env, id, version);
  const unapproved: PendingWorkflowBindings["bindings"] = [];
  for (const binding of versions.get(version) ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- one point lookup per binding
    if ((await approvalServing(env, id, version, binding)) !== undefined) {
      continue;
    }
    unapproved.push({
      alias: binding.alias,
      kind: binding.kind,
      contractId: binding.contractId,
      // oxlint-disable-next-line no-await-in-loop -- one binding at a time
      offered: await offersOf(
        offers,
        binding,
        async () => await offeredFor(env, id, binding, everyKind)
      ),
    });
  }
  return unapproved;
};

/**
 * Workflow `workflow`'s live `version` (none while it has none), when it
 * has catalog bindings no approval serves. Every kind is offered targets
 * when `everyKind`.
 */
const waitingOf = async (
  env: Env,
  workflow: { id: string; name: string },
  version: number | null,
  everyKind: boolean
): Promise<PendingWorkflowBindings[]> => {
  if (version === null) {
    return [];
  }
  const bindings = await unapprovedOf(
    env,
    workflow.id,
    version,
    everyKind,
    new Map()
  );
  return bindings.length === 0
    ? []
    : [
        {
          workflow: { id: workflow.id, name: workflow.name },
          version,
          bindings,
        },
      ];
};

/**
 * The live versions of workflows whose catalog bindings no approval
 * serves, for `by`, one of the organization's own admins.
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
      version: workflowResources.currentVersion,
    })
    .from(workflowResources)
    .where(
      and(
        isNull(workflowResources.deletedAt),
        isNotNull(workflowResources.currentVersion)
      )
    )
    .orderBy(desc(workflowResources.createdAt), desc(workflowResources.id))
    .limit(pendingWorkflowsMax);
  const pending: PendingWorkflowBindings[] = [];
  for (const row of rows) {
    pending.push(
      // oxlint-disable-next-line no-await-in-loop -- one workflow at a time, bounded
      ...(await waitingOf(env, row, row.version, false))
    );
  }
  return pending;
};

/**
 * Workflow `id`'s live version, when its catalog bindings no approval
 * serves, for `by`, one of the organization's own admins, to approve on
 * its page, each kind offered targets.
 */
export const workflowPendingBindings = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<PendingWorkflowBindings[]> => {
  requireMemberAdmin(by);
  const workflow = await requireWorkflowRole(env, by, id, "user");
  return await waitingOf(env, workflow, workflow.currentVersion, true);
};

/**
 * What the workflow's own active grants of the kinds a target goes
 * through are called, by permission ID: each by its binding name.
 */
const grantNamesOf = async (
  env: Env,
  id: string
): Promise<Map<string, string>> => {
  const [platform, connections] = await Promise.all([
    heldOf(env, id, "platform"),
    heldOf(env, id, "connection"),
  ]);
  return new Map(
    [...platform, ...connections].map(({ id: permissionId, binding }) => [
      permissionId,
      binding,
    ])
  );
};

/**
 * Workflow `id`'s active approvals, by alias, each named as an offer of
 * its target is (`labelOf`), for anyone with a role.
 */
export const listWorkflowBindings = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<ListedWorkflowBindingApproval[]> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const [rows, grants] = await Promise.all([
    drizzle(env.DB)
      .select()
      .from(workflowBindingApprovals)
      .where(
        and(
          eq(workflowBindingApprovals.workflowResourceId, workflow.id),
          eq(workflowBindingApprovals.status, "active"),
          // Of a kind still served: an `operation` approval left from
          // before each App's store was its own serves nothing, and a
          // later release removes it with its audit event.
          inArray(workflowBindingApprovals.kind, [...catalogBindingKinds])
        )
      )
      .orderBy(asc(workflowBindingApprovals.alias)),
    grantNamesOf(env, workflow.id),
  ]);
  return rows.map((row) => {
    const approval = approvalOf(row);
    const { target } = approval;
    const grant =
      "permissionId" in target ? grants.get(target.permissionId) : undefined;
    return { ...approval, label: labelOf(target, grant) };
  });
};
