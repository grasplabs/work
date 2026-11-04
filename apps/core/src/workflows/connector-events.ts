import { eventListenersMax } from "@grasp-os/shared/connect";
import type {
  EventListener,
  OutboxedConnectorEvent,
} from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  deliveredConnectorEventSchema,
  workflowErrors,
} from "@grasp-os/shared/workflows";

import {
  startConnectorTriggers,
  triggerListeners,
} from "./connector-triggers.ts";
import { stampedEventRun } from "./mail-stamps.ts";

// Events connections report, to independent workflows' connector
// triggers (connector-triggers.ts), each by its own grants. Connect can't
// reach core, so core drives it, as it drains connect's audit outbox:
// every minute, the clock tells connect who listens for events where
// (`listenersOf`), which is where connect listens and nowhere else, then
// takes the events connect read, delivers each here, and settles them
// (`pumpConnectorEvents`). The event types and their read actions are
// `connectorEventActions`; connect reads them (its events.ts).
//
// A message a run sent to a mailbox it watches carries the run's stamp
// (mail-stamps.ts): the run never gets the stamp, and the triggers decide
// from core's own record whether the event is the run's own mail
// (`stampedEventRun`).

/**
 * Starts the runs an event a connection reported starts; how many
 * workflows it started (or had started, delivered before). A trigger that
 * may go another time fails the delivery, after the rest are tried.
 */
export const deliverConnectorEvent = async (
  env: Env,
  input: unknown
): Promise<{ runs: number }> => {
  const delivered = workflowErrors.parse(
    "workflow.invalid",
    deliveredConnectorEventSchema,
    input
  );
  // The run gets the event without the stamp its message carried: what
  // its sender wrote, which only core's own record vouches for.
  const { stamp: _stamp, ...event } = delivered;
  // A hash, so the key (in the audit log too) stays short and says
  // nothing of the event.
  const same = await sha256Hex(JSON.stringify([event.connection, event.id]));
  const stamped = await stampedEventRun(env, delivered);
  return await startConnectorTriggers(env, event, same, stamped);
};

/**
 * Who listens for events where, for every event type connections report:
 * each listener once. Past `eventListenersMax` the rest are left out and
 * logged: connect stops listening for them (and says so in the audit
 * log), while everyone else goes on hearing their events.
 */
export const listenersOf = async (env: Env): Promise<EventListener[]> => {
  const listeners = new Map<string, EventListener>();
  for (const listener of await triggerListeners(env, eventListenersMax + 1)) {
    listeners.set(JSON.stringify(listener), listener);
  }
  const all = [...listeners.values()];
  if (all.length > eventListenersMax) {
    log.error("workflow.event_listeners_capped", {
      listeners: all.length,
      kept: eventListenersMax,
    });
  }
  return all.slice(0, eventListenersMax);
};

/** Events one clock run delivers, at most: one take's worth. */
const defaultEventsPerRun = 100;

/** Events one clock run delivers: fewer in tests (`CONNECTOR_EVENTS_PER_RUN`). */
const eventsPerRun = (env: Env): number => {
  const configured = Number(env.CONNECTOR_EVENTS_PER_RUN);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : defaultEventsPerRun;
};

/**
 * Delivers one event connect read: `done` once it started its runs,
 * `rejected` when it never will be taken (`workflow.invalid`, or not
 * JSON), `failed` otherwise, to be delivered again later.
 */
const deliverOne = async (
  env: Env,
  { event }: OutboxedConnectorEvent
): Promise<"done" | "failed" | "rejected"> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event);
  } catch {
    log.error("workflow.event_invalid", {});
    return "rejected";
  }
  try {
    await deliverConnectorEvent(env, parsed);
    return "done";
  } catch (error) {
    if (workflowErrors.codeOf(error) === "workflow.invalid") {
      log.error("workflow.event_invalid", errorFields(error));
      return "rejected";
    }
    return "failed";
  }
};

/**
 * Every minute, from the clock: tells connect who listens for
 * events where, then delivers at most `eventsPerRun` of the events it
 * read and settles them; the rest wait for the next run. Those read
 * before are delivered even when telling connect fails.
 */
export const pumpConnectorEvents = async (env: Env): Promise<void> => {
  try {
    await env.CONNECT.syncEventSources(await listenersOf(env));
  } catch (error) {
    log.error("workflow.event_sync_failed", errorFields(error));
  }
  const taken = await env.CONNECT.takeConnectorEvents();
  const settled: Record<"done" | "failed" | "rejected", string[]> = {
    done: [],
    failed: [],
    rejected: [],
  };
  for (const outboxed of taken.slice(0, eventsPerRun(env))) {
    // oxlint-disable-next-line no-await-in-loop -- one event at a time
    settled[await deliverOne(env, outboxed)].push(outboxed.id);
  }
  if (taken.length > 0) {
    await env.CONNECT.ackConnectorEvents(settled);
  }
};
