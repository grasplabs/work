import { encode } from "./codec.ts";
import { describe, isPlainObject, readSettings } from "./config.ts";
import type {
  InstanceStatus,
  RestartFrom,
  WorkflowInstanceSubscribeOptions,
  WorkflowInstanceSubscription,
} from "./contracts.ts";
import { isEventType } from "./history.ts";
import {
  assertEventType,
  assertStepName,
  maxEventKeyLength,
} from "./identity.ts";
import {
  maxEventPayloadBytes,
  maxInboxBytes,
  maxInboxEvents,
} from "./journal.ts";
import type { StepType } from "./journal.ts";
import type {
  EventOutcome,
  RestartCommand,
  SubscribeCommand,
  TerminateCommand,
  WorkflowRun,
} from "./run.ts";

export type RunStub = DurableObjectStub<WorkflowRun>;

export const notFound = (id: string): Error =>
  new Error(
    `instance.not_found: there is no workflow instance ${JSON.stringify(id)}`
  );

const stepTypes = new Set<unknown>(["do", "sleep", "waitForEvent"]);

const isStepType = (value: unknown): value is StepType => stepTypes.has(value);

/**
 * A restart's options, read once each, as the reference takes them:
 * `{ from?: { name, count?, type? } }`, `count` 1 and `type` "do" when left
 * out. A shape it can't be, or a setting it doesn't have, is a TypeError,
 * never read as a default.
 */
const readRestart = (options: unknown): RestartCommand => {
  if (options === undefined) {
    return { from: null };
  }
  if (!isPlainObject(options)) {
    throw new TypeError(
      `A restart's options are { from? }, not ${options === null ? "null" : describe(options)}`
    );
  }
  const { from } = readSettings("A restart's options", options, [
    "from",
  ] as const);
  if (from === undefined) {
    return { from: null };
  }
  if (!isPlainObject(from)) {
    throw new TypeError(
      `A restart's step is { name, count?, type? }, not ${from === null ? "null" : describe(from)}`
    );
  }
  const { name, count, type } = readSettings("A restart's step", from, [
    "name",
    "count",
    "type",
  ] as const);
  if (
    count !== undefined &&
    (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1)
  ) {
    throw new TypeError(
      `A restart's step count is a whole number from 1: ${typeof count === "number" ? String(count) : describe(count)}`
    );
  }
  if (type !== undefined && !isStepType(type)) {
    throw new TypeError(
      `A restart's step type is "do", "sleep" or "waitForEvent", not ${describe(type)}`
    );
  }
  return {
    from: {
      name: assertStepName(name),
      count: count ?? 1,
      type: type ?? "do",
    },
  };
};

/** `terminate`'s options, read once: `{ rollback? }`, false when left out. */
const readTerminate = (options: unknown): TerminateCommand => {
  if (options === undefined) {
    return { rollback: false };
  }
  if (!isPlainObject(options)) {
    throw new TypeError(
      `A termination's options are { rollback? }, not ${options === null ? "null" : describe(options)}`
    );
  }
  const { rollback } = readSettings("A termination's options", options, [
    "rollback",
  ] as const);
  if (rollback !== undefined && typeof rollback !== "boolean") {
    throw new TypeError(
      `A termination's rollback is true or false, not ${describe(rollback)}`
    );
  }
  return { rollback: rollback === true };
};

/**
 * `subscribe`'s options, read once each, as the reference takes them:
 * `{ cursor?, filter? }`, a cursor a whole number from 0 and a filter a
 * list of event types. Anything else is a TypeError, never read as a
 * default.
 */
