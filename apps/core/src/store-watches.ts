import { errorFields, log } from "@grasp-os/shared/log";
import {
  querySubscriptionLimits,
  screenErrors,
} from "@grasp-os/shared/screens";

// The live queries a business store's object tells of its commits
// (data-store.ts): each one core is keeping fresh for a screen
// (query-subscriptions.ts), by the tables its last evaluation read and
// the generation it read each at. A commit's `store.changed` outbox entry
// names the tables it changed and the generation it moved each to; every
// watch that read one of them at an older generation is told, and core
// reads that query again. Threat model, and how each is closed:
//
// - A change slips between a query's read and its watch (read, then
//   subscribe): a watch is registered with the generations its read saw,
//   compared with the store's current ones as it is registered, with
//   nothing awaited between, and told at once when one moved on.
// - A commit is lost between its write and the telling (the object dies
//   in between): the entry commits with the records and is handed over
//   again once the object wakes (the outbox's own guarantees); the
//   watches died with the object, and core hears that (its watcher is
//   let go), reads its queries again and watches anew, which compares
//   generations as above.
// - An entry handed over twice, or late: a watch is told only of a table
//   it read at an older generation than the entry's, so a replay of an
//   old entry tells nobody who read after it.
// - A screen gone without a word fills the object with watches: core
//   holds a screen to its subscriptions, and this object holds each
//   person to `querySubscriptionLimits.perPerson`, letting go of every
//   watch whose watcher no longer answers before it refuses one, and the
//   whole store to `storeMaxWatches`. A watcher that fails to take a
//   telling is let go at once.
// - One slow screen holds up the rest: each telling goes on by itself;
//   the hand-over of the entry returns at once.
// - Telling leaks data: a telling carries table names only, to core,
//   which reads the query again as its person before anything reaches a
//   screen.

/**
 * Core's watcher of one live query, as the store keeps it: called with
 * the names of the tables a commit changed, or with none to see whether
 * it is still there.
 */
export type StoreWatcher = Rpc.Stub<(tables: string[]) => void>;

/** Most watches one store keeps at once, across everyone. */
export const storeMaxWatches = 10_000;

/** How long a watcher has to answer whether it is still there. */
const pingMs = 2000;

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
  try {
    await work;
    resolve(true);
  } catch {
    resolve(false);
  } finally {
    clearTimeout(timer);
  }
  return await promise;
};

/** The watches one store's object keeps, in memory: a restart drops them. */
export class StoreWatches {
  readonly #watches = new Map<string, Watch>();

  /**
   * Keeps `watcher` (dup'd: the call's own stub ends with the call) for
   * `principal`'s query, which read the tables of `readSet` at those
   * generations; tells it at once when `current` (the store's
   * generations now, read with nothing awaited since) has moved past
   * any. Answers the watch's ID, or refuses with `TooManyWatchesError`.
   */
  async watch(
    principal: string,
    readSet: Record<string, number>,
    watcher: StoreWatcher,
    current: () => Record<string, number>
  ): Promise<string> {
    if (this.#count(principal) >= querySubscriptionLimits.perPerson) {
      await this.#sweep(principal);
    }
    if (
      this.#count(principal) >= querySubscriptionLimits.perPerson ||
      this.#watches.size >= storeMaxWatches
    ) {
      throw screenErrors.create("screen.too_many_queries");
    }
    const id = crypto.randomUUID();
    this.#watches.set(id, { principal, watcher: watcher.dup(), readSet });
    this.#check(id, current());
    return id;
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
    this.#watches.delete(id);
    watch?.watcher[Symbol.dispose]();
  }

  /**
   * Tells every watch that read one of `tables` at an older generation
   * than the one named: a commit changed it since. Returns at once.
   */
  changed(tables: Readonly<Record<string, number>>): void {
    for (const id of this.#watches.keys()) {
      this.#check(id, tables);
    }
  }

  /** The tables of `generations` watch `id` read at an older one. */
  #check(id: string, generations: Readonly<Record<string, number>>): void {
    const watch = this.#watches.get(id);
    if (watch === undefined) {
      return;
    }
    const moved = Object.entries(watch.readSet).flatMap(([table, read]) => {
      const now = Object.hasOwn(generations, table)
        ? generations[table]
        : undefined;
      return now !== undefined && now > read ? [table] : [];
    });
    if (moved.length > 0) {
      void this.#tell(id, watch, moved);
    }
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

  #count(principal: string): number {
    let count = 0;
    for (const watch of this.#watches.values()) {
      if (watch.principal === principal) {
        count += 1;
      }
    }
    return count;
  }

  /** Lets go of every watch of `principal`'s whose watcher doesn't answer. */
  async #sweep(principal: string): Promise<void> {
    const theirs = [...this.#watches].filter(
      ([, watch]) => watch.principal === principal
    );
    const answers = await Promise.all(
      theirs.map(
        async ([, watch]) => await answersWithin(watch.watcher([]), pingMs)
      )
    );
    for (const [index, [id, watch]] of theirs.entries()) {
      if (answers[index] !== true && this.#watches.get(id) === watch) {
        this.unwatch(id);
      }
    }
  }
}
