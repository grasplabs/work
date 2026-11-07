import { generatedWorkflowEntry } from "@grasp-os/compiler";
import type { ValueDescriptor } from "@grasp-os/sdk";
import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import { actorOf, auditDetailMaxKeys } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import {
  businessProcessSchema,
  storedProcessOf,
} from "@grasp-os/shared/business-processes";
import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import { dependencyErrors } from "@grasp-os/shared/dependencies";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { graspLockSchema } from "@grasp-os/shared/packages";
import type { GraspLock } from "@grasp-os/shared/packages";
import { isAdmin, requireBuilder, roleErrors } from "@grasp-os/shared/roles";
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
  SteeredWrite,
  WorkflowActionReview,
  WorkflowVersionAction,
  WorkflowVersionBinding,
  WorkflowVersionSource,
} from "@grasp-os/shared/workflow-resources";
import {
  bindingKindOf,
  contractKindOf,
} from "@grasp-os/workflow-schema/catalog";
import type { ContractUse } from "@grasp-os/workflow-schema/catalog";
import { checkWorkflow } from "@grasp-os/workflow-schema/check";
import type { CheckedWorkflow, Problem } from "@grasp-os/workflow-schema/check";
import { expressionTypeRequest } from "@grasp-os/workflow-schema/expression-scope";
import {
  bindingKinds,
  definitionFormat,
  eachStep,
  formatLimits,
  isSensitive,
} from "@grasp-os/workflow-schema/format";
import type {
  Binding,
  EventWaitStep,
  Step,
} from "@grasp-os/workflow-schema/format";
import type { SealedTask } from "@grasp-os/workflow-schema/sealed";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  dependencyRequests,
  sdkResourceBindings,
  workflowResourceDraftInspections,
  workflowResourceDraftModules,
  workflowResourceDrafts,
  projectItems,
  workflowResourceMembers,
  workflowResourceProcesses,
  workflowResources,
  workflowResourceVersions,
  workflowState,
  workflowStateWrites,
} from "./db/core/schema.ts";
import { isUniqueViolation, notNullFailed } from "./db/d1.ts";
import { withdrawnWith } from "./packages/approvals.ts";
import { checkWorkflowExpressions, withinBuildWait } from "./pages.ts";
import { namedProjectsFor, requireStillBuilt } from "./project-access.ts";
import { projectStillBuiltSql } from "./project-sql.ts";
import { newSeal, sealReferencedSql } from "./sealed-artifacts.ts";
import {
  ceilingOf,
  memberEntry,
  requireNotStaff,
  requireSharable,
  roleFromMembers,
  rowsOf,
  stillMembers,
} from "./sharing.ts";
import type { MemberRef } from "./sharing.ts";
import {
  buildOf,
  buildSummary,
  compiledTasksOf,
  compileWorkflow,
  loadWorkflowBuild,
  reviewedTasksOf,
  releaseBuild,
  requireServedBindingKinds,
  storeBuild,
} from "./workflow-builds.ts";
import type { CompiledBuild, SealedBuild } from "./workflow-builds.ts";
import { resolveCatalogKeys } from "./workflow-catalog.ts";
import type { ResolvedCatalogContract } from "./workflow-catalog.ts";
import {
  compileModules,
  moduleLookup,
  modulesHashOf,
  sealedUse,
  versionActionsOf,
} from "./workflow-modules.ts";
import type {
  CompiledModules,
  ModuleContracts,
  ModulePackages,
} from "./workflow-modules.ts";
import {
  packagesHold,
  packagesHoldSql,
  sealedPackagesSchema,
} from "./workflows/package-seal.ts";
import type {
  PackageSealer,
  SealedPackageManifest,
  SealedPackages,
} from "./workflows/package-seal.ts";
import { quotaLimits } from "./workflows/quotas.ts";

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
//   says: a grasp-workflow/1 document names no workflow, and its semantic
//   version is the one publication gives it (`writeVersion`).
// - "latest" and ranges. A binding to another workflow names an exact
//   `namespace/name/semver` contract; anything else isn't in the catalog,
//   so the definition is refused. What it resolves to is recorded once, at
//   publication, by ID, version and contract hash (`sdk_resource_bindings`
//   and the manifest), so a later version of the target, or a new workflow
//   given its name, never changes what a published version runs. Names
//   are global to the deployment and aren't reused, deleted workflows'
//   included, until an admin releases a deleted one's name
//   (`releaseWorkflowName`, once nothing names any version of it). Even
//   then its contract keys stay unanswered: no workflow publishes a
//   semantic version it published, so a key never names two workflows
//   and nobody's text binds the newcomer by naming an old key. A key with
//   a version the old workflow never published does resolve to the
//   newcomer, for a publisher with a role in it, as it would have to any
//   new version of the old one: an explicit choice of that version. A
//   builder
//   learns whether a name is held (`workflow.name_taken`), nothing else
//   of it. Refused creations are audited, and each person may
//   create at most the quota limits' `workflowResourcesPerPerson`,
//   deleted ones included, so names can't be hoarded without trace.
// - Disclosure through bindings. A binding resolves only to a workflow
//   the publisher has a role in; any other is "no such contract", exactly
//   as one that doesn't exist, so publishing can't probe for another
//   workflow's contract. A binding is a requirement, never a grant: who
//   may start the target is decided when it starts. A version's bindings
//   name the target resource (its ID and internal version) only to the
//   target's builders. The contract key goes to them and to the binding
//   workflow's builders, whose definition text names it anyway; anyone
//   else sees only the alias and the contract's fingerprint.
// - A stored version altered behind the registry's back. A definition is
//   hashed as canonical JSON at publication and checked again before it
//   is served; a contract is checked against its hash before a binding
//   pins it. A mismatch is refused (`workflow.version_corrupt`) and
//   logged, never used. A version's definition, contract and manifest are
//   bounded so its row stays within D1's limit.
// - A version changing after publication. A version is a row written once
//   (`(workflow_resource_id, version)` and its semantic version are unique,
//   and the database refuses any update, deletion or insert over either
//   or over a version's rowid, whatever the conflict clause: migrations
//   0080 and 0101); a publication retried on the same current version
//   with the same definition and modules answers the version it wrote
//   (`savedPublication`), so a retried publication is the same
//   publication.
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
// - Deleting a workflow something runs. Deletion is refused while a
//   trigger or an App binding may start it, or a run of it is live
//   (`workflow.resource_bound`), checked in the statement that marks it
//   deleted. A refusal whose hold is gone by the time it is read tries
//   that statement once more, then answers `workflow.resource_busy`: never
//   bound by nothing, and never deleted past the guard. The refusal and
//   its event name what holds it. A deleted workflow
//   keeps its row and versions, for the audit log and recovery, and is
//   never served again; a share racing the deletion writes nothing.
// - Grasp staff deciding whom a client's workflow reaches or what it runs:
//   they never share, unshare or delete one, nor publish a version whose
//   bindings differ from the current version's (`role.forbidden`). They
//   may read definitions and publish versions that bind nothing new, as
//   for Apps.

/**
 * `nextGeneration` for every workflow `where` picks (a condition on
 * `workflow_resources`): for a change that reaches many at once, such as
 * whom a project they are shared with reaches (projects.ts).
 */
export const nextGenerationWhere = (
  db: ReturnType<typeof drizzle>,
  where: SQL | undefined
) =>
  db
    .update(workflowResources)
    .set({ policyGeneration: sql`${workflowResources.policyGeneration} + 1` })
    .where(where);

/**
 * Moves workflow `id`'s policy generation on, for a batch that changes who
 * may start or follow it: a start admitted under the generation before is
 * refused (workflow-starts.ts).
 */
export const nextGeneration = (
  db: ReturnType<typeof drizzle>,
  id: string,
  landed?: SQL
) => nextGenerationWhere(db, and(eq(workflowResources.id, id), landed));

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

/** What a read of live workflows selects: `Live`'s columns. */
const liveColumns = {
  id: workflowResources.id,
  name: workflowResources.name,
  owner: workflowResources.ownerId,
  currentVersion: workflowResources.currentVersion,
  createdAt: workflowResources.createdAt,
};

/** `values` as an SQL list, bound as one parameter whatever its length. */
const jsonList = (values: readonly string[]): SQL =>
  sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

/**
 * `by`'s role in each of `workflows`, by ID, in one read: builder for the
 * organization's admins; their ceiling for its owner; for whom it is
 * shared with, the highest of the rows that are theirs (their own, their
 * teams'), capped by their ceiling (`roleFromMembers`). A workflow they
 * have no role in has no entry.
 */
const rolesIn = async (
  env: Env,
  by: Acting,
  workflows: readonly Pick<Live, "id" | "owner">[]
): Promise<Map<string, WorkflowRole>> => {
  const roles = new Map<string, WorkflowRole>();
  if (isAdmin(by.role)) {
    for (const { id } of workflows) {
      roles.set(id, "builder");
    }
    return roles;
  }
  const shared = workflows.filter(({ owner }) => owner !== by.userId);
  const rows =
    shared.length === 0
      ? []
      : await drizzle(env.DB)
          .select({
            id: workflowResourceMembers.workflowResourceId,
            role: workflowResourceMembers.role,
          })
          .from(workflowResourceMembers)
          .where(
            and(
              sql`${workflowResourceMembers.workflowResourceId} IN ${jsonList(
                shared.map(({ id }) => id)
              )}`,
              rowsOf(workflowResourceMembers, by)
            )
          );
  // Grouped once: each workflow then reads only its own rows.
  const rowRoles = new Map<string, WorkflowRole[]>();
  for (const row of rows) {
    const list = rowRoles.get(row.id) ?? [];
    list.push(row.role);
    rowRoles.set(row.id, list);
  }
  for (const { id, owner } of workflows) {
    const role =
      owner === by.userId
        ? ceilingOf(by)
        : roleFromMembers(by, rowRoles.get(id) ?? []);
    if (role !== undefined) {
      roles.set(id, role);
    }
  }
  return roles;
};

/** `by`'s role in `workflow` (`rolesIn`), undefined when they have none. */
const roleIn = async (
  env: Env,
  by: Acting,
  workflow: Pick<Live, "id" | "owner">
): Promise<WorkflowRole | undefined> => {
  const roles = await rolesIn(env, by, [workflow]);
  return roles.get(workflow.id);
};

