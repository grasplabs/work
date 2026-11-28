import { SessionFailed } from "@earendil-works/pi-durable";
import type { Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { agentErrors } from "@grasp-os/shared/agent";
import { chatIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { DurableObject } from "cloudflare:workers";

import type {
  ChatHarness,
  ChatHost,
  QueuedQuestion,
  TurnEnd,
  TurnRequest,
} from "./chat-harness.ts";
import { workspace } from "./durable-objects.ts";

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

/** When the alarm tries again after `failed` opens failed in a row. */
const backoffMs = (failed: number): number =>
  failed === 0 ? heartbeatMs : reopenMs * 2 ** (failed - 1);

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

/**
 * Kept once the object gave the chat's turn up (`#giveUp`): the next open
 * settles that turn as lost, as its Workspace showed it.
 */
const lostKey = "lost";

/** pi's failure of its storage, in the words a person may read. */
const lostOf = (error: unknown): unknown =>
  error instanceof SessionFailed
    ? agentErrors.create("agent.turn_lost")
    : error;

/** How many times in a row storage failed pi once open (`#onFailed`). */
const storageFailuresKey = "storageFailures";

/** How many opens in a row failed, or are under way: none once one works. */
const failedOpensKey = "failedOpens";

/**
 * pi's code (chat-harness.ts), once this isolate has loaded it: with its
 * first chat's open, not as core starts, and never again. Kept as the
 * class, never as a promise of it: an isolate hosts many chats, and a
 * promise belongs to the object that made it, which then runs or holds
 * whatever another object awaits on it.
 */
let harnessClass: typeof ChatHarness | undefined;

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
    // pi's code loads before the block, not in it: loading is the isolate's,
    // once for every chat it hosts, and can take long (a cold isolate, one
    // starved of CPU, the tests' runtime fetching each module), while the
    // block resets the object past 30 s. Calls meanwhile still wait on this
    // open (`#harness`); the block holds only what is this object's.
    let loadFailure: unknown;
    try {
      if (harnessClass === undefined) {
        const { ChatHarness: loaded } = await import("./chat-harness.ts");
        harnessClass = loaded;
      }
    } catch (error) {
      // Taken up in the block, so it counts as an open that failed.
      loadFailure = error;
    }
    if (this.#erased()) {
      throw agentErrors.create("agent.chat_not_found");
    }
    const opened = await this.ctx.blockConcurrencyWhile(
      async (): Promise<{ harness: ChatHarness } | { error: unknown }> => {
        // Counted before it can fail, by a throw or by a reset; and a
        // fallback set first, at the backoff should this open fail too: an
        // object whose open resets it is woken again, later each time.
        const failed = this.#failedOpens() + 1;
        const fallback = Date.now() + backoffMs(failed);
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > fallback) {
          await this.ctx.storage.setAlarm(fallback);
        }
        this.ctx.storage.kv.put(failedOpensKey, failed);
        let harness: ChatHarness | undefined;
        try {
          if (harnessClass === undefined) {
            throw loadFailure;
          }
          harness = await harnessClass.open(
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
          // A turn given up on meanwhile (`#giveUp`) is settled as lost.
          await opening.setUpStored(this.ctx.storage.kv.get(lostKey) === true);
          if (this.#current !== opening) {
            throw new Error("pi closed as it opened");
          }
          // Before pi runs anything: only pi writes this storage meanwhile.
          this.ctx.storage.kv.delete(failedOpensKey);
          this.ctx.storage.kv.delete(lostKey);
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
    await this.#withinOrReset(async () => await this.#lastClosed);
  }

  /** Waits for `work` at most `closeMs`, else resets the object. */
  async #withinOrReset(work: () => Promise<unknown>): Promise<void> {
    const waited = await Promise.race([
      work().then(() => "done" as const),
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
    if (end.kind !== "failed") {
      return;
    }
    // Counted, so storage that fails again after each open that works
    // (say, every time a turn's answer is stored) stops: the turn's paid
    // requests aren't sent again without end.
    const failures = this.#storageFailures() + 1;
    this.ctx.storage.kv.put(storageFailuresKey, failures);
    log.error("chat.storage_failed", {
      chatSession: this.ctx.id.name,
      failures,
      ...errorFields(end.error),
    });
    if (this.#erased()) {
      return;
    }
    if (failures >= opensMost) {
      await this.#giveUp();
      return;
    }
    // At once the first time, then later each time.
    this.#host.arm({
      active: false,
      at: Date.now() + (failures === 1 ? 0 : backoffMs(failures - 1)),
    });
  }

  /** How many times in a row storage failed pi once open. */
  #storageFailures(): number {
    const failures = this.ctx.storage.kv.get(storageFailuresKey);
    return typeof failures === "number" ? failures : 0;
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
        // No turn left unsettled: whatever failed before is behind it.
        if (harness.activeTurn() === undefined) {
          this.ctx.storage.kv.delete(storageFailuresKey);
        }
      }
    }
  }

  /**
   * Runs the chat's turn `request` to its end (chat-harness.ts). Should
   * storage fail pi under it, the turn goes on in pi opened again, found
   * by its ID: its caller waits on, rather than see it fail, for as many
   * failures as an open may fail (`opensMost`). Past that, or when pi
   * can't open, the caller hears it in our words, never pi's.
   */
  async run(request: TurnRequest): Promise<TurnEnd> {
    for (let failures = 0; ; failures += 1) {
      let used: ChatHarness | undefined;
      try {
        // oxlint-disable-next-line no-await-in-loop -- again only once pi failed
        return await this.#work(async (harness) => {
          used = harness;
          return await harness.run(request);
        });
      } catch (error) {
        // pi drops a Harness storage failed before the failing call returns.
        const dropped =
          used !== undefined && this.#current !== used && !this.#erased();
        if (!dropped || failures + 1 >= opensMost) {
          throw dropped ? agentErrors.create("agent.turn_lost") : lostOf(error);
        }
        log.warn("chat.turn_reopened", {
          chatSession: this.ctx.id.name,
          turnId: request.turnId,
        });
      }
    }
  }

  /**
   * Queues `question` into the chat's turn `turnId`, which runs
   * (`ChatHarness.queueQuestion`): false when that turn takes no more.
   */
  async queueQuestion(
    turnId: string,
    question: QueuedQuestion
  ): Promise<boolean> {
    return await this.#work(
      async (harness) => await harness.queueQuestion(turnId, question)
    );
  }

  /** Has turn `turnId` take its queued questions now (`ChatHarness.sendNow`). */
  async sendNow(turnId: string): Promise<void> {
    await this.#work(async (harness) => {
      await harness.sendNow(turnId);
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

  /**
   * Stops the turn under way, if there is one, or turn `turnId` as it
   * starts: the words of the questions queued into it that it dropped.
   */
  async abort(turnId?: string): Promise<string[]> {
    return await this.#work(async (harness) => await harness.abort(turnId));
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
        // At most `closeMs`, as a tool call that never answers holds both:
        // the object then resets, and the erase is asked again.
        await this.#withinOrReset(async () => {
          await harness.abort();
          await harness.close();
        });
      } catch {
        // One that failed to open, or to stop, goes with the storage below.
      }
    }
    // Nothing of a pi that failed writes after the storage is gone; one
    // that never closes resets the object, and the erase is asked again.
    await this.#closedOrReset();
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
    // Opens that keep failing, by a throw or by a reset, stop here: only a
    // call opens pi again.
    if (this.#current === undefined && this.#failedOpens() >= opensMost) {
      await this.#giveUp();
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
      await this.ctx.storage.setAlarm(Date.now() + backoffMs(failed));
      return;
    }
    await this.#giveUp();
  }

  /**
   * Stops waking the object for opens that keep failing, once its
   * Workspace is told the chat's turn no longer runs: until it is, the
   * alarm tells it again later, never opening pi meanwhile.
   */
  async #giveUp(): Promise<void> {
    // Inside the block, so no call opens pi meanwhile: one that comes waits,
    // and opens it after; one that came first keeps it, and its wake.
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.#current !== undefined || this.#opened !== undefined) {
        return;
      }
      const name = this.ctx.id.name ?? "";
      // Kept first: the next open settles the turn as the Workspace shows it.
      this.ctx.storage.kv.put(lostKey, true);
      log.error("chat.gave_up", {
        chatSession: name,
        failedOpens: this.#failedOpens(),
      });
      // A fallback first: a notice that fails, or resets the object, leaves
      // an alarm that tells it again. One attempt, inside the block, with
      // no retry that could land after a later open said the turn runs.
      await this.ctx.storage.setAlarm(Date.now() + backoffMs(opensMost));
      const [workspaceId, chatId] = name.split("/");
      try {
        await workspace(
          this.env,
          workspaceIdSchema.parse(workspaceId)
        ).turnLost(chatIdSchema.parse(chatId));
      } catch (error) {
        log.error("chat.gave_up_untold", {
          chatSession: name,
          ...errorFields(error),
        });
        return;
      }
      await this.ctx.storage.deleteAlarm();
    });
  }
}
