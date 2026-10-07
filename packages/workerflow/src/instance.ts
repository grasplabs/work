import { encode } from "./codec.ts";
import type { InstanceStatus } from "./contracts.ts";
import { assertEventType, maxEventKeyLength } from "./identity.ts";
import {
  maxEventPayloadBytes,
  maxInboxBytes,
  maxInboxEvents,
} from "./journal.ts";
import type { EventOutcome, WorkflowRun } from "./run.ts";

export type RunStub = DurableObjectStub<WorkflowRun>;

export const notFound = (id: string): Error =>
  new Error(
    `instance.not_found: there is no workflow instance ${JSON.stringify(id)}`
  );

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
