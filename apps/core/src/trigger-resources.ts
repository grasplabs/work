import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { connectorEventActions } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { triggerIdSchema } from "@grasp-os/shared/ids";
import type { TriggerId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { permissionStatusSchema } from "@grasp-os/shared/permissions";
import { isAdmin, requireBuilder } from "@grasp-os/shared/roles";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import {
  connectorTriggerConfigSchema,
  emailTriggerConfigSchema,
  scheduleTriggerConfigSchema,
  webhookTriggerConfigSchema,
  workflowTriggerCreateSchema,
} from "@grasp-os/shared/workflow-triggers";
import type {
  TriggerKind,
  TriggerSource,
  TriggerSummary,
  WorkflowTrigger,
} from "@grasp-os/shared/workflow-triggers";
import {
  maxFailedStarts,
  nextScheduledRun,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  auditedBatch,
  outboxed,
  outboxedIfChanged,
  outboxedWhere,
} from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  eventSources,
  permissions,
  triggerResources,
  triggerResourceVersions,
  triggerSchedules,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { inList, isUniqueViolation, notNullFailed } from "./db/d1.ts";
import { revokedWith, triggerRequests } from "./permissions.ts";
import { requireNotStaff } from "./sharing.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";
import { acceptedInput, pinned } from "./workflow-starts.ts";
import {
  addressTaken,
  randomEmailAddress,
  requireFreeAddresses,
} from "./workflows/email-addresses.ts";
import { quotaLimits } from "./workflows/quotas.ts";

// Independent triggers (platform specification 15, 24): each a resource of
// its own that starts one exact workflow version on its own. This is their
// registry: listing, creating one, moving it to another version of its
// workflow, disabling and deleting it, each served to a signed-in person
// over `/rpc` (workflow-triggers-rpc.ts). What it may start is decided as
// for any other subject, by a permission of its own (`start` on the workflow), granted
// by an admin, and checked at every start (workflow-starts.ts).
//
// Threat model, and how each is closed:
//
// - A trigger acting as the workflow's owner. Its starts act for the
//   person bound when it was created (`principal_binding`): whoever created
//   it, never the workflow's owner, and only while they are still in the
//   organization.
// - A trigger starting a version nobody made live. Each trigger version
//   pins an exact, published workflow version. Publishing or rolling back
//   the workflow moves each of its triggers, enabled or not, onto the
//   version it makes live, as a new trigger version in the batch that
//   makes it live (`triggersMovedTo`), audited with it, so none enabled
//   later starts a version no longer live. A schedule's occurrence keeps
//   its time as it moves: a start of it tried on the version before is
//   refused, and the next clock run starts it on the version moved to. Moving a trigger by hand is a new
//   trigger version too, audited, of the same workflow only. A run keeps
//   the version it started on.
// - Creating a trigger grants it something. Nothing: its creator must
//   build the workflow, and its starts still need a permission an admin
//   grants, naming the workflow it pins. Creating it only asks for that.
// - A trigger nobody may stop: the workflow's builders, and admins, may
//   disable or delete any trigger that starts it; only its owner moves or
//   re-enables it. Only an enabled trigger holding an active `start`
//   grant keeps the workflow from being deleted.
// - A trigger acting for someone who lost access: each start requires its
//   person to still have a role in the workflow (workflow-starts.ts).
// - Learning of a trigger one may not stop: listing shows a workflow's
//   triggers to whoever may disable them (its builders, admins) and
//   anyone else only their own.
// - Triggers piling up: a person has at most the quota limits'
//   `triggerResourcesPerPerson` live triggers.
// - Disabling or deleting it under a start. Every start reads the trigger
//   live and enabled in the statement that admits it, so one admitted
//   after either never lands. Runs already started go on (spec 15.3).
// - Grasp staff deciding what starts a client's workflow: they never
//   create, change or delete a trigger.
// - A schedule trigger starting what its workflow version doesn't take:
//   its input is literal JSON, checked against the version's input schema
//   when the trigger is created and again for each version it moves to;
//   its expression and time zone are checked to name a time to come.
//   Nothing in it is evaluated. Its runs start as workflows/schedule-
//   triggers.ts says.
// - A connector trigger hearing a connection its creator may not use: the
//   connection must exist and not be disconnected as it is created, and a
//   personal one must be its creator's own, whom its runs act for. It
//   hears nothing until an admin grants it the event's read action on
//   exactly that connection (and part of it), a grant of its own beside
//   `start` (permissions.ts), which it asks for as it is created, as it
//   does `start`. Its input is a fixed mapping (JSON Pointers into the
//   event, RFC 6901) with literal defaults, never an expression.
//   Its events start runs as workflows/connector-triggers.ts says.
// - An email trigger taking mail meant for another, or mailed by anyone
//   who learned its ID: its address is the name its builder chose, as an
//   App's is, or else `trigger-` and 128 random bits of its own
//   (`randomEmailAddress`), never derived from its ID (which builders,
//   admins, staff and the audit log see), shown only to whoever may see
//   the trigger; a random one is never audited or logged. Either way it
//   is one workflow's: Apps and triggers take addresses from one
//   namespace, first come, checked in the statement that takes one
//   (workflows/email-addresses.ts).
//   A chosen name can be guessed, as an App's can: anyone may mail it,
//   and its mail is held to the same ingress as any other. It is never
//   changed: deleting the trigger gives it up, and making another is how
//   it changes. Its input is a fixed mapping as a connector trigger's is.
//   Its mail starts runs as workflows/inbound-email.ts says.
// - A webhook trigger started by an outside system nobody approved: it
//   starts on the events of one event source (event-sources.ts), which
//   only an admin creates, and of one type; the source must be live as
//   the trigger is created, and its request for `start` names both, so
//   the admin granting it knows what starts the workflow. Anyone who may
//   build may start a workflow on a source's events; nothing starts until
//   that grant. Its events start runs as workflows/source-events.ts says.

/** What a trigger version keeps of its configuration, by kind. */
interface KindFields {
  eventType: string | null;
  scheduleCron: string | null;
  scheduleTimeZone: string | null;
  scheduleInput: string | null;
  connectionId: string | null;
  connectionResource: string | null;
  inputMapping: string | null;
  eventSourceId: string | null;
}

const noKindFields: KindFields = {
  eventType: null,
  scheduleCron: null,
  scheduleTimeZone: null,
  scheduleInput: null,
  connectionId: null,
  connectionResource: null,
  inputMapping: null,
  eventSourceId: null,
};

const invalid = (issue: string) =>
  workflowResourceErrors.create("workflow.resource_invalid", {
    issues: [issue],
  });

/**
 * When the schedule `cron` in `timeZone` next starts a run after `after`:
 * a time that the spring change skips is skipped (spec 15.2).
 */
export const nextOccurrence = (
  cron: string,
  timeZone: string,
  after: Date
): Date | undefined => nextScheduledRun({ cron, timeZone }, after, "skip");

/**
 * `input` as version `version` of workflow `workflowId` takes it, as
 * canonical JSON; `workflow.resource_invalid` with the issues otherwise.
 */
const scheduleInputFor = async (
  env: Env,
  workflowId: string,
  version: number,
  input: unknown
): Promise<string> => {
  const { inputDescriptor } = await pinned(env, workflowId, version);
  try {
    return acceptedInput(inputDescriptor, input);
  } catch (error) {
    if (isExpectedError(error)) {
      throw workflowResourceErrors.create("workflow.resource_invalid", {
        issues: [`config.input: Not an input version ${version} takes.`],
      });
    }
    throw error;
  }
};

/**
 * A connector trigger's fields, from `config`, checked: its connection
 * must exist in connect and not be disconnected, and, if personal, be
 * `principal`'s own, whom its runs act for.
 */
const connectorFieldsOf = async (
  env: Env,
  config: unknown,
  principal: string
): Promise<KindFields> => {
  const { connection, event, input } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    connectorTriggerConfigSchema,
    config
  );
  const [owner] = await env.CONNECT.connectionOwners([connection.connectionId]);
  if (
    owner === undefined ||
    owner.status === "disconnected" ||
    (owner.ownerUserId !== null && owner.ownerUserId !== principal)
  ) {
    throw invalid(
      "config.connection: Not a connection you may use: it must be connected, and a personal one your own."
    );
  }
  return {
    ...noKindFields,
    eventType: event,
    connectionId: connection.connectionId,
    connectionResource: connection.resource ?? null,
    inputMapping: canonicalJson(input),
  };
};