const readSubscribe = (options: unknown): SubscribeCommand => {
  if (options === undefined) {
    return { cursor: 0, filter: null };
  }
  if (!isPlainObject(options)) {
    throw new TypeError(
      `A subscription's options are { cursor?, filter? }, not ${options === null ? "null" : describe(options)}`
    );
  }
  const { cursor, filter } = readSettings("A subscription's options", options, [
    "cursor",
    "filter",
  ] as const);
  if (
    cursor !== undefined &&
    (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0)
  ) {
    throw new TypeError(
      `A subscription's cursor is an event ID, a whole number from 0: ${typeof cursor === "number" ? String(cursor) : describe(cursor)}`
    );
  }
  if (filter === undefined) {
    return { cursor: cursor ?? 0, filter: null };
  }
  if (!Array.isArray(filter)) {
    throw new TypeError(
      `A subscription's filter is a list of event types, not ${describe(filter)}`
    );
  }
  const types: string[] = [];
  for (const type of filter) {
    if (!isEventType(type)) {
      throw new TypeError(
        `A subscription's filter takes event types, not ${typeof type === "string" ? JSON.stringify(type) : describe(type)}`
      );
    }
    types.push(type);
  }
  return { cursor: cursor ?? 0, filter: types };
};

/** An event as a caller sends it. */
export interface InstanceEvent {
  type: string;
  payload?: unknown;
}

/** A run, as its caller holds it: Cloudflare Workflows' instance. */
export class WorkflowInstance {
  readonly id: string;
  readonly #stub: RunStub;

  constructor(id: string, stub: RunStub) {
    this.id = id;
    this.#stub = stub;
  }

  async status(): Promise<InstanceStatus> {
    const status = await this.#stub.status();
    if (status === undefined) {
      throw notFound(this.id);
    }
    return status;
  }

