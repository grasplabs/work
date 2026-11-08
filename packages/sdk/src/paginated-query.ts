import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { liveWindowMaxItems } from "@grasp-os/shared/store-limits";

import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import type { QueryCache } from "./client-query-cache.ts";
import { keepMs, show } from "./client-query-entry.ts";
import type { QueryEntry } from "./client-query-entry.ts";
import { unfollow } from "./client-query-following.ts";
import { inputOf, readReference } from "./client-request.ts";
import { observe } from "./client-retry.ts";
import {
  failExtension,
  failPager,
  isPageSize,
  pageSizeError,
  pagerChanged,
  snapshotOf,
  windowOf,
} from "./pager.ts";
import type { Extension, Pager } from "./pager.ts";
import { isPlainObject } from "./value-descriptor.ts";

// A paginated list (`usePaginatedQuery`, spec 10.6, 11.6) is one live
// query of its window: the first `extent` records, which core reads
// whole, as one state of the store, at every change (core's
// query-windows.ts). The client never holds a cursor or appends a page.
// Its own failure modes, and how each is closed:
//
// - A Load More appends a page read at another moment, so a record moved
//   between the two shows twice or not at all: it follows a larger window
//   instead, keeps showing the smaller one meanwhile, and shows the
//   larger only once core pushed it, whole, after it began.
// - A late answer lands in another list: each window is its own query,
//   keyed by the list's reference, its canonical arguments and its
//   extent; a list whose arguments change is another list, and nothing
//   of the old one's reaches it.
// - Load More piles up reads: one at a time per list, others joining it;
//   a list holds at most `liveWindowMaxItems` records
//   (`query.window_limit` past it), and each Load More asks for 1 to
//   `queryMaxResults` more.
// - The caller pages itself: `pagination` is refused among the list's
//   arguments, and a query that doesn't page is refused as a list
//   (`contract.not_paginated`).
// - A failure is lost: a Load More's failure rejects its promise, which
//   the client observes itself, and is thrown while rendering, as a
//   query's failure is.
// - A Load More waits forever on a table written faster than its window
//   reads: core refuses that window (`query.concurrent_change`, retryable,
//   its last push), which rejects the Load More and keeps the window
//   shown; a shown window core couldn't read again keeps what it shows
//   and follows again, backing off.
// - One person's list carries over to the next: when someone else signs
//   in, every list starts again at its first page, its failure cleared.

/**
 * A list's arguments, without `pagination`, as JSON: the host checks
 * them with the query's validator, a page added. `pagination` among
 * them is refused: the client supplies it.
 */
const listInput = (args: unknown): Json => {
  if (isPlainObject(args) && Object.hasOwn(args, "pagination")) {
    throw clientError("contract.invalid_args", {
      issues: [
        {
          code: "reserved",
          message:
            "A paginated list supplies pagination itself: pass the query's other arguments.",
          path: ["pagination"],
        },
      ],
    });
  }
  return inputOf(args);
};

/** The client's paginated lists, each one live query of its window. */
export class Pagers {
  readonly #queries: QueryCache;
  readonly #pagers = new Map<string, Pager>();

  constructor(queries: QueryCache) {
    this.#queries = queries;
  }