/**
 * A webhook trigger's fields, from `config`, checked: its source must be
 * live.
 */
const webhookFieldsOf = async (
  env: Env,
  config: unknown
): Promise<KindFields> => {
  const { source, type } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    webhookTriggerConfigSchema,
    config
  );
  const live = await drizzle(env.DB)
    .select({ id: eventSources.id })
    .from(eventSources)
    .where(and(eq(eventSources.id, source), isNull(eventSources.deletedAt)))
    .get();
  if (live === undefined) {
    throw invalid("config.source: Not a source of this workspace.");
  }
  return { ...noKindFields, eventType: type, eventSourceId: live.id };
};

/**
 * What a trigger of `kind` with `config` keeps in its version, checked
 * (`workflow.resource_invalid`): a schedule trigger's schedule and input, accepted by version `version` of workflow
 * `workflowId`, a connector trigger's connection, event and mapping, for
 * `principal`, a webhook trigger's source and type; an email trigger's
 * mapping.
 */
const kindFieldsOf = async (
  env: Env,
  kind: TriggerKind,
  config: unknown,
  workflowId: string,
  version: number,
  principal: string
): Promise<KindFields> => {
  if (kind === "connector") {
    return await connectorFieldsOf(env, config, principal);
  }
  if (kind === "email") {
    const { input } = workflowResourceErrors.parse(
      "workflow.resource_invalid",
      emailTriggerConfigSchema,
      config
    );
    return { ...noKindFields, inputMapping: canonicalJson(input) };
  }
  if (kind === "webhook") {
    return await webhookFieldsOf(env, config);
  }
  if (kind !== "schedule") {
    return noKindFields;
  }
  const { schedule, input } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    scheduleTriggerConfigSchema,
    config
  );
  if (
    nextOccurrence(schedule.cron, schedule.timeZone, new Date()) === undefined
  ) {
    throw invalid(
      "config.schedule: Not five cron fields in a known time zone that name a time to come."
    );
  }
  return {
    ...noKindFields,
    scheduleCron: schedule.cron,
    scheduleTimeZone: schedule.timeZone,
    scheduleInput: await scheduleInputFor(env, workflowId, version, input),
  };
};

