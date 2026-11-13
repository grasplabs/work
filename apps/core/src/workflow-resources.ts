import { generatedWorkflowEntry } from "@grasp-os/compiler";
import type { ValueDescriptor } from "@grasp-os/runtime/app";
import { schemaFromDescriptor } from "@grasp-os/runtime/host";
import type { FunctionManifest } from "@grasp-os/runtime/host";
import { actorOf, auditDetailMaxKeys } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import {
  businessProcessSchema,
  storedProcessOf,
} from "@grasp-os/shared/business-processes";
import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import { draftErrors } from "@grasp-os/shared/drafts";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin, requireBuilder, roleErrors } from "@grasp-os/shared/roles";
import {
  newSubjectMemberSchema,
  subjectMemberRefSchema,
} from "@grasp-os/shared/subject-members";
import type {
  MemberRole,
  SubjectMember,
} from "@grasp-os/shared/subject-members";
import {
  catalogBindingKinds,
  catalogKeySchema,
  workflowNameSchema,
  workflowNamespace,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import type {
  CatalogBindingKind,
  WorkflowDefinitionProblem,
  WorkflowResource,
  WorkflowResourceVersion,
  WorkflowBinders,
  SteeredWrite,
  WorkflowVersionBinding,
  WorkflowVersionSource,
} from "@grasp-os/shared/workflow-resources";
import { checkWorkflow } from "@grasp-os/workflow-schema/check";
import type { CheckedWorkflow, Problem } from "@grasp-os/workflow-schema/check";
import { expressionTypeRequest } from "@grasp-os/workflow-schema/expression-scope";
import {
  bindingsOf as documentBindings,
  definitionFormat,
  eachStep,
  isSensitive,
} from "@grasp-os/workflow-schema/format";
import type {
  Binding,
  ConnectionCallStep,
  Step,
  WaitForEventStep,
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
  lt,
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
  draftBlobs,
  draftCheckpointFiles,
  draftCheckpoints,
  draftFiles,
  drafts,
  sdkResourceBindings,
  projectItems,
  teams,
  users,
  workflowResourceLifecycles,
  workflowResourceMembers,
  workflowResourceProcesses,
  workflowResources,
  workflowResourceVersions,
  workflowState,
  workflowStateWrites,
} from "./db/core/schema.ts";
import { isUniqueViolation, notNullFailed } from "./db/d1.ts";
import type { Builder, DraftKind } from "./drafts.ts";
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
import { permittedFunctionsOf } from "./workflow-app-functions.ts";
import {
  buildOf,
  buildSummary,
  compiledTasksOf,
  compileWorkflow,
  loadWorkflowBuild,
  reviewedTasksOf,
  releaseBuild,
  requireManifestFormat,
  workflowManifestFormat,
  storeBuild,
} from "./workflow-builds.ts";
import type { CompiledBuild, SealedBuild } from "./workflow-builds.ts";
import { resolveCatalogKeys } from "./workflow-catalog.ts";
import type { ResolvedCatalogContract } from "./workflow-catalog.ts";
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
//   says: a grasp-workflow/2 document names no workflow, and its semantic
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
//   with the same definition answers the version it wrote
//   (`savedPublication`), so a retried publication is the same
//   publication.
// - A version running other code than its definition's. Publication
//   generates SDK TypeScript from the checked definition, compiles it and
//   seals it into the version's manifest, by hash (workflow-builds.ts):
//   what a version runs is fixed with it, and nothing compiles later.
// - Two publications racing. A publication names the current version it
//   built on; its batch inserts the version only while that is still the
//   current one and the workflow is live, and moves the current version in
//   the same transaction (`draft.conflict` otherwise).
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
): Promise<Map<string, MemberRole>> => {
  const roles = new Map<string, MemberRole>();
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
  const rowRoles = new Map<string, MemberRole[]>();
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
): Promise<MemberRole | undefined> => {
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
  needed: MemberRole
): Promise<Live & { role: MemberRole }> => {
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
  role: MemberRole,
  { process, paused }: { process: BusinessProcess | null; paused: boolean }
): WorkflowResource => ({
  id: workflow.id,
  namespace: workflowNamespace,
  name: workflow.name,
  owner: workflow.owner,
  currentVersion: workflow.currentVersion,
  role,
  process,
  paused,
  createdAt: workflow.createdAt.toISOString(),
});

