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
  workflowResourceErrors,
  workflowStartSchema,
} from "@grasp-os/shared/workflow-resources";
import type { WorkflowStart } from "@grasp-os/shared/workflow-resources";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
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
import { requireWorkflowRole } from "./workflow-resources.ts";

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
//   through the same App, agent or trigger.
// - Probing through code: an App, agent or trigger is checked against its
//   own grant before anything is read of the workflow, and every refusal
//   it gets is `workflow.start_denied`, so it can't learn which workflows
//   or versions exist.
// - A trigger acting for someone who lost access: its principal must still
//   have a role in the workflow when each start is admitted.
// - Input the workflow doesn't accept: checked against the version's
//   contract by the SDK's validator, within the operation input limit;
//   refusals name paths, never values.

/** Who starts a workflow: what the host established, never the caller. */
export type StartInvoker =
  | { type: "person"; person: Acting }
  | { type: "app"; authority: Authority }
  | { type: "agent"; authority: Authority; context?: WorkContext }
  | { type: "trigger"; triggerId: string };

/** A start the host decided on: what admitting it requires to still hold. */
export interface StartAuthorization {
  workflowId: string;
  version: number;
  manifestHash: string;
  /** The version's input descriptor, as JSON text. */
  inputDescriptor: string;
  invoker: WorkflowStart["invoker"];
  originAppVersion: number | null;
  triggerVersion: number | null;
  principal: string;
  generation: number;
  /** For the audit log: who started it. */
  actor: AuditActor;
  /** That it still holds, as SQL, read as the admitting statement runs. */
  holds: SQL;
}

