import { DurableObject } from "cloudflare:workers";

// Who follows one App's or workflow's draft (drafts.ts, drafts-rpc.ts):
// one object per subject, named `kind:id`, holding the pages that follow
// it in memory. Every write tells it (`revised`), which tells each, so
// every open page of the subject takes the write at once, whoever made
// it. Core checks the caller builds the subject before it follows, and
// again before each push (drafts-rpc.ts). A restart loses the followers,
// whose pages read the draft afresh at their next call and follow again.
//
// A write never waits on its followers: the writer tells this object
// without awaiting it (drafts.ts, `draftRevised`), and a page that doesn't
// answer a push in time is dropped, so one that hangs never holds up the
// others. Nobody fills it for the others: past `watchersPerPerson` of one
// person's pages, their oldest stops following.

/**
 * Most pages of one person's that follow one draft at once: a page past
 * it takes the place of their oldest.
 */
const watchersPerPerson = 20;

/** How long a page has to take a push before it is dropped. */
const pushWaitMs = 5000;

/** Where a page that follows a draft hears of its writes: its revision. */
type DraftListener = Rpc.Stub<(revision: number) => Promise<void>>;

export class DraftWatch extends DurableObject<Env> {
  /** The pages that follow the draft (`watch`), by ID, oldest first. */
  readonly #watchers = new Map<
    string,
    { personId: string; listener: DraftListener }
  >();

  /**
   * The draft was written (a chat's agent, a person's edit, a restore, a
   * discard, a publish or a roll back): every page that follows it hears
   * of `revision`, the one it is at now. A page that can't be reached, or
   * doesn't answer within `pushWaitMs`, is dropped.
   */
  async revised(revision: number): Promise<void> {
    await Promise.all(
      [...this.#watchers].map(async ([id, { listener }]) => {
        const late = Promise.withResolvers<"late">();
        const timer = setTimeout(() => {
          late.resolve("late");
        }, pushWaitMs);
        try {
          const answered = await Promise.race([
            listener(revision),
            late.promise,
          ]);
          if (answered === "late") {
            this.#drop(id);
          }
        } catch {
          this.#drop(id);
        } finally {
          clearTimeout(timer);
        }
      })
    );
  }

  /**
   * Follows the draft's writes for one page of `personId`'s (`revised`):
   * `listener` hears each revision. Past `watchersPerPerson` of theirs,
   * their oldest page stops following. Returns the ID `unwatch` drops it
   * by.
   */
  watch(personId: string, listener: DraftListener): string {
    const theirs = [...this.#watchers].filter(
      ([, watcher]) => watcher.personId === personId
    );
    const displaced = Math.max(0, theirs.length - watchersPerPerson + 1);
    for (const [id] of theirs.slice(0, displaced)) {
      this.#drop(id);
    }
    const id = crypto.randomUUID();
    this.#watchers.set(id, { personId, listener: listener.dup() });
    return id;
  }

  /** Stops telling the page `watch` answered `id` for. */
  unwatch(id: string): void {
    this.#drop(id);
  }

  #drop(id: string): void {
    this.#watchers.get(id)?.listener[Symbol.dispose]();
    this.#watchers.delete(id);
  }
}
