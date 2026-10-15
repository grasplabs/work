import { errorFields, log } from "@grasp-os/shared/log";
import {
  querySubscriptionLimits,
  screenErrors,
} from "@grasp-os/shared/screens";

// The live queries a business store's object tells of its writes
// (data-store.ts): each one core is keeping fresh for a screen
// (query-subscriptions.ts), by the tables its last read read and the
// generation it read each at. Every write that moves a table's generation
// (a commit, a migration or backfill batch) is told here once its
// transaction is over (store-host.ts, `onTablesMoved`), and every watch
// that read one of those tables at an older generation is told; core
// reads that query again. Threat model, and how each is closed:
//
// - A change slips between a query's read and its watch (read, then
//   subscribe): a watch is registered with the generations its read saw,
//   compared with the store's current ones as it is registered, with
//   nothing awaited between, and told at once when one moved on.
// - A write is lost between its commit and the telling (the object dies
//   in between): the watches die with the object. Core hears of that
//   when its watcher is let go, and in any case at its next `rewatch`,
//   which it makes now and then for every watch and which answers false
//   for one this object doesn't hold; it then reads the query again and
//   watches anew, comparing generations as above. So no durable record of
//   the telling is needed.
// - A telling twice, or late: a watch is told only of a table it read at
//   an older generation than the one named.
// - Screens gone without a word fill the object with watches: core holds
//   a page to its subscriptions; this object holds each person to
//   `querySubscriptionLimits.perPerson` and the store to
//   `storeMaxWatches`. Before refusing one, it lets go of every watch
//   whose watcher no longer answers: the person's at their bound, and
//   everyone's at the store's (each at most once per `sweepGapMs`), and
//   everyone's from the alarm (`sweep`). A watcher that fails to take a
//   telling is let go at once. A refusal at the store's bound is one core
//   tries again later, never one that stops a screen for good.
// - One slow screen holds up the rest: each telling goes on by itself.
// - Telling leaks data: a telling carries table names only, to core,
//   which reads the query again as its person before anything reaches a
//   screen.

/**
 * Core's watcher of one live query, as the store keeps it: called with
 * the names of the tables a write changed, or with none to see whether
 * it is still there.
 */
export type StoreWatcher = Rpc.Stub<(tables: string[]) => void>;

/** Most watches one store keeps at once, across everyone. */
export const storeMaxWatches = 10_000;

/** How long a watcher has to answer whether it is still there. */
const pingMs = 2000;

/** The least time between two sweeps of one person's watches, or of all. */
const sweepGapMs = 5000;

interface Watch {
  readonly principal: string;
  readonly watcher: StoreWatcher;
  /** The tables its query read, at the generation it read each. */
  readSet: Record<string, number>;
}

/** Resolves `true` once `work` settles, or `false` after `ms`. */
const answersWithin = async (
  work: Promise<unknown>,
  ms: number
): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => {
    resolve(false);
  }, ms);
  const settles = async (): Promise<void> => {
    try {
      await work;
      resolve(true);
    } catch {
      resolve(false);
    }
  };
  // A watcher that never answers is not waited for past `ms`.
  void settles();
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
};

/** The watches one store's object keeps, in memory: a restart drops them. */
export class StoreWatches {
  readonly #watches = new Map<string, Watch>();
  /** How many watches each person holds. */
  readonly #counts = new Map<string, number>();
  /** When each person's watches, and everyone's (`""`), were last swept. */
  readonly #swept = new Map<string, number>();

  /** How many watches it holds. */
  get size(): number {
    return this.#watches.size;
  }

  /**
   * Keeps `watcher` (dup'd: the call's own stub ends with the call) for
   * `principal`'s query, which read the tables of `readSet` at those
   * generations. Answers the watch's ID, and whether `current` (the
   * store's generations now, read with nothing awaited since) has moved
   * past any of them already; or refuses with
   * `screen.too_many_queries`, for core to try again later.
   */
  async watch(
    principal: string,
    readSet: Record<string, number>,
    watcher: StoreWatcher,
    current: () => Record<string, number>
  ): Promise<{ id: string; moved: boolean }> {
    if (this.#countOf(principal) >= querySubscriptionLimits.perPerson) {
      await this.#sweepOnce(principal);
    }
    if (this.#watches.size >= storeMaxWatches) {
      await this.#sweepOnce("");
    }
    if (
      this.#countOf(principal) >= querySubscriptionLimits.perPerson ||
      this.#watches.size >= storeMaxWatches
    ) {
      throw screenErrors.create("screen.too_many_queries");
    }
    const id = crypto.randomUUID();
    this.#watches.set(id, { principal, watcher: watcher.dup(), readSet });
    this.#counts.set(principal, this.#countOf(principal) + 1);
    // Whether a write moved what it read since: answered with its ID
    // rather than told through the watcher, which core can only match to
    // the watch once it has the ID.
    const moved = StoreWatches.#moved(readSet, current()).length > 0;
    return { id, moved };
  }