/**
 * The name an email trigger's builder chose for its address in `config`
 * (checked by `kindFieldsOf` already), if they chose one.
 */
const chosenAddressOf = (
  kind: TriggerKind,
  config: unknown
): string | undefined =>
  kind === "email"
    ? emailTriggerConfigSchema.safeParse(config).data?.address
    : undefined;

/** A trigger, as its registry answers it. */
export interface TriggerResource {
  id: TriggerId;
  kind: TriggerKind;
  owner: string;
  version: number;
  workflowId: string;
  workflowVersion: number;
  principal: string;
  enabled: boolean;
}

const unavailable = () =>
  workflowResourceErrors.create("workflow.trigger_unavailable");

const entry = (
  by: Acting,
  action: string,
  id: string,
  detail: AuditEntry["detail"] = {}
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action,
  target: { type: "trigger", id },
  detail,
});

/** Refuses a workflow version that wasn't published. */
const requirePublished = async (
  env: Env,
  workflowId: string,
  version: number
): Promise<void> => {
  const row = await drizzle(env.DB)
    .select({ version: workflowResourceVersions.version })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, workflowId),
        eq(workflowResourceVersions.version, version)
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
};

/**
 * Why creating a trigger (at the address `chosen`, if one was) failed with
 * `error`, as its creator is told: its address taken, over the cap, its
 * workflow gone, or `error` itself.
 */
const creationRefusal = async (
  env: Env,
  error: unknown,
  chosen: string | undefined
): Promise<unknown> => {
  // A new row's only unique column that can collide is its address.
  if (chosen !== undefined && isUniqueViolation(error)) {
    return workflowErrors.create("workflow.email_taken", { address: chosen });
  }
  if (notNullFailed(error, "trigger_resources.id")) {
    if (chosen !== undefined) {
      // Taken meanwhile answers as taken; over the cap otherwise.
      await requireFreeAddresses(env, [chosen]);
    }
    return workflowResourceErrors.create("workflow.trigger_limit");
  }
  if (notNullFailed(error, "trigger_resource_versions.workflow_resource_id")) {
    return workflowResourceErrors.create("workflow.resource_unavailable");
  }
  return error;
};

/**
 * Creates a trigger of `input.kind` that starts exactly version
 * `input.version` of workflow `input.workflowId`, acting for `by`, who must
 * build the workflow. It may start nothing until an admin grants it
 * `start` on the workflow, which it asks for as it is created, in the same
 * batch (`triggerRequests`); a connector trigger hears nothing until an
 * admin grants it its event's read on its connection, which it asks for
 * beside it. A person has at most the quota limits'
 * `triggerResourcesPerPerson` live triggers (`workflow.trigger_limit`),
 * counted in the insert; the workflow must be live as it lands.
 */
export const createTriggerResource = async (
  env: Env,
  by: Acting,
  input: unknown
): Promise<TriggerResource> => {
  requireBuilder(by);
  requireNotStaff(by);
  const { kind, workflowId, version, config } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowTriggerCreateSchema,
    input
  );
  const workflow = await requireWorkflowRole(env, by, workflowId, "builder");
  await requirePublished(env, workflow.id, version);
  const fields = await kindFieldsOf(
    env,
    kind,
    config,
    workflow.id,
    version,
    by.userId
  );
  const chosen = chosenAddressOf(kind, config);
  if (chosen !== undefined) {
    await requireFreeAddresses(env, [chosen]);
  }
  const id = triggerIdSchema.parse(crypto.randomUUID());
  const configHash = await sha256Hex(canonicalJson(config));
  const cap = quotaLimits(env).triggerResourcesPerPerson;
  const now = new Date();
  const db = drizzle(env.DB);
  const asked = triggerRequests(
    by,
    id,
    workflow.id,
    fields.connectionId === null || fields.eventType === null
      ? undefined
      : {
          connection: {
            connectionId: fields.connectionId,
            ...(fields.connectionResource === null
              ? {}
              : { resource: fields.connectionResource }),
          },
          event: fields.eventType,
        }
  );
  const batch = auditedBatch(env, db, [
    db.insert(triggerResources).values({
      // Only while `by` is under the cap, counted in this statement, and
      // a chosen address is still free, an App's or a trigger's
      // (email-addresses.ts): otherwise NULL, which fails the batch. The
      // address's unique index is a backstop.
      id: sql`(SELECT ${id} WHERE (SELECT COUNT(*) FROM trigger_resources
        WHERE owner_id = ${by.userId} AND deleted_at IS NULL) < ${cap}
        ${chosen === undefined ? sql`` : sql`AND NOT ${addressTaken([chosen])}`})`,
      ownerId: by.userId,
      kind,
      currentVersion: 1,
      enabled: true,
      createdAt: now,
      emailAddress: kind === "email" ? (chosen ?? randomEmailAddress()) : null,
    }),
    db.insert(triggerResourceVersions).values({
      triggerId: id,
      version: 1,
      // Only while the workflow is live: otherwise NULL, which fails the
      // batch, so a deletion and a new trigger never both land.
      workflowResourceId: sql`(SELECT id FROM workflow_resources
        WHERE id = ${workflow.id} AND deleted_at IS NULL)`,
      workflowResourceVersion: version,
      configHash,
      principalBinding: by.userId,
      createdAt: now,
      ...fields,
    }),
    // A schedule trigger's first occurrence: the next after now.
    ...(fields.scheduleCron === null || fields.scheduleTimeZone === null
      ? []
      : [
          db.insert(triggerSchedules).values({
            triggerId: id,
            version: 1,
            nextAt:
              nextOccurrence(
                fields.scheduleCron,
                fields.scheduleTimeZone,
                now
              ) ?? null,
            failedStarts: 0,
          }),
        ]),
    outboxed(
      db,
      entry(by, "trigger.created", id, {
        kind,
        workflowId: workflow.id,
        workflowVersion: version,
        configHash,
        // A name chosen is no secret, as an App's address isn't; a random
        // address is never audited.
        ...(chosen === undefined ? {} : { address: chosen }),
      })
    ),
    // Asked for as it lands, so the trigger never waits on a request
    // nobody made: an admin sees them with the others.
    ...asked.rows.map((row) => db.insert(permissions).values(row)),
    ...asked.entries.map((each) => outboxed(db, each)),
  ]);
  try {
    await batch;
  } catch (error) {
    throw await creationRefusal(env, error, chosen);
  }
  return {
    id,
    kind,
    owner: by.userId,
    version: 1,
    workflowId: workflow.id,
    workflowVersion: version,
    principal: by.userId,
    enabled: true,
  };
};