/** The live workflow `id`, or undefined. */
export const liveWorkflow = async (
  env: Env,
  id: unknown
): Promise<Live | undefined> => {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    return undefined;
  }
  const row = await drizzle(env.DB)
    .select(liveColumns)
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

const resourceOf = (
  workflow: Live,
  role: WorkflowRole,
  process: BusinessProcess | null
): WorkflowResource => ({
  id: workflow.id,
  namespace: workflowNamespace,
  name: workflow.name,
  owner: workflow.owner,
  currentVersion: workflow.currentVersion,
  role,
  process,
  createdAt: workflow.createdAt.toISOString(),
});

/**
 * The business process each of `workflows` serves, by ID, in one read: a
 * workflow none was set for has no entry.
 */
const processesOf = async (
  env: Env,
  workflows: readonly string[]
): Promise<Map<string, BusinessProcess>> => {
  if (workflows.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({
      id: workflowResourceProcesses.workflowResourceId,
      process: workflowResourceProcesses.process,
    })
    .from(workflowResourceProcesses)
    .where(
      sql`${workflowResourceProcesses.workflowResourceId} IN ${jsonList(workflows)}`
    );
  return new Map(
    rows.flatMap(({ id, process }) => {
      const stored = storedProcessOf(process);
      return stored === null ? [] : [[id, stored] as const];
    })
  );
};

/** The business process workflow `id` serves; null for none. */
const processOf = async (
  env: Env,
  id: string
): Promise<BusinessProcess | null> => {
  const processes = await processesOf(env, [id]);
  return processes.get(id) ?? null;
};

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
 * quota limits allow, deleted ones included, gets
 * `workflow.resource_limit`. Both refusals are audited.
 */
export const createWorkflowResource = async (
  env: Env,
  by: Acting,
  name: unknown,
  /** Admits the write, right before it commits: throws to create nothing. */
  admit?: () => Promise<void>
): Promise<WorkflowResource> => {
  requireBuilder(by);
  const parsed = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowNameSchema,
    name
  );
  const cap = quotaLimits(env).workflowResourcesPerPerson;
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
  await admit?.();
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
    ceilingOf(by),
    null
  );
};

/** Workflow `id`, for anyone with a role in it. */
export const getWorkflowResource = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowResource> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  return resourceOf(workflow, workflow.role, await processOf(env, workflow.id));
};

/**
 * Sets the business process workflow `id` serves to `input`
 * (`businessProcessSchema`), or clears it with null, for its builders: it
 * names nobody and grants nothing, so Grasp's staff, who assign it as they
 * map a client's work, may too. The change and its audit event are one
 * batch; setting what is set changes and records nothing.
 */
export const setWorkflowProcess = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowResource> => {
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const process = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    businessProcessSchema.nullable(),
    input
  );
  const before = await processOf(env, workflow.id);
  if (process !== before) {
    const db = drizzle(env.DB);
    const processes = workflowResourceProcesses;
    await auditedBatch(env, db, [
      process === null
        ? db
            .delete(processes)
            .where(eq(processes.workflowResourceId, workflow.id))
        : db
            .insert(processes)
            .values({
              workflowResourceId: workflow.id,
              process,
              setBy: by.userId,
              setAt: new Date(),
            })
            .onConflictDoUpdate({
              target: processes.workflowResourceId,
              set: { process, setBy: by.userId, setAt: new Date() },
            }),
      outboxed(
        db,
        entry(by, "workflow.process_set", workflow.id, {
          process,
          previousProcess: before,
        })
      ),
    ]);
  }
  return resourceOf(workflow, workflow.role, process);
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
    .select(liveColumns)
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
  const roles = await rolesIn(env, by, rows);
  const processes = await processesOf(
    env,
    rows.map(({ id }) => id)
  );
  return rows.flatMap((row) => {
    const role = roles.get(row.id);
    return role === undefined
      ? []
      : [resourceOf(row, role, processes.get(row.id) ?? null)];
  });
};

/**
 * A binding as publication resolved it: a host catalog contract by its key
 * and fingerprint, whose serving resource an approval names
 * (workflow-bindings.ts).
 */
export interface PinnedBinding {
  alias: string;
  kind: CatalogBindingKind;
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

/** Where a document declares its bindings, as far as a lookup needs. */
const declaredBindingsSchema = z.object({
  bindings: z.record(z.string(), z.unknown()),
});

/** A binding that names a contract of the catalog, not of the workflow's own modules. */
const catalogBindingSchema = z.object({
  kind: z
    .enum(bindingKinds)
    .refine((kind) => contractKindOf(kind) !== undefined),
  contract: catalogKeySchema,
});

/** `text` read as JSON, or undefined when it isn't. */
const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The host catalog keys a document's bindings name, read from its text
 * only to know what to look up before it is checked: what the check then
 * resolves is all that counts. Text that isn't JSON (`parsed` undefined)
 * names none, and the check refuses it.
 */
const namedKeys = (parsed: unknown): string[] => {
  const declared = declaredBindingsSchema.safeParse(parsed);
  if (!declared.success) {
    return [];
  }
  const keys = new Set<string>();
  for (const binding of Object.values(declared.data.bindings)) {
    const contract = catalogBindingSchema.safeParse(binding);
    if (contract.success) {
      keys.add(contract.data.contract);
    }
  }
  // No more than a document may bind: the check refuses the rest.
  return [...keys].slice(0, formatLimits.bindings);
};

const problemsOf = (
  problems: readonly Problem[]
): WorkflowDefinitionProblem[] =>
  problems.map(({ code, message, pointer, remedy }) => ({
    code,
    message,
    pointer,
    remedy,
  }));

const definitionInvalid = (problems: WorkflowDefinitionProblem[]) =>
  workflowResourceErrors.create("workflow.definition_invalid", {
    // Each problem is a code, a pointer and fixed text: never a value
    // from the definition.
    problems: problems.map((problem) => ({ ...problem })),
  });

/** The types an event wait takes, as a list (`EventFilter.type`). */
const eventTypesOf = (step: EventWaitStep): readonly string[] =>
  typeof step.event.type === "string" ? [step.event.type] : step.event.type;

/** The contract of a checked document: what a caller of it relies on. */
const contractOf = (checked: CheckedWorkflow): StoredContract => {
  const declared = checked.document.params ?? {};
  const params: StoredContract["params"] = {};
  for (const [name, descriptor] of checked.contract.params) {
    const param = declared[name];
    params[name] = {
      descriptor: z.json().parse(structuredClone(descriptor)),
      label: param?.label ?? name,
      sensitive: param === undefined || isSensitive(param),
    };
  }
  return {
    input: z.json().parse(structuredClone(checked.contract.input)),
    output: z.json().parse(structuredClone(checked.contract.output)),
    // Each event wait, by its step's ID: what an App may send the run.
    listens: Object.fromEntries(
      eachStep(checked.document.steps).flatMap(({ step }) =>
        step.type === "wait" && "event" in step
          ? [
              [
                step.id,
                { alias: step.event.from, types: [...eventTypesOf(step)] },
              ],
            ]
          : []
      )
    ),
    params,
  };
};

/**
 * A semantic version's major number, exactly, however large (a definition
 * may name one past `Number`'s safe integers), or 0 for one that names
 * none.
 */
const majorOf = (version: string): bigint => {
  const major = version.split(".", 1)[0] ?? "";
  return /^\d+$/u.test(major) ? BigInt(major) : 0n;
};

/**
 * The first version a new draft of a workflow named `name` may publish
 * (workflow-drafts.ts): 1.0.0, or, under a released name, the major
 * version past every one its earlier holders published (`versionTaken`).
 */
export const firstFreeVersion = async (
  env: Env,
  name: string
): Promise<string> => {
  const rows = await drizzle(env.DB)
    .select({ version: workflowResourceVersions.definitionVersion })
    .from(workflowResources)
    .innerJoin(
      workflowResourceVersions,
      eq(workflowResourceVersions.workflowResourceId, workflowResources.id)
    )
    .where(
      and(
        eq(workflowResources.name, name),
        isNotNull(workflowResources.nameReleasedAt)
      )
    );
  let highest = 0n;
  for (const { version } of rows) {
    const major = majorOf(version);
    if (major > highest) {
      highest = major;
    }
  }
  return `${highest + 1n}.0.0`;
};

/** The kind of the workflow's own module a `local:` binding of `kind` names. */
const moduleKinds = { compute: "compute", action: "operation" } as const;

/**
 * What keeps an action's `uses` from what the workflow declares: each a
 * binding of the kind it reaches, and each connector operation it names
 * one the connector's contract allows, as a step's must be, refused here
 * rather than at its first call.
 */
const actionUseProblems = (
  uses: readonly ContractUse[],
  bindings: Readonly<Record<string, Binding>>,
  catalog: ReadonlyMap<string, ResolvedCatalogContract>,
  pointer: string
): WorkflowDefinitionProblem[] => {
  const problems: WorkflowDefinitionProblem[] = [];
  for (const use of uses) {
    const used = Object.hasOwn(bindings, use.alias)
      ? bindings[use.alias]
      : undefined;
    // The use's kind is the catalog's (a Brain collection's `knowledge`),
    // the binding's the format's (`brain`).
    if (used === undefined || contractKindOf(used.kind) !== use.kind) {
      const kind = bindingKindOf(use.kind);
      problems.push({
        code: "binding.use_undeclared",
        message: `The action reaches \`${use.alias}\`, a ${kind} binding the workflow doesn't declare.`,
        pointer,
        remedy: `Declare \`${use.alias}\` as a ${kind} binding.`,
      });
      continue;
    }
    const allowed = catalog.get(used.contract)?.contract.operations;
    const unknown = (use.operations ?? []).filter(
      (operation) => allowed !== undefined && !Object.hasOwn(allowed, operation)
    );
    if (unknown.length > 0) {
      problems.push({
        code: "binding.unknown_operation",
        message: `The action declares \`${unknown.join("`, `")}\` of \`${use.alias}\`, which its connector's contract doesn't allow.`,
        pointer,
        remedy: "Declare only operations the contract allows.",
      });
    }
  }
  return problems;
};

/**
 * The types event wait `step` (at `pointer`) waits for that its binding's
 * event contract doesn't admit: a wait for one would never end but by its
 * timeout. A binding the catalog doesn't have is refused as such.
 */
const eventTypeProblems = (
  step: EventWaitStep,
  pointer: string,
  bindings: Readonly<Record<string, Binding>>,
  catalog: ReadonlyMap<string, ResolvedCatalogContract>
): WorkflowDefinitionProblem[] => {
  const contract = catalog.get(bindings[step.event.from]?.contract ?? "");
  if (contract?.kind !== "event") {
    return [];
  }
  const admitted = contract.contract.events ?? {};
  const listed = typeof step.event.type !== "string";
  return eventTypesOf(step).flatMap((type, index) =>
    Object.hasOwn(admitted, type)
      ? []
      : [
          {
            code: "event.unknown_type",
            message:
              "The event binding's contract admits no event of this type.",
            pointer: `${pointer}/event/type${listed ? `/${index}` : ""}`,
            remedy: "Wait for a type its contract's events name.",
          },
        ]
  );
};

/**
 * What the format can't check of a document's bindings, against what
 * they resolve to: each binding's contract in the host catalog (or, for a
 * `local:` one, among the workflow's own modules, `modules`), of the kind
 * the binding says; each connector operation a step calls one its
 * contract allows; and each binding an action of the workflow's own
 * reaches declared, of the kind it reaches.
 */
const bindingProblems = (
  checked: CheckedWorkflow,
  catalog: ReadonlyMap<string, ResolvedCatalogContract>,
  modules: ModuleContracts | undefined
): WorkflowDefinitionProblem[] => {
  const problems: WorkflowDefinitionProblem[] = [];
  const bindings = checked.document.bindings ?? {};
  const local = moduleLookup(modules);
  for (const [alias, binding] of Object.entries(bindings)) {
    const pointer = `/bindings/${alias}/contract`;
    if (binding.kind === "compute" || binding.kind === "action") {
      const contract = local(binding.contract);
      if (contract?.kind !== moduleKinds[binding.kind]) {
        problems.push({
          code: "binding.unknown_contract",
          message: `No ${binding.kind} of the workflow's own modules is \`${binding.contract}\`.`,
          pointer,
          remedy: `Export a ${binding.kind} under that name, or name one exported.`,
        });
        continue;
      }
      problems.push(
        ...actionUseProblems(contract.uses ?? [], bindings, catalog, pointer)
      );
      continue;
    }
    const contract = catalog.get(binding.contract);
    if (
      contract === undefined ||
      contract.kind !== contractKindOf(binding.kind)
    ) {
      problems.push({
        code: "binding.unknown_contract",
        message: `The catalog has no ${binding.kind} contract \`${binding.contract}\`.`,
        pointer,
        remedy: "Name a contract of the catalog, of the binding's kind.",
      });
    }
  }
  for (const { step, pointer } of eachStep(checked.document.steps)) {
    if (step.type === "wait" && "event" in step) {
      problems.push(...eventTypeProblems(step, pointer, bindings, catalog));
      continue;
    }
    if (step.type !== "do" || step.operation === undefined) {
      continue;
    }
    const binding = bindings[step.binding];
    const operations =
      binding === undefined
        ? undefined
        : catalog.get(binding.contract)?.contract.operations;
    if (
      operations !== undefined &&
      !Object.hasOwn(operations, step.operation)
    ) {
      problems.push({
        code: "connector.unknown_operation",
        message: `The connector's contract doesn't allow \`${step.operation}\`.`,
        pointer: `${pointer}/operation`,
        remedy: "Call one of the operations its contract allows.",
      });
    }
  }
  return problems;
};

/** A string literal in a type checker's message: possibly the author's data. */
const quotedLiteral = /"(?:[^"\\]|\\.)*"/gu;