/** Which of `workflows` are paused (workflow-pause.ts), in one read. */
const pausedAmong = async (
  env: Env,
  workflows: readonly string[]
): Promise<Set<string>> => {
  if (workflows.length === 0) {
    return new Set();
  }
  const rows = await drizzle(env.DB)
    .select({ id: workflowResourceLifecycles.workflowResourceId })
    .from(workflowResourceLifecycles)
    .where(
      and(
        sql`${workflowResourceLifecycles.workflowResourceId} IN ${jsonList(workflows)}`,
        isNotNull(workflowResourceLifecycles.pausedAt)
      )
    );
  return new Set(rows.map(({ id }) => id));
};

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
    { process: null, paused: false }
  );
};

/** Workflow `id`, for anyone with a role in it. */
export const getWorkflowResource = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowResource> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const [process, paused] = await Promise.all([
    processOf(env, workflow.id),
    pausedAmong(env, [workflow.id]),
  ]);
  return resourceOf(workflow, workflow.role, {
    process,
    paused: paused.has(workflow.id),
  });
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
  const paused = await pausedAmong(env, [workflow.id]);
  return resourceOf(workflow, workflow.role, {
    process,
    paused: paused.has(workflow.id),
  });
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
  const ids = rows.map(({ id }) => id);
  const [roles, processes, paused] = await Promise.all([
    rolesIn(env, by, rows),
    processesOf(env, ids),
    pausedAmong(env, ids),
  ]);
  return rows.flatMap((row) => {
    const role = roles.get(row.id);
    return role === undefined
      ? []
      : [
          resourceOf(row, role, {
            process: processes.get(row.id) ?? null,
            paused: paused.has(row.id),
          }),
        ];
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
 * A version's contract, as stored: the SDK descriptors of what a run
 * takes (`args`) and answers (`returns`), its parameters' descriptors,
 * labels and sensitivity, and its listen tasks, by task ID, each with the
 * event binding it listens through and the types its filters name: what
 * an App binding it may be held at, and sent (bound-workflow-events.ts).
 */
const storedContractSchema = z.strictObject({
  args: z.json(),
  returns: z.json(),
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

/** `text` read as JSON, or undefined when it isn't. */
const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The host catalog keys a checked document's bindings name, each once: all
 * of them, since the check holds a document to `formatLimits.bindings`
 * permissions in all (`workflow.too_many_permissions`).
 */
const namedKeys = (checked: CheckedWorkflow): string[] => {
  const keys = new Set<string>();
  for (const binding of Object.values(documentBindings(checked.document))) {
    if (catalogKeySchema.safeParse(binding.contract).success) {
      keys.add(binding.contract);
    }
  }
  return [...keys];
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

/** The types an event wait takes, as a list (`WaitForEventStep.eventType`). */
const eventTypesOf = (step: WaitForEventStep): readonly string[] =>
  typeof step.eventType === "string" ? [step.eventType] : step.eventType;

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
    args: z.json().parse(structuredClone(checked.contract.args)),
    returns: z.json().parse(structuredClone(checked.contract.returns)),
    // Each event wait, by its step's ID: what an App may send the run.
    listens: Object.fromEntries(
      eachStep(checked.document.steps).flatMap(({ step }) =>
        step.type === "waitForEvent"
          ? [[step.id, { alias: step.events, types: [...eventTypesOf(step)] }]]
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
 * The first contract version a workflow named `name` may publish: 1.0.0, or, under a released name, the major
 * version past every one its earlier holders published (`versionTaken`).
 */
export const firstFreeVersion = async (
  env: Env,
  name: string
): Promise<string> => {
  const rows = await drizzle(env.DB)
    .select({ version: workflowResourceVersions.contractVersion })
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

/** Where each kind of binding's permission stands under `permissions`. */
const permissionKeys: Readonly<Record<Binding["kind"], string>> = {
  model: "ai",
  connector: "connections",
  decision: "decisions",
  event: "events",
  files: "files",
  brain: "brain",
};

/**
 * Where permission `alias`, bound as `binding`, stands in the document:
 * `/permissions/ai`, or `/permissions/<kind>/<alias>`.
 */
const permissionPointer = (binding: Binding, alias: string): string =>
  binding.kind === "model"
    ? "/permissions/ai"
    : `/permissions/${permissionKeys[binding.kind]}/${alias}`;

/**
 * The types event wait `step` (at `pointer`) waits for that its binding's
 * event contract doesn't admit: a wait for one would never end but by its
 * timeout. A binding the catalog doesn't have is refused as such.
 */
const eventTypeProblems = (
  step: WaitForEventStep,
  pointer: string,
  bindings: Readonly<Record<string, Binding>>,
  catalog: ReadonlyMap<string, ResolvedCatalogContract>
): WorkflowDefinitionProblem[] => {
  const contract = catalog.get(bindings[step.events]?.contract ?? "");
  if (contract?.kind !== "event") {
    return [];
  }
  const admitted = contract.contract.events ?? {};
  const listed = typeof step.eventType !== "string";
  const matched = step.match !== undefined;
  return eventTypesOf(step).flatMap((type, index) => {
    const at = `${pointer}/eventType${listed ? `/${index}` : ""}`;
    if (!Object.hasOwn(admitted, type)) {
      return [
        {
          code: "event.unknown_type",
          message:
            "The event permission's contract admits no event of this type.",
          pointer: at,
          remedy: "Wait for a type its contract's events name.",
        },
      ];
    }
    // A match is decided over an event source's events alone (event-
    // waits.ts): a type nothing sends from a source would never match;
    // and one a source sends reaches a run only by a match, never
    // whichever run waits first.
    const unmatched = (each: string, where: string) =>
      !matched && admitted[each]?.ingress === "webhook"
        ? [
            {
              code: "event.match_required",
              message:
                "A webhook source's events reach a run only by a `match` on what the run is waiting for.",
              pointer: where,
              remedy:
                "Give the wait `match`: the field of the event's data, and the value it must have.",
            },
          ]
        : [];
    return matched && admitted[type]?.ingress !== "webhook"
      ? [
          {
            code: "event.match_unsourced",
            message:
              "A wait with `match` takes only events a webhook source sends, and its contract takes this type from elsewhere.",
            pointer: at,
            remedy:
              'Wait for a type the contract takes from a webhook source (`ingress: "webhook"`), or leave `match` out.',
          },
        ]
      : unmatched(type, at);
  });
};

/**
 * Where connection call `step` (at `pointer`) keeps a file or attaches
 * run files where its action's contract (`operation`) doesn't answer or
 * take files, as the connector's approval compared with what it serves:
 * refused here rather than at the call.
 */
const fileProblems = (
  step: ConnectionCallStep,
  operation: { answersFile?: true; takesFiles?: true } | undefined,
  pointer: string
): WorkflowDefinitionProblem[] => [
  ...(step.into !== undefined && operation?.answersFile !== true
    ? [
        {
          code: "connector.no_file_answer",
          message: `\`${step.action}\` doesn't answer a file, so nothing is kept \`into\` the run's files.`,
          pointer: `${pointer}/into`,
          remedy:
            "Keep a file only from an action whose contract answers one, or leave `into` out.",
        },
      ]
    : []),
  ...(step.from !== undefined && operation?.takesFiles !== true
    ? [
        {
          code: "connector.takes_no_files",
          message: `\`${step.action}\` attaches no files, so none come \`from\` the run's files.`,
          pointer: `${pointer}/from`,
          remedy:
            "Attach files only to an action whose contract takes them, or leave `from` out.",
        },
      ]
    : []),
];

/**
 * What the format can't check of a document's bindings, against what
 * they resolve to: each binding's contract in the host catalog, of the
 * kind the binding says; and each connector operation a step calls one
 * its contract allows.
 */
const bindingProblems = (
  checked: CheckedWorkflow,
  catalog: ReadonlyMap<string, ResolvedCatalogContract>
): WorkflowDefinitionProblem[] => {
  const problems: WorkflowDefinitionProblem[] = [];
  const bindings = documentBindings(checked.document);
  for (const [alias, binding] of Object.entries(bindings)) {
    const pointer = `${permissionPointer(binding, alias)}/contract`;
    const contract = catalog.get(binding.contract);
    if (contract === undefined || contract.kind !== binding.kind) {
      problems.push({
        code: "binding.unknown_contract",
        message: `The catalog has no ${binding.kind} contract \`${binding.contract}\`.`,
        pointer,
        remedy: "Name a contract of the catalog, of the binding's kind.",
      });
    }
  }
  for (const { step, pointer } of eachStep(checked.document.steps)) {
    if (step.type === "waitForEvent") {
      problems.push(...eventTypeProblems(step, pointer, bindings, catalog));
      continue;
    }
    if (step.type !== "call" || !("connection" in step)) {
      continue;
    }
    const binding = bindings[step.connection];
    const operations =
      binding === undefined
        ? undefined
        : catalog.get(binding.contract)?.contract.operations;
    if (operations !== undefined && !Object.hasOwn(operations, step.action)) {
      problems.push({
        code: "connector.unknown_operation",
        message: `The connection's contract doesn't allow \`${step.action}\`.`,
        pointer: `${pointer}/action`,
        remedy: "Call one of the actions its contract allows.",
      });
      continue;
    }
    problems.push(
      ...fileProblems(
        step,
        Object.hasOwn(operations ?? {}, step.action)
          ? operations?.[step.action]
          : undefined,
        pointer
      )
    );
  }
  return problems;
};

/**
 * Each function `checked`'s App permissions list that its App's current
 * version doesn't give as a query or mutation (`permitted`, by alias):
 * one never given, removed since, an action, or of an App that is gone.
 * A workflow names a function by its ID alone, so nothing it publishes
 * calls what isn't there to call; a removal after publication fails the
 * next call instead (workflows/app-calls.ts).
 */
const appFunctionProblems = (
  checked: CheckedWorkflow,
  permitted: ReadonlyMap<string, ReadonlyMap<string, FunctionManifest>>
): WorkflowDefinitionProblem[] =>
  Object.entries(checked.document.permissions?.apps ?? {}).flatMap(
    ([alias, { functions }]) =>
      Object.keys(functions).flatMap((id) =>
        permitted.get(alias)?.has(id) === true
          ? []
          : [
              {
                code: "workflow.app_function_unavailable",
                message: `\`${alias}\`'s App gives no query or mutation with this ID now.`,
                pointer: `/permissions/apps/${alias}/functions/${id}`,
                remedy:
                  "Name a function the App's current version gives an ID to, or remove the call.",
              },
            ]
      )
  );

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
  permitted: ReadonlyMap<string, ReadonlyMap<string, FunctionManifest>>,
  whose: string
): Promise<WorkflowDefinitionProblem[]> => {
  const bindings = documentBindings(checked.document);
  // A `call` step's result, as its call's contract answers it.
  const contractOutputOf = (step: Step) => {
    const called =
      step.type === "call" && "connection" in step ? step : undefined;
    const text =
      called === undefined
        ? undefined
        : catalog.get(bindings[called.connection]?.contract ?? "")?.contract
            .operations?.[called.action]?.output;
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
  // An App's function's, as its App's current version declares what it
  // returns (untyped where it declares nothing).
  const outputOf = (step: Step) =>
    step.type === "call" && "app" in step
      ? (permitted.get(step.app)?.get(step.function)?.returns ?? undefined)
      : contractOutputOf(step);
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
 * `definition` checked for publication by `by`: it is grasp-workflow/2
 * (`checkWorkflow`), and its bindings resolve against the host's catalog
 * (`bindingProblems`). Returns it with
 * what each binding resolved to, or its problems.
 */
const inspectDefinition = async (
  env: Env,
  /** Who saves or publishes it: the Apps it names are read as they may use them. */
  by: Acting | undefined,
  definition: string,
  /** Whose definition it is: the workflow's ID, or a blueprint's. */
  whose: string,
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
  const catalog = await resolveCatalogKeys(env, namedKeys(checked));
  const unresolved = bindingProblems(checked, catalog);
  if (unresolved.length > 0) {
    return { ok: false, problems: unresolved };
  }
  // Its contract must fit a version's row, checked here so a draft that
  // passes is one that publishes (workflow-editor.ts).
  if (bytesOf(canonicalJson(contractOf(checked))) > contractMaxBytes) {
    return {
      ok: false,
      problems: [
        {
          code: "contract.too_large",
          message:
            "The workflow's args, returns and parameter schemas together are larger than a version may hold.",
          pointer: "/args",
          remedy: "Keep the schemas smaller: move large constants into data.",
        },
      ],
    };
  }
  const bindings: PinnedBinding[] = [];
  for (const [alias, binding] of Object.entries(
    documentBindings(checked.document)
  )) {
    const contract = catalog.get(binding.contract);
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
  const permitted = await permittedFunctionsOf(
    env,
    by,
    checked.document.permissions?.apps
  );
  const unoffered = appFunctionProblems(checked, permitted);
  if (unoffered.length > 0) {
    return { ok: false, problems: unoffered };
  }
  const mistyped = await expressionTypeProblems(
    env,
    checked,
    catalog,
    permitted,
    whose
  );
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
  by: Acting,
  definition: string,
  whose: string,
  parsed: unknown
): Promise<{
  checked: CheckedWorkflow;
  bindings: PinnedBinding[];
}> => {
  const inspected = await inspectDefinition(env, by, definition, whose, parsed);
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
  // A version of another format never gets here: its review
  // lists it as refused (`formatRefusalOf`).
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

/** `writes` with each alias once, a connector's operations merged. */
const mergedWrites = (writes: readonly SteeredWrite[]): SteeredWrite[] => {
  const merged = new Map<string, SteeredWrite>();
  for (const write of writes) {
    const seen = merged.get(write.alias);
    if (seen === undefined) {
      merged.set(write.alias, write);
    } else {
      merged.set(write.alias, {
        ...seen,
        operations: [...new Set([...seen.operations, ...write.operations])],
      });
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
 * (GRA-727), read from the version as sealed and the catalog, never
 * inspected again: when its build holds any model task, every write its
 * connector tasks may make. Conservative: any model task counts as
 * reaching every call, whatever their order or the flow of data between
 * them.
 *
 * A connector's operation counts as a write unless the catalog contract
 * its binding pinned states it is read-only, and only while the catalog
 * still holds that exact contract (its fingerprint the one the version
 * sealed): a binding, contract or operation that isn't there, or a
 * contract that changed, counts as a write. So the flag shows whenever a write can't be ruled out.
 */
const steeringReview = async (
  lookup: CatalogLookup,
  bindings: readonly PinnedContract[],
  tasks: readonly SealedTask[]
): Promise<SteeredWrite[]> => {
  const connectorOf = (alias: string): PinnedContract | undefined =>
    bindings.find(
      (binding) => binding.alias === alias && binding.kind === "connector"
    );
  if (!asksModelInTasks(tasks)) {
    return [];
  }
  const keys = bindings.flatMap((binding) =>
    binding.kind === "connector" ? [binding.contractId] : []
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
  const taskWrites = (task: SealedTask): SteeredWrite[] =>
    // A sleep, a decision, an event and a model call itself write nothing
    // of the organization's.
    task.kind === "call" && task.call.name === "grasp.connector"
      ? connectorWrites(task.call.binding, [task.call.operation])
      : [];
  return mergedWrites(tasks.flatMap(taskWrites));
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
 * Why version `row` is refused as one to publish again, if its manifest is
 * of another format (`requireManifestFormat`): a listing shows it so,
 * where its run, start, review and export are refused.
 */
const formatRefusalOf = (
  row: typeof workflowResourceVersions.$inferSelect
): WorkflowResourceVersion["refused"] => {
  try {
    requireManifestFormat(parsedJson(row.manifest));
    return undefined;
  } catch (error) {
    if (
      workflowResourceErrors.codeOf(error) !== "workflow.format_unsupported"
    ) {
      throw error;
    }
    return {
      code: "workflow.format_unsupported",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * A version's row, as the registry answers it: only once its manifest
 * still hashes to what was sealed, since its build is read from it (`workflow.version_corrupt` otherwise).
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
  const refused = formatRefusalOf(row);
  if (refused !== undefined) {
    return {
      kind: "workflow",
      resourceId: row.workflowResourceId,
      version: row.version,
      contractVersion: row.contractVersion,
      label: row.label,
      profile: row.profileVersion,
      definitionHash: row.definitionJsonHash,
      contractHash: row.contractHash,
      manifestHash: row.manifestHash,
      bindings,
      modelSteeredWrites: [],
      build: null,
      refused,
      author: row.authorId,
      createdAt: row.createdAt.toISOString(),
    };
  }
  const sealedBindings = sealedBindingsOf(row);
  const modelSteeredWrites = await steeringReview(
    lookup,
    sealedBindings,
    await versionTasksOf(env, row, sealedBindings)
  );
  return {
    kind: "workflow",
    resourceId: row.workflowResourceId,
    version: row.version,
    contractVersion: row.contractVersion,
    label: row.label,
    profile: row.profileVersion,
    definitionHash: row.definitionJsonHash,
    contractHash: row.contractHash,
    manifestHash: row.manifestHash,
    bindings,
    modelSteeredWrites,
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

/** A version's contract: its args, returns and parameters. */
export type VersionContract = StoredContract;

/**
 * The contract of version `version` of workflow `id`, read once its
 * manifest hashes to what was sealed and is of this host's format
 * (`workflow.format_unsupported` otherwise), and checked against its hash
 * (`workflow.version_corrupt` otherwise); undefined for a version it
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
      manifest: workflowResourceVersions.manifest,
      manifestHash: workflowResourceVersions.manifestHash,
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
  if ((await sha256Hex(row.manifest)) !== row.manifestHash) {
    throw corrupt(id, version);
  }
  requireManifestFormat(parsedJson(row.manifest));
  if ((await sha256Hex(row.contract)) !== row.contractHash) {
    throw corrupt(id, version);
  }
  return storedContractSchema.parse(JSON.parse(row.contract));
};

/** The number of workflow `id`'s latest version; 0 while it has none. */
const latestVersionOf = async (env: Env, id: string): Promise<number> => {
  const row = await drizzle(env.DB)
    .select({ version: workflowResourceVersions.version })
    .from(workflowResourceVersions)
    .where(eq(workflowResourceVersions.workflowResourceId, id))
    .orderBy(desc(workflowResourceVersions.version))
    .limit(1)
    .get();
  return row?.version ?? 0;
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
}

/**
 * Writes `publication` as the workflow's next version, past every one it
 * has, in one batch with its bindings and its event: only while the
 * workflow is live. Not live itself: activating it is a publish's
 * (workflow-publish.ts). Answers the version written; another written at
 * once takes its number (a unique violation).
 */
const buildVersion = async (
  env: Env,
  by: Acting,
  publication: Publication
): Promise<WorkflowResourceVersion> => {
  const { workflow, checked, definition, definitionHash, bindings, compiled } =
    publication;
  // Bounded when the definition was checked (`inspectDefinition`).
  const contractText = canonicalJson(contractOf(checked));
  const contractHash = await sha256Hex(contractText);
  const version = (await latestVersionOf(env, workflow.id)) + 1;
  // A document names no version of its own: publication numbers it, past
  // every one an earlier holder of a released name published
  // (`firstFreeVersion`), so a contract key never names two workflows.
  const contractVersion = `${
    majorOf(await firstFreeVersion(env, workflow.name)) + BigInt(version - 1)
  }.0.0`;
  const manifest = canonicalJson({
    formatVersion: workflowManifestFormat,
    target: "workflow",
    resourceId: workflow.id,
    resourceVersion: version,
    namespace: workflowNamespace,
    name: workflow.name,
    // The sealed manifest format's key for the contract version.
    definitionVersion: contractVersion,
    profile: definitionFormat,
    definitionHash,
    contractHash,
    bindings: bindings.map((binding) => ({ ...binding })),
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
        pointer: "/permissions",
        remedy: "Bind fewer workflows.",
      },
    ]);
  }
  const manifestHash = await sha256Hex(manifest);
  // Before anything is written: a publication that lands answers it.
  const modelSteeredWrites = await steeringReview(
    catalogOnce(env),
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
    await auditedBatch(env, db, [
      db.insert(workflowResourceVersions).values({
        // Only while the workflow is live: otherwise NULL, which fails
        // the batch.
        workflowResourceId: sql`(SELECT id FROM workflow_resources
        WHERE id = ${workflow.id} AND deleted_at IS NULL)`,
        version,
        contractVersion,
        status: "published",
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
        entry(by, "workflow.version.built", workflow.id, {
          version,
          contractVersion,
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
    throw error;
  }
  return {
    kind: "workflow",
    resourceId: workflow.id,
    version,
    contractVersion,
    label: null,
    profile: definitionFormat,
    definitionHash,
    contractHash,
    manifestHash,
    bindings,
    modelSteeredWrites,
    build: buildSummary(compiled.build),
    author: by.userId,
    createdAt: createdAt.toISOString(),
  };
};

/**
 * Builds `definition` as workflow `workflow`'s next version for `by`:
 * checked by the profile and the catalog (`workflow.definition_invalid`
 * with its problems), compiled once, here (no start or resume compiles
 * anything), and written, not live (`buildVersion`). Another version
 * built at once takes the number: `draft.conflict`.
 */
export const buildWorkflowVersion = async (
  env: Env,
  by: Acting,
  workflow: Live,
  definition: string
): Promise<WorkflowResourceVersion> => {
  const { checked, bindings } = await checkDefinition(
    env,
    by,
    definition,
    workflow.id,
    parsedJson(definition)
  );
  // Of its canonical JSON: whitespace and key order make no other version.
  const definitionHash = await definitionHashOf(checked.document);
  const compiled = await compileWorkflow(env, checked, definition, workflow.id);
  try {
    return await buildVersion(env, by, {
      workflow,
      checked,
      definition,
      definitionHash,
      bindings,
      compiled,
    });
  } catch (error) {
    if (notNullFailed(error, "workflow_resource_versions.manifest_hash")) {
      // A reference of its build went before the row could name it, which
      // only a publication stalled past a day sees: publishing again
      // references afresh.
      throw draftErrors.create("draft.conflict");
    }
    if (
      notNullFailed(error, "workflow_resource_versions.workflow_resource_id")
    ) {
      throw unavailable();
    }
    if (isUniqueViolation(error)) {
      throw draftErrors.create("draft.conflict");
    }
    throw error;
  }
};

/** The file a workflow's draft and versions are, as drafts.ts holds them. */
export const workflowFile = "workflow.json";

/**
 * That `by` builds live workflow `id` as a statement runs, as SQL: as
 * `rolesIn` reads it, an admin; its owner, whose role builds; or someone
 * one of whose rows (their own, their teams', their projects') makes them
 * a builder, whose role builds.
 */
export const stillBuiltBy = (by: Builder, id: string): SQL => {
  const live = sql`EXISTS (SELECT 1 FROM ${workflowResources}
    WHERE ${workflowResources.id} = ${id} AND ${workflowResources.deletedAt} IS NULL)`;
  if (isAdmin(by.role)) {
    return live;
  }
  if (ceilingOf(by) !== "builder") {
    return sql`0`;
  }
  return sql`(${live} AND (EXISTS (SELECT 1 FROM ${workflowResources}
      WHERE ${workflowResources.id} = ${id} AND ${workflowResources.ownerId} = ${by.userId})
    OR EXISTS (SELECT 1 FROM ${workflowResourceMembers}
      WHERE ${workflowResourceMembers.workflowResourceId} = ${id}
        AND ${workflowResourceMembers.role} = 'builder'
        AND ${rowsOf(workflowResourceMembers, by)})))`;
};

/**
 * What a test run of a workflow's draft runs (workflows/candidate-runs.ts),
 * compiled and checked exactly as a publication of it would be, against
 * the host's catalog; nothing is written. Its contract is the one a version of it would seal. Refused as
 * publication refuses it (`workflow.definition_invalid` with its problems).
 */
export const candidateBuildOf = async (
  env: Env,
  by: Acting,
  workflow: Live,
  definition: string
) => {
  const parsed = parsedJson(definition);
  const { checked, bindings } = await checkDefinition(
    env,
    by,
    definition,
    workflow.id,
    parsed
  );
  const compiled = await compileWorkflow(env, checked, definition, workflow.id);
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
 * else (the catalog unreachable) is thrown. What a workflow's draft is
 * checked with (workflow-editor.ts), as a publish of it checks it.
 */
export const definitionProblems = async (
  env: Env,
  /** Who saves it; none for a blueprint, which names no App. */
  by: Acting | undefined,
  definition: string,
  /** Whose definition it is: the workflow's ID, or a blueprint's. */
  whose: string
): Promise<WorkflowDefinitionProblem[]> => {
  const inspected = await inspectDefinition(env, by, definition, whose);
  return inspected.ok ? [] : inspected.problems;
};

/** Most versions one `workflowVersions` call answers. */
const versionsPerPage = 100;

/**
 * Workflow `id`'s versions, newest first, a page at a time: the newest
 * {@link versionsPerPage}, or those before `before`. For anyone with a
 * role in it.
 */
export const workflowVersions = async (
  env: Env,
  by: Acting,
  id: unknown,
  before?: unknown
): Promise<WorkflowResourceVersion[]> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const until =
    before === undefined
      ? undefined
      : workflowResourceErrors.parse(
          "workflow.resource_invalid",
          z.int().min(1),
          before
        );
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, workflow.id),
        until === undefined
          ? undefined
          : lt(workflowResourceVersions.version, until)
      )
    )
    .orderBy(desc(workflowResourceVersions.version))
    .limit(versionsPerPage);
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

/** Version `version` of workflow `id`, for anyone with a role in it. */
export const workflowVersion = async (
  env: Env,
  by: Acting,
  id: unknown,
  version: unknown
): Promise<WorkflowResourceVersion> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const row =
    typeof version === "number" && Number.isSafeInteger(version)
      ? await drizzle(env.DB)
          .select()
          .from(workflowResourceVersions)
          .where(
            and(
              eq(workflowResourceVersions.workflowResourceId, workflow.id),
              eq(workflowResourceVersions.version, version)
            )
          )
          .get()
      : undefined;
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  const bindings = await bindingsOf(env, workflow.id, row.version);
  return await versionOf(
    env,
    catalogOnce(env),
    row,
    bindings.get(row.version) ?? []
  );
};

/**
 * The definition of version `version` of workflow `id`, exactly as
 * published: text that no longer hashes to what was published is
 * refused (`workflow.version_corrupt`), never handed out.
 */
export const publishedDefinition = async (
  env: Env,
  id: string,
  version: unknown
): Promise<string> => {
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
        eq(workflowResourceVersions.workflowResourceId, id),
        eq(workflowResourceVersions.version, version)
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  let hash: string | undefined;
  try {
    hash = await definitionHashOf(JSON.parse(row.definition));
  } catch {
    hash = undefined;
  }
  if (hash !== row.definitionHash) {
    throw corrupt(id, version);
  }
  return row.definition;
};

/**
 * The definition of version `version` of workflow `id`, exactly as
 * published (`publishedDefinition`), for its builders: its parameters'
 * defaults may be sensitive.
 */
export const workflowDefinition = async (
  env: Env,
  by: Acting,
  id: unknown,
  version: unknown
): Promise<string> => {
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  return await publishedDefinition(env, workflow.id, version);
};

/**
 * The portable source of version `version` of workflow `id`, for its
 * builders (`workflowDefinition`'s checks): the SDK TypeScript generated
 * from its definition, read back from its sealed
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
  return { files: { [generatedWorkflowEntry]: build.source } };
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
      readonly contractVersion: string;
      readonly profile: string;
      readonly manifestHash: string;
      readonly definitionHash: string;
      readonly buildHash: string;
      /** Its definition exactly as published, its hash checked. */
      readonly definition: string;
      /** The TypeScript generated from it. */
      readonly files: Readonly<Record<string, string>>;
      /** The exact versions of the workflows it binds, and its catalog kinds. */
      readonly bindings: readonly ExportedBinding[];
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
      contractVersion: workflowResourceVersions.contractVersion,
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
  const pinned = manifestBindingsSchema.safeParse(manifest);
  if (!pinned.success) {
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
    contractVersion: row.contractVersion,
    profile: row.profile,
    manifestHash: row.manifestHash,
    definitionHash: row.definitionHash,
    buildHash: loaded.hash,
    definition: row.definition,
    files: { [generatedWorkflowEntry]: loaded.source },
    bindings,
  };
};

/**
 * Whom workflow `id` is shared with, for anyone with a role in it, each
 * by name, as an App's members are (app-members.ts): the people still in
 * the organization, the teams that still exist and the projects, in the
 * order they were shared. A project's name only for someone in it: to
 * anyone else it stays unnamed.
 */
export const workflowMembers = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<SubjectMember[]> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const rows = await drizzle(env.DB)
    .select({
      row: workflowResourceMembers,
      person: users.name,
      team: teams.name,
    })
    .from(workflowResourceMembers)
    .leftJoin(
      users,
      and(
        eq(workflowResourceMembers.memberType, "person"),
        eq(users.id, workflowResourceMembers.memberId)
      )
    )
    .leftJoin(
      teams,
      and(
        eq(workflowResourceMembers.memberType, "team"),
        eq(teams.id, workflowResourceMembers.memberId)
      )
    )
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
  const projectNames = await namedProjectsFor(
    env,
    by,
    rows
      .filter(({ row }) => row.memberType === "project")
      .map(({ row }) => row.memberId)
  );
  return rows.map(({ row, person, team }) => ({
    type: row.memberType,
    id: row.memberId,
    name:
      row.memberType === "project"
        ? (projectNames.get(row.memberId) ?? null)
        : (person ?? team),
    role: row.role,
    addedBy: row.addedBy,
    addedAt: row.addedAt.toISOString(),
  }));
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
): Promise<SubjectMember> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const { role, ...member } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    newSubjectMemberSchema,
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
  const shared = await workflowMembers(env, by, workflow.id);
  const added = shared.find(
    (each) => each.type === member.type && each.id === member.id
  );
  if (added === undefined) {
    throw unavailable();
  }
  return added;
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
    subjectMemberRefSchema,
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
    // Its draft and checkpoints (drafts.ts) are never read again, and may
    // hold a sensitive parameter's default: they go once it is deleted.
    ...[
      drafts,
      draftFiles,
      draftCheckpoints,
      draftCheckpointFiles,
      draftBlobs,
    ].map((table) =>
      db.delete(table).where(
        and(
          eq(table.subjectKind, "workflow"),
          sql`${table.subjectId} IN (SELECT id
              FROM workflow_resources WHERE id = ${id} AND deleted_at IS NOT NULL)`
        )
      )
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

/**
 * A workflow as drafts and versions see it (drafts.ts, publish.ts): its
 * draft is one file, `workflow.json`, written by its builders while it
 * isn't deleted, over its live version. How it is published is
 * workflow-publish.ts' `workflowSteps`.
 */
export const workflowKind: DraftKind = {
  kind: "workflow",
  readable: async (env, by, input) => {
    const { id } = await requireWorkflowRole(env, by, input, "builder");
    return id;
  },
  editable: async (env, by, input) => {
    const { id } = await requireWorkflowRole(env, by, input, "builder");
    return id;
  },
  stillEditable: (id, by) => stillBuiltBy(by, id),
  currentVersion: async (env, id) => {
    const workflow = await liveWorkflow(env, id);
    return workflow?.currentVersion ?? null;
  },
  liveBase: async (env, id) => {
    const workflow = await liveWorkflow(env, id);
    return workflow?.currentVersion ?? null;
  },
  versionFiles: async (env, id, version) =>
    new Map([[workflowFile, await publishedDefinition(env, id, version)]]),
  versionDefinition: async () => await Promise.resolve(null),
  versions: {
    list: async (env, by, id, before) =>
      await workflowVersions(env, by, id, before),
    get: async (env, by, id, version) =>
      await workflowVersion(env, by, id, version),
  },
};