/**
 * The live trigger `id`, if `by` may act on it as `as` says, never Grasp
 * staff: to `manage` it (see it, disable or delete it), its owner, an
 * admin, or a builder of the workflow it starts, so no trigger keeps a
 * workflow's builders from stopping it; to `own` it (move it to another
 * version, enable it again), its owner alone, whose person it acts for,
 * and only while they still build the workflow, read now, as creating one
 * needs: an owner demoted or unshared can't undo a builder's disable.
 * Anyone else gets `workflow.trigger_unavailable`, as for one that
 * doesn't exist.
 */
export const requireTriggerManager = async (
  env: Env,
  by: Acting,
  id: unknown,
  as: "manage" | "own" = "manage"
): Promise<TriggerResource> => {
  requireNotStaff(by);
  const parsed = triggerIdSchema.safeParse(id);
  if (!parsed.success) {
    throw unavailable();
  }
  const row = await drizzle(env.DB)
    .select({
      kind: triggerResources.kind,
      owner: triggerResources.ownerId,
      version: triggerResources.currentVersion,
      enabled: triggerResources.enabled,
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
        eq(triggerResources.id, parsed.data),
        isNull(triggerResources.deletedAt)
      )
    )
    .get();
  if (row === undefined) {
    throw unavailable();
  }
  if (as === "own") {
    if (row.owner !== by.userId) {
      throw unavailable();
    }
    requireBuilder(by);
    await requireWorkflowRole(env, by, row.workflowId, "builder");
    return { id: parsed.data, ...row };
  }
  if (row.owner === by.userId) {
    return { id: parsed.data, ...row };
  }
  if (isAdmin(by.role)) {
    return { id: parsed.data, ...row };
  }
  try {
    await requireWorkflowRole(env, by, row.workflowId, "builder");
  } catch (error) {
    if (isExpectedError(error)) {
      throw unavailable();
    }
    throw error;
  }
  return { id: parsed.data, ...row };
};

/** Trigger `id`'s schedule, as its version `version` keeps it, if it has one. */
const scheduleOf = async (
  env: Env,
  id: string,
  version: number
): Promise<{ cron: string; timeZone: string; input: string } | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      cron: triggerResourceVersions.scheduleCron,
      timeZone: triggerResourceVersions.scheduleTimeZone,
      input: triggerResourceVersions.scheduleInput,
    })
    .from(triggerResourceVersions)
    .where(
      and(
        eq(triggerResourceVersions.triggerId, id),
        eq(triggerResourceVersions.version, version)
      )
    )
    .get();
  if (
    row === undefined ||
    row.cron === null ||
    row.timeZone === null ||
    row.input === null
  ) {
    return undefined;
  }
  return { cron: row.cron, timeZone: row.timeZone, input: row.input };
};

/**
 * Moves trigger `id` to version `version` of its own workflow, for `by`,
 * its owner, who must still build the workflow: a new trigger
 * version, audited, used by future starts only. Its principal stays. A
 * schedule trigger's input must be one the new version takes; it goes on
 * from its next occurrence after now, never one the old version missed.
 */