/**
 * Where `checked`'s expressions read what isn't there, or use it as a type
 * it isn't (`input.missing.x`, a number compared with a string), each at
 * its expression's pointer with its line and column: the compiler's typed
 * check (`checkWorkflowExpressions`) against the types the document's
 * schemas declare and its calls' contracts in `catalog` answer. A string
 * literal in the checker's words is left out, as a problem names no value
 * of the definition.
 */
const expressionTypeProblems = async (
  env: Env,
  checked: CheckedWorkflow,
  catalog: ReadonlyMap<string, ResolvedCatalogContract>,
  whose: string
): Promise<WorkflowDefinitionProblem[]> => {
  const bindings = checked.document.bindings ?? {};
  // A `do` step's output, as its call's contract answers it.
  const outputOf = (step: Step) => {
    const contract =
      step.type === "do"
        ? catalog.get(bindings[step.binding]?.contract ?? "")?.contract
        : undefined;
    const text =
      step.type === "do" && step.operation !== undefined
        ? contract?.operations?.[step.operation]?.output
        : contract?.output;
    // A contract whose output isn't a descriptor the SDK reads (one stated
    // as a JSON Schema) leaves the step untyped, as the check passes what
    // it can't know.
    let descriptor: ValueDescriptor | undefined;
    try {
      descriptor =
        text === undefined ? text : schemaFromDescriptor(text).descriptor;
    } catch {
      descriptor = undefined;
    }
    return descriptor;
  };
  const { scope, expressions } = expressionTypeRequest(checked, outputOf);
  if (Object.keys(expressions).length === 0) {
    return [];
  }
  // As the generated module's build (workflow-builds.ts): a check past the
  // build wait, or one its isolate gave up on, is the platform's to
  // finish, never the definition's fault, so the publication or the
  // draft's check is refused as one to try again. A late check runs on
  // and is cached for it.
  let typed: Awaited<ReturnType<typeof checkWorkflowExpressions>> | "late";
  try {
    typed = await withinBuildWait(
      env,
      async () => await checkWorkflowExpressions(env, scope, expressions, whose)
    );
  } catch (error) {
    if (isExpectedError(error)) {
      throw error;
    }
    log.warn("workflow.expression_check_unfinished", errorFields(error));
    typed = "late";
  }
  if (typed === "late") {
    throw workflowResourceErrors.create("workflow.build_slow");
  }
  // Its scope is the platform's own text: a problem there is the
  // platform's, as a generated module that doesn't build is.
  if (typed.scope.length > 0) {
    log.error("workflow.expression_scope_failed", {
      diagnostics: typed.scope.length,
      message: typed.scope[0]?.message.slice(0, 300),
    });
    throw workflowResourceErrors.create("workflow.build_failed");
  }
  return Object.entries(typed.expressions).flatMap(([pointer, errors]) =>
    errors.map(({ code, message, line, column }) => ({
      code: "expression.type",
      message: `${message.replaceAll(quotedLiteral, "a string")} (${code}, line ${line}, column ${column})`,
      pointer: `${pointer}/$expr`,
      remedy:
        "Read only what the workflow's schemas and its calls' contracts declare, as the types they declare.",
    }))
  );
};

/**
 * `definition` checked for publication by `by`: it is grasp-workflow/1
 * (`checkWorkflow`), and its bindings resolve against the host's catalog
 * and `modules`, the workflow's own (`bindingProblems`). Returns it with
 * what each binding resolved to, or its problems.
 */
const inspectDefinition = async (
  env: Env,
  definition: string,
  /** Whose definition it is: the workflow's ID, or a blueprint's. */
  whose: string,
  modules?: ModuleContracts,
  parsed: unknown = parsedJson(definition)
): Promise<
  | { ok: true; checked: CheckedWorkflow; bindings: PinnedBinding[] }
  | { ok: false; problems: WorkflowDefinitionProblem[] }
> => {
  if (parsed === undefined) {
    return {
      ok: false,
      problems: [
        {
          code: "schema.invalid",
          message: "The definition isn't JSON.",
          pointer: "",
          remedy: "Write the workflow as a JSON document.",
        },
      ],
    };
  }
  const result = checkWorkflow(parsed);
  if (!result.ok) {
    return { ok: false, problems: problemsOf(result.problems) };
  }
  const checked = result.workflow;
  const catalog = await resolveCatalogKeys(env, namedKeys(parsed));
  const unresolved = bindingProblems(checked, catalog, modules);
  if (unresolved.length > 0) {
    return { ok: false, problems: unresolved };
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
          pointer: "/input",
          remedy: "Keep the schemas smaller: move large constants into data.",
        },
      ],
    };
  }
  const bindings: PinnedBinding[] = [];
  for (const [alias, binding] of Object.entries(
    checked.document.bindings ?? {}
  )) {
    // A binding of the workflow's own modules is sealed with its build
    // (workflow-builds.ts): no approval serves it, so nothing pins it here.
    const contract = catalog.get(binding.contract);
    if (binding.kind === "compute" || binding.kind === "action") {
      continue;
    }
    if (contract === undefined) {
      throw new Error(`Binding ${alias} resolved outside the catalog`);
    }
    bindings.push({
      alias,
      kind: contract.kind,
      contractId: contract.key,
      fingerprint: contract.fingerprint,
    });
  }
  bindings.sort((a, b) => (a.alias < b.alias ? -1 : 1));
  const mistyped = await expressionTypeProblems(env, checked, catalog, whose);
  if (mistyped.length > 0) {
    return { ok: false, problems: mistyped };
  }
  return { ok: true, checked, bindings };
};

/**
 * `definition` checked for publication (`inspectDefinition`): refused as
 * `workflow.definition_invalid` with its problems otherwise.
 */
const checkDefinition = async (
  env: Env,
  definition: string,
  whose: string,
  modules: CompiledModules | undefined,
  parsed: unknown
): Promise<{
  checked: CheckedWorkflow;
  bindings: PinnedBinding[];
}> => {
  const inspected = await inspectDefinition(
    env,
    definition,
    whose,
    modules,
    parsed
  );
  if (!inspected.ok) {
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
  } catch (error) {
    if (isExpectedError(error)) {
      throw error;
    }
    throw corrupt(id, version);
  }
};

/**
 * Why a version's manifest is past `manifestMaxBytes`: the output shapes
 * its actions declare for their model calls (GRA-700), sealed in it, when
 * they hold most of it, pointing at the action with the largest; otherwise
 * what it pins.
 */
