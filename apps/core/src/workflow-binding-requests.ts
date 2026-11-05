import { collections } from "@grasp-os/brain/schema";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowBindingTargetSchema } from "@grasp-os/shared/workflow-resources";
import type {
  EventIngressKind,
  ListedWorkflowBindingApproval,
  PendingWorkflowBindings,
  WorkflowBindingTarget,
} from "@grasp-os/shared/workflow-resources";
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

import type { Acting } from "./auth/identity.ts";
import {
  permissions,
  workflowBindingApprovals,
  workflowResourceLifecycles,
  workflowResources,
} from "./db/core/schema.ts";
import { modelSettings } from "./models.ts";
import { requireMemberAdmin } from "./permissions.ts";
import { latestTemplateVersions } from "./resource-templates.ts";
import { grantedStore, servedIn, storeGrantFor } from "./store-operations.ts";
import {
  approvalOf,
  approvalServing,
  operationServesContract,
  requireTargetServes,
} from "./workflow-bindings.ts";
import { resolveCatalogKeys } from "./workflow-catalog.ts";
import { bindingsOf, requireWorkflowRole } from "./workflow-resources.ts";
import type { PinnedBinding } from "./workflow-resources.ts";
import { workflowStoreServer } from "./workflow-store-host.ts";
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
//   Composio one read from its server), a store operation's the paths each
//   of its own store grants lists, a template's the latest version of the
//   `templatesOffered` newest templates; each checked before it is
//   offered. So they are offered on one workflow's own read alone, never
//   across workflows, where those kinds list without offers.
// - A long read: at most `pendingWorkflowsMax` workflows, the most
//   recently created first.

/** Most workflows one read lists. */
const pendingWorkflowsMax = 50;

/**
 * Most templates offered for one template binding: the most recently
 * published, each at its latest version. Approving any other takes the
 * API.
 */
const templatesOffered = 100;

/** What an offer needs of a store operation: its kind and shapes. */
type StoreOperationShape = Parameters<typeof operationServesContract>[0] & {
  kind: string;
};

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

/**
 * What `target` names, as an offer of it and an approval of it are
 * listed: a connector's or store operation's by `grant`, the name of the
 * workflow's own grant it goes through (its binding name), a Brain
 * collection by `grant`, the collection's name, a model by its ID; empty
 * where it names nothing, or its grant is gone.
 */