export const updateTriggerVersion = async (
  env: Env,
  by: Acting,
  id: unknown,
  version: unknown
): Promise<TriggerResource> => {
  const trigger = await requireTriggerManager(env, by, id, "own");
  const target = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    z.number().int().positive(),
    version
  );
  await requirePublished(env, trigger.workflowId, target);
  const schedule =
    trigger.kind === "schedule"
      ? await scheduleOf(env, trigger.id, trigger.version)
      : undefined;
  if (schedule !== undefined) {
    await scheduleInputFor(
      env,
      trigger.workflowId,
      target,
      JSON.parse(schedule.input)
    );
  }
  const next = trigger.version + 1;
  const nextAt =
    schedule === undefined
      ? null
      : (nextOccurrence(schedule.cron, schedule.timeZone, new Date()) ?? null);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db.insert(triggerResourceVersions).values({
      triggerId: trigger.id,
      version: next,
      workflowResourceId: trigger.workflowId,
      workflowResourceVersion: target,
      configHash: sql`(SELECT config_hash FROM trigger_resource_versions
        WHERE trigger_id = ${trigger.id} AND version = ${trigger.version})`,
      principalBinding: trigger.principal,
      createdAt: new Date(),
      // Its configuration stays, as its hash does: only the version moves.
      eventType: sql`(SELECT event_type FROM trigger_resource_versions
        WHERE trigger_id = ${trigger.id} AND version = ${trigger.version})`,
      connectionId: sql`(SELECT connection_id FROM trigger_resource_versions
        WHERE trigger_id = ${trigger.id} AND version = ${trigger.version})`,
      connectionResource: sql`(SELECT connection_resource FROM trigger_resource_versions
        WHERE trigger_id = ${trigger.id} AND version = ${trigger.version})`,
      inputMapping: sql`(SELECT input_mapping FROM trigger_resource_versions
        WHERE trigger_id = ${trigger.id} AND version = ${trigger.version})`,
      eventSourceId: sql`(SELECT event_source_id FROM trigger_resource_versions
        WHERE trigger_id = ${trigger.id} AND version = ${trigger.version})`,
      scheduleCron: schedule?.cron ?? null,
      scheduleTimeZone: schedule?.timeZone ?? null,
      scheduleInput: schedule?.input ?? null,
    }),
    ...(schedule === undefined
      ? []
      : [
          db
            .insert(triggerSchedules)
            .values({
              triggerId: trigger.id,
              version: next,
              nextAt,
              failedStarts: 0,
            })
            .onConflictDoUpdate({
              target: triggerSchedules.triggerId,
              set: {
                version: next,
                nextAt,
                failedStarts: 0,
                attempts: 0,
                lastAttemptAt: null,
              },
            }),
        ]),
    db
      .update(triggerResources)
      .set({ currentVersion: next })
      .where(eq(triggerResources.id, trigger.id)),
    outboxed(
      db,
      entry(by, "trigger.updated", trigger.id, {
        version: next,
        workflowVersion: target,
      })
    ),
  ]);
  return { ...trigger, version: next, workflowVersion: target };
};

/**
 * What moves every trigger of workflow `workflowId`, enabled or not, onto
 * its version `version`, as that version goes live (workflow-publish.ts): a
 * new trigger version each, pinning it, its configuration and principal
 * as they were, written by the statements answered, each only while
 * `live` (SQL) holds, in the batch that makes the version live. A
 * schedule trigger's input must be one the version takes
 * (`workflow.resource_invalid` otherwise, before anything is written); it
 * goes on from its next occurrence. A trigger already pinning the
 * version, as after a try of the batch whose answer was lost, isn't moved
 * again. Answers how many it moves.
 */
export const triggersMovedTo = async (
  env: Env,
  workflowId: string,
  version: number,
  live: SQL,
  at: Date
) => {
  const db = drizzle(env.DB);
  const moving = await db
    .select({
      id: triggerResources.id,
      scheduleInput: triggerResourceVersions.scheduleInput,
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
        isNull(triggerResources.deletedAt),
        eq(triggerResourceVersions.workflowResourceId, workflowId),
        sql`${triggerResourceVersions.workflowResourceVersion} IS NOT ${version}`
      )
    )
    .all();
  for (const { scheduleInput } of moving) {
    if (scheduleInput !== null) {
      // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
      await scheduleInputFor(
        env,
        workflowId,
        version,
        JSON.parse(scheduleInput)
      );
    }
  }
  const ids = JSON.stringify(moving.map(({ id }) => id));
  const moved = sql`trigger_resources.id IN (SELECT value FROM json_each(${ids}))`;
  return {
    count: moving.length,
    statements:
      moving.length === 0
        ? []
        : [
            // In the table's column order.
            db.insert(triggerResourceVersions).select(
              sql`SELECT current.trigger_id, current.version + 1,
                current.workflow_resource_id, ${version}, current.config_hash,
                current.principal_binding, ${at.getTime()}, current.event_contract,
                current.event_type, current.schedule_cron,
                current.schedule_time_zone, current.schedule_input,
                current.connection_id, current.connection_resource,
                current.input_mapping, current.event_source_id
              FROM trigger_resources
              JOIN trigger_resource_versions AS current
                ON current.trigger_id = trigger_resources.id
                AND current.version = trigger_resources.current_version
              WHERE ${moved} AND trigger_resources.deleted_at IS NULL
                AND current.workflow_resource_id = ${workflowId}
                AND current.workflow_resource_version IS NOT ${version}
                AND ${live}`
            ),
            db
              .update(triggerResources)
              .set({
                currentVersion: sql`${triggerResources.currentVersion} + 1`,
              })
              .where(
                sql`${moved} AND EXISTS (SELECT 1 FROM trigger_resource_versions AS next
                  WHERE next.trigger_id = trigger_resources.id
                    AND next.version = trigger_resources.current_version + 1)`
              ),
            // A schedule follows its trigger's version, from the
            // occurrence it is at.
            db
              .update(triggerSchedules)
              .set({
                version: sql`(SELECT current_version FROM trigger_resources
                  WHERE trigger_resources.id = trigger_schedules.trigger_id)`,
              })
              .where(
                sql`${triggerSchedules.triggerId} IN (SELECT value FROM json_each(${ids}))`
              ),
          ],
  };
};