const tooLargeProblem = (
  actions: readonly WorkflowVersionAction[]
): WorkflowDefinitionProblem => {
  let total = 0;
  let largest: { binding: string; bytes: number } | undefined;
  for (const action of actions) {
    for (const use of action.uses) {
      if (use.kind === "model") {
        const bytes = bytesOf(use.output);
        total += bytes;
        if (largest === undefined || bytes > largest.bytes) {
          largest = { binding: action.binding, bytes };
        }
      }
    }
  }
  if (largest === undefined || total * 2 < manifestMaxBytes) {
    return {
      code: "manifest.too_large",
      message: "What the version pins is larger than a version may hold.",
      pointer: "/bindings",
      remedy: "Bind fewer workflows.",
    };
  }
  return {
    code: "manifest.too_large",
    // Fixed text, as every problem's: the pointer names the action with
    // the largest shape.
    message:
      "The output shapes the version's actions declare for their model calls are larger than a version may hold.",
    pointer: `/bindings/${largest.binding}`,
    remedy: "Declare smaller output shapes for the actions' model uses.",
  };
};

/** Where a version's manifest says what its actions may do (GRA-709). */
const manifestActionsSchema = z.object({
  actions: z.array(
    z.strictObject({
      binding: z.string(),
      module: z.string(),
      export: z.string(),
      uses: actionUsesSchema,
    })
  ),
});

/**
 * What version `row`'s actions may do, as its manifest seals it: a
 * manifest without them is malformed, as one without its build is.
 */
const sealedActionsOf = (
  row: typeof workflowResourceVersions.$inferSelect
): WorkflowVersionAction[] => {
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
  return parsed.data.actions;
};

/** Whether `action` asks a model (GRA-700). */
const asksModel = (action: WorkflowVersionAction): boolean =>
  action.uses.some(({ kind }) => kind === "model");

/** What a review reads of a version's binding: which contract it pinned. */
type PinnedContract = Pick<
  WorkflowVersionBinding,
  "alias" | "kind" | "contractId" | "fingerprint"
>;

/**
 * Where a version's manifest seals what its bindings pinned (`writeVersion`,
 * `PinnedBinding`): read for its review and its export alike.
 */
const manifestBindingsSchema = z.object({
  bindings: z.array(
    z.object({
      alias: z.string(),
      kind: z.enum(catalogBindingKinds),
      contractId: z.string(),
      fingerprint: z.string(),
    })
  ),
});

/**
 * What version `row`'s bindings pinned, as its manifest seals them, never
 * as a table that can be changed says: a review reads only what the
 * version's hash covers.
 */
const sealedBindingsOf = (
  row: typeof workflowResourceVersions.$inferSelect
): PinnedContract[] => {
  // A version binding a kind no longer served never gets here: its review
  // lists it as refused (`removedBindingKindOf`).
  const parsed = manifestBindingsSchema.safeParse(JSON.parse(row.manifest));
  if (!parsed.success) {
    throw corrupt(row.workflowResourceId, row.version);
  }
  return parsed.data.bindings.map(
    ({ alias, kind, contractId, fingerprint }) => ({
      alias,
      kind,
      contractId,
      fingerprint,
    })
  );
};

/** Reads catalog contracts by key: those the catalog holds intact. */
type CatalogLookup = (
  keys: readonly string[]
) => Promise<Map<string, ResolvedCatalogContract>>;

/**
 * A lookup that reads each catalog key once, however many reviews of one
 * answer ask for it, concurrently or not: a listing of many versions
 * pinning the same contract reads and hashes it once.
 */
const catalogOnce = (env: Env): CatalogLookup => {
  // Each key, by the read that loads it: set before anything is awaited,
  // so a review asking at the same time shares that read.
  const reads = new Map<
    string,
    Promise<Map<string, ResolvedCatalogContract>>
  >();
  return async (keys) => {
    const missing = [...new Set(keys)].filter((key) => !reads.has(key));
    if (missing.length > 0) {
      const read = resolveCatalogKeys(env, missing);
      for (const key of missing) {
        reads.set(key, read);
      }
    }
    const found = new Map<string, ResolvedCatalogContract>();
    for (const key of keys) {
      // oxlint-disable-next-line no-await-in-loop -- each read shared, once
      const read = await reads.get(key);
      const contract = read?.get(key);
      if (contract !== undefined) {
        found.set(key, contract);
      }
    }
    return found;
  };
};

/** What a version's review shows of what a model may steer. */
interface SteeringReview {
  readonly actions: WorkflowActionReview[];
  /** What the workflow's own model tasks may steer (GRA-727). */
  readonly modelSteeredWrites: SteeredWrite[];
}

/** `writes` with each alias once, a connector's operations merged. */
const mergedWrites = (writes: readonly SteeredWrite[]): SteeredWrite[] => {
  const merged = new Map<string, SteeredWrite>();
  for (const write of writes) {
    const seen = merged.get(write.alias);
    if (seen?.kind === "connector" && write.kind === "connector") {
      merged.set(write.alias, {
        ...seen,
        operations: [...new Set([...seen.operations, ...write.operations])],
      });
    } else if (seen === undefined) {
      merged.set(write.alias, write);
    }
  }
  return [...merged.values()];
};

/** Whether `tasks` hold a JSON model task (`grasp.model`). */
const asksModelInTasks = (tasks: readonly SealedTask[]): boolean =>
  tasks.some(
    (task) => task.kind === "call" && task.call.name === "grasp.model"
  );

/**
 * What a version's review shows of the writes a model's answers may steer
 * (GRA-718, GRA-727), read from the version as sealed and the catalog,
 * never inspected again:
 *
 * - each action that asks a model: its uses that may write;
 * - the workflow, when its build holds any model task: every write its
 *   call tasks may make, a connector task's operation and the writing uses
 *   of each action a task calls. Conservative:
 *   any model task counts as reaching every call, whatever their order or
 *   the flow of data between them.
 *
 * A connector's operation counts as a write unless the catalog contract
 * its binding pinned states it is read-only, and only while the catalog
 * still holds that exact contract (its fingerprint the one the version
 * sealed): a binding, contract or operation that isn't there, or a
 * contract that changed, counts as a write. So the flag shows whenever a write can't be ruled out.
 */
const steeringReview = async (
  lookup: CatalogLookup,
  actions: readonly WorkflowVersionAction[],
  bindings: readonly PinnedContract[],
  tasks: readonly SealedTask[]
): Promise<SteeringReview> => {
  const connectorOf = (alias: string): PinnedContract | undefined =>
    bindings.find(
      (binding) => binding.alias === alias && binding.kind === "connector"
    );
  const tasksAskModel = asksModelInTasks(tasks);
  const keys = bindings.flatMap((binding) =>
    binding.kind === "connector" && (tasksAskModel || actions.some(asksModel))
      ? [binding.contractId]
      : []
  );
  const catalog = await lookup(keys);
  const readOnly = (alias: string, operation: string): boolean => {
    const binding = connectorOf(alias);
    if (binding === undefined) {
      return false;
    }
    const contract = catalog.get(binding.contractId);
    return (
      contract !== undefined &&
      contract.fingerprint === binding.fingerprint &&
      contract.contract.operations?.[operation]?.readOnly === true
    );
  };
  const connectorWrites = (
    alias: string,
    operations: readonly string[]
  ): SteeredWrite[] => {
    const writes = operations.filter(
      (operation) => !readOnly(alias, operation)
    );
    return writes.length === 0
      ? []
      : [{ alias, kind: "connector", operations: writes }];
  };
  const steered = (
    use: WorkflowVersionAction["uses"][number]
  ): SteeredWrite[] =>
    use.kind === "connector" ? connectorWrites(use.alias, use.operations) : [];
  const taskWrites = (task: SealedTask): SteeredWrite[] => {
    if (task.kind !== "call") {
      return [];
    }
    const { call } = task;
    if (call.name === "grasp.connector") {
      return connectorWrites(call.binding, [call.operation]);
    }
    if (call.name === "grasp.action") {
      const action = actions.find(({ binding }) => binding === call.binding);
      // An action the version doesn't seal: nothing to rule out.
      return action === undefined
        ? [{ alias: call.binding, kind: "action" }]
        : action.uses.flatMap(steered);
    }
    // A sleep, a decision, a calculation (pure), an event and a model call
    // itself write nothing of the organization's.
    return [];
  };
  return {
    actions: actions.map((action) => ({
      ...action,
      modelSteeredWrites: asksModel(action) ? action.uses.flatMap(steered) : [],
    })),
    modelSteeredWrites: tasksAskModel
      ? mergedWrites(tasks.flatMap(taskWrites))
      : [],
  };
};

/**
 * The tasks version `row`'s build seals, for its review (GRA-727): read
 * only when its manifest pins a model binding, the only binding a model
 * task can name.
 */
const versionTasksOf = async (
  env: Env,
  row: typeof workflowResourceVersions.$inferSelect,
  bindings: readonly PinnedContract[]
): Promise<readonly SealedTask[]> => {
  if (!bindings.some(({ kind }) => kind === "model")) {
    return [];
  }
  return await reviewedTasksOf(
    env,
    row.workflowResourceId,
    row.version,
    row.manifest,
    row.manifestHash,
    row.sealId
  );
};

/**
 * Why version `row` is refused as one to publish again, if it binds a kind
 * no longer served (`requireServedBindingKinds`): a listing shows it so,
 * where its run, start, review and export are refused.
 */