const labelOf = (target: WorkflowBindingTarget, grant?: string): string => {
  switch (target.kind) {
    case "model": {
      return target.model;
    }
    case "connector": {
      return grant === undefined ? "" : `${grant}: ${target.contract}`;
    }
    case "storeOperation": {
      return grant === undefined ? "" : `${grant}: ${target.operation}`;
    }
    case "knowledge": {
      return grant ?? "";
    }
    // A template's offer is named by its contract as it is read
    // (`templateTargets`); an approval of one, by nothing.
    case "template":
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
 * from: a run's inbox takes whatever reaches it (run-inboxes.ts).
 */
const ingressLabels = {
  email: "Replies to the run's mail, from anyone it reaches",
} as const satisfies Record<EventIngressKind, string>;

/** The names of the Brain collections `ids`, by ID. */
const collectionNames = async (
  env: Env,
  ids: readonly string[]
): Promise<Map<string, string>> => {
  const named =
    ids.length === 0
      ? []
      : await drizzle(env.KNOWLEDGE)
          .select({ id: collections.id, name: collections.name })
          .from(collections)
          .where(inArray(collections.id, [...ids]));
  return new Map(named.map(({ id, name }) => [id, name]));
};

/** The workflow's own active permissions to read a collection, as targets, by the collection's name. */
const knowledgeTargets = async (env: Env, id: string): Promise<Offered[]> => {
  const rows = await heldOf(env, id, "collection");
  const names = await collectionNames(
    env,
    rows.map(({ objectId }) => objectId)
  );
  return rows.map(({ id: permissionId, objectId }) => {
    const target = { kind: "knowledge", permissionId } as const;
    return { target, label: labelOf(target, names.get(objectId)) };
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
 * The public queries and mutations, by path, that store permission
 * `permissionId` of workflow `id` lists and its store serves now: an
 * App's store as its owner's current release serves it, or a workflow's
 * as its owner's current version does. Read once for all its paths.
 */
const servedOperations = async (
  env: Env,
  id: string,
  permissionId: string,
  paths: readonly string[]
): Promise<{ path: string; operation: StoreOperationShape }[]> => {
  const consumer = {
    version: 1,
    subject: { type: "workflow", id },
    permissionId,
  } as const;
  const grant = await storeGrantFor(env, consumer);
  if (grant !== undefined) {
    return paths.flatMap((path) => {
      const served = servedIn(grant.release, path);
      return served === undefined || !grant.actions.includes(path)
        ? []
        : [{ path, operation: served.operation }];
    });
  }
  const storeId = await grantedStore(env, consumer, paths);
  const server =
    storeId === undefined ? undefined : await workflowStoreServer(env, storeId);
  // A workflow calls its own store as itself, never through a binding.
  if (server === undefined || server.workflowId === id) {
    return [];
  }
  return paths.flatMap((path) => {
    const served = server.store.operations.get(path)?.manifest;
    return served === undefined || server.store.fingerprints[path] === undefined
      ? []
      : [{ path, operation: served }];
  });
};

/**
 * The paths the workflow's own store permissions list whose operation
 * takes and returns exactly what operation contract `key` says, each as
 * the kind its store serves it: checked here as `requireTargetServes`
 * checks one, from one read of each store, so they aren't checked one by
 * one again (an approval checks its own afresh).
 */
const operationTargets = async (
  env: Env,
  id: string,
  key: string
): Promise<Offered[]> => {
  const contracts = await resolveCatalogKeys(env, [key]);
  const contract = contracts.get(key)?.contract;
  if (contract === undefined) {
    return [];
  }
  const offered: Offered[] = [];
  for (const row of await heldOf(env, id, "store")) {
    // oxlint-disable-next-line no-await-in-loop -- one store read per grant, few
    const served = await servedOperations(
      env,
      id,
      row.id,
      actionsOf(row.actions)
    );
    for (const { path, operation } of served) {
      if (
        (operation.kind === "query" || operation.kind === "mutation") &&
        operationServesContract(operation, contract)
      ) {
        const target = {
          kind: "storeOperation",
          permissionId: row.id,
          operation: path,
          operationKind: operation.kind,
        } as const;
        offered.push({ target, label: labelOf(target, row.binding) });
      }
    }
  }
  return offered;
};

/** The newest templates' latest versions, each pinned by its content's hash. */
const templateTargets = async (env: Env): Promise<Offered[]> => {
  const published = await latestTemplateVersions(env, templatesOffered);
  return published.map(
    ({ templateId, version, contract, contentHash }): Offered => ({
      target: { kind: "template", templateId, version, contentHash },
      label: `${contract} v${version}`,
    })
  );
};

/**
 * The targets core can pick for `binding` of workflow `id`, before they
 * are checked; a connector's, store operation's and template's only when
 * `everyKind` (one workflow's own read).
 */
const candidatesOf = async (
  env: Env,
  id: string,
  binding: PinnedBinding,
  everyKind: boolean
): Promise<Offered[]> => {
  if (
    !everyKind &&
    (binding.kind === "connector" ||
      binding.kind === "operation" ||
      binding.kind === "template")
  ) {
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
    // (run-inboxes.ts): what approving it lets outsiders do.
    case "event": {
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
    case "knowledge": {
      return await knowledgeTargets(env, id);
    }
    case "connector": {
      return await connectorTargets(env, id);
    }
    case "operation": {
      return await operationTargets(env, id, binding.contractId);
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

/**
 * What one workflow's read has offered so far, by binding kind and
 * contract: the same for each of its versions that declares it, and for a
 * template whatever the contract, as any template version serves one.
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
    // One an approval couldn't take as written (a path no operation could
    // have) is never offered.
    if (!workflowBindingTargetSchema.safeParse(candidate.target).success) {
      continue;
    }
    // Checked as it was read, its store read once (`operationTargets`).
    if (candidate.target.kind === "storeOperation") {
      offered.push(candidate);
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
  const key =
    binding.kind === "template"
      ? binding.kind
      : `${binding.kind}:${binding.contractId}`;
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
 * Of workflow `workflow`'s `versions`, those with catalog bindings no
 * approval serves, each version once, in the order given: `live` the one
 * a start runs now. Every kind is offered targets when `everyKind`.
 */
const waitingOf = async (
  env: Env,
  workflow: { id: string; name: string },
  versions: readonly { version: number | null; live: boolean }[],
  everyKind: boolean
): Promise<PendingWorkflowBindings[]> => {
  const pending: PendingWorkflowBindings[] = [];
  const seen = new Set<number>();
  const offers: Offers = new Map();
  for (const { version, live } of versions) {
    if (version === null || seen.has(version)) {
      continue;
    }
    seen.add(version);
    // oxlint-disable-next-line no-await-in-loop -- one workflow version at a time, three at most
    const bindings = await unapprovedOf(
      env,
      workflow.id,
      version,
      everyKind,
      offers
    );
    if (bindings.length > 0) {
      pending.push({
        workflow: { id: workflow.id, name: workflow.name },
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
    pending.push(
      // oxlint-disable-next-line no-await-in-loop -- one workflow at a time, bounded
      ...(await waitingOf(
        env,
        row,
        [
          { version: row.live, live: true },
          { version: row.goLive, live: false },
        ],
        false
      ))
    );
  }
  return pending;
};

/**
 * Workflow `id`'s versions whose catalog bindings no approval serves, for
 * `by`, one of the organization's own admins, to approve on its page, each
 * kind offered targets: the version a start runs now (the live one, or
 * before any went live the one published last, as a start from its page
 * takes it), the one asked to go live, and the one published last, which a
 * test run starts.
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
  return await waitingOf(
    env,
    workflow,
    [
      { version: lifecycle?.live ?? workflow.currentVersion, live: true },
      { version: lifecycle?.goLive ?? null, live: false },
      { version: workflow.currentVersion, live: false },
    ],
    true
  );
};

/**
 * What the workflow's own active grants of the kinds a target goes
 * through are called, by permission ID: a Brain collection's by the
 * collection's name, a connection's or store's by its binding name.
 */
const grantNamesOf = async (
  env: Env,
  id: string
): Promise<Map<string, string>> => {
  const [read, connections, stores] = await Promise.all([
    heldOf(env, id, "collection"),
    heldOf(env, id, "connection"),
    heldOf(env, id, "store"),
  ]);
  const names = await collectionNames(
    env,
    read.map(({ objectId }) => objectId)
  );
  const grants = new Map<string, string>();
  for (const { id: permissionId, objectId } of read) {
    const name = names.get(objectId);
    if (name !== undefined) {
      grants.set(permissionId, name);
    }
  }
  for (const { id: permissionId, binding } of [...connections, ...stores]) {
    grants.set(permissionId, binding);
  }
  return grants;
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
          eq(workflowBindingApprovals.status, "active")
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