/**
 * Disables trigger `id` for `by`, who manages it, or enables it again for
 * its owner: disabled, it starts nothing more; runs it started go on. A
 * schedule trigger enabled again goes on from its next occurrence after
 * now: the ones it missed while disabled start nothing. Enabling one that
 * is enabled but whose schedule stopped (workflows/schedule-triggers.ts)
 * starts its schedule again, the same way, audited
 * (`trigger.schedule.restarted`).
 */
export const setTriggerEnabled = async (
  env: Env,
  by: Acting,
  id: unknown,
  wanted: unknown
): Promise<void> => {
  // Over `/rpc` anything may arrive: only a boolean says which way, and
  // which of the two checks applies.
  const enabled = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    z.boolean(),
    wanted
  );
  const trigger = await requireTriggerManager(
    env,
    by,
    id,
    enabled ? "own" : "manage"
  );
  const schedule =
    enabled && trigger.kind === "schedule"
      ? await scheduleOf(env, trigger.id, trigger.version)
      : undefined;
  const db = drizzle(env.DB);
  const toggled = [
    db
      .update(triggerResources)
      .set({ enabled })
      .where(
        and(
          eq(triggerResources.id, trigger.id),
          eq(triggerResources.enabled, !enabled)
        )
      ),
    outboxedIfChanged(
      db,
      entry(by, enabled ? "trigger.enabled" : "trigger.disabled", trigger.id)
    ),
  ] as const;
  if (schedule === undefined) {
    await auditedBatch(env, db, toggled);
    return;
  }
  await auditedBatch(env, db, [
    // Before the trigger's own change, while it is still disabled, so
    // enabling one already enabled moves no occurrence on, unless its
    // schedule stopped.
    db
      .update(triggerSchedules)
      .set({
        nextAt:
          nextOccurrence(schedule.cron, schedule.timeZone, new Date()) ?? null,
        failedStarts: 0,
        attempts: 0,
        lastAttemptAt: null,
      })
      .where(
        and(
          eq(triggerSchedules.triggerId, trigger.id),
          eq(triggerSchedules.version, trigger.version),
          sql`(${triggerSchedules.nextAt} IS NULL OR EXISTS (
            SELECT 1 FROM trigger_resources
            WHERE id = ${trigger.id} AND enabled = 0 AND deleted_at IS NULL))`
        )
      ),
    // Only for one already enabled: enabling a disabled one is audited
    // as that.
    outboxedWhere(
      db,
      entry(by, "trigger.schedule.restarted", trigger.id, {
        version: trigger.version,
      }),
      sql`changes() > 0 AND EXISTS (SELECT 1 FROM trigger_resources
        WHERE id = ${trigger.id} AND enabled = 1 AND deleted_at IS NULL)`
    ),
    ...toggled,
  ]);
};

/**
 * Deletes trigger `id` for `by`, who manages it: it starts nothing more,
 * and its permissions, asked for or granted, are revoked by `by` in the
 * same batch, each audited (`revokedWith`), so no request of a trigger
 * that is gone waits for an admin. None lands after: a request names only
 * a live trigger (`requestPermission`).
 */
export const deleteTriggerResource = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<void> => {
  const trigger = await requireTriggerManager(env, by, id);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    // Its address goes with it, for another workflow to take
    // (email-addresses.ts): mail to it bounces from now on.
    db
      .update(triggerResources)
      .set({ deletedAt: new Date(), emailAddress: null })
      .where(
        and(
          eq(triggerResources.id, trigger.id),
          isNull(triggerResources.deletedAt)
        )
      ),
    outboxedIfChanged(db, entry(by, "trigger.deleted", trigger.id)),
    ...revokedWith(db, by, { type: "trigger", triggerId: trigger.id }),
  ]);
};

const jsonSchema = z.json();

/** The canonical JSON a trigger version keeps, read back. */
const keptJson = (text: string): Json => jsonSchema.parse(JSON.parse(text));

/** What a trigger's current version keeps, as `triggersWhere` reads it. */
interface TriggerRow {
  id: string;
  kind: TriggerKind;
  owner: string;
  version: number;
  enabled: boolean;
  createdAt: Date;
  workflowId: string;
  workflowVersion: number;
  principal: string;
  emailAddress: string | null;
  eventType: string | null;
  scheduleCron: string | null;
  scheduleTimeZone: string | null;
  scheduleInput: string | null;
  connectionId: string | null;
  connectionResource: string | null;
  inputMapping: string | null;
  eventSourceId: string | null;
  sourceName: string | null;
  sourceDeletedAt: Date | null;
  nextAt: Date | null;
  failedStarts: number | null;
  start: string | null;
  events: string | null;
}

