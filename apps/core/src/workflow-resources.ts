import type { CatalogContract } from "@grasp-os/open-workflow/catalog";
import type { Diagnostic } from "@grasp-os/open-workflow/diagnostics";
import {
  generatedPath,
  sensitiveReads,
} from "@grasp-os/open-workflow/generate";
import { profileLimits } from "@grasp-os/open-workflow/limits";
import { validateWorkflow } from "@grasp-os/open-workflow/validate";
import type { CheckedWorkflow } from "@grasp-os/open-workflow/validate";
import { workflowReferenceLimits } from "@grasp-os/sdk/host";
import { actorOf, auditDetailMaxKeys } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  canBuild,
  isAdmin,
  requireBuilder,
  roleErrors,
} from "@grasp-os/shared/roles";
import { actionUsesSchema } from "@grasp-os/shared/workflow-modules";
import {
  catalogBindingKinds,
  catalogKeySchema,
  workflowNameSchema,
  workflowNamespace,
  workflowPublishSchema,
  workflowResourceErrors,
  workflowShareSchema,
  workflowMemberSchema,
} from "@grasp-os/shared/workflow-resources";
import type {
  CatalogBindingKind,
  WorkflowDefinitionProblem,
  WorkflowMember,
  WorkflowResource,
  WorkflowResourceVersion,
  WorkflowRole,
  WorkflowBinders,
  WorkflowVersionAction,
  WorkflowVersionBinding,
  WorkflowVersionSource,
} from "@grasp-os/shared/workflow-resources";
import { jqProvenance } from "@grasp-os/workflow-expressions/provenance";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { boundEventsOf } from "./bound-workflow-events.ts";
import type { PinnedEventBinding } from "./bound-workflow-events.ts";
import {
  sdkReleasePins,
  sdkResourceBindings,
  workflowResourceDrafts,
  workflowResourceMembers,
  workflowResources,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { isUniqueViolation, notNullFailed } from "./db/d1.ts";
import { withdrawnWithWorkflow } from "./dependencies/pending.ts";
import {
  memberEntry,
  requireNotStaff,
  requireSharable,
  rowsOf,
  stillMembers,
} from "./sharing.ts";
import type { MemberRef } from "./sharing.ts";
import {
  buildOf,
  buildSummary,
  compileWorkflow,
  loadWorkflowBuild,
  adoptReservations,
  publicationReservation,
  releaseBuild,
  storeBuild,
} from "./workflow-builds.ts";
import type { CompiledBuild, SealedBuild } from "./workflow-builds.ts";
import { resolveCatalogKeys } from "./workflow-catalog.ts";
import type { ResolvedCatalogContract } from "./workflow-catalog.ts";
import {
  compileModules,
  moduleLookup,
  modulesHashOf,
  versionActionsOf,
} from "./workflow-modules.ts";
import type { CompiledModules } from "./workflow-modules.ts";
import { quotaPolicy } from "./workflows/quotas.ts";

// Independent workflows (platform specification 3, 13.2, 15, 16 and 24):
// each a resource of its own, with its own owner, members and immutable
// versions, never part of an App. This is their registry: who may see,
// publish, share and delete one, and what a published version pins.
// Starting one, App bindings and parameter snapshots build on it.
//
// Threat model, and how each is closed:
//
// - Authority from source text. The resource a version is published to is
//   the one the call names by its host-minted ID, which the caller must
//   build; its owner is whoever created it, never anything the definition
//   says. The definition's `document.namespace` and `name` must be the
//   deployment's namespace and the resource's own name
//   (`workflow.identity_mismatch`): text that names another workflow can't
//   land in this one, and naming this one grants nothing.
// - "latest" and ranges. A binding to another workflow names an exact
//   `namespace/name/semver` contract; anything else isn't in the catalog,
//   so the definition is refused. What it resolves to is recorded once, at
//   publication, by ID, version and contract hash (`sdk_resource_bindings`
//   and the manifest), so a later version of the target, or a new workflow
//   given its name, never changes what a published version runs. Names
//   are never reused, deleted workflows' included, and are global to the
//   deployment: a builder learns whether a name exists (`workflow.name_taken`),
//   nothing else of it. Refused creations are audited, and each person may
//   create at most the quota policy's `workflowResourcesPerPerson`,
//   deleted ones included, so names can't be hoarded without trace.
// - Disclosure through bindings. A binding resolves only to a workflow
//   the publisher has a role in; any other is "no such contract", exactly
//   as one that doesn't exist, so publishing can't probe for another
//   workflow's contract. A binding is a requirement, never a grant: who
//   may start the target is decided when it starts. A version's bindings
//   name their target (ID, version, contract key) only to its builders;
//   anyone else sees the alias and the contract's fingerprint.
// - A stored version altered behind the registry's back. A definition is
//   hashed as canonical JSON at publication and checked again before it
//   is served; a contract is checked against its hash before a binding
//   pins it. A mismatch is refused (`workflow.version_corrupt`) and
//   logged, never used. A version's definition, contract and manifest are
//   bounded so its row stays within D1's limit.
// - A version changing after publication. A version is a row written once
//   (`(workflow_resource_id, version)` and its semantic version are unique,
//   and nothing updates them); publishing a semantic version again with
//   other content is refused (`workflow.version_exists`), and with the
//   same content answers the version already published, so a retried
//   publication is the same publication.
// - A version running other code than its definition's. Publication
//   generates SDK TypeScript from the checked definition, compiles it and
//   seals it into the version's manifest, by hash (workflow-builds.ts):
//   what a version runs is fixed with it, and nothing compiles later.
// - Two publications racing. A publication names the current version it
//   built on; its batch inserts the version only while that is still the
//   current one and the workflow is live, and moves the current version in
//   the same transaction (`workflow.version_conflict` otherwise).
// - An App gaining a workflow. Nothing here reads Apps: no column, key or
//   role of an App reaches a workflow, so neither grouping a workflow with
//   an App, nor sharing, nor deleting that App, gives anyone a role in it
//   or removes it. Who has one is its owner, the organization's admins,
//   and whom it is shared with, read from the database on every call, each
//   capped by their organization role (a `user` never builds), as for
//   Apps (app-access.ts). Anyone else gets `workflow.resource_unavailable`,
//   the same as for a workflow that doesn't exist.
// - Deleting a workflow something runs. Deletion is refused while the
//   current version of another live workflow binds it
//   (`workflow.resource_bound`), checked in the statement that marks it
//   deleted; a publication's binding in turn requires its target live in
//   the publication's batch, so one of the two wins. Only current versions
//   count, so nobody can make another's workflow undeletable for good with
//   an old version; the refusal names the binders the caller may see and
//   counts the rest, and its event names them all. A deleted workflow
//   keeps its row and versions, for the audit log and recovery, and is
//   never served again; a share racing the deletion writes nothing.
// - Grasp staff deciding whom a client's workflow reaches or what it runs:
//   they never share, unshare or delete one, nor publish a version whose
//   bindings differ from the current version's (`role.forbidden`). They
//   may read definitions and publish versions that bind nothing new, as
//   for Apps.

/**
 * Moves workflow `id`'s policy generation on, for a batch that changes who
 * may start or follow it: a start admitted under the generation before is
 * refused (workflow-starts.ts).
 */
export const nextGeneration = (
  db: ReturnType<typeof drizzle>,
  id: string,
  landed?: SQL
) =>
  db
    .update(workflowResources)
    .set({ policyGeneration: sql`${workflowResources.policyGeneration} + 1` })
    .where(and(eq(workflowResources.id, id), landed));

/**
 * That the batch's previous statement changed a row, as SQL: for the
 * statement right after a write, which then changes a row only if the
 * write did, so the one after it can ask the same (`outboxedIfChanged`).
 */
export const previousChanged = sql`changes() > 0`;

/** The audit log's target type of a workflow resource. */
const targetType = "workflow_resource";

/** A live workflow as the registry reads it. */
interface Live {
  id: string;
  name: string;
  owner: string;
  currentVersion: number | null;
  createdAt: Date;
}

const unavailable = () =>
  workflowResourceErrors.create("workflow.resource_unavailable");

/**
 * A stored version whose definition or contract doesn't match its hash:
 * logged for Grasp, and refused, never used.
 */
const corrupt = (id: string, version: number) => {
  log.error("workflow.version_corrupt", { workflowId: id, version });
  return workflowResourceErrors.create("workflow.version_corrupt");
};

/** The hash a definition is published under: of its canonical JSON. */
const definitionHashOf = async (definition: unknown): Promise<string> =>
  await sha256Hex(canonicalJson(z.json().parse(definition)));

/** The highest role `by`'s organization role lets them have in a workflow. */
const ceilingOf = (by: Acting): WorkflowRole =>
  canBuild(by.role) ? "builder" : "user";

/**
 * `by`'s role in `workflow`: builder for the organization's admins; their
 * ceiling for its owner; for whom it is shared with, the highest of the
 * rows that are theirs (their own, their teams'), capped by their ceiling.
 * Undefined when they have none.
 */
const roleIn = async (
  env: Env,
  by: Acting,
  workflow: Pick<Live, "id" | "owner">
): Promise<WorkflowRole | undefined> => {
  if (isAdmin(by.role)) {
    return "builder";
  }
  if (workflow.owner === by.userId) {
    return ceilingOf(by);
  }
  const rows = await drizzle(env.DB)
    .select({ role: workflowResourceMembers.role })
    .from(workflowResourceMembers)
    .where(
      and(
        eq(workflowResourceMembers.workflowResourceId, workflow.id),
        rowsOf(workflowResourceMembers, by)
      )
    );
  if (rows.length === 0) {
    return undefined;
  }
  return rows.some(({ role }) => role === "builder") ? ceilingOf(by) : "user";
};

/** The live workflow `id`, or undefined. */
const liveWorkflow = async (
  env: Env,
  id: unknown
): Promise<Live | undefined> => {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    return undefined;
  }
  const row = await drizzle(env.DB)
    .select({
      id: workflowResources.id,
      name: workflowResources.name,
      owner: workflowResources.ownerId,
      currentVersion: workflowResources.currentVersion,
      createdAt: workflowResources.createdAt,
    })
    .from(workflowResources)
    .where(
      and(eq(workflowResources.id, id), isNull(workflowResources.deletedAt))
    )
    .get();
  return row;
};

