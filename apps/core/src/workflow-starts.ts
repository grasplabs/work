import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import { actorOf, delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError, issuesOf } from "@grasp-os/shared/errors";
import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import {
  coreStartKeyPrefix,
  maxLiveRunsPerPrincipal,
  workflowResourceErrors,
  workflowStartSchema,
} from "@grasp-os/shared/workflow-resources";
import type { WorkflowStart } from "@grasp-os/shared/workflow-resources";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedWhere } from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/auth.ts";
import type { Acting } from "./auth/identity.ts";
import {
  permissions,
  triggerResources,
  triggerResourceVersions,
  workflowResources,
  workflowResourceVersions,
  workflowStartReceipts,
} from "./db/core/schema.ts";
import { isUniqueViolation } from "./db/d1.ts";
import { allowingPermissionSql } from "./permissions.ts";
import { approvalServing, requireTargetServes } from "./workflow-bindings.ts";
import { buildOf } from "./workflow-builds.ts";
import type { SealedBuild } from "./workflow-builds.ts";
import { frozenParams } from "./workflow-params.ts";
import { bindingsOf, requireWorkflowRole } from "./workflow-resources.ts";
import { runAdmitted, startResourceRun } from "./workflows/resource-runs.ts";

// Starting an independent workflow (platform specification 13.2, 15.1, 24):
// who may, for whom, and on which exact version. Every start is admitted
// in one statement that writes its receipt only while the authorization
// it was decided on still holds, read again as the statement runs; a
// start the host decided on earlier can't land on authority that changed
// since. Running what was admitted is the engine's (GRA-268); this is the
// start contract every invoker shares.
//
// Who may start a workflow, and as whom:
//
// - A person: anyone with a role in it (`user` or `builder`), acting for
//   themselves.
// - An App: only with a permission of its own, `start` on the workflow,
//   granted by an admin, from a version of the App an admin approved
//   (starting changes things), acting for the person its call acts for.
//   The App's role or grouping gives it nothing else.
// - An agent: with a permission of its own, `start` on the workflow
//   (a chat's own only in that chat), and only for a person who could
//   start it themselves: the agent's grant and the person's role, both.
// - A trigger (a system event, a connector event, a webhook, a schedule):
//   with a permission of its own, `start` on the workflow, live and
//   enabled, only the exact version its current trigger version pins, and
//   acting for the person it was bound to, never the workflow's owner.
//
// Threat model, and how each is closed:
//
// - A start naming "latest", a range or an unpublished version: a start
//   names a publication number, an integer, and must match a published
//   version of the live workflow and its manifest hash in the admitting
//   statement (`workflow.start_invalid`, `workflow.version_not_found`).
// - A stale grant: the admitting statement requires the permission active
//   then (and, for an App, the version approved then); a revoked grant, or
//   one asked for again when an unapproved App version was made current,
//   admits nothing (`workflow.start_denied`).
// - A revoked App release: an App's start requires its version's release
//   not revoked, read in the admitting statement, so the kill switch stops
//   starts its code made, or staged before, as it stops its calls.
// - A caller taking one of core's keys: keys core derives (an App
//   action's starts, a committed mutation's) begin with
//   `coreStartKeyPrefix`, which a person's or an agent's key may not.
// - Revocation racing a start: the check and the receipt are one
//   statement, so of a revocation and a start, the start lands only if it
//   was admitted before the revocation committed. A start decided before
//   and admitted after is refused: the grant is read again, and any change
//   of the workflow's members or of grants on it moves its policy
//   generation, which the admitting statement requires unchanged.
// - Team membership changing mid-start: a person's role through a team is
//   read from the team's members (Better Auth's `team_members`) in the
//   admitting statement, not from the session's list of teams.
// - A person who left: every principal must be an active member when the
//   statement runs.
// - The same start sent twice: one receipt per invoker, person acted for
//   and idempotency key; the same key with the same version, input and
//   App or trigger version is the same start, with another is refused
//   (`workflow.start_conflict`). One person never gets another's receipt
//   through the same App, agent or trigger. A start sent again is
//   answered with its receipt once the invoker's own access is checked
//   again, before anything the workflow's configuration requires now: a
//   retry after an approval was revoked, or a version published, is still
//   the start that was admitted.
// - Probing through code: an App, agent or trigger is checked against its
//   own grant before anything is read of the workflow, and every refusal
//   it gets is `workflow.start_denied`, so it can't learn which workflows
//   or versions exist.
// - A trigger acting for someone who lost access: its principal must still
//   have a role in the workflow when each start is admitted.
// - Input the workflow doesn't accept: checked against the version's
//   contract by the SDK's validator, within the operation input limit;
//   refusals name paths, never values.
// - A parameter edit racing a start: a start freezes the values of the
//   revision in force as it is decided, and the admitting statement
//   requires that revision still in force; an edit in between refuses it.
// - A binding unapproved, approved for another contract, or approved for
//   another version: a start freezes, for each catalog binding of its
//   version, the active approval an admin gave for that exact version and
//   declaration, and its target; the admitting statement requires each
//   approval and the permission it names still active
//   (`workflow.binding_unapproved` when there is none, or its target can't
//   serve it now, workflow-bindings.ts's own answer). A version a
//   builder published after the review, or one before it, is code nobody
//   reviewed for that target, and serves nothing until approved itself.
// - A binding to another workflow it may not start, or that is gone: the
//   admitting statement requires the bound workflow live and an active
//   `start` grant of this workflow's own on it.
// - A frozen snapshot changed later: a receipt, with its frozen params and
//   bindings and their hashes, is a row written once; the database refuses
//   any change of it but retention removing its input and values, and any
//   deletion. Its audit event names the bindings' hash, never a
//   parameter's value nor a hash of the values, which a guess at a short
//   sensitive one could be checked against.