/** A schedule trigger's configuration, if its version keeps one. */
const scheduleConfigOf = (row: TriggerRow): Json | null =>
  row.scheduleCron === null ||
  row.scheduleTimeZone === null ||
  row.scheduleInput === null
    ? null
    : {
        schedule: { cron: row.scheduleCron, timeZone: row.scheduleTimeZone },
        input: keptJson(row.scheduleInput),
        missedOccurrences: "coalesce",
      };

/** A connector trigger's configuration, if its version keeps one. */
const connectorConfigOf = (row: TriggerRow): Json | null => {
  if (
    row.connectionId === null ||
    row.eventType === null ||
    row.inputMapping === null
  ) {
    return null;
  }
  const connection: Record<string, Json> = { connectionId: row.connectionId };
  if (row.connectionResource !== null) {
    connection.resource = row.connectionResource;
  }
  return {
    connection,
    event: row.eventType,
    input: keptJson(row.inputMapping),
  };
};

/** The source a webhook trigger starts on, as its row names it. */
const sourceOf = (row: {
  eventSourceId: string | null;
  sourceName: string | null;
  sourceDeletedAt: Date | null;
}): TriggerSource | null =>
  row.eventSourceId === null || row.sourceName === null
    ? null
    : {
        id: row.eventSourceId,
        name: row.sourceName,
        deleted: row.sourceDeletedAt !== null,
      };

/**
 * A trigger's configuration as it was created, in its kind's schema, from
 * the fields its version keeps. An email trigger's address is served as
 * its `address`, not in here.
 */
const configOf = (row: TriggerRow): Json | null => {
  if (row.kind === "email") {
    return row.inputMapping === null
      ? null
      : { input: keptJson(row.inputMapping) };
  }
  if (row.kind === "schedule") {
    return scheduleConfigOf(row);
  }
  if (row.kind === "connector") {
    return connectorConfigOf(row);
  }
  return row.eventSourceId === null || row.eventType === null
    ? null
    : { source: row.eventSourceId, type: row.eventType };
};

const viewOf = (row: TriggerRow): WorkflowTrigger => ({
  id: row.id,
  kind: row.kind,
  owner: row.owner,
  version: row.version,
  workflowId: row.workflowId,
  workflowVersion: row.workflowVersion,
  principal: row.principal,
  enabled: row.enabled,
  createdAt: row.createdAt.toISOString(),
  config: configOf(row),
  nextAt: row.kind === "schedule" ? (row.nextAt?.toISOString() ?? null) : null,
  address: row.emailAddress,
  source: sourceOf(row),
  // Stopped by its own failing starts (workflows/schedule-triggers.ts):
  // no next time, after `maxFailedStarts` in a row.
  stopped:
    row.kind === "schedule" &&
    row.nextAt === null &&
    (row.failedStarts ?? 0) >= maxFailedStarts,
  start: permissionStatusSchema.nullable().parse(row.start),
  events: permissionStatusSchema.nullable().parse(row.events),
});

/**
 * Where a trigger's permission on `object` (of `objectType`, and matching
 * `also`) allowing `action` stands, as SQL for a query joining
 * `trigger_resources` and its current `trigger_resource_versions` row: of
 * its permissions for it, an active one first, then a requested one, then
 * a revoked one; NULL if none.
 */
const heldStatusSql = (
  objectType: "workflow" | "connection",
  object: SQL,
  action: SQL,
  also: SQL = sql``
) => sql<string | null>`(SELECT ${permissions.status}
  FROM ${permissions}
  WHERE ${permissions.subjectType} = 'trigger'
    AND ${permissions.subjectId} = ${triggerResources.id}
    AND ${permissions.objectType} = ${objectType}
    AND ${permissions.objectId} = ${object}${also}
    AND EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value = ${action})
  ORDER BY CASE ${permissions.status}
    WHEN 'active' THEN 0 WHEN 'requested' THEN 1 ELSE 2 END
  LIMIT 1)`;

/** Where a trigger's `start` on the workflow its current version pins stands (`heldStatusSql`). */
export const startStatusSql = heldStatusSql(
  "workflow",
  sql`${triggerResourceVersions.workflowResourceId}`,
  sql`'start'`
);

/**
 * Where a connector trigger's read of its event on the connection and part
 * its current version names stands (`heldStatusSql`); NULL for any other
 * kind, which names no connection.
 */
const eventsStatusSql = heldStatusSql(
  "connection",
  sql`${triggerResourceVersions.connectionId}`,
  sql`(CASE ${triggerResourceVersions.eventType} ${sql.join(
    Object.entries(connectorEventActions).map(
      ([type, action]) => sql`WHEN ${type} THEN ${action}`
    ),
    sql` `
  )} END)`,
  sql` AND ${permissions.resource} IS ${triggerResourceVersions.connectionResource}`
);