/**
 * The live workflow `id` and `by`'s role in it, which must be `needed` or
 * more: a workflow they have no role in is `workflow.resource_unavailable`,
 * as one that doesn't exist; too low a role is `role.forbidden`. Whom it
 * is shared with is read now; `by`'s role and teams are their identity as
 * read for this call.
 */
export const requireWorkflowRole = async (
  env: Env,
  by: Acting,
  id: unknown,
  needed: WorkflowRole
): Promise<Live & { role: WorkflowRole }> => {
  const workflow = await liveWorkflow(env, id);
  const role =
    workflow === undefined ? undefined : await roleIn(env, by, workflow);
  if (workflow === undefined || role === undefined) {
    throw unavailable();
  }
  if (needed === "builder" && role !== "builder") {
    throw roleErrors.create("role.forbidden");
  }
  return { ...workflow, role };
};

const resourceOf = (workflow: Live, role: WorkflowRole): WorkflowResource => ({
  id: workflow.id,
  namespace: workflowNamespace,
  name: workflow.name,
  owner: workflow.owner,
  currentVersion: workflow.currentVersion,
  role,
  createdAt: workflow.createdAt.toISOString(),
});

const entry = (
  by: Acting,
  action: string,
  id: string,
  detail: AuditEntry["detail"] = {}
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action,
  target: { type: targetType, id },
  detail,
});

/**
 * Creates a workflow named `name`, owned by `by`, who must build: its ID
 * minted here, at random, audited with its row. A name any workflow has
 * had is `workflow.name_taken`; a person who has created as many as the
 * quota policy allows, deleted ones included, gets
 * `workflow.resource_limit`. Both refusals are audited.
 */
export const createWorkflowResource = async (
  env: Env,
  by: Acting,
  name: unknown
): Promise<WorkflowResource> => {
  requireBuilder(by);
  const parsed = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowNameSchema,
    name
  );
  const policy = await quotaPolicy(env);
  const cap = policy.limits.workflowResourcesPerPerson;
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const db = drizzle(env.DB);
  const refuse = async (
    reason: "workflow.name_taken" | "workflow.resource_limit"
  ): Promise<never> => {
    await auditedBatch(env, db, [
      outboxed(db, {
        actor: by.actor ?? actorOf(by),
        action: "workflow.create_refused",
        detail: { name: parsed, reason },
      }),
    ]);
    throw workflowResourceErrors.create(reason);
  };
  try {
    await auditedBatch(env, db, [
      db.insert(workflowResources).values({
        // Only while `by` is under the cap, counted in this statement:
        // otherwise NULL, which fails the batch.
        id: sql`(SELECT ${id} WHERE (SELECT COUNT(*) FROM workflow_resources
          WHERE owner_id = ${by.userId}) < ${cap})`,
        name: parsed,
        ownerId: by.userId,
        createdAt,
      }),
      outboxed(db, entry(by, "workflow.created", id, { name: parsed })),
    ]);
  } catch (error) {
    if (notNullFailed(error, "workflow_resources.id")) {
      return await refuse("workflow.resource_limit");
    }
    if (isUniqueViolation(error)) {
      return await refuse("workflow.name_taken");
    }
    throw error;
  }
  return resourceOf(
    { id, name: parsed, owner: by.userId, currentVersion: null, createdAt },
    ceilingOf(by)
  );
};

/** Workflow `id`, for anyone with a role in it. */
export const getWorkflowResource = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowResource> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  return resourceOf(workflow, workflow.role);
};

/** The live workflows `by` has a role in, by name. */
export const listWorkflowResources = async (
  env: Env,
  by: Acting
): Promise<WorkflowResource[]> => {
  const db = drizzle(env.DB);
  const shared = db
    .select({ one: sql`1` })
    .from(workflowResourceMembers)
    .where(
      and(
        eq(workflowResourceMembers.workflowResourceId, workflowResources.id),
        rowsOf(workflowResourceMembers, by)
      )
    );
  const rows = await db
    .select({
      id: workflowResources.id,
      name: workflowResources.name,
      owner: workflowResources.ownerId,
      currentVersion: workflowResources.currentVersion,
      createdAt: workflowResources.createdAt,
    })
    .from(workflowResources)
    .where(
      and(
        isNull(workflowResources.deletedAt),
        isAdmin(by.role)
          ? undefined
          : or(eq(workflowResources.ownerId, by.userId), exists(shared))
      )
    )
    .orderBy(asc(workflowResources.name));
  const listed: WorkflowResource[] = [];
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one role per listed workflow, read as `get` reads it
    const role = await roleIn(env, by, row);
    if (role !== undefined) {
      listed.push(resourceOf(row, role));
    }
  }
  return listed;
};

/** `namespace/name/semver`: the only workflow contract key there is. */
const workflowContractKey =
  /^(?<namespace>[a-z0-9-]+)\/(?<name>[a-z0-9-]+)\/(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;

/** At most this many workflow contracts are looked up for one definition. */
const maxWorkflowBindings = 64;

/**
 * A binding as publication resolved it: another workflow's exact version,
 * or a host catalog contract by its key and fingerprint, whose serving
 * resource an approval names (workflow-bindings.ts).
 */
export type PinnedBinding =
  | {
      alias: string;
      kind: "workflow";
      resourceId: string;
      resourceVersion: number;
      contractId: string;
      fingerprint: string;
    }
  | {
      alias: string;
      kind: CatalogBindingKind;
      resourceId: null;
      resourceVersion: null;
      contractId: string;
      fingerprint: string;
    };

/** At most this many catalog contracts are looked up for one definition. */
const maxCatalogBindings = 64;

/**
 * The most a version's contract and manifest may each take as text: with
 * the definition (at most the profile's 1 MiB), a version's row stays
 * well within D1's 2 MB.
 */
const contractMaxBytes = 384 * 1024;
const manifestMaxBytes = 64 * 1024;

const bytesOf = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

/** What a workflow contract key resolved to, at publication. */
interface ResolvedWorkflow {
  resourceId: string;
  version: number;
  contractHash: string;
  contract: CatalogContract;
}

/**
 * A version's contract, as stored: the SDK descriptors of its input and
 * output, its parameters' descriptors, labels and sensitivity, and its
 * listen tasks, by task ID, each with the event binding it listens
 * through and the types its filters name: what an App binding it may be
 * held at, and sent (bound-workflow-events.ts).
 */
const storedContractSchema = z.strictObject({
  input: z.json(),
  output: z.json(),
  listens: z.record(
    z.string(),
    z.strictObject({ alias: z.string(), types: z.array(z.string()) })
  ),
  params: z.record(
    z.string(),
    z.strictObject({
      descriptor: z.json(),
      label: z.string(),
      sensitive: z.boolean(),
    })
  ),
});
type StoredContract = z.infer<typeof storedContractSchema>;

/** Where a definition declares its bindings, as far as a lookup needs. */
const declaredBindingsSchema = z.object({
  document: z.object({
    metadata: z.object({
      grasp: z.object({ bindings: z.record(z.string(), z.unknown()) }),
    }),
  }),
});

const workflowBindingSchema = z.object({
  kind: z.literal("workflow"),
  contract: z.string().regex(workflowContractKey),
});

const catalogBindingSchema = z.object({
  kind: z.enum(catalogBindingKinds),
  contract: catalogKeySchema,
});

/** The labels and sensitivity a checked definition gives its parameters. */
const declaredParamsSchema = z.object({
  document: z.object({
    metadata: z.object({
      grasp: z.object({
        params: z
          .record(
            z.string(),
            z.object({ label: z.string(), sensitive: z.boolean() })
          )
          .optional(),
      }),
    }),
  }),
});

/**
 * The contract keys a definition's bindings name, workflow contracts and
 * host catalog ones apart, read from its text only to know what to look up
 * before validation: what validation then resolves through the catalog is
 * all that counts. Text that isn't JSON names none, and validation
 * refuses it.
 */
const namedKeys = (
  definition: string
): { workflows: string[]; catalog: string[] } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    return { workflows: [], catalog: [] };
  }
  const declared = declaredBindingsSchema.safeParse(parsed);
  if (!declared.success) {
    return { workflows: [], catalog: [] };
  }
  const workflows = new Set<string>();
  const catalog = new Set<string>();
  for (const binding of Object.values(
    declared.data.document.metadata.grasp.bindings
  )) {
    const workflow = workflowBindingSchema.safeParse(binding);
    if (workflow.success) {
      workflows.add(workflow.data.contract);
    }
    const contract = catalogBindingSchema.safeParse(binding);
    if (contract.success) {
      catalog.add(contract.data.contract);
    }
  }
  return {
    workflows: [...workflows].slice(0, maxWorkflowBindings),
    catalog: [...catalog].slice(0, maxCatalogBindings),
  };
};