  /**
   * Moves watch `id` on to what its query read again (`readSet`), told at
   * once as `watch` tells; false when there is no such watch (this
   * object restarted since), which then has to be made again.
   */
  rewatch(
    id: string,
    readSet: Record<string, number>,
    current: () => Record<string, number>
  ): boolean {
    const watch = this.#watches.get(id);
    if (watch === undefined) {
      return false;
    }
    watch.readSet = readSet;
    this.#check(id, current());
    return true;
  }

  /** Lets go of watch `id`, if it is still kept. */
  unwatch(id: string): void {
    const watch = this.#watches.get(id);
    if (watch === undefined) {
      return;
    }
    this.#watches.delete(id);
    const left = this.#countOf(watch.principal) - 1;
    if (left > 0) {
      this.#counts.set(watch.principal, left);
    } else {
      this.#counts.delete(watch.principal);
    }
    watch.watcher[Symbol.dispose]();
  }

  /**
   * Tells every watch that read one of `tables` at an older generation
   * than the one named: a write changed it since. Returns at once.
   */
  changed(tables: Readonly<Record<string, number>>): void {
    for (const id of this.#watches.keys()) {
      this.#check(id, tables);
    }
  }

  /** Lets go of every watch whose watcher doesn't answer (the alarm's). */
  async sweep(): Promise<void> {
    await this.#sweepOf([...this.#watches]);
  }

  /** The tables of `generations` watch `id` read at an older one. */
  #check(id: string, generations: Readonly<Record<string, number>>): void {
    const watch = this.#watches.get(id);
    if (watch === undefined) {
      return;
    }
    const moved = StoreWatches.#moved(watch.readSet, generations);
    if (moved.length > 0) {
      void this.#tell(id, watch, moved);
    }
  }

  /** The tables of `readSet` that `generations` moved past. */
  static #moved(
    readSet: Readonly<Record<string, number>>,
    generations: Readonly<Record<string, number>>
  ): string[] {
    return Object.entries(readSet).flatMap(([table, read]) => {
      const now = Object.hasOwn(generations, table)
        ? generations[table]
        : undefined;
      return now !== undefined && now > read ? [table] : [];
    });
  }

  async #tell(id: string, watch: Watch, tables: string[]): Promise<void> {
    try {
      await watch.watcher(tables);
    } catch (error) {
      log.info("store.watcher_gone", errorFields(error));
      if (this.#watches.get(id) === watch) {
        this.unwatch(id);
      }
    }
  }

  #countOf(principal: string): number {
    return this.#counts.get(principal) ?? 0;
  }

  /**
   * Sweeps `principal`'s watches (everyone's for `""`), unless they were
   * swept within `sweepGapMs`: a page at its bound asking over and over
   * pings them once, not on every ask.
   */
  async #sweepOnce(principal: string): Promise<void> {
    const now = Date.now();
    if (
      now - (this.#swept.get(principal) ?? Number.NEGATIVE_INFINITY) <
      sweepGapMs
    ) {
      return;
    }
    // Only sweeps within the gap matter: older ones are forgotten, so
    // this holds at most the people swept in the last `sweepGapMs`.
    for (const [who, at] of this.#swept) {
      if (now - at >= sweepGapMs) {
        this.#swept.delete(who);
      }
    }
    this.#swept.set(principal, now);
    await this.#sweepOf(
      [...this.#watches].filter(
        ([, watch]) => principal === "" || watch.principal === principal
      )
    );
  }

  /** Lets go of each of `watches` whose watcher doesn't answer. */
  async #sweepOf(watches: readonly [string, Watch][]): Promise<void> {
    const answers = await Promise.all(
      watches.map(
        async ([, watch]) => await answersWithin(watch.watcher([]), pingMs)
      )
    );
    for (const [index, [id, watch]] of watches.entries()) {
      if (answers[index] !== true && this.#watches.get(id) === watch) {
        this.unwatch(id);
      }
    }
  }
}