/** The live triggers `where` finds, at their current versions, oldest first. */
const triggersWhere = async (
  env: Env,
  where: SQL | undefined
): Promise<WorkflowTrigger[]> => {
  const rows = await drizzle(env.DB)
    .select({
      id: triggerResources.id,
      kind: triggerResources.kind,
      owner: triggerResources.ownerId,
      version: triggerResources.currentVersion,
      enabled: triggerResources.enabled,
      createdAt: triggerResources.createdAt,
      workflowId: triggerResourceVersions.workflowResourceId,
      workflowVersion: triggerResourceVersions.workflowResourceVersion,
      principal: triggerResourceVersions.principalBinding,
      emailAddress: triggerResources.emailAddress,
      eventType: triggerResourceVersions.eventType,
      scheduleCron: triggerResourceVersions.scheduleCron,
      scheduleTimeZone: triggerResourceVersions.scheduleTimeZone,
      scheduleInput: triggerResourceVersions.scheduleInput,
      connectionId: triggerResourceVersions.connectionId,
      connectionResource: triggerResourceVersions.connectionResource,
      inputMapping: triggerResourceVersions.inputMapping,
      eventSourceId: triggerResourceVersions.eventSourceId,
      sourceName: eventSources.name,
      sourceDeletedAt: eventSources.deletedAt,
      nextAt: triggerSchedules.nextAt,
      failedStarts: triggerSchedules.failedStarts,
      start: startStatusSql,
      events: eventsStatusSql,
    })
    .from(triggerResources)
    .innerJoin(
      triggerResourceVersions,
      and(
        eq(triggerResourceVersions.triggerId, triggerResources.id),
        eq(triggerResourceVersions.version, triggerResources.currentVersion)
      )
    )
    .leftJoin(
      triggerSchedules,
      and(
        eq(triggerSchedules.triggerId, triggerResources.id),
        eq(triggerSchedules.version, triggerResources.currentVersion)
      )
    )
    .leftJoin(
      eventSources,
      eq(eventSources.id, triggerResourceVersions.eventSourceId)
    )
    .where(and(isNull(triggerResources.deletedAt), where))
    .orderBy(asc(triggerResources.createdAt), asc(triggerResources.id))
    .all();
  return rows.map(viewOf);
};

/**
 * What each of the live triggers `ids` is (`TriggerSummary`), by ID, for
 * the permissions they hold as listed to whoever may see them
 * (permissions-open.ts): one read, however many. A trigger deleted since
 * has none.
 */
export const triggerSummaries = async (
  env: Env,
  ids: readonly string[]
): Promise<Map<string, TriggerSummary>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({
      id: triggerResources.id,
      kind: triggerResources.kind,
      cron: triggerResourceVersions.scheduleCron,
      timeZone: triggerResourceVersions.scheduleTimeZone,
      event: triggerResourceVersions.eventType,
      connectionId: triggerResourceVersions.connectionId,
      resource: triggerResourceVersions.connectionResource,
      eventSourceId: triggerResourceVersions.eventSourceId,
      sourceName: eventSources.name,
      sourceDeletedAt: eventSources.deletedAt,
    })
    .from(triggerResources)
    .innerJoin(
      triggerResourceVersions,
      and(
        eq(triggerResourceVersions.triggerId, triggerResources.id),
        eq(triggerResourceVersions.version, triggerResources.currentVersion)
      )
    )
    .leftJoin(
      eventSources,
      eq(eventSources.id, triggerResourceVersions.eventSourceId)
    )
    .where(
      and(
        inList(triggerResources.id, [...new Set(ids)]),
        isNull(triggerResources.deletedAt)
      )
    )
    .all();
  return new Map(
    rows.map((row): [string, TriggerSummary] => [
      row.id,
      {
        kind: row.kind,
        schedule:
          row.cron === null || row.timeZone === null
            ? null
            : { cron: row.cron, timeZone: row.timeZone },
        event: row.event,
        connection:
          row.connectionId === null
            ? null
            : { connectionId: row.connectionId, resource: row.resource },
        source: sourceOf(row),
      },
    ])
  );
};

/** Live trigger `id`, as anyone who may manage it (`requireTriggerManager`) sees it. */
export const workflowTrigger = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowTrigger> => {
  const trigger = await requireTriggerManager(env, by, id);
  const [view] = await triggersWhere(env, eq(triggerResources.id, trigger.id));
  if (view === undefined) {
    throw unavailable();
  }
  return view;
};

/**
 * The live triggers that start workflow `workflowId`, for `by`, never Grasp
 * staff: every one for the organization's admins and the workflow's
 * builders, who may disable any of them; `by`'s own for anyone else, so
 * nobody learns of a trigger they may not manage.
 */
export const listWorkflowTriggers = async (
  env: Env,
  by: Acting,
  workflowId: unknown
): Promise<WorkflowTrigger[]> => {
  requireNotStaff(by);
  const id = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    z.string().min(1).max(128),
    workflowId
  );
  const ofWorkflow = eq(triggerResourceVersions.workflowResourceId, id);
  if (isAdmin(by.role)) {
    return await triggersWhere(env, ofWorkflow);
  }
  try {
    await requireWorkflowRole(env, by, id, "builder");
  } catch (error) {
    if (isExpectedError(error)) {
      return await triggersWhere(
        env,
        and(ofWorkflow, eq(triggerResources.ownerId, by.userId))
      );
    }
    throw error;
  }
  return await triggersWhere(env, ofWorkflow);
};