const removedBindingKindOf = (
  row: typeof workflowResourceVersions.$inferSelect
): WorkflowResourceVersion["refused"] => {
  try {
    requireServedBindingKinds(parsedJson(row.manifest));
    return undefined;
  } catch (error) {
    if (
      workflowResourceErrors.codeOf(error) !== "workflow.binding_kind_removed"
    ) {
      throw error;
    }
    return {
      code: "workflow.binding_kind_removed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * A version's row, as the registry answers it: only once its manifest
 * still hashes to what was sealed, since what its actions may do and its
 * build are read from it (`workflow.version_corrupt` otherwise).
 */
const versionOf = async (
  env: Env,
  lookup: CatalogLookup,
  row: typeof workflowResourceVersions.$inferSelect,
  bindings: WorkflowVersionBinding[]
): Promise<WorkflowResourceVersion> => {
  if ((await sha256Hex(row.manifest)) !== row.manifestHash) {
    throw corrupt(row.workflowResourceId, row.version);
  }
  const refused = removedBindingKindOf(row);
  if (refused !== undefined) {
    return {
      resourceId: row.workflowResourceId,
      version: row.version,
      definitionVersion: row.definitionVersion,
      profile: row.profileVersion,
      definitionHash: row.definitionJsonHash,
      contractHash: row.contractHash,
      manifestHash: row.manifestHash,
      bindings,
      actions: [],
      modelSteeredWrites: [],
      build: null,
      refused,
      author: row.authorId,
      createdAt: row.createdAt.toISOString(),
    };
  }
  const sealedBindings = sealedBindingsOf(row);
  const review = await steeringReview(
    lookup,
    sealedActionsOf(row),
    sealedBindings,
    await versionTasksOf(env, row, sealedBindings)
  );
  return {
    resourceId: row.workflowResourceId,
    version: row.version,
    definitionVersion: row.definitionVersion,
    profile: row.profileVersion,
    definitionHash: row.definitionJsonHash,
    contractHash: row.contractHash,
    manifestHash: row.manifestHash,
    bindings,
    actions: review.actions,
    modelSteeredWrites: review.modelSteeredWrites,
    build: buildSummary(
      sealedBuildOf(row.workflowResourceId, row.version, row.manifest)
    ),
    author: row.authorId,
    createdAt: row.createdAt.toISOString(),
  };
};

/** The bindings of the versions of `id` (only `version`'s, if given), by version. */
export const bindingsOf = async (
  env: Env,
  id: string,
  version?: number
): Promise<Map<number, PinnedBinding[]>> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(sdkResourceBindings)
    .where(
      and(
        eq(sdkResourceBindings.resourceId, id),
        version === undefined
          ? undefined
          : eq(sdkResourceBindings.resourceVersion, version),
        inArray(sdkResourceBindings.kind, [...catalogBindingKinds])
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
    list.push({
      alias: row.alias,
      kind: row.kind,
      // The contract key the version declared: `target_id` names the
      // store an approval resolved instead, while one does.
      contractId: row.contractId ?? row.targetId,
      fingerprint: row.schemaHash,
    });
    byVersion.set(row.resourceVersion, list);
  }
  return byVersion;
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

/**
 * Version `version` of workflow `id`, if it was published from the
 * definition `parsed` (its canonical JSON's hash, `definitionHashOf`, so
 * whitespace and key order aside) and the modules `modulesHash`: what a
 * retried publication that landed answers. Read off the text alone: a
 * saved version passed its checks as it was published, and nothing is
 * written for it again. Its bindings are answered as pinned;
 * `publishWorkflowVersion` answers them as its caller may see them.
 */
const savedPublication = async (
  env: Env,
  { id, version }: { id: string; version: number },
  parsed: unknown,
  modulesHash: string | null
): Promise<WorkflowResourceVersion | undefined> => {
  if (parsed === undefined) {
    return undefined;
  }
  const row = await drizzle(env.DB)
    .select()
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, id),
        eq(workflowResourceVersions.version, version)
      )
    )
    .get();
  if (
    row === undefined ||
    sealedModulesHash(row) !== modulesHash ||
    row.definitionJsonHash !== (await definitionHashOf(parsed))
  ) {
    return undefined;
  }
  const bindings = await bindingsOf(env, id);
  return await versionOf(
    env,
    catalogOnce(env),
    row,
    bindings.get(row.version) ?? []
  );
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
  const byVersion = await bindingsOf(env, version.resourceId, version.version);
  const pinned = byVersion.get(version.version) ?? [];
  return { ...version, bindings: pinned };
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
  /** The approved packages its modules import, if any (GRA-665). */
  packages: SealedPackageManifest | undefined;
  /** Admits the write, right before it commits: throws to write nothing. */
  admit: (() => Promise<void>) | undefined;
}

/**
 * Writes `publication` as the version after the current one, in one batch
 * with its bindings, the move of the current version and its event: only
 * while the workflow is live and still at the version it built on.
 * Answers the version written.
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
    packages,
    admit,
  } = publication;
  // Bounded when the definition was checked (`inspectDefinition`).
  const contractText = canonicalJson(contractOf(checked));
  const contractHash = await sha256Hex(contractText);
  const version = (workflow.currentVersion ?? 0) + 1;
  // A document names no version of its own: publication numbers it, past
  // every one an earlier holder of a released name published
  // (`firstFreeVersion`), so a contract key never names two workflows.
  const definitionVersion = `${
    majorOf(await firstFreeVersion(env, workflow.name)) + BigInt(version - 1)
  }.0.0`;
  const manifest = canonicalJson({
    formatVersion: 1,
    target: "workflow",
    resourceId: workflow.id,
    resourceVersion: version,
    namespace: workflowNamespace,
    name: workflow.name,
    definitionVersion,
    profile: definitionFormat,
    definitionHash,
    modulesHash,
    contractHash,
    bindings: bindings.map((binding) => ({ ...binding })),
    // What its own actions may do, as its build seals them (GRA-709): read
    // back for review, never derived again.
    actions: actions.map((action) => ({
      binding: action.binding,
      module: action.module,
      export: action.export,
      // Each use exactly as sealed, a model's output included (GRA-700).
      uses: action.uses.map((use) => sealedUse(use)),
    })),
    // What the version runs, sealed with it: its build's artifacts by
    // hash, and its executable identity (workflow-builds.ts).
    build: compiled.build,
    // The approved graph its modules import, which every start and call
    // admits again (workflows/sealed-packages.ts); the entries' code is
    // among the build's artifacts.
    ...(packages === undefined ? {} : { packages }),
    artifactTrust: "unreviewed",
  });
  if (bytesOf(manifest) > manifestMaxBytes) {
    throw definitionInvalid([tooLargeProblem(actions)]);
  }
  const manifestHash = await sha256Hex(manifest);
  // Before anything is written: a publication that lands answers it.
  const reviewed = await steeringReview(
    catalogOnce(env),
    actions,
    bindings,
    compiledTasksOf(compiled)
  );
  const createdAt = new Date();
  const db = drizzle(env.DB);
  // This publication's own seal: another publishing the same version at
  // once has its own, so neither gives back the other's references.
  const seal = newSeal();
  try {
    // Its build's bytes, referenced by its seal and stored, before the row
    // that names them; inside the cleanup, so a store that fails halfway
    // gives its references back too.
    await storeBuild(env, seal, compiled);
    // After the slow work (compiling, storing the build), right before the
    // row lands: refused, it gives its reservations back as below.
    await admit?.();
    await auditedBatch(env, db, [
      db.insert(workflowResourceVersions).values({
        // Only while the workflow is live and still at the version this
        // publication built on, and the graph it seals still approved (a
        // revocation may have come since it was sealed): otherwise NULL,
        // which fails the batch.
        workflowResourceId: sql`(SELECT id FROM workflow_resources
        WHERE id = ${workflow.id} AND deleted_at IS NULL
          AND current_version IS ${workflow.currentVersion}
          AND ${packages === undefined ? sql`1` : packagesHoldSql(workflow.id, packages.graphHash, true)})`,
        version,
        definitionVersion,
        definition,
        definitionJsonHash: definitionHash,
        profileVersion: definitionFormat,
        // The column is NOT NULL with no default, and a core still serving
        // during a rollout writes it, so it stays until GRA-1605 drops it:
        // empty, since no evaluator is pinned.
        evaluatorHash: "",
        contract: contractText,
        contractHash,
        manifest,
        // The hash only while its seal references every artifact its build
        // names: otherwise NULL, which the column refuses, and the whole
        // publication with it (sealed-artifacts.ts).
        manifestHash: sql`(SELECT ${manifestHash} WHERE ${sealReferencedSql(seal, manifest, "$.build.artifacts")})`,
        authorId: by.userId,
        createdAt,
        sealId: seal,
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
    // Not written: this publication's references go back, and only those:
    // another's, and a saved version's, stay.
    try {
      await releaseBuild(env, seal);
    } catch (releaseError) {
      log.warn("workflow.build_release_failed", errorFields(releaseError));
    }
    // Its graph was revoked as it was written.
    if (
      packages !== undefined &&
      notNullFailed(error, "workflow_resource_versions.workflow_resource_id") &&
      !(await packagesHold(db, workflow.id, packages.graphHash, true))
    ) {
      throw dependencyErrors.create("dependency.revoked");
    }
    throw error;
  }
  return {
    resourceId: workflow.id,
    version,
    definitionVersion,
    profile: definitionFormat,
    definitionHash,
    contractHash,
    manifestHash,
    bindings,
    actions: reviewed.actions,
    modelSteeredWrites: reviewed.modelSteeredWrites,
    build: buildSummary(compiled.build),
    author: by.userId,
    createdAt: createdAt.toISOString(),
  };
};

/** A publication's input, its definition bounded by the format's bytes. */
const publishSchema = workflowPublishSchema.refine(
  ({ definition }) => bytesOf(definition) <= formatLimits.bytes,
  { path: ["definition"], message: "Larger than a definition may be" }
);

/**
 * What identifies a binding: its alias, its kind, and the catalog contract
 * it binds by its key, so the same alias on another contract or kind is
 * another binding.
 */
const bindingKey = (binding: PinnedBinding): string =>
  [binding.alias, binding.kind, binding.contractId].join("\n");

/**
 * Refuses Grasp staff (`role.forbidden`) a publication whose bindings
 * aren't exactly those of the current version: which workflows a client's
 * workflow runs is the client's decision, as which stores an App binds is
 * (data-stores.ts). Staff may still publish a version that binds the same.
 * Binding nothing is a change too, when the current version binds
 * something: dropping what a client chose is theirs to decide as well.
 */
const requireStaffKeepsBindings = async (
  env: Env,
  by: Acting,
  workflow: Live,
  bindings: readonly PinnedBinding[]
): Promise<void> => {
  if (!by.staff) {
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
 * Refuses a publication that names packages it can't seal: one whose
 * caller seals none (only a builder's own publication does, the RPC's),
 * or with no modules to import them.
 */
const requireSealable = (
  asked: { graphHash: string } | undefined,
  sealer: PackageSealer | undefined,
  sources: Readonly<Record<string, string>>
): void => {
  if (asked === undefined) {
    return;
  }
  if (sealer === undefined) {
    throw workflowResourceErrors.create("workflow.packages_invalid", {
      reason: "This publication can't seal packages.",
    });
  }
  if (Object.keys(sources).length === 0) {
    throw workflowResourceErrors.create("workflow.packages_invalid", {
      reason: "Packages are for the workflow's modules, and it has none.",
    });
  }
};

/** What modules of `sealed`'s may import, for their build (`compileModules`). */
const packagesOf = (
  sealed: SealedPackages | undefined
): ModulePackages | undefined =>
  sealed === undefined
    ? undefined
    : {
        entries: Object.keys(sealed.manifest.entries),
        modules: sealed.modules,
      };

/** `publishWorkflowVersion`, answering bindings as pinned. */
const publish = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown,
  sealer: PackageSealer | undefined,
  admit: (() => Promise<void>) | undefined
): Promise<WorkflowResourceVersion> => {
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const {
    definition,
    basedOn,
    modules: sources = {},
    packages: asked,
  } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    publishSchema,
    input
  );
  requireSealable(asked, sealer, sources);
  // Its modules are part of what is published, and so are the packages
  // they import: the same definition with other modules or packages is
  // another publication.
  const modulesHash =
    Object.keys(sources).length === 0
      ? null
      : await modulesHashOf(sources, asked?.graphHash);
  // A retry of a publication that landed answers the version it wrote
  // before its bindings are resolved again: the builder may have lost a
  // contract it binds since, and the version still binds what it pinned
  // then. Its text read once: for this, and for the keys its bindings name.
  const parsed = parsedJson(definition);
  const landed = { id: workflow.id, version: (basedOn ?? 0) + 1 };
  const saved = await savedPublication(env, landed, parsed, modulesHash);
  if (saved !== undefined) {
    return saved;
  }
  if (basedOn !== workflow.currentVersion) {
    throw workflowResourceErrors.create("workflow.version_conflict");
  }
  // The approved graph sealed first (admitted for this workflow as a new
  // use, built, each entry's module read): its modules import them.
  const sealed =
    asked === undefined
      ? undefined
      : await sealer?.(env, by, workflow.id, asked.graphHash);
  // Built and inspected first: its `local:` bindings resolve against what
  // they export.
  const modules =
    modulesHash === null
      ? undefined
      : await compileModules(env, sources, workflow.id, packagesOf(sealed));
  const { checked, bindings } = await checkDefinition(
    env,
    definition,
    workflow.id,
    modules,
    parsed
  );
  await requireStaffKeepsBindings(env, by, workflow, bindings);
  // Of its canonical JSON: a retry that differs only in whitespace or key
  // order is the same definition, and the same publication.
  const definitionHash = await definitionHashOf(checked.document);
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
      actions: versionActionsOf(
        new Map(Object.entries(checked.document.bindings ?? {})),
        modules
      ),
      packages: sealed?.manifest,
      admit,
    });
  } catch (error) {
    if (notNullFailed(error, "workflow_resource_versions.manifest_hash")) {
      // A reference of its build went before the row could name it, which
      // only a publication stalled past a day sees: publishing again
      // references afresh.
      throw workflowResourceErrors.create("workflow.version_conflict");
    }
    const moved = notNullFailed(
      error,
      "workflow_resource_versions.workflow_resource_id"
    );
    if (moved && (await liveWorkflow(env, workflow.id)) === undefined) {
      throw unavailable();
    }
    if (!moved && !isUniqueViolation(error)) {
      throw error;
    }
    // The current version moved, or another publication of the same
    // number won: this one's, if it was this very definition.
    const won = await savedPublication(env, landed, parsed, modulesHash);
    if (won === undefined) {
      throw workflowResourceErrors.create("workflow.version_conflict");
    }
    return won;
  }
};