/**
 * The workflow contract `key` resolves to for `by`: an exact published
 * version of a live workflow of this deployment's namespace that `by` has
 * a role in. Undefined otherwise, the same for each reason.
 */
const resolveWorkflowKey = async (
  env: Env,
  by: Acting,
  key: string
): Promise<ResolvedWorkflow | undefined> => {
  const groups = workflowContractKey.exec(key)?.groups;
  if (
    groups?.namespace !== workflowNamespace ||
    groups.name === undefined ||
    groups.version === undefined
  ) {
    return undefined;
  }
  const row = await drizzle(env.DB)
    .select({
      id: workflowResources.id,
      name: workflowResources.name,
      owner: workflowResources.ownerId,
      version: workflowResourceVersions.version,
      definitionVersion: workflowResourceVersions.definitionVersion,
      contract: workflowResourceVersions.contract,
      contractHash: workflowResourceVersions.contractHash,
    })
    .from(workflowResources)
    .innerJoin(
      workflowResourceVersions,
      eq(workflowResourceVersions.workflowResourceId, workflowResources.id)
    )
    .where(
      and(
        eq(workflowResources.name, groups.name),
        isNull(workflowResources.deletedAt),
        eq(workflowResourceVersions.definitionVersion, groups.version)
      )
    )
    .get();
  if (row === undefined || (await roleIn(env, by, row)) === undefined) {
    return undefined;
  }
  // The contract a binding pins is the one its hash says, or none.
  if ((await sha256Hex(row.contract)) !== row.contractHash) {
    throw corrupt(row.id, row.version);
  }
  const contract = storedContractSchema.parse(JSON.parse(row.contract));
  return {
    resourceId: row.id,
    version: row.version,
    contractHash: row.contractHash,
    contract: {
      kind: "workflow",
      workflow: {
        namespace: workflowNamespace,
        name: row.name,
        version: row.definitionVersion,
      },
      input: JSON.stringify(contract.input),
      output: JSON.stringify(contract.output),
    },
  };
};

const problemsOf = (
  diagnostics: readonly Diagnostic[]
): WorkflowDefinitionProblem[] =>
  diagnostics
    .filter(({ severity }) => severity === "error")
    .map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      pointer: diagnostic.pointer,
      ...(diagnostic.taskId === undefined ? {} : { taskId: diagnostic.taskId }),
      remedy: diagnostic.remedy,
    }));

const definitionInvalid = (problems: WorkflowDefinitionProblem[]) =>
  workflowResourceErrors.create("workflow.definition_invalid", {
    // Each problem is a code, a pointer and fixed text: never a value
    // from the definition.
    problems: problems.map((problem) => ({ ...problem })),
  });

/** The descriptor of a schema the checked workflow compiled at `pointer`. */
const descriptorAt = (
  checked: CheckedWorkflow,
  pointer: string
): StoredContract["input"] => {
  const schema = checked.schemas.get(pointer);
  if (schema === undefined) {
    throw new Error(`A checked workflow has no schema at ${pointer}`);
  }
  return z.json().parse(schema.descriptor);
};

/** What is at JSON Pointer `pointer` in `value`, if anything. */
const valueAt = (value: unknown, pointer: string): unknown => {
  let node = value;
  for (const segment of pointer.split("/").slice(1)) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    node =
      typeof node === "object" && node !== null && Object.hasOwn(node, key)
        ? Reflect.get(node, key)
        : undefined;
  }
  return node;
};

/** The literal types a listen's filters name, at `listen.to`. */
const filterTypesOf = (to: unknown): string[] => {
  const filters: unknown[] = [valueAt(to, "/one")];
  for (const list of [valueAt(to, "/any"), valueAt(to, "/all")]) {
    if (Array.isArray(list)) {
      const items: readonly unknown[] = list;
      filters.push(...items);
    }
  }
  const types = new Set<string>();
  for (const filter of filters) {
    const type = valueAt(filter, "/with/type");
    if (typeof type === "string") {
      types.add(type);
    }
  }
  return [...types].toSorted();
};

/**
 * The listen tasks of a checked definition, by task ID (unique in the
 * definition, and what a run's waits name), each with the event binding
 * its `metadata.grasp.binding` names, which validation required to be a
 * declared event binding, and the literal types its filters name, which
 * validation required its contract to admit.
 */
const listensOf = (checked: CheckedWorkflow): StoredContract["listens"] => {
  const listens: StoredContract["listens"] = {};
  for (const task of checked.tasks) {
    if (task.kind === "listen") {
      const alias = valueAt(
        checked.definition,
        `${task.pointer}/metadata/grasp/binding`
      );
      if (
        typeof alias !== "string" ||
        checked.bindings.get(alias)?.kind !== "event"
      ) {
        throw new Error(
          `A checked listen task has no event binding: ${task.id}`
        );
      }
      listens[task.id] = {
        alias,
        types: filterTypesOf(
          valueAt(checked.definition, `${task.pointer}/listen/to`)
        ),
      };
    }
  }
  return listens;
};

/** The contract of a checked definition: what a caller of it relies on. */
const contractOf = (checked: CheckedWorkflow): StoredContract => {
  const declared =
    declaredParamsSchema.parse(checked.definition).document.metadata.grasp
      .params ?? {};
  const params: StoredContract["params"] = {};
  for (const [name, schema] of checked.params) {
    params[name] = {
      descriptor: z.json().parse(schema.descriptor),
      label: declared[name]?.label ?? name,
      // The profile requires `sensitive`; were it missing, treat it as such.
      sensitive: declared[name]?.sensitive ?? true,
    };
  }
  return {
    input: descriptorAt(checked, "/input/schema"),
    output: descriptorAt(checked, "/output/schema"),
    listens: listensOf(checked),
    params,
  };
};

const identityCode = "workflow.identity_mismatch";

/** A definition that names another workflow than `workflow`, as a problem. */
const identityProblem = (
  workflow: Pick<Live, "name">
): WorkflowDefinitionProblem => ({
  code: identityCode,
  message:
    "The definition names another workflow than this one: its namespace and name must be the workflow's own.",
  pointer: "/document",
  remedy: `Name this workflow: namespace "${workflowNamespace}" and name "${workflow.name}".`,
});

/**
 * The problem with a definition that has more listen tasks an App's
 * references would carry as event waits (those waiting only on a
 * browser-callable type) than a reference holds: sealing an App bound to
 * it would fail later, where the builder can't see why.
 */
const referenceableListensProblem = (
  checked: CheckedWorkflow,
  catalog: Map<string, ResolvedCatalogContract>
): WorkflowDefinitionProblem | undefined => {
  const bindings: PinnedEventBinding[] = [];
  for (const [alias, binding] of checked.bindings) {
    const events = catalog.get(binding.contract)?.contract.events;
    if (binding.kind === "event" && events !== undefined) {
      bindings.push({ alias, events });
    }
  }
  const referenced = Object.keys(
    boundEventsOf(bindings, listensOf(checked)).listens
  ).length;
  if (referenced <= workflowReferenceLimits.listens) {
    return undefined;
  }
  return {
    code: "listen.too_many",
    message: `More than ${workflowReferenceLimits.listens} tasks listen for events a screen sends, which an App's references can't hold.`,
    pointer: "/do",
    remedy:
      "Listen for a screen's events in fewer tasks: a bounded loop of one listen covers repeats.",
  };
};

