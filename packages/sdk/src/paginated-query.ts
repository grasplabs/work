import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { queryMaxScannedEntries } from "@grasp-os/shared/store-limits";

import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import type { QueryCache } from "./client-query-cache.ts";
import { keepMs, show } from "./client-query-entry.ts";
import { inputOf, readReference } from "./client-request.ts";
import { observe } from "./client-retry.ts";
import {
  failPager,
  isPageSize,
  pageOf,
  pageSizeError,
  pagerChanged,
  shownPage,
  snapshotOf,
} from "./pager.ts";
import type { ListPage, Pager } from "./pager.ts";
import { isPlainObject } from "./value-descriptor.ts";

// A paginated list (`usePaginatedQuery`) follows each of its pages as a
// live query of its own, as Convex does: a page is the query with its
// `pagination` argument, its cursor and size, and once a page follows it,
// the cursor that page starts at as its end (`endCursor`). Core keeps
// each page fresh on its own and pushes only a page whose answer changed,
// so a write costs what the pages it touches cost, never a read of the
// whole list. Its own failure modes, and how each is closed:
//
// - Records move between pages, so one shows twice or not at all: every
//   page but the last ends at the cursor the next starts at, read by the
//   store as a bound (core's store-queries.ts, `readPage`), so a page
//   grows or shrinks as records move in and out of it, and the pages
//   tile the query whatever changes. The last page is bounded by its
//   size: a record moved past it shows once more is loaded.
// - A Load More gives the last page its end, a query of its own: until
//   that answers, the page shows what it showed, so nothing flickers.
// - A cursor no longer applies (the App published a new version, or a
//   search's anchor record went): a page fails with `data.cursor_expired`
//   or `data.invalid_cursor`, and the list starts again with one first
//   page as long as what it showed, showing that meanwhile.
// - A late answer lands in another list: each page is its own query,
//   keyed by the list's reference, its canonical arguments and its
//   pagination; a list whose arguments change is another list.
// - Load More piles up pages: one at a time per list, others joining it.
//   Each page is bounded as any read is, by the records it examines.
// - The caller pages itself: `pagination` is refused among the list's
//   arguments, and a query that doesn't page is refused by core
//   (`contract.not_paginated`).
// - A failure is lost: a Load More's failure rejects its promise, which
//   the client observes itself, and is thrown while rendering, as a
//   query's failure is.
// - One person's list carries over to the next: when someone else signs
//   in, every list starts again at its first page, its failure cleared.

/** The codes of a cursor a page's query refused: from before a change. */
const cursorRefusals: ReadonlySet<string> = new Set([
  "data.invalid_cursor",
  "data.cursor_expired",
]);

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