/** Who starts a workflow: what the host established, never the caller. */
export type StartInvoker =
  | { type: "person"; person: Acting }
  | { type: "app"; authority: Authority }
  | { type: "agent"; authority: Authority; context?: WorkContext }
  | { type: "trigger"; triggerId: string };

/**
 * A new start the host decided on: what it freezes, and what admitting it
 * requires to still hold.
 */
export interface StartAuthorization {
  workflowId: string;
  version: number;
  manifestHash: string;
  invoker: WorkflowStart["invoker"];
  originAppVersion: number | null;
  triggerVersion: number | null;
  principal: string;
  generation: number;
  /** The invoker's idempotency key. */
  key: string;
  /** The validated input (canonical JSON), and its SHA-256. */
  input: string;
  inputHash: string;
  /** The parameter values it froze (canonical JSON), and their revision. */
  params: string;
  paramsRevision: number;
  /** The bindings it froze (canonical JSON). */
  bindings: string;
  /**
   * The executable identity of the version's build, which the start's run
   * is admitted for; null for a version without one: no run is admitted.
   */
  buildHash: string | null;
  /** For the audit log: who started it. */
  actor: AuditActor;
  /**
   * That it still holds, as SQL, read as the admitting statement runs: of
   * a fixed size whatever the version binds, as `required` holds the
   * approvals, permissions and workflows its bindings need as one value.
   */
  holds: SQL;
}

/**
 * What deciding a start answers: the start already admitted under the
 * invoker's key, or a new one to admit.
 */
export type StartDecision =
  | { start: WorkflowStart }
  | { authorization: StartAuthorization };

const denied = () => workflowResourceErrors.create("workflow.start_denied");

/**
 * Audits a start of workflow `workflowId` refused for `reason`, by
 * `actor`: what was decided (`detail`), never the input itself.
 */
const refusedStart = async (
  env: Env,
  actor: AuditActor,
  workflowId: string,
  detail: Record<string, string | number | null>,
  reason: string
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, {
      actor,
      action: "workflow.start.refused",
      target: { type: "workflow_resource", id: workflowId },
      detail: { ...detail, receipt: null, reason },
    }),
  ]);
};

/** The input descriptor stored with a version's contract. */
const contractInputSchema = z.object({ input: z.json() });

/** That `person` is an active member of the organization, as SQL. */
const activeSql = (person: string): SQL => activeMember(person);

/**
 * That `person` has a role in workflow `id` now, as SQL: an admin of the
 * organization, its owner, or someone it is shared with, as a person or
 * through a team they are in now (Better Auth's `team_members`, read in
 * this statement, never the session's list of teams). Only while they
 * are an active member.
 */
const roleSql = (person: string, id: string): SQL => sql`(${activeSql(person)}
  AND (${activeMember(person, ["admin"])}
    OR EXISTS (SELECT 1 FROM workflow_resources AS owned
      WHERE owned.id = ${id} AND owned.owner_id = ${person})
    OR EXISTS (SELECT 1 FROM workflow_resource_members AS shared
      WHERE shared.workflow_resource_id = ${id}
        AND shared.member_type = 'person' AND shared.member_id = ${person})
    OR EXISTS (SELECT 1 FROM workflow_resource_members AS shared
      JOIN teams ON teams.id = shared.member_id
        AND teams.organization_id = ${organizationId}
      JOIN team_members ON team_members.team_id = shared.member_id
        AND team_members.user_id = ${person}
      WHERE shared.workflow_resource_id = ${id}
        AND shared.member_type = 'team')))`;