/**
 * `definition` checked for publication to `workflow` by `by`: it passes
 * grasp-open-workflow/1 against the host's catalog, its workflow bindings
 * resolved for `by` (`workflow.definition_invalid` with its diagnostics
 * otherwise), and names this workflow (`workflow.identity_mismatch`).
 * Returns it with what each binding resolved to.
 */
const inspectDefinition = async (
  env: Env,
  by: Acting,
  workflow: Pick<Live, "name">,
  definition: string,
  modules?: CompiledModules
): Promise<
  | { ok: true; checked: CheckedWorkflow; bindings: PinnedBinding[] }
  | { ok: false; problems: WorkflowDefinitionProblem[] }
> => {
  // Every contract the definition names, resolved before validation,
  // which looks contracts up as it goes: workflows for `by`, catalog
  // contracts from the host catalog.
  const named = namedKeys(definition);
  const catalog = await resolveCatalogKeys(env, named.catalog);
  const resolved = new Map<string, ResolvedWorkflow>();
  for (const key of named.workflows) {
    // oxlint-disable-next-line no-await-in-loop -- bounded, each a point lookup
    const found = await resolveWorkflowKey(env, by, key);
    if (found !== undefined) {
      resolved.set(key, found);
    }
  }
  const policy = await quotaPolicy(env);
  const result = await validateWorkflow(definition, {
    catalog: (key) => resolved.get(key)?.contract ?? catalog.get(key)?.contract,
    // `local:` keys resolve against the workflow's own modules only.
    modules: moduleLookup(modules),
    ceilings: {
      maxSteps: policy.limits.workflowSteps,
      maxModelCalls: policy.limits.lineageModelRequests,
      maxActiveMs: policy.limits.workflowActiveMs,
    },
  });
  if (!result.ok) {
    return { ok: false, problems: problemsOf(result.diagnostics) };
  }
  const checked = result.workflow;
  if (
    checked.identity.namespace !== workflowNamespace ||
    checked.identity.name !== workflow.name
  ) {
    return { ok: false, problems: [identityProblem(workflow)] };
  }
  // Its contract must fit a version's row, checked here so a draft that
  // passes is one that publishes (workflow-drafts.ts).
  if (bytesOf(canonicalJson(contractOf(checked))) > contractMaxBytes) {
    return {
      ok: false,
      problems: [
        {
          code: "contract.too_large",
          message:
            "The workflow's input, output and parameter schemas together are larger than a version may hold.",
          pointer: "/input/schema",
          remedy: "Keep the schemas smaller: move large constants into data.",
        },
      ],
    };
  }
  // A run's output reaches whoever started it, who may only use the
  // workflow: a sensitive parameter stays out of every expression until
  // bindings that need one come (GRA-566).
  const sensitive = sensitiveReads(checked);
  if (sensitive.length > 0) {
    return {
      ok: false,
      problems: sensitive.map((read) => ({
        code: "expression.sensitive_param",
        message:
          "An expression reads a sensitive parameter, or all parameters at once, which could pass its value on.",
        pointer: read.pointer,
        ...(read.taskId === undefined ? {} : { taskId: read.taskId }),
        remedy: "Read only parameters that aren't sensitive, each by its name.",
      })),
    };
  }
  const bindings: PinnedBinding[] = [];
  for (const [alias, binding] of checked.bindings) {
    // A binding of the workflow's own modules is sealed with its build
    // (workflow-builds.ts): no approval serves it, so nothing pins it here.
    if (binding.contract.startsWith("local:")) {
      continue;
    }
    const contract = catalog.get(binding.contract);
    if (binding.kind !== "workflow" && contract?.kind === binding.kind) {
      bindings.push({
        alias,
        kind: contract.kind,
        resourceId: null,
        resourceVersion: null,
        contractId: contract.key,
        fingerprint: contract.fingerprint,
      });
      continue;
    }
    const target = resolved.get(binding.contract);
    // Validation resolved every binding it kept through the catalog: a
    // workflow's or a catalog contract.
    if (binding.kind !== "workflow" || target === undefined) {
      throw new Error(`Binding ${alias} resolved outside the catalog`);
    }
    bindings.push({
      alias,
      kind: "workflow",
      resourceId: target.resourceId,
      resourceVersion: target.version,
      contractId: binding.contract,
      fingerprint: target.contractHash,
    });
  }
  bindings.sort((a, b) => (a.alias < b.alias ? -1 : 1));
  const listens = referenceableListensProblem(checked, catalog);
  if (listens !== undefined) {
    return { ok: false, problems: [listens] };
  }
  return { ok: true, checked, bindings };
};

/**
 * `definition` checked for publication (`inspectDefinition`): refused as
 * `workflow.definition_invalid` with its problems otherwise.
 */
const checkDefinition = async (
  env: Env,
  by: Acting,
  workflow: Pick<Live, "name">,
  definition: string,
  modules: CompiledModules | undefined
): Promise<{
  checked: CheckedWorkflow;
  bindings: PinnedBinding[];
}> => {
  const inspected = await inspectDefinition(
    env,
    by,
    workflow,
    definition,
    modules
  );
  if (!inspected.ok) {
    const [first] = inspected.problems;
    if (inspected.problems.length === 1 && first?.code === identityCode) {
      throw workflowResourceErrors.create("workflow.identity_mismatch");
    }
    throw definitionInvalid(inspected.problems);
  }
  return { checked: inspected.checked, bindings: inspected.bindings };
};

/**
 * The build version `version` of workflow `id` seals, from its manifest
 * text (`workflow.version_corrupt` for one that seals none it can read).
 */
const sealedBuildOf = (
  id: string,
  version: number,
  manifest: string
): SealedBuild => {
  try {
    return buildOf(manifest);
  } catch {
    throw corrupt(id, version);
  }
};

/** Where a version's manifest says what its actions may do (GRA-709). */
const manifestActionsSchema = z.object({
  actions: z
    .array(
      z.strictObject({
        binding: z.string(),
        module: z.string(),
        export: z.string(),
        uses: actionUsesSchema,
      })
    )
    .optional(),
});

/**
 * What version `row`'s actions may do, as its manifest seals it; null for
 * a version sealed before it was recorded, which says nothing either way.
 */
const sealedActionsOf = (
  row: typeof workflowResourceVersions.$inferSelect
): WorkflowVersionAction[] | null => {
  let manifest: unknown;
  try {
    manifest = JSON.parse(row.manifest);
  } catch {
    throw corrupt(row.workflowResourceId, row.version);
  }
  const parsed = manifestActionsSchema.safeParse(manifest);
  if (!parsed.success) {
    throw corrupt(row.workflowResourceId, row.version);
  }
  return parsed.data.actions ?? null;
};

/** A version's row, as the registry answers it. */
const versionOf = (
  row: typeof workflowResourceVersions.$inferSelect,
  bindings: WorkflowVersionBinding[]
): WorkflowResourceVersion => ({
  resourceId: row.workflowResourceId,
  version: row.version,
  definitionVersion: row.definitionVersion,
  profile: row.profileVersion,
  definitionHash: row.definitionJsonHash,
  contractHash: row.contractHash,
  manifestHash: row.manifestHash,
  bindings,
  actions: sealedActionsOf(row),
  build: buildSummary(
    sealedBuildOf(row.workflowResourceId, row.version, row.manifest)
  ),
  author: row.authorId,
  createdAt: row.createdAt.toISOString(),
});

/** The bindings of the versions of `id`, by version. */
export const bindingsOf = async (
  env: Env,
  id: string
): Promise<Map<number, PinnedBinding[]>> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(sdkResourceBindings)
    .where(
      and(
        eq(sdkResourceBindings.resourceId, id),
        inArray(sdkResourceBindings.kind, ["workflow", ...catalogBindingKinds])
      )
    )
    .orderBy(asc(sdkResourceBindings.alias));
  const byVersion = new Map<number, PinnedBinding[]>();
  for (const row of rows) {
    // Filtered above: an App's store binding is never a workflow's.
    if (row.kind === "store") {
      continue;
    }
    const list = byVersion.get(row.resourceVersion) ?? [];
    list.push(
      row.kind === "workflow"
        ? {
            alias: row.alias,
            kind: "workflow",
            resourceId: row.targetId,
            resourceVersion: row.targetVersion ?? 0,
            contractId: row.contractId ?? "",
            fingerprint: row.schemaHash,
          }
        : {
            alias: row.alias,
            kind: row.kind,
            resourceId: null,
            resourceVersion: null,
            contractId: row.targetId,
            fingerprint: row.schemaHash,
          }
    );
    byVersion.set(row.resourceVersion, list);
  }
  return byVersion;
};

