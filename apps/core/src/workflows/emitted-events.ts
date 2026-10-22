import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedWhere } from "../audit-outbox.ts";
import { workflowEmittedEvents } from "../db/core/schema.ts";
import { acceptedEventData, pinnedEventDataOf } from "./event-contracts.ts";
import { contentType } from "./event-envelopes.ts";
import { requireCallAuthority } from "./resource-authority.ts";
import type { CallingRun } from "./resource-authority.ts";

// Events JSON workflows emit (platform specification 13.5 `emit`, 14.3,
// 15.1 system events): each `emit` task's event, written to core's
// transactional outbox (`workflow_emitted_events`) as its task's work,
// with its audit entry, in one batch. Threat model, and how each is closed:
//
// - An event of a type, or through a binding, the run's start didn't pin.
//   The binding must be an event binding its start froze, its authority
//   holding now (resource-authority.ts, `requireCallAuthority`: its
//   approval active, its person in the workflow, its start's grant
//   standing); the type must be one its pinned contract admits, by its
//   fingerprint, and the data what that type's descriptor takes, by the
//   native validator (`workflow.event_invalid`). The generator sealed the
//   binding and the type as literals.
// - An event claiming to come from elsewhere. Its source is the emitting
//   run, its ID derived from the run and the task's step, its time when it
//   was first written, its content type JSON: the host's, never the
//   workflow's. A `source` in the definition isn't lowered (generate.ts).
// - An event to an arbitrary destination. An emit names no destination:
//   it goes to the outbox, and nowhere else; no run's inbox, no URL.
// - The same event emitted twice. A retry or a replay of the task's step
//   writes under the same ID, which is written once (the database refuses
//   a second row, and any change of the first but its delivery and its
//   retention): the first stands.
// - A test run's events leaving it. A test run of a draft emits nothing.

/** What an `emit` task's event is, before the host mints its envelope. */
export interface EmitRequest {
  readonly taskId: string;
  /** Its task's step's key: one per task of a run, the same in every attempt. */
  readonly stepKey: string;
  readonly binding: string;
  readonly type: string;
  readonly subject?: Json;
  readonly dataschema?: Json;
  readonly data: Json;
}

/** An emitted event: its ID and when the run first emitted it. */
export interface EmittedEvent {
  readonly id: string;
  readonly source: string;
}

/** Text of at most `max` characters: a subject's or a data schema's. */
const textOf = (value: Json | undefined, name: string, max: number) => {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.length > max) {
    throw workflowResourceErrors.create("workflow.event_invalid", {
      issues: [`${name}: Text of at most ${max} characters.`],
    });
  }
  return value;
};

/**
 * Emits `request` for `run` (version `version`), as its task's work: into
 * the outbox, once, with its audit entry, as the header says. Its ID and
 * source; the same for the same step however often asked.
 */
export const emitEvent = async (
  env: Env,
  run: CallingRun,
  request: EmitRequest
): Promise<EmittedEvent> => {
  const binding = run.bindings.get(request.binding);
  if (binding?.kind !== "event") {
    throw workflowResourceErrors.create("workflow.event_denied");
  }
  try {
    await requireCallAuthority(env, run, binding);
  } catch (error) {
    if (workflowResourceErrors.codeOf(error) === "workflow.call_denied") {
      throw workflowResourceErrors.create("workflow.event_denied");
    }
    throw error;
  }
  const descriptor = await pinnedEventDataOf(env, binding, request.type);
  if (descriptor === undefined) {
    throw workflowResourceErrors.create("workflow.event_invalid");
  }
  const data = acceptedEventData(descriptor, request.data);
  const subject = textOf(request.subject, "subject", 1024);
  const dataschema = textOf(request.dataschema, "dataschema", 1024);
  const digest = await sha256Hex(canonicalJson([run.runId, request.stepKey]));
  const id = `evt_${digest.slice(0, 48)}`;
  const source = `urn:grasp:workflow:${run.workflowId}:run:${run.runId}`;
  const createdAt = Date.now();
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(workflowEmittedEvents)
      .values({
        id,
        runId: run.runId,
        workflowResourceId: run.workflowId,
        version: run.version,
        taskId: request.taskId,
        binding: request.binding,
        contractId: binding.contractId,
        source,
        type: request.type,
        subject,
        dataschema,
        data: canonicalJson(data),
        createdAt: new Date(createdAt),
      })
      .onConflictDoNothing(),
    // Once, as the event is first written: a retry writes no second entry.
    outboxedWhere(
      db,
      {
        actor: { type: "system" },
        action: "workflow.event.emitted",
        target: { type: "workflow_run", id: run.runId },
        detail: {
          event: id,
          workflow: run.workflowId,
          version: run.version,
          task: request.taskId,
          binding: request.binding,
          contract: binding.contractId,
          type: request.type,
          datacontenttype: contentType,
        },
      },
      sql`EXISTS (SELECT 1 FROM ${workflowEmittedEvents}
        WHERE ${workflowEmittedEvents.id} = ${id}
          AND ${workflowEmittedEvents.createdAt} = ${createdAt})`
    ),
  ]);
  return { id, source };
};