/**
 * What a test run of a draft's checkpoint runs (workflows/candidate-runs.ts),
 * compiled and checked exactly as a publication of it would be, against
 * the host's catalog and `sources`, the draft's own modules; nothing is
 * written. Its contract is the one a version of it would seal. Refused as
 * publication refuses it (`workflow.definition_invalid` with its problems).
 */
export const candidateBuildOf = async (
  env: Env,
  by: Acting,
  workflow: Live,
  definition: string,
  sources: Record<string, string>
) => {
  const modules =
    Object.keys(sources).length === 0
      ? undefined
      : await compileModules(env, sources, workflow.id);
  const parsed = parsedJson(definition);
  const { checked, bindings } = await checkDefinition(
    env,
    definition,
    workflow.id,
    modules,
    parsed
  );
  const compiled = await compileWorkflow(
    env,
    checked,
    definition,
    workflow.id,
    modules
  );
  return {
    checked,
    bindings,
    compiled,
    definitionHash: await definitionHashOf(checked.document),
    contract: contractOf(checked),
  };
};

/**
 * What keeps `definition` from being published, as
 * `checkDefinition` checks it: empty when nothing does. Its refusals of
 * the definition are answered as problems, at their pointers; anything
 * else (the catalog unreachable) is thrown. What drafts are checked with
 * (workflow-drafts.ts), so a checkpoint is exactly what would publish:
 * against `modules`, the draft's own, built as a publication builds them.
 */
export const definitionProblems = async (
  env: Env,
  definition: string,
  /** Whose definition it is: the workflow's ID, or a blueprint's. */
  whose: string,
  modules?: ModuleContracts
): Promise<WorkflowDefinitionProblem[]> => {
  const inspected = await inspectDefinition(env, definition, whose, modules);
  return inspected.ok ? [] : inspected.problems;
};

/**
 * Publishes a version of workflow `id` for `by`, who must build it, from
 * `input`: the definition's text and the current version it built on.
 * The definition must be grasp-workflow/1, its bindings resolved against
 * the host's catalog (refused with its problems,
 * `workflow.definition_invalid`). Its version is the next publication
 * number; it becomes the current version. A retry of a publication that
 * landed (the same definition and modules, on the same current version)
 * answers the version it published.
 */