/**
 * `bindings` as `by` may see them: which workflow each binds (its ID,
 * version and contract key, which names it) only where `by` builds that
 * workflow; elsewhere only the alias and the contract's fingerprint. Each
 * target's role is read once.
 */
const visibleTo = async (
  env: Env,
  by: Acting,
  bindings: readonly PinnedBinding[]
): Promise<Map<PinnedBinding, WorkflowVersionBinding>> => {
  const builds = new Map<string, boolean>();
  for (const { resourceId } of bindings) {
    if (resourceId !== null && !builds.has(resourceId)) {
      // oxlint-disable-next-line no-await-in-loop -- one point lookup per bound workflow
      const target = await liveWorkflow(env, resourceId);
      const role =
        // oxlint-disable-next-line no-await-in-loop -- the same lookup's role
        target === undefined ? undefined : await roleIn(env, by, target);
      builds.set(resourceId, role === "builder");
    }
  }
  return new Map(
    bindings.map((binding) => [
      binding,
      binding.resourceId === null || builds.get(binding.resourceId) === true
        ? binding
        : {
            alias: binding.alias,
            kind: binding.kind,
            resourceId: null,
            resourceVersion: null,
            contractId: null,
            fingerprint: binding.fingerprint,
          },
    ])
  );
};

/** A version's contract: its input, output and parameters. */
export type VersionContract = StoredContract;

/**
 * The contract of version `version` of workflow `id`, checked against its
 * hash (`workflow.version_corrupt` otherwise); undefined for a version it
 * never published.
 */
export const versionContract = async (
  env: Env,
  id: string,
  version: number
): Promise<VersionContract | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      contract: workflowResourceVersions.contract,
      contractHash: workflowResourceVersions.contractHash,
    })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, id),
        eq(workflowResourceVersions.version, version)
      )
    )
    .get();
  if (row === undefined) {
    return undefined;
  }
  if ((await sha256Hex(row.contract)) !== row.contractHash) {
    throw corrupt(id, version);
  }
  return storedContractSchema.parse(JSON.parse(row.contract));
};

/** Where a version's manifest says what its modules were published as. */
const manifestModulesSchema = z.object({
  modulesHash: z.string().nullable().optional(),
});

/** The hash of the modules version `row` was published with, null for none. */
const sealedModulesHash = (
  row: typeof workflowResourceVersions.$inferSelect
): string | null => {
  try {
    return (
      manifestModulesSchema.parse(JSON.parse(row.manifest)).modulesHash ?? null
    );
  } catch {
    throw corrupt(row.workflowResourceId, row.version);
  }
};

/** The version of `id` with semantic version `definitionVersion`, if any. */
const publishedAs = async (
  env: Env,
  id: string,
  definitionVersion: string
): Promise<
  { version: WorkflowResourceVersion; modulesHash: string | null } | undefined
> => {
  const row = await drizzle(env.DB)
    .select()
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, id),
        eq(workflowResourceVersions.definitionVersion, definitionVersion)
      )
    )
    .get();
  if (row === undefined) {
    return undefined;
  }
  const bindings = await bindingsOf(env, id);
  return {
    version: versionOf(row, bindings.get(row.version) ?? []),
    modulesHash: sealedModulesHash(row),
  };
};

/** Where a definition's text says its semantic version. */
const statedVersionSchema = z.object({
  document: z.object({ version: z.string() }),
});

/**
 * The version of workflow `id` already published from `definition`: the
 * one under the semantic version its text states, if it was published
 * from the same definition (`definitionHashOf`, so whitespace and key
 * order aside). Read off the text alone: a saved version passed
 * validation as it was published, and nothing is written for it again.
 * Its bindings are answered as pinned; `publishWorkflowVersion` answers
 * them as its caller may see them.
 */
const savedPublication = async (
  env: Env,
  id: string,
  definition: string,
  modulesHash: string | null
): Promise<WorkflowResourceVersion | undefined> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    return undefined;
  }
  const stated = statedVersionSchema.safeParse(parsed).data?.document.version;
  if (stated === undefined) {
    return undefined;
  }
  const existing = await publishedAs(env, id, stated);
  if (
    existing === undefined ||
    existing.modulesHash !== modulesHash ||
    existing.version.definitionHash !== (await definitionHashOf(parsed))
  ) {
    return undefined;
  }
  return existing.version;
};

/**
 * `version` of workflow `id` as `by` may see it (`visibleTo`): every
 * answer to a publication, new, raced or retried, tells no more of what
 * it binds than the version's listing does.
 */
const seenBy = async (
  env: Env,
  by: Acting,
  version: WorkflowResourceVersion
): Promise<WorkflowResourceVersion> => {
  const byVersion = await bindingsOf(env, version.resourceId);
  const pinned = byVersion.get(version.version) ?? [];
  const visible = await visibleTo(env, by, pinned);
  return {
    ...version,
    bindings: pinned.map((binding) => visible.get(binding) ?? binding),
  };
};

/** A version about to be written: everything its row and manifest hold. */
interface Publication {
  workflow: Live;
  checked: CheckedWorkflow;
  definition: string;
  definitionHash: string;
  bindings: PinnedBinding[];
  /** What it runs: the code generated from it, compiled (workflow-builds.ts). */
  compiled: CompiledBuild;
  /** The hash of the modules published with it, null for none. */
  modulesHash: string | null;
  /** What its own actions may do, from the contracts its build seals. */
  actions: WorkflowVersionAction[];
}

/**
 * Writes `publication` as the version after the current one, in one batch
 * with its bindings, the move of the current version and its event: only
 * while the workflow is live and still at the version it built on, and
 * each bound workflow still live. Answers the version written.
 */