  /**
   * Pauses the run, as Cloudflare's `pause`: one asleep or waiting for an
   * event is paused at once; one running finishes the steps it has out,
   * starts nothing new (its status `waitingForPause`), then is paused. A
   * run that is queued, paused or ended is left as it is.
   */
  async pause(): Promise<void> {
    if ((await this.#stub.pause()) === "missing") {
      throw notFound(this.id);
    }
  }

  /**
   * Resumes a paused run, as Cloudflare's `resume`: its pending deadlines
   * (sleeps, event waits, retries) are moved on by the time it was paused.
   * A run still pausing goes on as if the pause was never asked for; any
   * other run is left as it is.
   */
  async resume(): Promise<void> {
    if ((await this.#stub.resume()) === "missing") {
      throw notFound(this.id);
    }
  }

  /**
   * Ends the run as `terminated`, as Cloudflare's `terminate`. Whatever a
   * step still out answers later is ignored, and nothing more of the run
   * starts. With `rollback: true`, the rollbacks its steps registered run
   * first, latest started first: the run is `rollingBack` until they have,
   * then `terminated`, its status saying how they went. A run that has
   * ended, or is rolling back, can't be terminated.
   */
  async terminate(options?: { rollback?: boolean }): Promise<void> {
    const outcome = await this.#stub.terminate(readTerminate(options));
    if (outcome === "missing") {
      throw notFound(this.id);
    }
    if (outcome === "ended") {
      throw new Error(
        `instance.cannot_terminate: workflow instance ${JSON.stringify(this.id)} has ended, and can't be terminated`
      );
    }
    if (outcome === "rolling_back") {
      throw new Error(
        `instance.cannot_terminate: workflow instance ${JSON.stringify(this.id)} is rolling back, which isn't cut short`
      );
    }
  }

  /**
   * Runs the run again, as Cloudflare's `restart`, whatever state it is in:
   * from its start, or from the step `from` names, keeping the outcomes of
   * the steps started before it. Each step it runs again goes out under a
   * new idempotency key, never a retry's. A run rolling back can't be
   * restarted until it has ended.
   */
  async restart(options?: { from?: RestartFrom }): Promise<void> {
    const command = readRestart(options);
    const outcome = await this.#stub.restart(command);
    if (outcome === "missing") {
      throw notFound(this.id);
    }
    if (outcome === "rolling_back") {
      throw new Error(
        `instance.cannot_restart: workflow instance ${JSON.stringify(this.id)} is rolling back, which isn't cut short`
      );
    }
    if (outcome === "nested_step") {
      throw new Error(
        `instance.cannot_restart: step ${JSON.stringify(command.from?.name)} of workflow instance ${JSON.stringify(this.id)} was called from inside another step; restart from that step instead`
      );
    }
    if (outcome === "no_such_step") {
      throw new Error(
        `instance.cannot_restart: step ${JSON.stringify(command.from?.name)} not found in the execution history of workflow instance ${JSON.stringify(this.id)}`
      );
    }
  }

  /**
   * Subscribes to the run's events, as Cloudflare's `subscribe`: those it
   * has kept, after `cursor` (the last event ID the caller handled), then
   * each as it happens, only the types `filter` names. Once the run's end
   * has been delivered (or filtered out) every `next` is done; dispose of
   * the subscription (`using`) when done with it earlier. A subscription
   * cut off (the caller's or the run's process went away) is taken up
   * again by subscribing from the last event ID handled: nothing is missed
   * and nothing is seen twice. Who may observe a run is the caller's to
   * decide: whoever holds the binding can.
   */
  async subscribe(
    options?: WorkflowInstanceSubscribeOptions
  ): Promise<WorkflowInstanceSubscription> {
    const command = readSubscribe(options);
    const subscription = await this.#stub.subscribe(command);
    if (subscription === undefined) {
      throw notFound(this.id);
    }
    return subscription;
  }

  /**
   * Deletes the run and everything it keeps, as Cloudflare's `delete`.
   * Nothing runs for it on the way, no rollback either.
   */
  async delete(): Promise<void> {
    if ((await this.#stub.deleteRun()) === "missing") {
      throw notFound(this.id);
    }
  }

  async #send(event: InstanceEvent, key: string | null): Promise<boolean> {
    const type = assertEventType(event.type);
    // Encoded here, so a payload the journal can't keep fails the caller
    // before the run sees it.
    const payload = encode(event.payload);
    const outcome: EventOutcome = await this.#stub.sendEvent({
      type,
      payload,
      key,
    });
    switch (outcome) {
      case "accepted":
      case "duplicate": {
        return outcome === "accepted";
      }
      case "conflict": {
        throw new Error(
          `The event ${JSON.stringify(key)} sent to workflow instance ${JSON.stringify(this.id)} was sent before with another type or payload`
        );
      }
      case "too_large": {
        throw new TypeError(
          `An event's payload takes at most ${maxEventPayloadBytes} bytes encoded`
        );
      }
      case "full": {
        throw new Error(
          `instance.inbox_full: workflow instance ${JSON.stringify(this.id)} holds as many events as it takes (${maxInboxEvents} events, ${maxInboxBytes} bytes)`
        );
      }
      case "ended": {
        throw new Error(
          `instance.not_running: workflow instance ${JSON.stringify(this.id)} has ended and takes no events`
        );
      }
      case "missing": {
        throw notFound(this.id);
      }
      default: {
        throw new Error(`Unknown event outcome: ${String(outcome)}`);
      }
    }
  }

  /**
   * Sends the run an event, as Cloudflare Workflows' `sendEvent` does: it
   * is in the run's inbox once this resolves, for a wait already waiting
   * or one reached later. Sent again, it is another event. For an event
   * that may be delivered more than once, use `deliverEvent`.
   */
  async sendEvent(event: InstanceEvent): Promise<void> {
    await this.#send(event, null);
  }

  /**
   * Sends an event that may be delivered more than once: the same `key`,
   * type and payload again is the same event, accepted once. `accepted`
   * says whether this delivery was the one.
   */
  async deliverEvent(
    event: InstanceEvent & { key: string }
  ): Promise<{ accepted: boolean }> {
    const { key } = event;
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > maxEventKeyLength
    ) {
      throw new TypeError(
        `An event key is 1 to ${maxEventKeyLength} characters long`
      );
    }
    return { accepted: await this.#send(event, key) };
  }
}