export const publishWorkflowVersion = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown,
  /**
   * Seals the approved packages the input names (`sealPackages`): only a
   * builder's own publication passes it; without it, a publication that
   * names packages is refused.
   */
  sealer?: PackageSealer,
  /**
   * Admits the write, called right before the version is committed, after
   * it was compiled and its build stored: throws to publish nothing (a
   * chat's code run that ended meanwhile, agent-workflow-build.ts).
   */
  admit?: () => Promise<void>
): Promise<WorkflowResourceVersion> =>
  await seenBy(env, by, await publish(env, by, id, input, sealer, admit));

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
  // One lookup for the whole listing: each contract read once.
  const lookup = catalogOnce(env);
  return await Promise.all(
    rows.map(
      async (row) =>
        await versionOf(env, lookup, row, bindings.get(row.version) ?? [])
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
 * builders (`workflowDefinition`'s checks): the SDK TypeScript generated
 * from its definition and its own modules, read back from its sealed
 * build with every hash checked. The definition stays with the version,
 * for review. It goes one way: a version is only ever published from a
 * definition, so edited generated code never comes back as one.
 */
export const workflowSource = async (
  env: Env,
  by: Acting,
  id: unknown,
  version: unknown
): Promise<WorkflowVersionSource> => {
  await workflowDefinition(env, by, id, version);
  // Both checked by `workflowDefinition`: a workflow `by` builds, and a
  // version it published.
  const build = await loadWorkflowBuild(env, String(id), Number(version));
  // Its own modules, as published, read back from the seal.
  return {
    files: { [generatedWorkflowEntry]: build.source, ...build.compute.sources },
  };
};

/** A binding of a version, as a definition export follows it. */
export interface ExportedBinding {
  readonly alias: string;
  readonly kind: CatalogBindingKind;
}

/**
 * A workflow version as a definition export reads it (definition-export.ts),
 * or why it can't: `missing` for a workflow or version that isn't there,
 * `forbidden` for one `by` doesn't build.
 */
export type ExportedWorkflowVersion =
  | { readonly status: "missing" | "forbidden" }
  | {
      readonly status: "found";
      readonly name: string;
      readonly definitionVersion: string;
      readonly profile: string;
      readonly manifestHash: string;
      readonly definitionHash: string;
      readonly buildHash: string;
      /** Its definition exactly as published, its hash checked. */
      readonly definition: string;
      /** The TypeScript generated from it, and its own modules as published. */
      readonly files: Readonly<Record<string, string>>;
      /** The exact versions of the workflows it binds, and its catalog kinds. */
      readonly bindings: readonly ExportedBinding[];
      /** The approved packages its modules import, if any (`exportedPackages`). */
      readonly packages: ExportedPackages | null;
    };

/** What a version seals of its approved packages, as an export carries it. */
export interface ExportedPackages {
  readonly graphHash: string;
  /** The entries its modules import, sorted. */
  readonly entries: readonly string[];
  /** The graph's lock, from which another deployment asks for the same exact versions. */
  readonly lock: GraspLock;
}

/** Where a version's manifest seals its packages, as an export reads it. */
const exportedPackagesSchema = z.object({
  packages: sealedPackagesSchema.optional(),
});

/**
 * What version manifest `manifest` of workflow `workflowId` seals of its
 * approved packages, for its export: the graph, the entries its modules
 * import, and the graph's lock. Never the approval, which is this
 * deployment's: the destination approves the graph again. Undefined for a
 * manifest, or a stored lock, that doesn't read as one, JSON or not.
 */
const exportedPackages = async (
  env: Env,
  workflowId: string,
  manifest: string
): Promise<ExportedPackages | null | undefined> => {
  const parsed = exportedPackagesSchema.safeParse(parsedJson(manifest));
  if (!parsed.success) {
    return undefined;
  }
  const sealed = parsed.data.packages;
  if (sealed === undefined) {
    return null;
  }
  // The lock of the request that approved it, whatever became of it since.
  const row = await drizzle(env.DB)
    .select({ snapshot: dependencyRequests.snapshot })
    .from(dependencyRequests)
    .where(
      and(
        eq(dependencyRequests.subjectType, "workflow"),
        eq(dependencyRequests.subjectId, workflowId),
        eq(dependencyRequests.graphHash, sealed.graphHash)
      )
    )
    .limit(1)
    .get();
  const read = z
    .object({ lock: graspLockSchema })
    .safeParse(row === undefined ? undefined : parsedJson(row.snapshot));
  if (!read.success) {
    return undefined;
  }
  return {
    graphHash: sealed.graphHash,
    entries: Object.keys(sealed.entries).toSorted(),
    lock: read.data.lock,
  };
};

/**
 * Version `version` of workflow `id`, for a definition export by `by`, who
 * must build the workflow, as for its source (`workflowSource`): its
 * definition and sealed build read back with every hash checked
 * (`workflow.version_corrupt` otherwise), and what its manifest pins of its
 * bindings. Never its parameters' values, its bindings' approvals or its
 * runs: none of them is read.
 */
export const exportedWorkflowVersion = async (
  env: Env,
  by: Acting,
  id: string,
  version: number
): Promise<ExportedWorkflowVersion> => {
  const workflow = await liveWorkflow(env, id);
  if (workflow === undefined) {
    return { status: "missing" };
  }
  if ((await roleIn(env, by, workflow)) !== "builder") {
    return { status: "forbidden" };
  }
  const row = await drizzle(env.DB)
    .select({
      definitionVersion: workflowResourceVersions.definitionVersion,
      definition: workflowResourceVersions.definition,
      definitionHash: workflowResourceVersions.definitionJsonHash,
      profile: workflowResourceVersions.profileVersion,
      manifest: workflowResourceVersions.manifest,
      manifestHash: workflowResourceVersions.manifestHash,
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
    return { status: "missing" };
  }
  let definitionHash: string | undefined;
  try {
    definitionHash = await definitionHashOf(JSON.parse(row.definition));
  } catch {
    definitionHash = undefined;
  }
  if (
    definitionHash !== row.definitionHash ||
    (await sha256Hex(row.manifest)) !== row.manifestHash
  ) {
    throw corrupt(workflow.id, version);
  }
  const loaded = await loadWorkflowBuild(
    env,
    workflow.id,
    version,
    row.manifestHash
  );
  const manifest = parsedJson(row.manifest);
  requireServedBindingKinds(manifest);
  const pinned = manifestBindingsSchema.safeParse(manifest);
  const packages = await exportedPackages(env, workflow.id, row.manifest);
  if (!pinned.success || packages === undefined) {
    throw corrupt(workflow.id, version);
  }
  const bindings: ExportedBinding[] = [];
  for (const binding of pinned.data.bindings) {
    const catalogKind = catalogBindingKinds.find(
      (kind) => kind === binding.kind
    );
    if (catalogKind === undefined) {
      throw corrupt(workflow.id, version);
    } else {
      bindings.push({ alias: binding.alias, kind: catalogKind });
    }
  }
  return {
    status: "found",
    name: workflow.name,
    definitionVersion: row.definitionVersion,
    profile: row.profile,
    manifestHash: row.manifestHash,
    definitionHash: row.definitionHash,
    buildHash: loaded.hash,
    definition: row.definition,
    files: {
      [generatedWorkflowEntry]: loaded.source,
      ...loaded.compute.sources,
    },
    bindings,
    packages,
  };
};

/**
 * The modules version `version` of workflow `id` sealed, by path, read
 * back from its build with every hash checked: none for a version without
 * modules. For the
 * workflow's builders, whose role the caller has checked.
 */
export const sealedModules = async (
  env: Env,
  workflowId: string,
  version: number
): Promise<Record<string, string>> => {
  const build = await loadWorkflowBuild(env, workflowId, version);
  return { ...build.compute.sources };
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
  await requireSharable(
    env,
    member,
    {
      owner: workflow.owner,
      builds: role === "builder",
      invalid: (issue) =>
        workflowResourceErrors.create("workflow.resource_invalid", {
          issues: [issue],
        }),
      ownerIssue: "id: The workflow's owner always has it.",
      buildsIssue:
        "role: Only the organization's admins and builders build workflows.",
    },
    by
  );
  // A share with a project: the project, while `by` still builds it.
  const toProject =
    member.type === "project"
      ? projectStillBuiltSql(member.id, by.userId)
      : undefined;
  const addedAt = new Date();
  const db = drizzle(env.DB);
  const batch = auditedBatch(env, db, [
    db
      .insert(workflowResourceMembers)
      .values({
        // Only while the workflow is live: otherwise NULL, which fails the
        // batch, so a share racing a deletion writes nothing.
        // A share with a project, also only while it is there and `by`
        // builds it, read here: a builder taken out meanwhile shares
        // nothing.
        workflowResourceId: sql`(SELECT id FROM workflow_resources
          WHERE id = ${workflow.id} AND deleted_at IS NULL
            AND ${toProject === undefined ? sql`1` : sql`${toProject} IS NOT NULL`})`,
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
        // Live already: a deleted workflow's ID is NULL above, which
        // fails the insert before any conflict is looked for.
        setWhere: sql`${workflowResourceMembers.role} <> ${role}`,
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
      // The project's guard, if that was what held it back, says why.
      if (toProject !== undefined) {
        await requireStillBuilt(env, member.id, by.userId);
      }
      throw unavailable();
    }
    throw error;
  }
};

/**
 * Whether workflow `id`'s owner lets people ask Stephen to start it in a
 * chat app (`workflow_resources.askable`), for anyone with a role in it.
 */
export const workflowAskable = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<boolean> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const [row] = await drizzle(env.DB)
    .select({ askable: workflowResources.askable })
    .from(workflowResources)
    .where(eq(workflowResources.id, workflow.id));
  return row?.askable === true;
};

/**
 * Lets people ask Stephen to start workflow `id` in a chat app, or stops
 * that, for `by`, who must own it and isn't Grasp staff: whom he may offer
 * it to is whoever could start it themselves (channels/workflow-offers.ts).
 * A change is audited; setting what it is already records nothing.
 */
export const setWorkflowAskable = async (
  env: Env,
  by: Acting,
  id: unknown,
  askable: unknown
): Promise<void> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "user");
  if (workflow.owner !== by.userId) {
    throw roleErrors.create("role.forbidden");
  }
  const allowed = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    z.boolean(),
    askable
  );
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(workflowResources)
      .set({ askable: allowed })
      .where(
        and(
          eq(workflowResources.id, workflow.id),
          isNull(workflowResources.deletedAt),
          ne(workflowResources.askable, allowed)
        )
      ),
    outboxedIfChanged(
      db,
      entry(by, "workflow.askable_changed", workflow.id, { askable: allowed })
    ),
  ]);
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
  // A project's name only for someone in it: it is its members' alone.
  const projectNames = await namedProjectsFor(
    env,
    by,
    rows
      .filter(({ memberType }) => memberType === "project")
      .map(({ memberId }) => memberId)
  );
  return rows.map((row) => ({
    type: row.memberType,
    id: row.memberId,
    ...(row.memberType === "project"
      ? { projectName: projectNames.get(row.memberId) ?? null }
      : {}),
    role: row.role,
    addedBy: row.addedBy,
    addedAt: row.addedAt.toISOString(),
  }));
};

/**
 * `counts` and as many of `groups` as fit beside them in one audit event's
 * detail (`auditDetailMaxKeys` fields in all), each group's fields named
 * with its place in its list (`trigger3`, `appBinding2` and `app2`),
 * earlier lists first. The counts always say how many there are.
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
      AND run.status IN ('starting', 'running', 'paused'))`;

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
const boundSql = (id: string) => sql`(EXISTS (${pinningTriggersSql(id)})
  OR EXISTS (${pinningAppsSql(id)})
  OR ${liveRunsSql(id)} > 0)`;

/**
 * Deletes workflow `id` in one statement that requires the current version
 * of no other live workflow, no trigger, App binding or live run to hold
 * it: whether it was deleted.
 */
const deletedOnce = async (
  env: Env,
  by: Acting,
  id: string
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const now = new Date();
  const [deleted] = await auditedBatch(env, db, [
    db
      .update(workflowResources)
      .set({
        deletedAt: now,
        policyGeneration: sql`${workflowResources.policyGeneration} + 1`,
      })
      .where(
        and(
          eq(workflowResources.id, id),
          isNull(workflowResources.deletedAt),
          sql`NOT ${boundSql(id)}`
        )
      )
      .returning({ id: workflowResources.id }),
    outboxedIfChanged(db, entry(by, "workflow.deleted", id)),
    ...withdrawnWith(
      db,
      by.actor ?? actorOf(by),
      { type: "workflow", id },
      sql`EXISTS (SELECT 1 FROM workflow_resources WHERE id = ${id} AND deleted_at IS NOT NULL)`,
      now
    ),
    // Its draft (workflow-drafts.ts) is never read again, and may hold a
    // sensitive parameter's default: it goes once it is deleted.
    db.delete(workflowResourceDrafts).where(
      sql`${workflowResourceDrafts.workflowResourceId} IN (SELECT id
        FROM workflow_resources WHERE id = ${id} AND deleted_at IS NOT NULL)`
    ),
    db.delete(workflowResourceDraftModules).where(
      sql`${workflowResourceDraftModules.workflowResourceId} IN (SELECT id
        FROM workflow_resources WHERE id = ${id} AND deleted_at IS NOT NULL)`
    ),
    db.delete(workflowResourceDraftInspections).where(
      sql`${workflowResourceDraftInspections.workflowResourceId} IN (SELECT id
        FROM workflow_resources WHERE id = ${id} AND deleted_at IS NOT NULL)`
    ),
    // Out of every project, filed or shared: a deleted workflow takes no
    // project's room (projects.ts).
    db.delete(projectItems).where(
      and(
        eq(projectItems.itemType, "workflow"),
        sql`${projectItems.itemId} IN (SELECT id
          FROM workflow_resources WHERE id = ${id} AND deleted_at IS NOT NULL)`
      )
    ),
    db.delete(workflowResourceMembers).where(
      and(
        eq(workflowResourceMembers.memberType, "project"),
        sql`${workflowResourceMembers.workflowResourceId} IN (SELECT id
          FROM workflow_resources WHERE id = ${id} AND deleted_at IS NOT NULL)`
      )
    ),
    // What it kept between its runs (workflow-state.ts): no run of it
    // reads or writes it again.
    db.delete(workflowState).where(
      sql`${workflowState.workflowResourceId} IN (SELECT id
        FROM workflow_resources WHERE id = ${id} AND deleted_at IS NOT NULL)`
    ),
    db.delete(workflowStateWrites).where(
      sql`${workflowStateWrites.workflowResourceId} IN (SELECT id
        FROM workflow_resources WHERE id = ${id} AND deleted_at IS NOT NULL)`
    ),
  ]);
  return deleted.length > 0;
};

/** What keeps workflow `id` from being deleted (`boundSql`), as read now. */
interface Blockers {
  triggers: string[];
  appBindings: { id: string; app: string }[];
  liveRuns: number;
}