const writeVersion = async (
  env: Env,
  by: Acting,
  publication: Publication
): Promise<WorkflowResourceVersion> => {
  const {
    workflow,
    checked,
    definition,
    definitionHash,
    bindings,
    compiled,
    modulesHash,
    actions,
  } = publication;
  // Bounded when the definition was checked (`inspectDefinition`).
  const contractText = canonicalJson(contractOf(checked));
  const contractHash = await sha256Hex(contractText);
  const version = (workflow.currentVersion ?? 0) + 1;
  const definitionVersion = checked.identity.version;
  const manifest = canonicalJson({
    formatVersion: 1,
    target: "workflow",
    resourceId: workflow.id,
    resourceVersion: version,
    namespace: workflowNamespace,
    name: workflow.name,
    definitionVersion,
    profile: checked.profile,
    definitionHash,
    modulesHash,
    evaluatorHash: jqProvenance.sha256,
    contractHash,
    bindings: bindings.map((binding) => ({ ...binding })),
    // What its own actions may do, as its build seals them (GRA-709): read
    // back for review, never derived again.
    actions: actions.map((action) => ({
      binding: action.binding,
      module: action.module,
      export: action.export,
      uses: action.uses.map((use) =>
        use.kind === "connector"
          ? {
              alias: use.alias,
              kind: use.kind,
              operations: [...use.operations],
            }
          : { alias: use.alias, kind: use.kind }
      ),
    })),
    // What the version runs, sealed with it: its build's artifacts by
    // hash, and its executable identity (workflow-builds.ts).
    build: compiled.build,
    artifactTrust: "unreviewed",
  });
  if (bytesOf(manifest) > manifestMaxBytes) {
    throw definitionInvalid([
      {
        code: "manifest.too_large",
        message: "What the version pins is larger than a version may hold.",
        pointer: "/document/metadata/grasp/bindings",
        remedy: "Bind fewer workflows.",
      },
    ]);
  }
  const manifestHash = await sha256Hex(manifest);
  const createdAt = new Date();
  const db = drizzle(env.DB);
  // This publication's own reservations: another publishing the same
  // version at once keeps its own, so neither gives back the other's.
  const owner = publicationReservation(workflow.id);
  try {
    // Its build's bytes, reserved for this publication and stored, before
    // the row that names them; inside the cleanup, so a store that fails
    // halfway gives its reservations back too.
    await storeBuild(env, { id: owner, version }, compiled);
    await auditedBatch(env, db, [
      db.insert(workflowResourceVersions).values({
        // Only while the workflow is live and still at the version this
        // publication built on: otherwise NULL, which fails the batch.
        workflowResourceId: sql`(SELECT id FROM workflow_resources
        WHERE id = ${workflow.id} AND deleted_at IS NULL
          AND current_version IS ${workflow.currentVersion})`,
        version,
        definitionVersion,
        definition,
        definitionJsonHash: definitionHash,
        profileVersion: checked.profile,
        evaluatorHash: jqProvenance.sha256,
        contract: contractText,
        contractHash,
        manifest,
        // The hash only while every artifact its build names is reserved for
        // this publication: otherwise NULL, which the column refuses, and
        // the whole publication with it. So no sweep deletes bytes a version
        // names (release-retention.ts).
        manifestHash: sql`(SELECT ${manifestHash} WHERE NOT EXISTS (
        SELECT 1 FROM json_each(${manifest}, '$.build.artifacts') AS named
        WHERE NOT EXISTS (SELECT 1 FROM sdk_release_artifacts AS reserved
          WHERE reserved.app_id = ${owner} AND reserved.version = ${version}
            AND reserved.sha256 = json_extract(named.value, '$.sha256'))))`,
        authorId: by.userId,
        createdAt,
      }),
      // The version's from now on, as long as it is.
      ...adoptReservations(db, owner, workflow.id, version),
      db
        .update(workflowResources)
        .set({ currentVersion: version })
        .where(eq(workflowResources.id, workflow.id)),
      ...bindings.map((binding) =>
        binding.kind === "workflow"
          ? db.insert(sdkResourceBindings).values({
              resourceId: workflow.id,
              resourceVersion: version,
              alias: binding.alias,
              kind: "workflow" as const,
              // Only while the target is live: otherwise NULL, which fails the
              // batch, so a deletion and this binding never both land.
              targetId: sql`(SELECT id FROM workflow_resources
          WHERE id = ${binding.resourceId} AND deleted_at IS NULL)`,
              targetVersion: binding.resourceVersion,
              contractId: binding.contractId,
              schemaHash: binding.fingerprint,
              manifestHash,
            })
          : db.insert(sdkResourceBindings).values({
              resourceId: workflow.id,
              resourceVersion: version,
              alias: binding.alias,
              kind: binding.kind,
              // A catalog contract, by its key: what serves it is an
              // approval's (workflow-bindings.ts), never this row's.
              targetId: binding.contractId,
              targetVersion: null,
              contractId: binding.contractId,
              schemaHash: binding.fingerprint,
              manifestHash,
            })
      ),
      outboxed(
        db,
        entry(by, "workflow.version.published", workflow.id, {
          version,
          definitionVersion,
          definitionHash,
          contractHash,
          manifestHash,
        })
      ),
    ]);
  } catch (error) {
    // Not written: what this publication reserved goes back, and only
    // that: another's, and a saved version's, stay.
    try {
      await releaseBuild(env, { id: owner, version }, compiled);
    } catch (releaseError) {
      log.warn("workflow.build_release_failed", errorFields(releaseError));
    }
    throw error;
  }
  return {
    resourceId: workflow.id,
    version,
    definitionVersion,
    profile: checked.profile,
    definitionHash,
    contractHash,
    manifestHash,
    bindings,
    actions,
    build: buildSummary(compiled.build),
    author: by.userId,
    createdAt: createdAt.toISOString(),
  };
};

/** A publication's input, its definition bounded by the profile's bytes. */
const publishSchema = workflowPublishSchema.refine(
  ({ definition }) => bytesOf(definition) <= profileLimits.maxDefinitionBytes,
  { path: ["definition"], message: "Larger than a definition may be" }
);

/** What identifies a binding: its alias and the exact version it binds. */
const bindingKey = (binding: PinnedBinding): string =>
  `${binding.alias}\n${binding.resourceId}\n${binding.resourceVersion}`;

/**
 * Refuses Grasp staff (`role.forbidden`) a publication whose bindings
 * aren't exactly those of the current version: which workflows a client's
 * workflow runs is the client's decision, as which stores an App binds is
 * (data-stores.ts). Staff may still publish a version that binds the same,
 * or nothing.
 */
const requireStaffKeepsBindings = async (
  env: Env,
  by: Acting,
  workflow: Live,
  bindings: readonly PinnedBinding[]
): Promise<void> => {
  if (!by.staff || bindings.length === 0) {
    return;
  }
  const versions = await bindingsOf(env, workflow.id);
  const current =
    workflow.currentVersion === null
      ? []
      : (versions.get(workflow.currentVersion) ?? []);
  const kept = new Set(current.map(bindingKey));
  if (
    current.length !== bindings.length ||
    !bindings.every((binding) => kept.has(bindingKey(binding)))
  ) {
    throw roleErrors.create("role.forbidden");
  }
};

/** `publishWorkflowVersion`, answering bindings as pinned. */
const publish = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowResourceVersion> => {
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const {
    definition,
    basedOn,
    modules: sources = {},
  } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    publishSchema,
    input
  );
  // Its modules are part of what is published: the same definition with
  // other modules is another publication.
  const modulesHash =
    Object.keys(sources).length === 0 ? null : await modulesHashOf(sources);
  // A retry of a publication that was saved answers the saved version
  // before its bindings are resolved again: the builder may have lost
  // their role in a workflow it binds since, or that workflow been
  // deleted, and the version still binds what it pinned then.
  const saved = await savedPublication(
    env,
    workflow.id,
    definition,
    modulesHash
  );
  if (saved !== undefined) {
    return saved;
  }
  // Built and inspected first: validation resolves `local:` bindings
  // against what they export.
  const modules =
    modulesHash === null
      ? undefined
      : await compileModules(env, sources, workflow.id);
  const { checked, bindings } = await checkDefinition(
    env,
    by,
    workflow,
    definition,
    modules
  );
  await requireStaffKeepsBindings(env, by, workflow, bindings);
  // Of its canonical JSON: a retry that differs only in whitespace or key
  // order is the same definition, and the same publication.
  const definitionHash = await definitionHashOf(checked.definition);
  const sameVersion = async (): Promise<
    WorkflowResourceVersion | undefined
  > => {
    const existing = await publishedAs(
      env,
      workflow.id,
      checked.identity.version
    );
    if (
      existing !== undefined &&
      (existing.version.definitionHash !== definitionHash ||
        existing.modulesHash !== modulesHash)
    ) {
      throw workflowResourceErrors.create("workflow.version_exists");
    }
    return existing?.version;
  };
  const existing = await sameVersion();
  if (existing !== undefined) {
    return existing;
  }
  if (basedOn !== workflow.currentVersion) {
    throw workflowResourceErrors.create("workflow.version_conflict");
  }
  // Generated and built once, here: no start or resume compiles anything.
  const compiled = await compileWorkflow(
    env,
    checked,
    definition,
    workflow.id,
    modules
  );
  try {
    return await writeVersion(env, by, {
      workflow,
      checked,
      definition,
      definitionHash,
      bindings,
      compiled,
      modulesHash,
      actions: versionActionsOf(checked.bindings, modules),
    });
  } catch (error) {
    if (notNullFailed(error, "workflow_resource_versions.manifest_hash")) {
      // A reservation of its build went before the row could name it,
      // which only a publication stalled past the sweep's grace sees:
      // publishing again reserves afresh.
      throw workflowResourceErrors.create("workflow.version_conflict");
    }
    if (
      notNullFailed(error, "workflow_resource_versions.workflow_resource_id")
    ) {
      if ((await liveWorkflow(env, workflow.id)) === undefined) {
        throw unavailable();
      }
      // The current version moved: to this very definition, if an
      // identical publication won the race, which is then this one's.
      const won = await sameVersion();
      if (won === undefined) {
        throw workflowResourceErrors.create("workflow.version_conflict");
      }
      return won;
    }
    if (notNullFailed(error, "sdk_resource_bindings.target_id")) {
      throw definitionInvalid([
        {
          code: "binding.unknown_contract",
          message: "A workflow the definition binds was deleted.",
          pointer: "/document/metadata/grasp/bindings",
          remedy: "Bind a workflow that exists.",
        },
      ]);
    }
    if (!isUniqueViolation(error)) {
      throw error;
    }
    // Another publication of the same number or semantic version won.
    const won = await sameVersion();
    if (won === undefined) {
      throw workflowResourceErrors.create("workflow.version_conflict");
    }
    return won;
  }
};

/**
 * Publishes a version of workflow `id` for `by`, who must build it, from
 * `input`: the definition's text and the current version it built on.
 * The definition must pass grasp-open-workflow/1 against the host's
 * catalog (refused with its diagnostics, `workflow.definition_invalid`)
 * and name this workflow. Its version is the next publication number; it
 * becomes the current version. Publishing a semantic version already
 * published answers that version if the definition is the same, and is
 * refused otherwise.
 */
