import type { Wake } from "@earendil-works/pi-durable";
import { agentErrors } from "@grasp-os/shared/agent";
import { DurableObject } from "cloudflare:workers";

import type { ChatHarness, TurnEnd, TurnRequest } from "./chat-harness.ts";

// One chat's agent: the object that runs its turns on pi-durable
// (chat-harness.ts), named by its Workspace and chat (`chatSession` in
// durable-objects.ts), in the EU. Its storage is the chat's transcript as
// the model reads it, so deleting the chat deletes it whole (`erase`).
// Each chat its own object, as pi-durable's tables take room of their own:
// a Workspace with hundreds of chats isn't made to load them all, and one
// chat's turn never waits on another's. Its alarm is pi's wake, as pi's
// README keeps a Durable Object's.

/** How long a turn under way may go unwatched before its alarm checks on it. */
const heartbeatMs = 60_000;

/**
 * Kept once the object is erased (`erase`), and nothing else: it never
 * opens pi again, so nothing that reaches it later (a note on a decision,
 * a stop) brings back what its chat or person's erasure took.
 */
const erasedKey = "erased";

export class ChatSession extends DurableObject<Env> {
  #opened: Promise<ChatHarness> | undefined;

  /** Set as `erase` begins: the object takes nothing from then on. */
  #erasing = false;

  /** Whether the object is erased, or being erased: its chat is gone. */
  #erased(): boolean {
    return this.#erasing || this.ctx.storage.kv.get(erasedKey) === true;
  }

  /**
   * The chat's Harness, opened at the first call that needs it: pi loads
   * with it, as the chat's first turn, not as core starts. Opened, the
   * turn a restart cut short set up again and resumed, before the object
   * serves any call. Never once the object is erased: its chat is gone.
   */
  async #harness(): Promise<ChatHarness> {
    if (this.#erased()) {
      throw agentErrors.create("agent.chat_not_found");
    }
    this.#opened ??= this.ctx.blockConcurrencyWhile(async () => {
      // A fallback before anything can throw: an object whose open or
      // recovery fails is started again.
      const fallback = Date.now() + heartbeatMs;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > fallback) {
        await this.ctx.storage.setAlarm(fallback);
      }
      const { ChatHarness: Opening } = await import("./chat-harness.ts");
      const harness = await Opening.open(this.ctx, this.env, (wake) => {
        // A failed alarm write resets the object; it arms again as it starts.
        this.ctx.waitUntil(
          this.#arm(wake).catch(() => {
            this.ctx.abort("The chat's alarm could not be set.");
          })
        );
      });
      // Armed before anything runs, as for any call that can start work.
      await this.#arm(harness.wake());
      await harness.setUpStored();
      harness.resume();
      return harness;
    });
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
    // A call that ends after an erase keeps nothing for the object.
    if (this.#erased()) {
      return;
    }
    const heartbeat = wake.active ? Date.now() + heartbeatMs : undefined;
    const at =
      heartbeat === undefined || wake.at === undefined
        ? (heartbeat ?? wake.at)
        : Math.min(heartbeat, wake.at);
    await (at === undefined
      ? this.ctx.storage.deleteAlarm()
      : this.ctx.storage.setAlarm(at));
  }

  /**
   * Makes `call`, which can start work, on the chat's Harness: armed
   * first, as `onWake` only runs after the call's commit, and armed again
   * from what pi says after, as pi tells no change of a call that started
   * nothing.
   */
  async #work<T>(call: (harness: ChatHarness) => Promise<T> | T): Promise<T> {
    const harness = await this.#harness();
    await this.#arm({ ...harness.wake(), active: true });
    try {
      return await call(harness);
    } finally {
      await this.#arm(harness.wake());
    }
  }

  /** Runs the chat's turn `request` to its end (chat-harness.ts). */
  async run(request: TurnRequest): Promise<TurnEnd> {
    return await this.#work(async (harness) => await harness.run(request));
  }

  /** Tells turn `turnId` `text` for it to answer, once a `key`. */
  async notify(turnId: string, key: string, text: string): Promise<void> {
    await this.#work(async (harness) => {
      await harness.notify(turnId, key, text);
    });
  }

  /** Tells the chat's agent `text` for its turn under way or its next. */
  async note(text: string): Promise<void> {
    await this.#work(async (harness) => {
      await harness.note(text);
    });
  }

  /** The chat's turn not yet settled, if there is one (`ChatHarness.run`). */
  async activeTurn(): Promise<string | undefined> {
    return await this.#work((harness) => harness.activeTurn());
  }

  /** Stops the turn under way, if there is one, or turn `turnId` as it starts. */
  async abort(turnId?: string): Promise<void> {
    await this.#work(async (harness) => {
      await harness.abort(turnId);
    });
  }

  /**
   * Deletes everything the chat's agent kept: the chat is being deleted,
   * or its person erased. Kept erased (`erasedKey`), so no call after
   * opens pi again. Asking again erases again.
   */
  async erase(): Promise<void> {
    this.#erasing = true;
    const opened = this.#opened;
    this.#opened = undefined;
    if (opened !== undefined) {
      try {
        const harness = await opened;
        await harness.abort();
        await harness.close();
      } catch {
        // One that failed to open, or to stop, goes with the storage below.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ctx.storage.kv.put(erasedKey, true);
  }

  /** Goes on with a turn a restart cut short, and with what sleeps till now. */
  override async alarm(): Promise<void> {
    if (this.#erased()) {
      return;
    }
    await this.#work((harness) => {
      harness.resume();
    });
  }
}