/** What holds workflow `id` now: each kind `boundSql` refuses a deletion for. */
const blockersOf = async (env: Env, id: string): Promise<Blockers> => {
  const db = drizzle(env.DB);
  const triggerRows = await db.all<{ id: string }>(
    sql`${pinningTriggersSql(id)} ORDER BY trigger.id`
  );
  const appBindings = await db.all<{ id: string; app: string }>(
    sql`${pinningAppsSql(id)} ORDER BY pinned.app_id, pinned.id`
  );
  const [live] = await db.all<{ count: number }>(
    sql`SELECT ${liveRunsSql(id)} AS count`
  );
  return {
    triggers: triggerRows.map(({ id: trigger }) => trigger),
    appBindings,
    liveRuns: live?.count ?? 0,
  };
};

/**
 * Audits and throws the refusal of `by`'s deletion of workflow `id`:
 * `workflow.resource_bound` with what holds it (`blockers`) when something
 * does; else
 * `workflow.resource_busy`, the guard having refused it for something gone
 * by the time it was read, twice.
 */
const refuseDeletion = async (
  env: Env,
  by: Acting,
  id: string,
  { triggers, appBindings, liveRuns }: Blockers,
  blocked: boolean
): Promise<never> => {
  const reason = blocked ? "workflow.resource_bound" : "workflow.resource_busy";
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(
      db,
      entry(
        by,
        "workflow.delete_refused",
        id,
        namedWithin(
          {
            reason,
            triggers: triggers.length,
            appBindings: appBindings.length,
            liveRuns,
          },
          [
            triggers.map((trigger) => ({ trigger })),
            appBindings.map(({ id: appBinding, app }) => ({ appBinding, app })),
          ]
        )
      )
    ),
  ]);
  if (!blocked) {
    throw workflowResourceErrors.create("workflow.resource_busy");
  }
  throw workflowResourceErrors.create("workflow.resource_bound", {
    // A workflow's builders manage every trigger that starts it
    // (trigger-resources.ts), and only they delete it: they see them all.
    triggers: { ids: triggers, hidden: 0 },
    // And remove any App binding to it (app-workflow-bindings.ts): they
    // see them all, with their Apps.
    appBindings,
    liveRuns,
  } satisfies WorkflowBinders);
};

/**
 * Deletes workflow `id` for `by`, who must build it and isn't Grasp staff,
 * in one statement that requires nothing to hold it (`deletedOnce`): no
 * trigger able to start it, no App binding able to start it, and no run
 * of it still live. Otherwise `workflow.resource_bound`, audited with what
 * holds it, and answered with its triggers, App bindings and live runs
 * (`WorkflowBinders`). A
 * refusal that finds nothing holding it (the hold gone in between) tries
 * the statement once more, then answers `workflow.resource_busy`, audited
 * the same. Its row and versions stay, never served again.
 */
export const deleteWorkflowResource = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<void> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  // A refusal that finds nothing binding it lost a race with whatever
  // stopped binding it in between: tried once more, then answered as
  // busy rather than as bound by nothing.
  for (const last of [false, true]) {
    // oxlint-disable-next-line no-await-in-loop -- the retry follows the attempt
    if (await deletedOnce(env, by, workflow.id)) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    if ((await liveWorkflow(env, workflow.id)) === undefined) {
      throw unavailable();
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    const blockers = await blockersOf(env, workflow.id);
    const blocked =
      blockers.triggers.length > 0 ||
      blockers.appBindings.length > 0 ||
      blockers.liveRuns > 0;
    if (blocked || last) {
      // oxlint-disable-next-line no-await-in-loop -- refused once, then thrown
      await refuseDeletion(env, by, workflow.id, blockers, blocked);
    }
  }
  // Never reached (the last try refuses whatever it finds), and never a
  // success if it were: a deletion only succeeds by its statement.
  throw workflowResourceErrors.create("workflow.resource_busy");
};

/**
 * What still names a version of workflow `id`, by kind, as SQL counts: any
 * version (not only the current one) of another live workflow that binds
 * it, any live trigger whose current version starts it, any active App
 * binding to it whatever its grants, and its runs that haven't ended.
 * Stricter than what keeps it from being deleted (`boundSql`): releasing
 * its name is about who answers its name, not who may start it.
 */
const namedBySql = (id: string) => sql`SELECT
    (SELECT COUNT(*) FROM trigger_resources AS trigger
      JOIN trigger_resource_versions AS pinned
        ON pinned.trigger_id = trigger.id AND pinned.version = trigger.current_version
      WHERE pinned.workflow_resource_id = ${id}
        AND trigger.deleted_at IS NULL) AS triggers,
    (SELECT COUNT(*) FROM app_workflow_bindings AS pinned
      WHERE pinned.workflow_resource_id = ${id}
        AND pinned.status = 'active') AS app_bindings,
    ${liveRunsSql(id)} AS live_runs`;

/**
 * How many times a release is tried in all when each miss finds nothing
 * pinning the workflow any more (a pin removed in between): after that,
 * it is refused.
 */
const releaseTries = 3;

/**
 * Points in a release's retry for tests to change what pins the workflow
 * at (`recounting`, before its pins are counted again after a miss, and
 * `recounted`, after); nothing passes them otherwise.
 */
export interface ReleaseSeam {
  readonly recounting?: () => Promise<void>;
  readonly recounted?: () => Promise<void>;
}

/** The most of a refused name an audit event keeps. */
const workflowNameMaxShown = 128;

/** What `namedBySql` counts, as a row. */
const namedBySchema = z.object({
  triggers: z.number(),
  app_bindings: z.number(),
  live_runs: z.number(),
});

/**
 * Releases `name`, the name of a deleted workflow, for `by`, an admin of
 * the organization and not Grasp staff, so a new workflow may take it
 * (GRA-562). Refused, and audited, while anything still names a version of
 * that workflow (`namedBySql`: `workflow.name_pinned`, with what does,
 * counted), and for a name no deleted workflow holds, a live one's
 * included (`workflow.name_unreleasable`, the same for both). A name
 * released already and taken by nobody since is released: that changes
 * and records nothing.
 *
 * The old workflow keeps its row, its versions and its name in them: only
 * the unique index skips it (migration 0107). Its contract keys never
 * resolve again, to it or to another: a workflow may not publish a
 * semantic version a released workflow of its name published
 * (`versionTaken`), so `workspace/<name>/<semver>` never
 * names two workflows, and nobody's draft binds the newcomer by naming an
 * old key.
 */
export const releaseWorkflowName = async (
  env: Env,
  by: Acting,
  name: unknown,
  seam: ReleaseSeam = {}
): Promise<void> => {
  const db = drizzle(env.DB);
  const shown =
    typeof name === "string" ? name.slice(0, workflowNameMaxShown) : null;
  // Every refusal is audited, under the workflow that holds the name when
  // one does.
  const refuse = async (
    reason: string,
    error: Error,
    holder?: string,
    detail: Record<string, number> = {}
  ): Promise<never> => {
    await auditedBatch(env, db, [
      outboxed(db, {
        actor: by.actor ?? actorOf(by),
        action: "workflow.name_release_refused",
        ...(holder === undefined
          ? {}
          : { target: { type: targetType, id: holder } }),
        detail: { name: shown, reason, ...detail },
      }),
    ]);
    throw error;
  };
  if (by.staff || !isAdmin(by.role)) {
    return await refuse("role.forbidden", roleErrors.create("role.forbidden"));
  }
  const unreleasable = async (holder?: string): Promise<never> =>
    await refuse(
      "workflow.name_unreleasable",
      workflowResourceErrors.create("workflow.name_unreleasable"),
      holder
    );
  const parsed = workflowNameSchema.safeParse(name);
  if (!parsed.success) {
    return await unreleasable();
  }
  const holder = await db
    .select({
      id: workflowResources.id,
      deletedAt: workflowResources.deletedAt,
    })
    .from(workflowResources)
    .where(
      and(
        eq(workflowResources.name, parsed.data),
        isNull(workflowResources.nameReleasedAt)
      )
    )
    .get();
  if (holder === undefined) {
    const released = await db
      .select({ id: workflowResources.id })
      .from(workflowResources)
      .where(
        and(
          eq(workflowResources.name, parsed.data),
          isNotNull(workflowResources.nameReleasedAt)
        )
      )
      .get();
    if (released !== undefined) {
      // Released already, and nobody took it since.
      return;
    }
    return await unreleasable();
  }
  if (holder.deletedAt === null) {
    return await unreleasable(holder.id);
  }
  // The release lands in one statement, only while nothing names the
  // workflow. One that lands nothing is asked why: released meanwhile by
  // another admin (a release), a pin that went in between (tried again,
  // a few times, then `workflow.name_busy`), or a pin (refused).
  for (let tries = 1; ; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- tried again only after a miss
    const [released] = await auditedBatch(env, db, [
      db
        .update(workflowResources)
        .set({ nameReleasedAt: new Date(), nameReleasedBy: by.userId })
        .where(
          and(
            eq(workflowResources.id, holder.id),
            isNotNull(workflowResources.deletedAt),
            isNull(workflowResources.nameReleasedAt),
            // Read as the release lands: a pin made since the check above
            // keeps the name.
            sql`(SELECT triggers + app_bindings + live_runs
              FROM (${namedBySql(holder.id)})) = 0`
          )
        )
        .returning({ id: workflowResources.id }),
      outboxedIfChanged(
        db,
        entry(by, "workflow.name.released", holder.id, { name: parsed.data })
      ),
    ]);
    if (released.length > 0) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    const now = await db
      .select({ releasedAt: workflowResources.nameReleasedAt })
      .from(workflowResources)
      .where(eq(workflowResources.id, holder.id))
      .get();
    if (now?.releasedAt !== null && now?.releasedAt !== undefined) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    await seam.recounting?.();
    // oxlint-disable-next-line no-await-in-loop -- see above
    const counts = namedBySchema.parse(await db.get(namedBySql(holder.id)));
    // oxlint-disable-next-line no-await-in-loop -- see above
    await seam.recounted?.();
    const pinned = {
      triggers: counts.triggers,
      appBindings: counts.app_bindings,
      liveRuns: counts.live_runs,
    };
    if (Object.values(pinned).some((count) => count > 0)) {
      // oxlint-disable-next-line no-await-in-loop -- refused, the loop ends
      return await refuse(
        "workflow.name_pinned",
        workflowResourceErrors.create("workflow.name_pinned", pinned),
        holder.id,
        pinned
      );
    }
    if (tries >= releaseTries) {
      // oxlint-disable-next-line no-await-in-loop -- refused, the loop ends
      return await refuse(
        "workflow.name_busy",
        workflowResourceErrors.create("workflow.name_busy"),
        holder.id
      );
    }
  }
};
