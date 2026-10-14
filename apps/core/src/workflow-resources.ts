import type { CatalogContract } from "@grasp-os/open-workflow/catalog";
import type { Diagnostic } from "@grasp-os/open-workflow/diagnostics";
import { profileLimits } from "@grasp-os/open-workflow/limits";
import { validateWorkflow } from "@grasp-os/open-workflow/validate";
import type { CheckedWorkflow } from "@grasp-os/open-workflow/validate";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import {
  canBuild,
  isAdmin,
  requireBuilder,
  roleErrors,
} from "@grasp-os/shared/roles";
import {
  workflowNameSchema,
  workflowNamespace,
  workflowPublishSchema,
  workflowResourceErrors,
  workflowShareSchema,
  workflowMemberSchema,
} from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowDefinitionProblem,
  WorkflowMember,
  WorkflowResource,
  WorkflowResourceVersion,
  WorkflowRole,
  WorkflowBinders,
  WorkflowVersionBinding,
} from "@grasp-os/shared/workflow-resources";
import { jqProvenance } from "@grasp-os/workflow-expressions/provenance";
import { and, asc, desc, eq, exists, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  sdkResourceBindings,
  workflowResourceMembers,
  workflowResources,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { isUniqueViolation, notNullFailed } from "./db/d1.ts";
import {
  memberEntry,
  requireNotStaff,
  requireSharable,
  rowsOf,
  stillMembers,
} from "./sharing.ts";
import type { MemberRef } from "./sharing.ts";
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
 * as one that doesn't exist; too low a role is `role.forbidden`.
 */
const accessible = async (
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
  const workflow = await accessible(env, by, id, "user");
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

/** A binding as publication resolved it: every field known. */
interface PinnedBinding {
  alias: string;
  kind: "workflow";
  resourceId: string;
  resourceVersion: number;
  contractId: string;
  fingerprint: string;
}

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
 * output, and its parameters' descriptors, labels and sensitivity.
 */
const storedContractSchema = z.strictObject({
  input: z.json(),
  output: z.json(),
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
 * The workflow contract keys a definition's bindings name, read from its
 * text only to know what to look up before validation: what validation
 * then resolves through the catalog is all that counts. Text that isn't
 * JSON names none, and validation refuses it.
 */
const namedWorkflowKeys = (definition: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    return [];
  }
  const declared = declaredBindingsSchema.safeParse(parsed);
  if (!declared.success) {
    return [];
  }
  const keys = new Set<string>();
  for (const binding of Object.values(
    declared.data.document.metadata.grasp.bindings
  )) {
    const workflow = workflowBindingSchema.safeParse(binding);
    if (workflow.success) {
      keys.add(workflow.data.contract);
    }
  }
  return [...keys].slice(0, maxWorkflowBindings);
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
    params,
  };
};

/**
 * `definition` checked for publication to `workflow` by `by`: it passes
 * grasp-open-workflow/1 against the host's catalog, its workflow bindings
 * resolved for `by` (`workflow.definition_invalid` with its diagnostics
 * otherwise), and names this workflow (`workflow.identity_mismatch`).
 * Returns it with what each binding resolved to.
 */
const checkDefinition = async (
  env: Env,
  by: Acting,
  workflow: Live,
  definition: string
): Promise<{
  checked: CheckedWorkflow;
  bindings: PinnedBinding[];
}> => {
  // Every workflow contract the definition names, resolved for `by`
  // before validation, which looks contracts up as it goes.
  const resolved = new Map<string, ResolvedWorkflow>();
  for (const key of namedWorkflowKeys(definition)) {
    // oxlint-disable-next-line no-await-in-loop -- bounded, each a point lookup
    const found = await resolveWorkflowKey(env, by, key);
    if (found !== undefined) {
      resolved.set(key, found);
    }
  }
  const policy = await quotaPolicy(env);
  const result = await validateWorkflow(definition, {
    catalog: (key) => resolved.get(key)?.contract,
    ceilings: {
      maxSteps: policy.limits.workflowSteps,
      maxModelCalls: policy.limits.lineageModelRequests,
      maxActiveMs: policy.limits.workflowActiveMs,
    },
  });
  if (!result.ok) {
    throw definitionInvalid(problemsOf(result.diagnostics));
  }
  const checked = result.workflow;
  if (
    checked.identity.namespace !== workflowNamespace ||
    checked.identity.name !== workflow.name
  ) {
    throw workflowResourceErrors.create("workflow.identity_mismatch");
  }
  const bindings: PinnedBinding[] = [];
  for (const [alias, binding] of checked.bindings) {
    const target = resolved.get(binding.contract);
    // Validation resolved every binding it kept through the catalog,
    // which holds workflow contracts alone.
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
  return { checked, bindings };
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
  author: row.authorId,
  createdAt: row.createdAt.toISOString(),
});

/** The workflow bindings of the versions of `id`, by version. */
const bindingsOf = async (
  env: Env,
  id: string
): Promise<Map<number, PinnedBinding[]>> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(sdkResourceBindings)
    .where(
      and(
        eq(sdkResourceBindings.resourceId, id),
        eq(sdkResourceBindings.kind, "workflow")
      )
    )
    .orderBy(asc(sdkResourceBindings.alias));
  const byVersion = new Map<number, PinnedBinding[]>();
  for (const row of rows) {
    const list = byVersion.get(row.resourceVersion) ?? [];
    list.push({
      alias: row.alias,
      kind: "workflow",
      resourceId: row.targetId,
      resourceVersion: row.targetVersion ?? 0,
      contractId: row.contractId ?? "",
      fingerprint: row.schemaHash,
    });
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
    if (!builds.has(resourceId)) {
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
      builds.get(binding.resourceId) === true
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

/** The version of `id` with semantic version `definitionVersion`, if any. */
const publishedAs = async (
  env: Env,
  id: string,
  definitionVersion: string
): Promise<WorkflowResourceVersion | undefined> => {
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
  return versionOf(row, bindings.get(row.version) ?? []);
};

/** A version about to be written: everything its row and manifest hold. */
interface Publication {
  workflow: Live;
  checked: CheckedWorkflow;
  definition: string;
  definitionHash: string;
  bindings: PinnedBinding[];
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
  const { workflow, checked, definition, definitionHash, bindings } =
    publication;
  const contract = contractOf(checked);
  const contractText = canonicalJson(contract);
  if (bytesOf(contractText) > contractMaxBytes) {
    throw definitionInvalid([
      {
        code: "contract.too_large",
        message:
          "The workflow's input, output and parameter schemas together are larger than a version may hold.",
        pointer: "/input/schema",
        remedy: "Keep the schemas smaller: move large constants into data.",
      },
    ]);
  }
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
    evaluatorHash: jqProvenance.sha256,
    contractHash,
    bindings: bindings.map((binding) => ({ ...binding })),
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
      manifestHash,
      authorId: by.userId,
      createdAt,
    }),
    db
      .update(workflowResources)
      .set({ currentVersion: version })
      .where(eq(workflowResources.id, workflow.id)),
    ...bindings.map((binding) =>
      db.insert(sdkResourceBindings).values({
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
  return {
    resourceId: workflow.id,
    version,
    definitionVersion,
    profile: checked.profile,
    definitionHash,
    contractHash,
    manifestHash,
    bindings,
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
export const publishWorkflowVersion = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowResourceVersion> => {
  const workflow = await accessible(env, by, id, "builder");
  const { definition, basedOn } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    publishSchema,
    input
  );
  const { checked, bindings } = await checkDefinition(
    env,
    by,
    workflow,
    definition
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
    if (existing !== undefined && existing.definitionHash !== definitionHash) {
      throw workflowResourceErrors.create("workflow.version_exists");
    }
    return existing;
  };
  const existing = await sameVersion();
  if (existing !== undefined) {
    return existing;
  }
  if (basedOn !== workflow.currentVersion) {
    throw workflowResourceErrors.create("workflow.version_conflict");
  }
  try {
    return await writeVersion(env, by, {
      workflow,
      checked,
      definition,
      definitionHash,
      bindings,
    });
  } catch (error) {
    if (
      notNullFailed(error, "workflow_resource_versions.workflow_resource_id")
    ) {
      throw (await liveWorkflow(env, workflow.id)) === undefined
        ? unavailable()
        : workflowResourceErrors.create("workflow.version_conflict");
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

/** Every version of workflow `id`, newest first, for anyone with a role. */
export const workflowVersions = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowResourceVersion[]> => {
  const workflow = await accessible(env, by, id, "user");
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
  const workflow = await accessible(env, by, id, "builder");
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
  const workflow = await accessible(env, by, id, "builder");
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
  const workflow = await accessible(env, by, id, "builder");
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
  const workflow = await accessible(env, by, id, "user");
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

/** At most this many binders are named in a refused deletion's event. */
const maxNamedBinders = 20;

/**
 * That the current version of another live workflow binds `id`, as SQL.
 * Only the current version counts: an older, immutable version can't keep
 * a workflow from ever being deleted. Versions pinned by live runs, App
 * bindings and rollback targets come with starts and App bindings, and
 * will count here then.
 */
const boundSql = (
  id: string
) => sql`EXISTS (SELECT 1 FROM sdk_resource_bindings AS bound
    JOIN workflow_resources AS binder ON binder.id = bound.resource_id
    WHERE bound.kind = 'workflow' AND bound.target_id = ${id}
      AND bound.resource_version = binder.current_version
      AND binder.id <> ${id} AND binder.deleted_at IS NULL)`;

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
  const workflow = await accessible(env, by, id, "builder");
  const db = drizzle(env.DB);
  const [deleted] = await auditedBatch(env, db, [
    db
      .update(workflowResources)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(workflowResources.id, workflow.id),
          isNull(workflowResources.deletedAt),
          sql`NOT ${boundSql(workflow.id)}`
        )
      )
      .returning({ id: workflowResources.id }),
    outboxedIfChanged(db, entry(by, "workflow.deleted", workflow.id)),
  ]);
  if (deleted.length > 0) {
    return;
  }
  if ((await liveWorkflow(env, workflow.id)) === undefined) {
    throw unavailable();
  }
  const binders = await bindersOf(env, workflow.id);
  const named = Object.fromEntries(
    binders
      .slice(0, maxNamedBinders)
      .map((binder, index) => [`binder${index + 1}`, binder.id])
  );
  await auditedBatch(env, db, [
    outboxed(
      db,
      entry(by, "workflow.delete_refused", workflow.id, {
        reason: "workflow.resource_bound",
        binders: binders.length,
        ...named,
      })
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
  };
  throw workflowResourceErrors.create("workflow.resource_bound", {
    binders: details.binders,
    hidden: details.hidden,
  });
};