  /** See `ClientInternals.pager`. */
  pager(reference: unknown, args: unknown, initialPageSize: unknown): Pager {
    if (!isPageSize(initialPageSize)) {
      throw pageSizeError("initialPageSize");
    }
    // Paginated because the caller asked for pages (`usePaginatedQuery`):
    // core refuses a query that takes none (`contract.not_paginated`).
    const read = readReference(reference, "query");
    const input = listInput(args);
    const key = canonicalJson([read.name, input, initialPageSize]);
    const known = this.#pagers.get(key);
    if (known !== undefined) {
      return known;
    }
    // The list its Load More acts on, once it is made just below.
    const made: { pager: Pager | undefined } = { pager: undefined };
    // Not async: an async wrapper would hand back a promise of its own,
    // which nobody observes when a click ignores it.
    // oxlint-disable-next-line typescript/promise-function-async -- see above
    const loadMore = (pageSize?: number): Promise<void> => {
      if (made.pager === undefined) {
        return Promise.resolve();
      }
      const work = this.#loadMore(made.pager, pageSize);
      // Observed here and returned as it is, so a click that ignores it
      // leaves nothing unhandled; its caller still hears of its failure.
      void observe(work);
      return work;
    };
    const current = this.#queries.entryFor(read, input, initialPageSize);
    const pager: Pager = {
      key,
      reference: read,
      input,
      initialPageSize,
      extent: initialPageSize,
      current,
      stopCurrent: undefined,
      extension: undefined,
      first: undefined,
      failure: undefined,
      snapshot: snapshotOf(current, undefined, false, loadMore),
      shown: current.snapshot.value,
      listeners: new Set(),
      evict: undefined,
      loadMore,
    };
    made.pager = pager;
    this.#pagers.set(key, pager);
    // Made for a render that may never subscribe: let go of it unless one does.
    this.#releasePager(pager);
    return pager;
  }