/** The client's paginated lists, each a live query per page. */
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
    const pager: Pager = {
      key,
      reference: read,
      input,
      initialPageSize,
      pages: [],
      waiting: undefined,
      held: undefined,
      failure: undefined,
      snapshot: {
        view: { items: [], hasMore: false, isLoading: true, loadMore },
        error: undefined,
      },
      shown: [],
      listeners: new Set(),
      evict: undefined,
      loadMore,
    };
    pager.pages = [this.#page(pager, null, null, initialPageSize)];
    ({ snapshot: pager.snapshot, shown: pager.shown } = snapshotOf(pager));
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
    for (const page of pager.pages) {
      this.#follow(pager, page);
    }
    this.#changed(pager);
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

  /** Page `cursor` to `endCursor` of `pager`'s query, `pageSize` records. */
  #page(
    pager: Pager,
    cursor: string | null,
    endCursor: string | null,
    pageSize: number
  ): ListPage {
    const input: Json = {
      ...(isPlainObject(pager.input) ? pager.input : {}),
      pagination: {
        pageSize,
        cursor,
        ...(endCursor === null ? {} : { endCursor }),
      },
    };
    return {
      cursor,
      endCursor,
      pageSize,
      entry: this.#queries.entryFor(pager.reference, input),
      stop: undefined,
      held: undefined,
    };
  }

  /** Follows `page` for `pager`, while the list has readers. */
  #follow(pager: Pager, page: ListPage): void {
    if (pager.listeners.size === 0 || page.stop !== undefined) {
      return;
    }
    page.stop = this.#queries.subscribe(page.entry, () => {
      this.#changed(pager);
    });
  }

  /** Stops following every page of `pager`'s. */
  static #stopPages(pager: Pager): void {
    for (const page of pager.pages) {
      page.stop?.();
      page.stop = undefined;
    }
  }

  /**
   * Something `pager` shows changed: a page whose cursor no longer applies
   * starts the list again; a page that answered lets go of what it held,
   * and a Load More waiting on the last page settles; then its readers
   * are told of its new snapshot, if it is new.
   */
  #changed(pager: Pager): void {
    const expired = pager.pages.some(
      (page) =>
        (page.cursor !== null || page.endCursor !== null) &&
        cursorRefusals.has(page.entry.snapshot.error?.code ?? "")
    );
    if (expired) {
      this.#restart(pager, pager.snapshot.view.items);
      return;
    }
    for (const page of pager.pages) {
      const { value } = page.entry.snapshot;
      if (page.held !== undefined && value !== undefined) {
        page.held = undefined;
      }
      // A query that answers something other than a page doesn't page.
      if (value !== undefined && pageOf(value) === undefined) {
        pager.failure ??= clientError("contract.not_paginated");
      }
    }
    const last = pager.pages.at(-1);
    if (pager.waiting !== undefined && last !== undefined) {
      const { error } = last.entry.snapshot;
      if (error !== undefined) {
        pager.waiting.reject(error);
        pager.waiting = undefined;
      } else if (shownPage(last) !== undefined) {
        pager.waiting.resolve(null);
        pager.waiting = undefined;
      }
    }
    const [first] = pager.pages;
    if (first !== undefined && shownPage(first) !== undefined) {
      pager.held = undefined;
    }
    pagerChanged(pager);
  }

  /**
   * Starts `pager` again with one first page, as long as `items` (what it
   * showed, kept on screen until that page answers) or its first size.
   */
  #restart(pager: Pager, items?: readonly unknown[]): void {
    Pagers.#stopPages(pager);
    const size = Math.min(
      queryMaxScannedEntries,
      Math.max(pager.initialPageSize, items?.length ?? 0)
    );
    pager.pages = [this.#page(pager, null, null, size)];
    pager.held = items === undefined || items.length === 0 ? undefined : items;
    for (const page of pager.pages) {
      this.#follow(pager, page);
    }
    this.#changed(pager);
  }

  /**
   * No one reads `pager` now: its pages stop, and the list ends. A later
   * reader, such as a page that switched its arguments away and back,
   * starts it again at its first page with no Load More's failure of
   * before (`usePaginatedQuery`).
   */
  #idlePager(pager: Pager): void {
    Pagers.#stopPages(pager);
    // Nobody reads the list: what waited on it ends as a no-op.
    pager.waiting?.resolve(null);
    pager.waiting = undefined;
    pager.failure = undefined;
    pager.held = undefined;
    const [first] = pager.pages;
    if (
      pager.pages.length !== 1 ||
      first?.endCursor !== null ||
      first.pageSize !== pager.initialPageSize
    ) {
      pager.pages = [this.#page(pager, null, null, pager.initialPageSize)];
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
    const failed = pager.snapshot.error ?? pager.failure;
    if (failed !== undefined) {
      throw failed;
    }
    if (pager.waiting !== undefined) {
      await pager.waiting.promise;
      return;
    }
    const last = pager.pages.at(-1);
    const shown = last === undefined ? undefined : shownPage(last);
    if (last === undefined || shown === undefined) {
      // The last page isn't shown yet: wait for it, adding nothing.
      pager.waiting = Promise.withResolvers<null>();
      void observe(pager.waiting.promise);
      await pager.waiting.promise;
      return;
    }
    if (!shown.hasMore || shown.nextCursor === null) {
      return;
    }
    // The last page ends where it ends now, as a query of its own that
    // shows what it showed until it answers; the new page starts there.
    const ended: ListPage = {
      ...this.#page(pager, last.cursor, shown.nextCursor, last.pageSize),
      held: shown,
    };
    last.stop?.();
    last.stop = undefined;
    const next = this.#page(pager, shown.nextCursor, null, size);
    pager.pages = [...pager.pages.slice(0, -1), ended, next];
    pager.waiting = Promise.withResolvers<null>();
    const { promise } = pager.waiting;
    void observe(promise);
    this.#follow(pager, ended);
    this.#follow(pager, next);
    this.#changed(pager);
    await promise;
  }

  /**
   * Stops every Load More under way, as `reason` rejects it: the person
   * or their access changed, and a page read before isn't theirs to show.
   */
  cancelLoads(reason: GraspError): void {
    for (const pager of this.#pagers.values()) {
      pager.failure = undefined;
      pager.waiting?.reject(reason);
      pager.waiting = undefined;
    }
  }

  /**
   * Someone else signed in: every list starts again at its first page, as
   * the person now, so nothing of the person before (how far they loaded)
   * carries over. At a fence, the first page shows `refusal` too, read
   * only once the list is tried again.
   */
  restartPagers(refusal?: GraspError): void {
    for (const pager of this.#pagers.values()) {
      this.#restart(pager);
      const [first] = pager.pages;
      if (
        refusal !== undefined &&
        first !== undefined &&
        first.entry.snapshot.error === undefined
      ) {
        show(first.entry, { value: undefined, error: refusal });
      }
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
