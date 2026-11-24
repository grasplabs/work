import type {
  EventSource,
  EventSourceDeliveryPage,
  EventSourceDeliveryWithPayload,
  EventSourceRefusals,
  EventSourcesApi,
  EventSourceTestResult,
  EventSourceTrigger,
  EventSourceWithSecret,
} from "@grasp-os/shared/event-sources";

import {
  createEventSource,
  deleteEventSource,
  listEventSources,
  revokeSourceSecret,
  rotateSourceSecret,
} from "./event-sources.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  listDeliveries,
  readDelivery,
  sourceRefusals,
  sourceTriggers,
} from "./workflows/source-deliveries.ts";
import { sendTestEvent } from "./workflows/source-events.ts";

/**
 * A signed-in person's `workflowResources.sources` (event-sources.ts and
 * workflows/source-deliveries.ts, where who may do what is decided: each
 * call checks it there).
 */
export class EventSourcesRpc extends CoreRpcTarget implements EventSourcesApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<EventSource[]> {
    return await withPerson(
      this.#check,
      async (person) => await listEventSources(this.#env, person)
    );
  }

  async create(input: unknown): Promise<EventSourceWithSecret> {
    return await withPerson(
      this.#check,
      async (person) => await createEventSource(this.#env, person, input)
    );
  }

  async rotateSecret(id: string): Promise<EventSourceWithSecret> {
    return await withPerson(
      this.#check,
      async (person) => await rotateSourceSecret(this.#env, person, id)
    );
  }

  async revokeSecret(id: string): Promise<EventSource> {
    return await withPerson(
      this.#check,
      async (person) => await revokeSourceSecret(this.#env, person, id)
    );
  }

  async delete(id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await deleteEventSource(this.#env, person, id);
    });
  }

  async deliveries(
    id: string,
    page?: string
  ): Promise<EventSourceDeliveryPage> {
    return await withPerson(
      this.#check,
      async (person) => await listDeliveries(this.#env, person, id, page)
    );
  }

  async delivery(
    id: string,
    deliveryId: string
  ): Promise<EventSourceDeliveryWithPayload> {
    return await withPerson(
      this.#check,
      async (person) => await readDelivery(this.#env, person, id, deliveryId)
    );
  }

  async refusals(id: string): Promise<EventSourceRefusals[]> {
    return await withPerson(
      this.#check,
      async (person) => await sourceRefusals(this.#env, person, id)
    );
  }

  async triggers(id: string): Promise<EventSourceTrigger[]> {
    return await withPerson(
      this.#check,
      async (person) => await sourceTriggers(this.#env, person, id)
    );
  }

  async sendTest(id: string, input: unknown): Promise<EventSourceTestResult> {
    return await withPerson(
      this.#check,
      async (person) => await sendTestEvent(this.#env, person, id, input)
    );
  }
}