/**
 * What keeps `definition` from being published to `workflow` by `by`, as
 * `checkDefinition` checks it: empty when nothing does. Its refusals of
 * the definition are answered as problems, at their pointers; anything
 * else (the catalog unreachable) is thrown. What drafts are checked with
 * (workflow-drafts.ts), so a checkpoint is exactly what would publish.
 * A draft is its definition alone and publishes without modules, so it is
 * checked without them: a `local:` binding is a problem in a draft.
 */
export const definitionProblems = async (
  env: Env,
  by: Acting,
  workflow: Pick<Live, "name">,
  definition: string
): Promise<WorkflowDefinitionProblem[]> => {
  const inspected = await inspectDefinition(env, by, workflow, definition);
  return inspected.ok ? [] : inspected.problems;
};

export const publishWorkflowVersion = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowResourceVersion> =>
  await seenBy(env, by, await publish(env, by, id, input));

/** Every version of workflow `id`, newest first, for anyone with a role. */
export const workflowVersions = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowResourceVersion[]> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowResourceVersions)
    .where(eq(workflowResourceVersions.workflowResourceId, workflow.id))
    .orderBy(desc(workflowResourceVersions.version));
  const bindings = await bindingsOf(env, workflow.id);
  const visible = await visibleTo(env, by, [...bindings.values()].flat());
  return rows.map((row) =>
    versionOf(
      row,
      (bindings.get(row.version) ?? []).map(
        (binding) => visible.get(binding) ?? binding
      )
    )
  );
};

/**
 * The definition of version `version` of workflow `id`, exactly as
 * published, for its builders: its parameters' defaults may be sensitive.
 */
export const workflowDefinition = async (
  env: Env,
  by: Acting,
  id: unknown,
  version: unknown
): Promise<string> => {
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  const row = await drizzle(env.DB)
    .select({
      definition: workflowResourceVersions.definition,
      definitionHash: workflowResourceVersions.definitionJsonHash,
    })
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
  // Served only as published: text that no longer hashes to what was
  // published is refused, never handed out.
  let hash: string | undefined;
  try {
    hash = await definitionHashOf(JSON.parse(row.definition));
  } catch {
    hash = undefined;
  }
  if (hash !== row.definitionHash) {
    throw corrupt(workflow.id, version);
  }
  return row.definition;
};

/**
 * The portable source of version `version` of workflow `id`, for its
 * builders: its definition exactly as published (`workflowDefinition`'s
 * checks) and, for an executable version, the SDK TypeScript generated
 * from it, read back from its sealed build with every hash checked. It
 * goes one way: a version is only ever published from a definition, so
 * edited generated code never comes back as one.
 */
export const workflowSource = async (
  env: Env,
  by: Acting,
  id: unknown,
  version: unknown
): Promise<WorkflowVersionSource> => {
  const definition = await workflowDefinition(env, by, id, version);
  // Both checked by `workflowDefinition`: a workflow `by` builds, and a
  // version it published.
  const workflowId = String(id);
  const number = Number(version);
  const row = await drizzle(env.DB)
    .select({ manifest: workflowResourceVersions.manifest })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, workflowId),
        eq(workflowResourceVersions.version, number)
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  const files: Record<string, string> = { "workflow.json": definition };
  if (sealedBuildOf(workflowId, number, row.manifest).executable) {
    const build = await loadWorkflowBuild(env, workflowId, number);
    files[generatedPath] = build.source;
    // Its own modules, as published, read back from the seal.
    for (const [path, source] of Object.entries(build.compute.sources)) {
      files[path] = source;
    }
  }
  return { files };
};

/**
 * Shares workflow `id` with a person or team in a role, for `by`, who must
 * build it and isn't Grasp staff: never with its owner; as a builder, only
 * with someone whose organization role builds. Sharing again changes the
 * role, and records only a change.
 */
export const shareWorkflowResource = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<void> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const { role, ...member } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowShareSchema,
    input
  );
  await requireSharable(env, member, {
    owner: workflow.owner,
    builds: role === "builder",
    invalid: (issue) =>
      workflowResourceErrors.create("workflow.resource_invalid", {
        issues: [issue],
      }),
    ownerIssue: "id: The workflow's owner always has it.",
    buildsIssue:
      "role: Only the organization's admins and builders build workflows.",
  });
  const addedAt = new Date();
  const db = drizzle(env.DB);
  const batch = auditedBatch(env, db, [
    db
      .insert(workflowResourceMembers)
      .values({
        // Only while the workflow is live: otherwise NULL, which fails the
        // batch, so a share racing a deletion writes nothing.
        workflowResourceId: sql`(SELECT id FROM workflow_resources
          WHERE id = ${workflow.id} AND deleted_at IS NULL)`,
        memberType: member.type,
        memberId: member.id,
        role,
        addedBy: by.userId,
        addedAt,
      })
      .onConflictDoUpdate({
        target: [
          workflowResourceMembers.workflowResourceId,
          workflowResourceMembers.memberType,
          workflowResourceMembers.memberId,
        ],
        set: { role, addedBy: by.userId, addedAt },
        setWhere: sql`${workflowResourceMembers.role} <> ${role}
          AND EXISTS (SELECT 1 FROM workflow_resources
            WHERE id = ${workflow.id} AND deleted_at IS NULL)`,
      }),
    // Only when the share changed something (a role the member already
    // has changes nothing): a start decided meanwhile is still good.
    nextGeneration(db, workflow.id, previousChanged),
    outboxedIfChanged(
      db,
      memberEntry(
        by,
        "workflow.member.added",
        { type: targetType, id: workflow.id },
        { ...member, role }
      )
    ),
  ]);
  try {
    await batch;
  } catch (error) {
    if (
      notNullFailed(error, "workflow_resource_members.workflow_resource_id")
    ) {
      throw unavailable();
    }
    throw error;
  }
};

/**
 * Stops sharing workflow `id` with a person or team, for `by`, who must
 * build it and isn't Grasp staff. Unsharing someone it isn't shared with
 * changes and records nothing.
 */
export const unshareWorkflowResource = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<void> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const member: MemberRef = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowMemberSchema,
    input
  );
  const db = drizzle(env.DB);
  const ofMember = and(
    eq(workflowResourceMembers.workflowResourceId, workflow.id),
    eq(workflowResourceMembers.memberType, member.type),
    eq(workflowResourceMembers.memberId, member.id)
  );
  // The role it had, for the event, which only the deletion stores.
  const row = await db
    .select({ role: workflowResourceMembers.role })
    .from(workflowResourceMembers)
    .where(ofMember)
    .get();
  if (row === undefined) {
    return;
  }
  await auditedBatch(env, db, [
    db.delete(workflowResourceMembers).where(ofMember),
    nextGeneration(db, workflow.id, previousChanged),
    outboxedIfChanged(
      db,
      memberEntry(
        by,
        "workflow.member.removed",
        { type: targetType, id: workflow.id },
        { ...member, role: row.role }
      )
    ),
  ]);
};

/**
 * Whom workflow `id` is shared with, for anyone with a role in it: the
 * people still in the organization and the teams that still exist, in the
 * order they were shared.
 */
export const workflowMembers = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowMember[]> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowResourceMembers)
    .where(
      and(
        eq(workflowResourceMembers.workflowResourceId, workflow.id),
        stillMembers(workflowResourceMembers)
      )
    )
    .orderBy(
      asc(workflowResourceMembers.addedAt),
      asc(workflowResourceMembers.memberType),
      asc(workflowResourceMembers.memberId)
    );
  return rows.map((row) => ({
    type: row.memberType,
    id: row.memberId,
    role: row.role,
    addedBy: row.addedBy,
    addedAt: row.addedAt.toISOString(),
  }));
};

/**
 * `counts` and as many of `groups` as fit beside them in one audit event's
 * detail (`auditDetailMaxKeys` fields in all), each group's fields named
 * with its place in its list (`binder1`, `trigger3`, `appBinding2` and
 * `app2`), earlier lists first. The counts always say how many there are.
 */
const namedWithin = (
  counts: Record<string, string | number>,
  lists: readonly Record<string, string>[][]
): Record<string, string | number> => {
  let room = auditDetailMaxKeys - Object.keys(counts).length;
  const named: Record<string, string> = {};
  for (const list of lists) {
    for (const [index, group] of list.entries()) {
      const fields = Object.entries(group);
      if (fields.length > room) {
        return { ...counts, ...named };
      }
      for (const [field, value] of fields) {
        named[`${field}${index + 1}`] = value;
      }
      room -= fields.length;
    }
  }
  return { ...counts, ...named };
};

/**
 * The triggers that may start `id`, as SQL rows of their IDs: live,
 * enabled, their current version pinning `id`, and holding an active
 * `start` grant on it. A trigger that can't start it pins nothing.
 */