/**
 * That `person` has a role in App `app` now, as SQL: an admin of the
 * organization, its owner, or someone it is shared with, as a person or
 * through a team they are in now. Only while they are an active member.
 */
const appRoleSql = (
  person: string,
  app: string
): SQL => sql`(${activeSql(person)}
  AND (${activeMember(person, ["admin"])}
    OR EXISTS (SELECT 1 FROM apps AS owned
      WHERE owned.id = ${app} AND owned.owner_id = ${person})
    OR EXISTS (SELECT 1 FROM app_members AS shared
      WHERE shared.app_id = ${app}
        AND shared.member_type = 'person' AND shared.member_id = ${person})
    OR EXISTS (SELECT 1 FROM app_members AS shared
      JOIN teams ON teams.id = shared.member_id
        AND teams.organization_id = ${organizationId}
      JOIN team_members ON team_members.team_id = shared.member_id
        AND team_members.user_id = ${person}
      WHERE shared.app_id = ${app} AND shared.member_type = 'team')))`;

/** That a permission allowing `start` on `id` for the invoker holds, as SQL. */
const grantSql = (allowing: SQL): SQL =>
  sql`EXISTS (SELECT 1 FROM ${permissions} WHERE ${allowing})`;

/**
 * The live workflow `id` at `version`, its policy generation and the
 * version's manifest and input descriptor. A workflow that isn't live is
 * `workflow.resource_unavailable`; a version it never published
 * `workflow.version_not_found`.
 */
const pinned = async (
  env: Env,
  id: string,
  version: number
): Promise<{
  generation: number;
  configRevision: number;
  manifestHash: string;
  inputDescriptor: string;
  /** The executable identity of its build; null when it has none. */
  buildHash: string | null;
}> => {
  const row = await drizzle(env.DB)
    .select({
      generation: workflowResources.policyGeneration,
      configRevision: workflowResources.configRevision,
      manifestHash: workflowResourceVersions.manifestHash,
      contract: workflowResourceVersions.contract,
      manifest: workflowResourceVersions.manifest,
    })
    .from(workflowResources)
    .leftJoin(
      workflowResourceVersions,
      and(
        eq(workflowResourceVersions.workflowResourceId, workflowResources.id),
        eq(workflowResourceVersions.version, version)
      )
    )
    .where(
      and(eq(workflowResources.id, id), isNull(workflowResources.deletedAt))
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.resource_unavailable");
  }
  if (
    row.manifestHash === null ||
    row.contract === null ||
    row.manifest === null
  ) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  const { input } = contractInputSchema.parse(JSON.parse(row.contract));
  // Read from the manifest the admitting statement pins by its hash: the
  // run is admitted for the build that manifest seals.
  let build: SealedBuild;
  try {
    build = buildOf(row.manifest);
  } catch {
    throw workflowResourceErrors.create("workflow.version_corrupt");
  }
  return {
    generation: row.generation,
    configRevision: row.configRevision,
    manifestHash: row.manifestHash,
    inputDescriptor: JSON.stringify(input),
    buildHash: build.executable ? build.hash : null,
  };
};

/**
 * What a start's bindings need to still hold as it is admitted: the
 * approvals serving its catalog bindings, the permissions of the workflow
 * they and its workflow bindings use, and the workflows it binds.
 */
interface Required {
  approvals: string[];
  permissions: string[];
  workflows: string[];
}

/**
 * That everything `required` (JSON text of `Required`) names still holds
 * for version `version` of workflow `id`, as SQL: each approval active,
 * given for this version; each permission active and the workflow's own;
 * each bound workflow live. One bound value, read with `json_each`, so the
 * statement stays within D1's bound parameters however many bindings a
 * version declares.
 */
const requiredSql = (id: string, version: number, required: string): SQL =>
  sql`(NOT EXISTS (SELECT 1 FROM json_each(${required}, '$.approvals') AS needed
      WHERE NOT EXISTS (SELECT 1 FROM workflow_binding_approvals AS approval
        WHERE approval.id = needed.value AND approval.workflow_resource_id = ${id}
          AND approval.reviewed_version = ${version} AND approval.status = 'active'))
    AND NOT EXISTS (SELECT 1 FROM json_each(${required}, '$.permissions') AS needed
      WHERE NOT EXISTS (SELECT 1 FROM permissions AS held
        WHERE held.id = needed.value AND held.status = 'active'
          AND held.subject_type = 'workflow' AND held.subject_id = ${id}))
    AND NOT EXISTS (SELECT 1 FROM json_each(${required}, '$.workflows') AS needed
      WHERE NOT EXISTS (SELECT 1 FROM workflow_resources AS bound
        WHERE bound.id = needed.value AND bound.deleted_at IS NULL)))`;