  /** See `ClientInternals.subscribePager`. */
  subscribePager(pager: Pager, onChange: () => void): () => void {
    pager.listeners.add(onChange);
    clearTimeout(pager.evict);
    pager.evict = undefined;
    if (!this.#pagers.has(pager.key)) {
      this.#pagers.set(pager.key, pager);
    }
    pager.stopCurrent ??= this.#queries.subscribe(pager.current, () => {
      pagerChanged(pager);
    });
    pagerChanged(pager);
    return () => {
      pager.listeners.delete(onChange);
      // As a query's: kept across a resubscribe within one task.
      queueMicrotask(() => {
        if (pager.listeners.size === 0) {
          this.#idlePager(pager);
        }
      });
      this.#releasePager(pager);
    };
  }

  /**
   * No one reads `pager` now: its window and its Load More stop, and the
   * list ends. A later reader, such as a page that switched its
   * arguments away and back, starts it again at its first page with no
   * Load More's failure of before (`usePaginatedQuery`).
   */
  #idlePager(pager: Pager): void {
    pager.stopCurrent?.();
    pager.stopCurrent = undefined;
    const { extension, first } = pager;
    pager.extension = undefined;
    pager.first = undefined;
    // Nobody reads the list: what waited on it ends as a no-op.
    extension?.stop?.();
    extension?.done.resolve(null);
    first?.resolve(null);
    pager.failure = undefined;
    if (pager.extent !== pager.initialPageSize) {
      pager.extent = pager.initialPageSize;
      pager.current = this.#queries.entryFor(
        pager.reference,
        pager.input,
        pager.initialPageSize
      );
    }
    pagerChanged(pager);
  }

  /** Drops `pager` once nothing has read it for a while. */
  #releasePager(pager: Pager): void {
    if (pager.listeners.size > 0 || pager.evict !== undefined) {
      return;
    }
    pager.evict = setTimeout(() => {
      pager.evict = undefined;
      if (pager.listeners.size === 0) {
        this.#pagers.delete(pager.key);
      }
    }, keepMs);
  }

  /** See `PaginatedQueryView.loadMore`. */
  async #loadMore(pager: Pager, pageSize: unknown): Promise<void> {
    const size = pageSize ?? pager.initialPageSize;
    if (!isPageSize(size)) {
      throw failPager(pager, pageSizeError("pageSize"));
    }
    if (pager.listeners.size === 0) {
      return;
    }
    const { error, value } = pager.current.snapshot;
    const failed = error ?? pager.failure;
    if (failed !== undefined) {
      throw failed;
    }
    if (pager.extension !== undefined) {
      await pager.extension.done.promise;
      return;
    }
    const window = windowOf(value);
    if (window === undefined) {
      // The first window isn't shown yet: wait for it, adding nothing.
      if (pager.first === undefined) {
        pager.first = Promise.withResolvers<null>();
        void observe(pager.first.promise);
      }
      await pager.first.promise;
      return;
    }
    if (!window.hasMore) {
      return;
    }
    const extent = pager.extent + size;
    if (extent > liveWindowMaxItems) {
      throw failPager(
        pager,
        clientError("query.window_limit", { maxItems: liveWindowMaxItems })
      );
    }
    const entry = this.#queries.entryFor(pager.reference, pager.input, extent);
    const extension: Extension = {
      extent,
      entry,
      stop: undefined,
      since: entry.settled,
      current: false,
      done: Promise.withResolvers<null>(),
    };
    void observe(extension.done.promise);
    pager.extension = extension;
    // A follow from before, pushed to or not yet: its answer may be older
    // than the Load More.
    const followedBefore = entry.live;
    // Its handle is installed before it subscribes: a transport may push
    // at once, which can settle the Load More, and the list then takes
    // the handle over as its own.
    const handle: { unsubscribe?: () => void; stopped: boolean } = {
      stopped: false,
    };
    extension.stop = () => {
      handle.stopped = true;
      handle.unsubscribe?.();
    };
    handle.unsubscribe = this.#queries.subscribe(entry, () => {
      pagerChanged(pager);
    });
    if (handle.stopped) {
      handle.unsubscribe();
    }
    // The larger window is shown only from an answer that came after the
    // Load More began: one cached, or pushed to another list that follows
    // it, may be older than the window shown, as windows of one query are
    // read and pushed on their own. So it is followed afresh.
    if (followedBefore !== undefined && entry.live === followedBefore) {
      unfollow(entry);
      this.#queries.follow(entry, 0);
    }
    // A window that shows a failure already fails the Load More at once:
    // following it again waits for the list to be tried again.
    extension.current = entry.snapshot.error !== undefined;
    pagerChanged(pager);
    await extension.done.promise;
  }

  /** Fails every Load More waiting for `entry`'s window with `error`. */
  failExtensionsOf(entry: QueryEntry, error: GraspError): void {
    for (const pager of this.#pagers.values()) {
      const { extension } = pager;
      if (extension?.entry === entry) {
        failExtension(pager, extension, error);
      }
    }
  }

  /**
   * Stops every Load More under way, as `reason` rejects it: the person
   * or their access changed, and a larger window read before isn't theirs
   * to show.
   */
  cancelExtensions(reason: GraspError): void {
    for (const pager of this.#pagers.values()) {
      pager.failure = undefined;
      // A Load More waiting for the first window is the person before's too.
      pager.first?.reject(reason);
      pager.first = undefined;
      const { extension } = pager;
      if (extension !== undefined) {
        pager.extension = undefined;
        extension.stop?.();
        extension.done.reject(reason);
      }
    }
  }

  /**
   * Someone else signed in: every list starts again at its first page, as
   * the person now, so nothing of the person before (how far they loaded)
   * carries over.
   */
  restartPagers(refusal?: GraspError): void {
    for (const pager of this.#pagers.values()) {
      if (pager.extent === pager.initialPageSize) {
        // Its snapshot shows what its first page shows now, read by a
        // remount at once, whether or not anyone listens meanwhile.
        pagerChanged(pager);
        continue;
      }
      const before = pager.stopCurrent;
      pager.extent = pager.initialPageSize;
      pager.current = this.#queries.entryFor(
        pager.reference,
        pager.input,
        pager.initialPageSize
      );
      // At a fence, the first page shows the refusal too, read only once
      // the list is tried again.
      if (refusal !== undefined && pager.current.snapshot.error === undefined) {
        show(pager.current, { value: undefined, error: refusal });
      }
      pager.stopCurrent =
        pager.listeners.size > 0
          ? this.#queries.subscribe(pager.current, () => {
              pagerChanged(pager);
            })
          : undefined;
      before?.();
      pagerChanged(pager);
    }
  }

  /** Clears every list's Load More failure: the lists are tried again. */
  clearFailures(): void {
    for (const pager of this.#pagers.values()) {
      pager.failure = undefined;
    }
  }

  /** Tells every list's readers of what it shows now. */
  changedAll(): void {
    for (const pager of this.#pagers.values()) {
      pagerChanged(pager);
    }
  }
}
