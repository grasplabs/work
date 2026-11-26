import type { Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { agentErrors } from "@grasp-os/shared/agent";
import { chatIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { DurableObject } from "cloudflare:workers";

import type {
  ChatHarness,
  ChatHost,
  TurnEnd,
  TurnRequest,
} from "./chat-harness.ts";
import { callObject, workspace } from "./durable-objects.ts";

// One chat's agent: the object that runs its turns on pi-durable
// (chat-harness.ts), named by its Workspace and chat (`chatSession` in
// durable-objects.ts), in the EU. Its storage is the chat's transcript as
// the model reads it, so deleting the chat deletes it whole (`erase`).
// Each chat its own object, as pi-durable's tables take room of their own:
// a Workspace with hundreds of chats isn't made to load them all, and one
// chat's turn never waits on another's. It is the chat's one host
// (`ChatHost`): pi's storage on the object's SQLite, pi's wake on its
// alarm, as pi's README keeps a Durable Object's, and its `waitUntil`.
//
// What holds wherever the object stops (an eviction, a deploy, a reset,
// running out of memory):
// - A turn under way always has an alarm: one armed before pi opens, before
//   any call that can start work, after every call, and whenever pi's wake
//   changes. An early alarm, or one that fires twice, only resumes what pi
//   holds, which does nothing twice; a missing one would strand the turn.
// - pi opens inside `blockConcurrencyWhile`, once at a time, so no call
//   sees a chat half open. One that fails to open isn't kept: the next call
//   or alarm opens it again.
// - pi failed by its storage stays closed (it retries nothing): the object
//   drops it at once and opens another only once it has closed (or resets
//   when that takes past `closeMs`), never two over the same storage; its
//   alarm opens it again at once, so the turn goes on.
// - Every open is counted in storage before it is tried, so a reset (out of
//   memory) counts too; one that works clears the count. The alarm tries
//   one that failed again after 30 s, then 1, 2, 4 and 8 min. After
//   `opensMost` failed in a row, a call's among them, the object stops
//   waking itself and tells its Workspace the chat's turn no longer runs,
//   so it never shows busy for good; a call still tries.
// - An erased object never opens pi again.

/** How long a turn under way may go unwatched before its alarm checks on it. */
const heartbeatMs = 60_000;

/** How soon the alarm first tries an open that failed again, doubling after. */
const reopenMs = 30_000;

/** Opens that fail in a row before the object stops waking itself. */
const opensMost = 6;

/** Most a Harness that failed may take to close before the object resets. */
const closeMs = 30_000;

/**
 * Kept once the object is erased (`erase`), and nothing else: it never
 * opens pi again, so nothing that reaches it later (a note on a decision,
 * a stop) brings back what its chat or person's erasure took.
 */
const erasedKey = "erased";

/** How many opens in a row failed, or are under way: none once one works. */
const failedOpensKey = "failedOpens";

export class ChatSession extends DurableObject<Env> {
  #opened: Promise<ChatHarness> | undefined;

  /** The Harness `#opened` holds, once open: the one a close drops. */
  #current: ChatHarness | undefined;

  /** Settles once the last Harness dropped has closed: none opens over it. */
  #lastClosed: Promise<unknown> = Promise.resolve();

  /** Set as `erase` begins: the object takes nothing from then on. */
  #erasing = false;

  readonly #host: ChatHost = {
    storage: async () =>
      await openDurableObjectSqliteStorage(this.ctx.storage, {
        prefix: "pi_",
      }),
    arm: (wake) => {
      this.ctx.waitUntil(
        (async () => {
          try {
            await this.#arm(wake);
          } catch {
            // A failed alarm write resets the object; it arms again as it starts.
            this.ctx.abort("The chat's alarm could not be set.");
          }
        })()
      );
    },
    waitUntil: (work) => {
      this.ctx.waitUntil(work);
    },
  };

  /** Whether the object is erased, or being erased: its chat is gone. */
  #erased(): boolean {
    return this.#erasing || this.ctx.storage.kv.get(erasedKey) === true;
  }

  /** How many opens in a row failed, the one under way included. */
  #failedOpens(): number {
    const failed = this.ctx.storage.kv.get(failedOpensKey);
    return typeof failed === "number" ? failed : 0;
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
    this.#opened ??= this.#open();
    try {
      return await this.#opened;
    } catch (error) {
      this.#opened = undefined;
      throw error;
    }
  }

  /**
   * Opens pi, sets up the turn a restart cut short and resumes it, inside
   * `blockConcurrencyWhile`, so no call sees it half open. A failure is
   * handed out of the block, never thrown in it, which would reset the
   * object and lose what it wrote: the count of failed opens, which the
   * alarm backs off by (`#retry`).
   */
  async #open(): Promise<ChatHarness> {
    // Never two over one storage: pi writes its last as it closes. Waited
    // for outside the block, and at most `closeMs`: a tool call that never
    // answers holds pi's close, and the object then resets, which ends it.
    await this.#closedOrReset();
    if (this.#erased()) {
      throw agentErrors.create("agent.chat_not_found");
    }
    const opened = await this.ctx.blockConcurrencyWhile(
      async (): Promise<{ harness: ChatHarness } | { error: unknown }> => {
        // A fallback before anything can fail: an object whose open or
        // recovery fails is woken again.
        const fallback = Date.now() + heartbeatMs;
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > fallback) {
          await this.ctx.storage.setAlarm(fallback);
        }
        // Counted before it can fail, by a throw or by a reset.
        this.ctx.storage.kv.put(failedOpensKey, this.#failedOpens() + 1);
        let harness: ChatHarness | undefined;
        try {
          const { ChatHarness: Opening } = await import("./chat-harness.ts");
          harness = await Opening.open(
            this.#host,
            this.ctx.id.name ?? this.ctx.id.toString(),
            this.env
          );
          const opening = harness;
          this.#current = opening;
          opening.onClose(() => {
            this.#drop(opening);
          });
          // Armed before anything runs, as for any call that can start work.
          await this.#arm(opening.wake());
          await opening.setUpStored();
          if (this.#current !== opening) {
            throw new Error("pi closed as it opened");
          }
          // Before pi runs anything: only pi writes this storage meanwhile.
          this.ctx.storage.kv.delete(failedOpensKey);
          opening.resume();
        } catch (error) {
          if (harness !== undefined) {
            // Closed, so the next open is the only pi over this storage.
            this.#drop(harness);
            try {
              await harness.close();
            } catch {
              // Closed by its failure already.
            }
          }
          return { error };
        }
        // Only once open: a failure while it opens is the backoff's.
        void this.#onFailed(harness);
        return { harness };
      }
    );
    if ("error" in opened) {
      log.warn("chat.open_failed", {
        chatSession: this.ctx.id.name,
        failedOpens: this.#failedOpens(),
        ...errorFields(opened.error),
      });
      throw opened.error;
    }
    return opened.harness;
  }

  /**
   * Waits until the last Harness dropped has closed, or resets the object
   * once that takes past `closeMs`: either way no other pi is left over
   * this storage.
   */
  async #closedOrReset(): Promise<void> {
    const waited = await Promise.race([
      this.#lastClosed.then(() => "closed" as const),
      scheduler.wait(closeMs).then(() => "late" as const),
    ]);
    if (waited === "late") {
      log.error("chat.close_overdue", { chatSession: this.ctx.id.name });
      this.ctx.abort("pi did not close");
    }
  }

  /**
   * Lets `harness` go as it begins to close, if it is the one open: the
   * next call opens pi again, once it has closed.
   */
  #drop(harness: ChatHarness): void {
    if (this.#current !== harness) {
      return;
    }
    this.#current = undefined;
    this.#opened = undefined;
    this.#lastClosed = harness.closed;
  }

  /**
   * Once storage failed `harness`, and it has closed: logged, and the
   * alarm armed for now, which opens pi again, so a turn under way goes
   * on with no call to start it.
   */
  async #onFailed(harness: ChatHarness): Promise<void> {
    const end = await harness.closed;
    if (end.reason !== "failed") {
      return;
    }
    log.error("chat.storage_failed", {
      chatSession: this.ctx.id.name,
      ...errorFields(end.error),
    });
    if (!this.#erased()) {
      this.#host.arm({ active: false, at: Date.now() });
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
   * nothing. A pi that failed meanwhile is armed for once it has closed
   * (`#onFailed`).
   */
  async #work<T>(call: (harness: ChatHarness) => Promise<T> | T): Promise<T> {
    const harness = await this.#harness();
    await this.#arm({ ...harness.wake(), active: true });
    try {
      return await call(harness);
    } finally {
      if (this.#current === harness) {
        await this.#arm(harness.wake());
      }
    }
  }

  /**
   * Runs the chat's turn `request` to its end (chat-harness.ts). Should
   * storage fail pi under it, the turn goes on in pi opened again, found
   * by its ID, once: its caller waits on, rather than see it fail.
   */
  async run(request: TurnRequest): Promise<TurnEnd> {
    let used: ChatHarness | undefined;
    try {
      return await this.#work(async (harness) => {
        used = harness;
        return await harness.run(request);
      });
    } catch (error) {
      // pi drops a Harness storage failed before the failing call returns.
      if (used === undefined || this.#current === used || this.#erased()) {
        throw error;
      }
      log.warn("chat.turn_reopened", {
        chatSession: this.ctx.id.name,
        turnId: request.turnId,
      });
      return await this.#work(async (harness) => await harness.run(request));
    }
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
    this.#current = undefined;
    if (opened !== undefined) {
      try {
        const harness = await opened;
        await harness.abort();
        await harness.close();
      } catch {
        // One that failed to open, or to stop, goes with the storage below.
      }
    }
    // Nothing of a pi that failed writes after the storage is gone.
    await this.#lastClosed;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ctx.storage.kv.put(erasedKey, true);
  }

  /**
   * Goes on with a turn a restart cut short, and with what sleeps till
   * now. An open that fails is tried again later (`#retry`), never by the
   * platform's own few retries of an alarm that throws.
   */
  override async alarm(): Promise<void> {
    if (this.#erased()) {
      return;
    }
    try {
      await this.#work((harness) => {
        harness.resume();
      });
    } catch {
      await this.#retry();
    }
  }

  /**
   * After an alarm whose open failed: woken again after the backoff, or,
   * after `opensMost` in a row, no more, the chat's Workspace told its
   * turn no longer runs. A pi that failed after it opened is opened again
   * at the heartbeat.
   */
  async #retry(): Promise<void> {
    const failed = this.#failedOpens();
    if (failed < opensMost) {
      const backoff = failed === 0 ? heartbeatMs : reopenMs * 2 ** (failed - 1);
      await this.ctx.storage.setAlarm(Date.now() + backoff);
      return;
    }
    await this.ctx.storage.deleteAlarm();
    const name = this.ctx.id.name ?? "";
    log.error("chat.gave_up", { chatSession: name, failedOpens: failed });
    const [workspaceId, chatId] = name.split("/");
    try {
      await callObject(async () => {
        await workspace(
          this.env,
          workspaceIdSchema.parse(workspaceId)
        ).turnRunning(chatIdSchema.parse(chatId), false);
      });
    } catch (error) {
      log.error("chat.gave_up_untold", {
        chatSession: name,
        ...errorFields(error),
      });
    }
  }
}