const denied = () => workflowResourceErrors.create("workflow.start_denied");

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
  manifestHash: string;
  inputDescriptor: string;
}> => {
  const row = await drizzle(env.DB)
    .select({
      generation: workflowResources.policyGeneration,
      manifestHash: workflowResourceVersions.manifestHash,
      contract: workflowResourceVersions.contract,
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
  if (row.manifestHash === null || row.contract === null) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  const { input } = contractInputSchema.parse(JSON.parse(row.contract));
  return {
    generation: row.generation,
    manifestHash: row.manifestHash,
    inputDescriptor: JSON.stringify(input),
  };
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
        // approved changes nothing), for someone who may use the App now.
        holds: sql`(${appRoleSql(onBehalfOf, subject.appId)}
          AND EXISTS (SELECT 1 FROM app_versions AS code
            WHERE code.app_id = ${subject.appId} AND code.version = ${appVersion})
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
 * Decides whether `invoker` may start version `version` of workflow `id`
 * (see the rules above): refused with `workflow.resource_unavailable`
 * (a person with no role, as for a workflow that doesn't exist),
 * `workflow.version_not_found`, `workflow.trigger_unavailable` or
 * `workflow.start_denied`. What it answers is admitted only while it
 * still holds (`admitWorkflowStart`).
 */
export const authorizeWorkflowStart = async (
  env: Env,
  invoker: StartInvoker,
  id: unknown,
  version: unknown
): Promise<StartAuthorization> => {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw workflowResourceErrors.create("workflow.resource_unavailable");
  }
  // A publication number, never an alias such as "latest".
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw workflowResourceErrors.create("workflow.start_invalid", {
      issues: ["version: Name an exact published version."],
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
  const { generation, manifestHash, inputDescriptor } = found;
  // Read again as the admitting statement runs: the workflow live at the
  // same policy generation, the same version and manifest, and the
  // invoker's own rule.
  const holds = sql`(EXISTS (SELECT 1 FROM workflow_resources AS live
      WHERE live.id = ${id} AND live.deleted_at IS NULL
        AND live.policy_generation = ${generation})
    AND EXISTS (SELECT 1 FROM workflow_resource_versions AS pinned
      WHERE pinned.workflow_resource_id = ${id} AND pinned.version = ${version}
        AND pinned.manifest_hash = ${manifestHash})
    AND ${rule.holds})`;
  const decided = await drizzle(env.DB).get<{ holds: number }>(
    sql`SELECT ${holds} AS holds`
  );
  if (decided.holds === 0) {
    throw denied();
  }
  return {
    workflowId: id,
    version,
    manifestHash,
    inputDescriptor,
    invoker: rule.invoker,
    originAppVersion: rule.originAppVersion,
    triggerVersion: rule.triggerVersion,
    principal: rule.principal,
    generation,
    actor: rule.actor,
    holds,
  };
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
  createdAt: row.createdAt.toISOString(),
});

/**
 * The receipt of `invoker`'s start for `principal` under `key`, if there
 * is one: keys are an invoker's for each person it acts for, so one person
 * never gets another's start through the same App, agent or trigger.
 */
const receiptOf = async (
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
  authorization: StartAuthorization,
  inputHash: string
): WorkflowStart => {
  if (
    row.workflowResourceId !== authorization.workflowId ||
    row.workflowResourceVersion !== authorization.version ||
    row.principalId !== authorization.principal ||
    row.originAppVersion !== authorization.originAppVersion ||
    row.triggerVersion !== authorization.triggerVersion ||
    row.inputHash !== inputHash
  ) {
    throw workflowResourceErrors.create("workflow.start_conflict");
  }
  return startOf(row);
};

/**
 * Admits the start `authorization` decided on, with `input` and the
 * invoker's idempotency `key`: its receipt, written in one statement only
 * while the authorization still holds, with its audit event. A start
 * whose authority changed since is refused (`workflow.start_denied`) and
 * the refusal audited; the same key again answers the same start.
 */
export const admitWorkflowStart = async (
  env: Env,
  authorization: StartAuthorization,
  input: unknown,
  key: string
): Promise<WorkflowStart> => {
  const text = acceptedInput(authorization.inputDescriptor, input);
  const inputHash = await sha256Hex(text);
  const existing = await receiptOf(
    env,
    authorization.invoker,
    authorization.principal,
    key
  );
  if (existing !== undefined) {
    return sameStart(existing, authorization, inputHash);
  }
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const db = drizzle(env.DB);
  const values = [
    id,
    authorization.invoker.type,
    authorization.invoker.id,
    key,
    authorization.workflowId,
    authorization.version,
    authorization.manifestHash,
    authorization.originAppVersion,
    authorization.triggerVersion,
    authorization.principal,
    authorization.generation,
    text,
    inputHash,
    createdAt.getTime(),
  ].map((value) => (value === null ? sql`NULL` : sql`${value}`));
  const detail = {
    receipt: id,
    version: authorization.version,
    manifestHash: authorization.manifestHash,
    invokerType: authorization.invoker.type,
    invoker: authorization.invoker.id,
    principal: authorization.principal,
    generation: authorization.generation,
    inputHash,
  };
  try {
    await auditedBatch(env, db, [
      db
        .insert(workflowStartReceipts)
        .select(
          sql`SELECT ${sql.join(values, sql`, `)} WHERE ${authorization.holds}`
        ),
      outboxedIfChanged(db, {
        actor: authorization.actor,
        action: "workflow.start.admitted",
        target: { type: "workflow_resource", id: authorization.workflowId },
        detail,
      }),
    ]);
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
    key
  );
  if (admitted !== undefined) {
    return sameStart(admitted, authorization, inputHash);
  }
  await auditedBatch(env, db, [
    outboxed(db, {
      actor: authorization.actor,
      action: "workflow.start.refused",
      target: { type: "workflow_resource", id: authorization.workflowId },
      detail: { ...detail, receipt: null, reason: "workflow.start_denied" },
    }),
  ]);
  throw denied();
};

/**
 * Starts workflow `id` for `invoker` with `request` (`workflowStartSchema`:
 * the exact version, the input and the invoker's idempotency key):
 * decided, then admitted.
 */
export const startWorkflow = async (
  env: Env,
  invoker: StartInvoker,
  id: unknown,
  request: unknown
): Promise<WorkflowStart> => {
  const { version, input, key } = workflowResourceErrors.parse(
    "workflow.start_invalid",
    workflowStartSchema,
    request
  );
  const authorization = await authorizeWorkflowStart(env, invoker, id, version);
  return await admitWorkflowStart(env, authorization, input, key);
};
