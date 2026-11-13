import { DurableObject } from "cloudflare:workers";

// Who follows one App's or workflow's draft (drafts.ts, drafts-rpc.ts):
// one object per subject, named `kind:id`, holding the pages that follow
// it in memory. Every write tells it (`revised`), which tells each, so
// every open page of the subject takes the write at once, whoever made
// it. Core checks the caller builds the subject before it follows, and
// again before each push (drafts-rpc.ts). A restart loses the followers,
// whose pages read the draft afresh at their next call and follow again.

/** Where a page that follows a draft hears of its writes: its revision. */
type DraftListener = Rpc.Stub<(revision: number) => Promise<void>>;

export class DraftWatch extends DurableObject<Env> {
  /** The pages that follow the draft (`watch`), by ID, oldest first. */
  readonly #watchers = new Map<string, DraftListener>();

  /**
   * The draft was written (a chat's agent, a person's edit, a restore, a
   * discard, a publish or a roll back): every page that follows it hears
   * of `revision`, the one it is at now. A page that can't be reached is
   * dropped.
   */
  async revised(revision: number): Promise<void> {
    await Promise.all(
      [...this.#watchers].map(async ([id, listener]) => {
        try {
          await listener(revision);
        } catch {
          this.#drop(id);
        }
      })
    );
  }

  /**
   * Follows the draft's writes for one page (`revised`): `listener` hears
   * each revision. How many one connection follows is its own to bound
   * (drafts-rpc.ts). Returns the ID `unwatch` drops it by.
   */
  watch(listener: DraftListener): string {
    const id = crypto.randomUUID();
    this.#watchers.set(id, listener.dup());
    return id;
  }

  /** Stops telling the page `watch` answered `id` for. */
  unwatch(id: string): void {
    this.#drop(id);
  }

  #drop(id: string): void {
    this.#watchers.get(id)?.[Symbol.dispose]();
    this.#watchers.delete(id);
  }
}