const pinningTriggersSql = (id: string) => sql`SELECT trigger.id AS id
    FROM trigger_resources AS trigger
    JOIN trigger_resource_versions AS pinned
      ON pinned.trigger_id = trigger.id AND pinned.version = trigger.current_version
    WHERE pinned.workflow_resource_id = ${id} AND trigger.deleted_at IS NULL
      AND trigger.enabled = 1
      AND EXISTS (SELECT 1 FROM permissions AS allowed
        WHERE allowed.subject_type = 'trigger' AND allowed.subject_id = trigger.id
          AND allowed.object_type = 'workflow' AND allowed.object_id = ${id}
          AND allowed.status = 'active'
          AND EXISTS (SELECT 1 FROM json_each(allowed.actions) WHERE value = 'start'))`;

/**
 * The App bindings that may start a version of `id`, as SQL rows of each
 * binding's ID and its App's: active, their App holding an active `start`
 * grant on it. A binding grants nothing, so one whose App can't start it
 * pins nothing: no builder of some App keeps a workflow from being deleted
 * by binding it.
 */
const pinningAppsSql = (id: string) => sql`SELECT pinned.id AS id,
      pinned.app_id AS app
    FROM app_workflow_bindings AS pinned
    WHERE pinned.workflow_resource_id = ${id} AND pinned.status = 'active'
      AND EXISTS (SELECT 1 FROM permissions AS allowed
        WHERE allowed.subject_type = 'app' AND allowed.subject_id = pinned.app_id
          AND allowed.object_type = 'workflow' AND allowed.object_id = ${id}
          AND allowed.status = 'active'
          AND EXISTS (SELECT 1 FROM json_each(allowed.actions) WHERE value = 'start'))`;

/**
 * How many runs of `id` haven't ended, as SQL: a run admitted is
 * `starting` until the engine's first word of it (workflows/
 * resource-runs.ts), so it counts from its receipt's statement on.
 */
const liveRunsSql = (id: string) => sql`(SELECT COUNT(*)
    FROM workflow_resource_runs AS run
    WHERE run.workflow_resource_id = ${id}
      AND run.status IN ('starting', 'running'))`;

/**
 * That something still pins a version of `id`, as SQL: the current version
 * of another live workflow binds it, a live trigger's current version
 * starts it, or an active App binding whose App may start it pins one of
 * its versions, or a run of it hasn't ended: its builders terminate one
 * (workflows/resource-runs.ts) to delete it sooner. Only another
 * workflow's current version counts, so an older, immutable version can't keep a workflow from ever being deleted;
 * a workflow has no rollback of its own, and an App rolls back to a
 * binding by binding it again, so a removed App binding pins nothing.
 */
const boundSql = (
  id: string
) => sql`(EXISTS (SELECT 1 FROM sdk_resource_bindings AS bound
    JOIN workflow_resources AS binder ON binder.id = bound.resource_id
    WHERE bound.kind = 'workflow' AND bound.target_id = ${id}
      AND bound.resource_version = binder.current_version
      AND binder.id <> ${id} AND binder.deleted_at IS NULL)
  OR EXISTS (${pinningTriggersSql(id)})
  OR EXISTS (${pinningAppsSql(id)})
  OR ${liveRunsSql(id)} > 0)`;

/** The live workflows whose current version binds `id`. */
const bindersOf = async (env: Env, id: string): Promise<Live[]> =>
  await drizzle(env.DB)
    .selectDistinct({
      id: workflowResources.id,
      name: workflowResources.name,
      owner: workflowResources.ownerId,
      currentVersion: workflowResources.currentVersion,
      createdAt: workflowResources.createdAt,
    })
    .from(sdkResourceBindings)
    .innerJoin(
      workflowResources,
      and(
        eq(workflowResources.id, sdkResourceBindings.resourceId),
        eq(
          sdkResourceBindings.resourceVersion,
          workflowResources.currentVersion
        )
      )
    )
    .where(
      and(
        eq(sdkResourceBindings.kind, "workflow"),
        eq(sdkResourceBindings.targetId, id),
        isNull(workflowResources.deletedAt),
        sql`${workflowResources.id} <> ${id}`
      )
    )
    .orderBy(asc(workflowResources.id));

/**
 * Deletes workflow `id` for `by`, who must build it and isn't Grasp staff,
 * in one statement that requires the current version of no other live
 * workflow to bind it. Otherwise `workflow.resource_bound`, audited with
 * the binders' IDs, and answered with the binders `by` may see and a count
 * of those they may not (`WorkflowBinders`). Its row and versions stay,
 * never served again.
 */
export const deleteWorkflowResource = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<void> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const db = drizzle(env.DB);
  const [deleted] = await auditedBatch(env, db, [
    db
      .update(workflowResources)
      .set({
        deletedAt: new Date(),
        policyGeneration: sql`${workflowResources.policyGeneration} + 1`,
      })
      .where(
        and(
          eq(workflowResources.id, workflow.id),
          isNull(workflowResources.deletedAt),
          sql`NOT ${boundSql(workflow.id)}`
        )
      )
      .returning({ id: workflowResources.id }),
    outboxedIfChanged(db, entry(by, "workflow.deleted", workflow.id)),
    // Its packages end with it: approvals revoked, the request waiting
    // withdrawn, and the locks only they named gone, their files to
    // cleanup (dependencies/pending.ts).
    ...withdrawnWithWorkflow(db, by, workflow.id),
    // Its draft (workflow-drafts.ts) is never read again, and may hold a
    // sensitive parameter's default: it goes once it is deleted.
    db.delete(workflowResourceDrafts).where(
      sql`${workflowResourceDrafts.workflowResourceId} IN (SELECT id
        FROM workflow_resources WHERE id = ${workflow.id} AND deleted_at IS NOT NULL)`
    ),
    // The releases its approvals kept (workflow-bindings.ts) go back to
    // their retention once it is deleted.
    db.delete(sdkReleasePins).where(
      and(
        eq(sdkReleasePins.holderKind, "approval"),
        sql`${sdkReleasePins.holderId} IN (SELECT approval.id
          FROM workflow_binding_approvals AS approval
          JOIN workflow_resources AS workflow ON workflow.id = approval.workflow_resource_id
          WHERE approval.workflow_resource_id = ${workflow.id}
            AND workflow.deleted_at IS NOT NULL)`
      )
    ),
  ]);
  if (deleted.length > 0) {
    return;
  }
  if ((await liveWorkflow(env, workflow.id)) === undefined) {
    throw unavailable();
  }
  const binders = await bindersOf(env, workflow.id);
  const triggerRows = await drizzle(env.DB).all<{ id: string }>(
    sql`${pinningTriggersSql(workflow.id)} ORDER BY trigger.id`
  );
  const triggers = triggerRows.map(({ id: trigger }) => trigger);
  const appBindings = await drizzle(env.DB).all<{ id: string; app: string }>(
    sql`${pinningAppsSql(workflow.id)} ORDER BY pinned.app_id, pinned.id`
  );
  const [live] = await drizzle(env.DB).all<{ count: number }>(
    sql`SELECT ${liveRunsSql(workflow.id)} AS count`
  );
  const liveRuns = live?.count ?? 0;
  await auditedBatch(env, db, [
    outboxed(
      db,
      entry(
        by,
        "workflow.delete_refused",
        workflow.id,
        namedWithin(
          {
            reason: "workflow.resource_bound",
            binders: binders.length,
            triggers: triggers.length,
            appBindings: appBindings.length,
            liveRuns,
          },
          [
            binders.map(({ id: binder }) => ({ binder })),
            triggers.map((trigger) => ({ trigger })),
            appBindings.map(({ id: appBinding, app }) => ({ appBinding, app })),
          ]
        )
      )
    ),
  ]);
  const visible: WorkflowBinders["binders"] = [];
  for (const binder of binders) {
    // oxlint-disable-next-line no-await-in-loop -- one role per binder, as `get` reads it
    if ((await roleIn(env, by, binder)) !== undefined) {
      visible.push({ id: binder.id, name: binder.name });
    }
  }
  const details: WorkflowBinders = {
    binders: visible,
    hidden: binders.length - visible.length,
    // A workflow's builders manage every trigger that starts it
    // (trigger-resources.ts), and only they delete it: they see them all.
    triggers: { ids: triggers, hidden: 0 },
    // And remove any App binding to it (app-workflow-bindings.ts): they
    // see them all, with their Apps.
    appBindings: appBindings.map(({ id: binding, app }) => ({
      id: binding,
      app,
    })),
    liveRuns,
  };
  throw workflowResourceErrors.create("workflow.resource_bound", {
    binders: details.binders,
    hidden: details.hidden,
    triggers: details.triggers,
    appBindings: details.appBindings,
    liveRuns: details.liveRuns,
  });
};
