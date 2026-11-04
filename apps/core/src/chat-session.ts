import type { Wake } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";

import type { ChatHarness, TurnEnd, TurnRequest } from "./chat-harness.ts";

// One chat's agent: the object that runs its turns on pi-durable
// (chat-harness.ts), named by its Workspace and chat (`chatSession` in
// durable-objects.ts), in the EU. Its storage is the chat's transcript as
// the model reads it, so deleting the chat deletes it whole (`erase`).
// Each chat its own object, as pi-durable's tables take room of their own:
// a Workspace with hundreds of chats isn't made to load them all, and one
// chat's turn never waits on another's.

/** How long a turn under way may go unwatched before its alarm checks on it. */
const heartbeatMs = 60_000;

export class ChatSession extends DurableObject<Env> {
  #opened: Promise<ChatHarness> | undefined;

  /**
   * The chat's Harness, opened at the first call that needs it: pi loads
   * with it, as the chat's first turn, not as core starts.
   */
  async #harness(): Promise<ChatHarness> {
    this.#opened ??= (async () => {
      const { ChatHarness: Opening } = await import("./chat-harness.ts");
      return await Opening.open(this.ctx, this.env, (wake) => {
        // A failed alarm write resets the object; it arms again as it starts.
        this.ctx.waitUntil(
          this.#arm(wake).catch(() => {
            this.ctx.abort("The chat's alarm could not be set.");
          })
        );
      });
    })();
    try {
      return await this.#opened;
    } catch (error) {
      this.#opened = undefined;
      throw error;
    }
  }

  /**
   * Keeps the alarm armed while a turn runs (a heartbeat, so a turn a
   * restart cut short goes on), and for the earliest sleep, such as a retry.
   */
  async #arm(wake: Wake): Promise<void> {
    const heartbeat = wake.active ? Date.now() + heartbeatMs : undefined;
    const at =
      heartbeat === undefined || wake.at === undefined
        ? (heartbeat ?? wake.at)
        : Math.min(heartbeat, wake.at);
    await (at === undefined
      ? this.ctx.storage.deleteAlarm()
      : this.ctx.storage.setAlarm(at));
  }

  /** Runs the chat's turn `request` to its end (chat-harness.ts). */
  async run(request: TurnRequest): Promise<TurnEnd> {
    const harness = await this.#harness();
    await this.#arm({ ...harness.wake(), active: true });
    return await harness.run(request);
  }

  /** Tells the turn under way `text` before its next request. */
  async steer(text: string): Promise<void> {
    const harness = await this.#harness();
    await this.#arm({ ...harness.wake(), active: true });
    await harness.steer(text);
  }

  /** Tells the chat's agent `text` for its turn under way or its next. */
  async note(text: string): Promise<void> {
    const harness = await this.#harness();
    await harness.note(text);
  }

  /** Stops the turn under way, if there is one, or turn `turnId` as it starts. */
  async abort(turnId?: string): Promise<void> {
    const harness = await this.#harness();
    await this.#arm({ ...harness.wake(), active: true });
    await harness.abort(turnId);
  }

  /** Deletes everything the chat's agent kept: the chat is being deleted. */
  async erase(): Promise<void> {
    if (this.#opened !== undefined) {
      const harness = await this.#harness();
      await harness.abort();
      await harness.close();
      this.#opened = undefined;
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Goes on with a turn a restart cut short, and with what sleeps till now. */
  override async alarm(): Promise<void> {
    const harness = await this.#harness();
    await this.#arm({ ...harness.wake(), active: true });
    await harness.resume();
  }
}
