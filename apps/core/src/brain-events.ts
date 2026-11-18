import type { AuditEvent } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";

import { recordEvents } from "./brain-next.ts";
import type { ObservedStep } from "./brain-next.ts";

// The tool calls made through Grasp, as the Brain's events (GRA-1763):
// every call connect carries out is in its audit outbox as a
// `connection.call` event, which core drains (audit-drains.ts), so each
// call a person's agent or App made for them becomes a step of theirs,
// which core keeps for their teams (brain-next.ts `recordEvents`). What
// is kept of a call, and what not:
//
// - Only a call that went through (`ok`), made for a person: never one
//   answered from an earlier one (a repeat), and never an independent
//   workflow's, which runs as the system, for no one's team.
// - The step is the call's action, in the system its connector is
//   (`provider`), and whether it changed something there (`sideEffect`).
//   Never its connection: a person's own connection names that person.
//   Never its input or its answer.
// - No item: what a call names as read is a record for a native tool,
//   but for a toolkit's its toolkit and tool (connect's policy.ts
//   `withProvenance`), which no item is. The sync's events carry items.
// - Keyed by its audit event, so a drain that runs twice keeps it once.

/** The step a drained audit event is, if it is a call made for a person. */
const stepOf = (event: AuditEvent): ObservedStep[] => {
  const { detail } = event;
  if (
    event.source !== "connect" ||
    event.action !== "connection.call" ||
    detail.outcome !== "ok" ||
    detail.replayed === true ||
    detail.subjectType === "workflow" ||
    typeof detail.onBehalfOf !== "string" ||
    typeof detail.action !== "string" ||
    typeof detail.provider !== "string"
  ) {
    return [];
  }
  return [
    {
      key: event.id,
      personId: detail.onBehalfOf,
      step: detail.action,
      system: detail.provider,
      writes: detail.sideEffect === true,
      item: null,
      at: new Date(event.at),
    },
  ];
};

/**
 * Keeps the calls among `events` (connect's, as the log took them) as the
 * Brain's events. Never fails the drain: a failure is logged, and the
 * events it would have kept are not kept.
 */
export const recordCallEvents = async (
  env: Env,
  events: readonly AuditEvent[]
): Promise<void> => {
  const steps = events.flatMap(stepOf);
  if (steps.length === 0) {
    return;
  }
  try {
    await recordEvents(env, steps);
  } catch (error) {
    log.error("brain.events.record_failed", errorFields(error));
  }
};