/**
 * The bindings version `version` of workflow `id` declares, as a start
 * freezes them: each other workflow's exact version, with the permission
 * of this workflow's own that lets it start it (`workflow.start_denied`
 * without one); and for each catalog binding the active approval given
 * for this version's exact declaration and its target
 * (`workflow.binding_unapproved` naming the alias when there is none), as
 * canonical JSON; and what of them must still hold as it is admitted.
 */
const frozenBindings = async (
  env: Env,
  id: string,
  version: number
): Promise<{ text: string; required: Required }> => {
  const versions = await bindingsOf(env, id);
  const declared = versions.get(version) ?? [];
  const frozen: Record<string, unknown>[] = [];
  const required: Required = { approvals: [], permissions: [], workflows: [] };
  for (const binding of declared) {
    if (binding.resourceId !== null) {
      // This workflow's own grant to start it, never its builders'.
      // oxlint-disable-next-line no-await-in-loop -- one point lookup per binding
      const grant = await drizzle(env.DB)
        .select({ id: permissions.id })
        .from(permissions)
        .where(
          allowingPermissionSql(
            {
              type: "workflow",
              workflowId: workflowResourceIdSchema.parse(id),
            },
            undefined,
            {
              type: "workflow",
              workflowId: workflowResourceIdSchema.parse(binding.resourceId),
            },
            "start"
          )
        )
        .get();
      if (grant === undefined) {
        throw denied();
      }
      frozen.push({ ...binding });
      required.permissions.push(grant.id);
      required.workflows.push(binding.resourceId);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one point lookup per binding
    const approval = await approvalServing(env, id, version, binding);
    if (approval === undefined) {
      throw workflowResourceErrors.create("workflow.binding_unapproved", {
        issues: [`${binding.alias}: No approval serves its contract.`],
      });
    }
    // The approved target can still serve it now, as it could when it was
    // approved: the same answer, so no approval outlives its target.
    try {
      // oxlint-disable-next-line no-await-in-loop -- one target per binding
      await requireTargetServes(env, id, binding, approval.target);
    } catch (error) {
      if (isExpectedError(error)) {
        throw workflowResourceErrors.create("workflow.binding_unapproved", {
          issues: [`${binding.alias}: Its approved target can't serve it now.`],
        });
      }
      throw error;
    }
    frozen.push({ ...binding, approval: approval.id, target: approval.target });
    required.approvals.push(approval.id);
    if ("permissionId" in approval.target) {
      required.permissions.push(approval.target.permissionId);
    }
  }
  frozen.sort((a, b) => (String(a.alias) < String(b.alias) ? -1 : 1));
  return { text: canonicalJson(z.json().parse(frozen)), required };
};

/** The trigger `id`'s current version, if it is live and enabled. */
const liveTrigger = async (env: Env, id: string) =>
  await drizzle(env.DB)
    .select({
      version: triggerResources.currentVersion,
      workflowId: triggerResourceVersions.workflowResourceId,
      workflowVersion: triggerResourceVersions.workflowResourceVersion,
      principal: triggerResourceVersions.principalBinding,
    })
    .from(triggerResources)
    .innerJoin(
      triggerResourceVersions,
      and(
        eq(triggerResourceVersions.triggerId, triggerResources.id),
        eq(triggerResourceVersions.version, triggerResources.currentVersion)
      )
    )
    .where(
      and(
        eq(triggerResources.id, id),
        isNull(triggerResources.deletedAt),
        eq(triggerResources.enabled, true)
      )
    )
    .get();

/** What an invoker contributes to an authorization: who, for whom, and its rule. */
interface InvokerRule {
  invoker: WorkflowStart["invoker"];
  originAppVersion: number | null;
  triggerVersion: number | null;
  principal: string;
  actor: AuditActor;
  holds: SQL;
}

const ruleOf = async (
  env: Env,
  invoker: StartInvoker,
  id: string,
  version: number
): Promise<InvokerRule> => {
  // An ID no workflow could have: unavailable to a person, as for one that
  // doesn't exist; to code, `start_denied`, as for anything it may not start.
  const workflowId = workflowResourceIdSchema.safeParse(id);
  if (!workflowId.success) {
    throw invoker.type === "person"
      ? workflowResourceErrors.create("workflow.resource_unavailable")
      : denied();
  }
  const object = { type: "workflow", workflowId: workflowId.data } as const;
  switch (invoker.type) {
    case "person": {
      // A role now, as `get` decides it, before anything says more.
      await requireWorkflowRole(env, invoker.person, id, "user");
      const person = invoker.person.userId;
      return {
        invoker: { type: "person", id: person },
        originAppVersion: null,
        triggerVersion: null,
        principal: person,
        actor: invoker.person.actor ?? actorOf(invoker.person),
        holds: roleSql(person, id),
      };
    }
    case "app": {
      const { subject, appVersion, onBehalfOf } = invoker.authority;
      if (subject.type !== "app" || appVersion === undefined) {
        throw denied();
      }
      return {
        invoker: { type: "app", id: subject.appId },
        originAppVersion: appVersion,
        triggerVersion: null,
        principal: onBehalfOf,
        actor: delegateActorOf(invoker.authority),
        // The App's own grant, from a version the App has (one no admin
        // approved changes nothing) whose release isn't revoked, for
        // someone who may use the App now.
        holds: sql`(${appRoleSql(onBehalfOf, subject.appId)}
          AND EXISTS (SELECT 1 FROM app_versions AS code
            WHERE code.app_id = ${subject.appId} AND code.version = ${appVersion})
          AND NOT EXISTS (SELECT 1 FROM sdk_release_manifests AS sealed
            WHERE sealed.app_id = ${subject.appId} AND sealed.version = ${appVersion}
              AND sealed.revoked_at IS NOT NULL)
          AND ${grantSql(
            allowingPermissionSql(subject, appVersion, object, "start")
          )})`,
      };
    }
    case "agent": {
      const { subject, onBehalfOf } = invoker.authority;
      if (subject.type !== "agent") {
        throw denied();
      }
      return {
        invoker: { type: "agent", id: subject.agentId },
        originAppVersion: null,
        triggerVersion: null,
        principal: onBehalfOf,
        actor: delegateActorOf(invoker.authority),
        holds: sql`(${roleSql(onBehalfOf, id)} AND ${grantSql(
          allowingPermissionSql(subject, undefined, object, "start", true, {
            context: invoker.context,
            onBehalfOf,
          })
        )})`,
      };
    }
    case "trigger": {
      const trigger = await liveTrigger(env, invoker.triggerId);
      // Only the exact version it pins: a trigger never starts another.
      if (
        trigger === undefined ||
        trigger.workflowId !== id ||
        trigger.workflowVersion !== version
      ) {
        throw workflowResourceErrors.create("workflow.trigger_unavailable");
      }
      const subject = {
        type: "trigger",
        triggerId: triggerIdSchema.parse(invoker.triggerId),
      } as const;
      return {
        invoker: { type: "trigger", id: invoker.triggerId },
        originAppVersion: null,
        triggerVersion: trigger.version,
        principal: trigger.principal,
        actor: { type: "system" },
        // Its principal must still have a role in the workflow: a trigger
        // never acts for someone the workflow is no longer shared with.
        holds: sql`(${roleSql(trigger.principal, id)}
          AND EXISTS (SELECT 1 FROM trigger_resources AS live
            JOIN trigger_resource_versions AS current
              ON current.trigger_id = live.id AND current.version = live.current_version
            WHERE live.id = ${invoker.triggerId} AND live.deleted_at IS NULL
              AND live.enabled = 1 AND current.version = ${trigger.version}
              AND current.workflow_resource_id = ${id}
              AND current.workflow_resource_version = ${version}
              AND current.principal_binding = ${trigger.principal})
          AND ${grantSql(
            allowingPermissionSql(subject, undefined, object, "start")
          )})`,
      };
    }
    default: {
      return invoker satisfies never;
    }
  }
};

/**
 * `input` as the version's contract takes it, normalized, as canonical
 * JSON: `workflow.start_invalid` with its issues (paths, never values)
 * otherwise, or when it is over the operation input limit.
 */
const acceptedInput = (descriptor: string, input: unknown): string => {
  const schema = schemaFromDescriptor(descriptor);
  const checked = schema["~standard"].validate(input);
  if ("then" in checked) {
    throw new Error("A workflow's input schema validated asynchronously");
  }
  if (checked.issues !== undefined) {
    throw workflowResourceErrors.create("workflow.start_invalid", {
      issues: issuesOf({
        issues: checked.issues.map(({ path, message }) => ({
          path: (path ?? []).map(String),
          message,
        })),
      }),
    });
  }
  const parsed = z.json().safeParse(checked.value);
  if (!parsed.success) {
    throw workflowResourceErrors.create("workflow.start_invalid");
  }
  const text = canonicalJson(parsed.data);
  if (
    new TextEncoder().encode(text).byteLength >
    platformLimits.operationInputBytes
  ) {
    throw workflowResourceErrors.create("workflow.start_invalid", {
      issues: ["input: Too large for a start."],
    });
  }
  return text;
};

const startOf = (
  row: typeof workflowStartReceipts.$inferSelect
): WorkflowStart => ({
  id: row.id,
  workflowId: row.workflowResourceId,
  version: row.workflowResourceVersion,
  manifestHash: row.manifestHash,
  invoker: { type: row.invokerType, id: row.invokerId },
  principal: row.principalId,
  authorityGeneration: row.authorityGeneration,
  inputHash: row.inputHash,
  paramsRevision: row.paramsRevision,
  bindingsHash: row.bindingsHash,
  // Read with the run's own row, by `startWorkflow`.
  runId: null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * The receipt of `invoker`'s start for `principal` under `key`, if there
 * is one: keys are an invoker's for each person it acts for, so one person
 * never gets another's start through the same App, agent or trigger.
 */
export const receiptOf = async (
  env: Env,
  invoker: WorkflowStart["invoker"],
  principal: string,
  key: string
) =>
  await drizzle(env.DB)
    .select()
    .from(workflowStartReceipts)
    .where(
      and(
        eq(workflowStartReceipts.invokerType, invoker.type),
        eq(workflowStartReceipts.invokerId, invoker.id),
        eq(workflowStartReceipts.principalId, principal),
        eq(workflowStartReceipts.idempotencyKey, key)
      )
    )
    .get();

/** The same start as `row`, or `workflow.start_conflict`. */
const sameStart = (
  row: typeof workflowStartReceipts.$inferSelect,
  start: {
    workflowId: string;
    version: number;
    principal: string;
    originAppVersion: number | null;
    triggerVersion: number | null;
  },
  inputHash: string
): WorkflowStart => {
  if (
    row.workflowResourceId !== start.workflowId ||
    row.workflowResourceVersion !== start.version ||
    row.principalId !== start.principal ||
    row.originAppVersion !== start.originAppVersion ||
    row.triggerVersion !== start.triggerVersion ||
    row.inputHash !== inputHash
  ) {
    throw workflowResourceErrors.create("workflow.start_conflict");
  }
  return startOf(row);
};

/**
 * Decides on `request` (`workflowStartSchema`: the exact version, the
 * input and the invoker's idempotency key) to start workflow `id` for
 * `invoker` (see the rules above). The invoker's own access is checked
 * first, every time; then the version and the input; then a start already
 * admitted under the key is answered as it was (`workflow.start_conflict`
 * if the key was used for another); only a new start freezes the
 * workflow's parameters and bindings and needs them to hold now.
 *
 * Refused with `workflow.resource_unavailable` (a person with no role, as
 * for a workflow that doesn't exist), `workflow.version_not_found`,
 * `workflow.start_invalid`, `workflow.trigger_unavailable`,
 * `workflow.binding_unapproved`, `workflow.params_invalid` or
 * `workflow.start_denied`. A new start is admitted only while it still
 * holds (`admitWorkflowStart`).
 */
export const decideWorkflowStart = async (
  env: Env,
  invoker: StartInvoker,
  id: unknown,
  request: unknown
): Promise<StartDecision> => {
  const { version, input, key } = workflowResourceErrors.parse(
    "workflow.start_invalid",
    workflowStartSchema,
    request
  );
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw workflowResourceErrors.create("workflow.resource_unavailable");
  }
  // A key a person or an agent chose never takes one core derives.
  if (
    (invoker.type === "person" || invoker.type === "agent") &&
    key.startsWith(coreStartKeyPrefix)
  ) {
    throw workflowResourceErrors.create("workflow.start_invalid", {
      issues: [`key: Keys beginning with "${coreStartKeyPrefix}" are core's.`],
    });
  }
  const rule = await ruleOf(env, invoker, id, version);
  if (invoker.type !== "person") {
    // Code and triggers learn nothing of a workflow they may not start:
    // their own rule first, and then any refusal is `start_denied`.
    const allowed = await drizzle(env.DB).get<{ holds: number }>(
      sql`SELECT ${rule.holds} AS holds`
    );
    if (allowed.holds === 0) {
      throw denied();
    }
  }
  let found: Awaited<ReturnType<typeof pinned>>;
  try {
    found = await pinned(env, id, version);
  } catch (error) {
    if (invoker.type !== "person" && isExpectedError(error)) {
      throw denied();
    }
    throw error;
  }
  const {
    generation,
    configRevision,
    manifestHash,
    inputDescriptor,
    buildHash,
  } = found;
  const base = {
    version,
    manifestHash,
    invokerType: rule.invoker.type,
    invoker: rule.invoker.id,
    principal: rule.principal,
    generation,
  };
  let text: string;
  try {
    text = acceptedInput(inputDescriptor, input);
  } catch (error) {
    await refusedStart(
      env,
      rule.actor,
      id,
      { ...base, inputHash: null },
      "workflow.start_invalid"
    );
    throw error;
  }
  const inputHash = await sha256Hex(text);
  if (invoker.type === "person") {
    // Their access as it is now, before even a start already admitted is
    // answered: the role check above goes by the session's teams, which
    // may still list one they left.
    const live = await drizzle(env.DB).get<{ holds: number }>(
      sql`SELECT ${rule.holds} AS holds`
    );
    if (live.holds === 0) {
      await refusedStart(
        env,
        rule.actor,
        id,
        { ...base, inputHash },
        "workflow.start_denied"
      );
      throw denied();
    }
  }
  const existing = await receiptOf(env, rule.invoker, rule.principal, key);
  if (existing !== undefined) {
    try {
      return {
        start: sameStart(
          existing,
          { workflowId: id, version, ...rule },
          inputHash
        ),
      };
    } catch (error) {
      await refusedStart(
        env,
        rule.actor,
        id,
        { ...base, inputHash },
        "workflow.start_conflict"
      );
      throw error;
    }
  }
  // Frozen now, from what was read above: the parameter values of the
  // revision in force, and what serves each binding.
  const params = await frozenParams(env, id, version, configRevision);
  const bindings = await frozenBindings(env, id, version);
  // Read again as the admitting statement runs: the workflow live at the
  // same policy generation and parameter revision, the same version and
  // manifest, everything its bindings need, and the invoker's own rule.
  const holds = sql`(EXISTS (SELECT 1 FROM workflow_resources AS live
      WHERE live.id = ${id} AND live.deleted_at IS NULL
        AND live.policy_generation = ${generation}
        AND live.config_revision = ${configRevision})
    AND EXISTS (SELECT 1 FROM workflow_resource_versions AS pinned
      WHERE pinned.workflow_resource_id = ${id} AND pinned.version = ${version}
        AND pinned.manifest_hash = ${manifestHash})
    AND ${requiredSql(id, version, JSON.stringify(bindings.required))}
    AND ${rule.holds})`;
  const decided = await drizzle(env.DB).get<{ holds: number }>(
    sql`SELECT ${holds} AS holds`
  );
  if (decided.holds === 0) {
    throw denied();
  }
  return {
    authorization: {
      workflowId: id,
      version,
      manifestHash,
      invoker: rule.invoker,
      originAppVersion: rule.originAppVersion,
      triggerVersion: rule.triggerVersion,
      principal: rule.principal,
      generation,
      key,
      input: text,
      inputHash,
      params,
      paramsRevision: configRevision,
      bindings: bindings.text,
      buildHash,
      actor: rule.actor,
      holds,
    },
  };
};

/**
 * That the person a start acts for has fewer than
 * `maxLiveRunsPerPrincipal` runs of the workflow that haven't ended, as
 * SQL, for a start that admits a run (its version is executable). Until
 * lineage quotas hold these runs (GRA-567), it bounds what one person's
 * starts make core spend at once.
 */
const underRunLimit = (authorization: StartAuthorization): SQL =>
  authorization.buildHash === null
    ? sql`1`
    : sql`((SELECT COUNT(*) FROM workflow_resource_runs AS live
        WHERE live.workflow_resource_id = ${authorization.workflowId}
          AND live.principal_id = ${authorization.principal}
          AND live.status IN ('starting', 'running')) < ${maxLiveRunsPerPrincipal})`;

/**
 * Admits the new start `authorization` decided on: its receipt, written in
 * one statement only while the authorization, and `also` (what its caller
 * requires besides, as SQL), still hold, with its audit event. A start
 * whose authority changed since is refused (`workflow.start_denied`) and
 * the refusal audited; the same key admitted meanwhile answers that start.
 */
export const admitWorkflowStart = async (
  env: Env,
  authorization: StartAuthorization,
  also: SQL = sql`1`,
  /** What else its audit events name (the agent that had it made, say). */
  noted: Readonly<Record<string, string>> = {}
): Promise<WorkflowStart> => {
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const bindingsHash = await sha256Hex(authorization.bindings);
  const db = drizzle(env.DB);
  const values = [
    id,
    authorization.invoker.type,
    authorization.invoker.id,
    authorization.key,
    authorization.workflowId,
    authorization.version,
    authorization.manifestHash,
    authorization.originAppVersion,
    authorization.triggerVersion,
    authorization.principal,
    authorization.generation,
    authorization.input,
    authorization.inputHash,
    authorization.params,
    authorization.paramsRevision,
    authorization.bindings,
    bindingsHash,
    createdAt.getTime(),
    null,
  ].map((value) => (value === null ? sql`NULL` : sql`${value}`));
  const detail = {
    ...noted,
    receipt: id,
    version: authorization.version,
    manifestHash: authorization.manifestHash,
    invokerType: authorization.invoker.type,
    invoker: authorization.invoker.id,
    originAppVersion: authorization.originAppVersion,
    principal: authorization.principal,
    generation: authorization.generation,
    inputHash: authorization.inputHash,
    // The revision of the frozen values, never the values nor a hash of
    // them: a sensitive one stays out.
    paramsRevision: authorization.paramsRevision,
    bindingsHash,
  };
  // Why it wasn't admitted, if it isn't: read in the admitting batch, just
  // before its insert, so the reason is the state it was refused in.
  let refusedFor: { under: number } | undefined;
  try {
    const [[state]] = await auditedBatch(env, db, [
      db
        .select({ under: sql<number>`${underRunLimit(authorization)}` })
        .from(sql`(SELECT 1)`),
      db
        .insert(workflowStartReceipts)
        .select(
          sql`SELECT ${sql.join(values, sql`, `)} WHERE ${authorization.holds} AND ${also} AND ${underRunLimit(authorization)}`
        ),
      // Its run, pinned to the version's build, with the receipt or not at
      // all (resource-runs.ts): the engine is sent it once this commits.
      ...(authorization.buildHash === null
        ? []
        : [
            runAdmitted(db, {
              receipt: id,
              workflowId: authorization.workflowId,
              version: authorization.version,
              manifestHash: authorization.manifestHash,
              buildHash: authorization.buildHash,
              principal: authorization.principal,
              createdAt: createdAt.getTime(),
            }),
          ]),
      // Only once the receipt is written, read as such: never inferred from
      // the statement just before it, whichever that is.
      outboxedWhere(
        db,
        {
          actor: authorization.actor,
          action: "workflow.start.admitted",
          target: { type: "workflow_resource", id: authorization.workflowId },
          detail,
        },
        sql`EXISTS (SELECT 1 FROM ${workflowStartReceipts} WHERE ${workflowStartReceipts.id} = ${id})`
      ),
    ]);
    refusedFor = state;
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    // The same key, admitted as this ran.
  }
  const admitted = await receiptOf(
    env,
    authorization.invoker,
    authorization.principal,
    authorization.key
  );
  if (admitted !== undefined) {
    try {
      return sameStart(admitted, authorization, authorization.inputHash);
    } catch (error) {
      await refusedStart(
        env,
        authorization.actor,
        authorization.workflowId,
        detail,
        "workflow.start_conflict"
      );
      throw error;
    }
  }
  // Refused by the cap on live runs, or by authority that changed: said
  // as which, as the admitting batch found it.
  const limited = refusedFor?.under === 0;
  const reason = limited ? "workflow.run_limit" : "workflow.start_denied";
  await refusedStart(
    env,
    authorization.actor,
    authorization.workflowId,
    detail,
    reason
  );
  throw limited
    ? workflowResourceErrors.create("workflow.run_limit", {
        limit: maxLiveRunsPerPrincipal,
      })
    : denied();
};

/**
 * Starts workflow `id` for `invoker` with `request`: decided, then, for a
 * new start, admitted while `also` holds too.
 */
export const startWorkflow = async (
  env: Env,
  invoker: StartInvoker,
  id: unknown,
  request: unknown,
  also?: SQL,
  noted?: Readonly<Record<string, string>>
): Promise<WorkflowStart> => {
  const decision = await decideWorkflowStart(env, invoker, id, request);
  const start =
    "start" in decision
      ? decision.start
      : await admitWorkflowStart(env, decision.authorization, also, noted);
  // Its run, sent to the engine while it is still starting: a start sent
  // again finishes one core stopped in the middle of (resource-runs.ts).
  return { ...start, runId: await startResourceRun(env, start.id) };
};
