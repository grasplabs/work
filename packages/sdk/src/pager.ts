import type { Json } from "@grasp-os/shared/json";
import { queryMaxScannedEntries } from "@grasp-os/shared/store-limits";

import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import type { QueryEntry } from "./client-query-entry.ts";
import type { ReadReference } from "./client-request.ts";
import { isPlainObject } from "./value-descriptor.ts";

/**
 * What a paginated list shows: the ordered records of its loaded pages,
 * whether more follow, whether it is loading, and how to load more.
 * Pagination controls, not an operation result.
 */
export interface PaginatedQueryView<Item = unknown> {
  readonly items: Item[];
  readonly hasMore: boolean;
  readonly isLoading: boolean;
  /**
   * Loads `pageSize` more records (the list's `initialPageSize` unless
   * set) as one more page: resolves once that page shows, or at once
   * when there is no more or the list isn't read; rejects with a
   * structured error, which the list also throws while rendering. A call
   * while the list loads joins that load.
   */
  readonly loadMore: (pageSize?: number) => Promise<void>;
}

/** What a paginated list's readers see: its view, or its failure. */
export interface PagerSnapshot {
  readonly view: PaginatedQueryView;
  readonly error: GraspError | undefined;
}

/** A page as its query answered it. */
export interface PageValue {
  readonly items: readonly unknown[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  /** Where core says to split the page (`readPage`), if it grew too long. */
  readonly splitCursor?: string;
}

/** One of a list's pages: a live query of its own. */
export interface ListPage {
  /** Where it starts: null for the first page. */
  readonly cursor: string | null;
  /**
   * Where it ends, once a page follows it: the cursor that page starts
   * at, so records moving in and out of it never shift the pages after.
   */
  readonly endCursor: string | null;
  readonly pageSize: number;
  readonly entry: QueryEntry;
  /** What stops following it, while the list has readers. */
  stop: (() => void) | undefined;
  /**
   * What it showed before it was given its end or split, shown instead
   * of its own answer until that comes (and, once split, its other half's
   * too): the same records, so nothing flickers.
   */
  held: PageValue | undefined;
  /** The other half of the page it was split from, if it was. */
  twin: ListPage | undefined;
}

/** One paginated list, by reference, arguments and first page size. */
export interface Pager {
  readonly key: string;
  readonly reference: ReadReference;
  /** Its arguments, without `pagination`. */
  readonly input: Json;
  readonly initialPageSize: number;
  /** Its pages in order, each followed while the list has readers. */
  pages: ListPage[];
  /** What Load Mores wait on: the last page's first answer. */
  waiting: PromiseWithResolvers<null> | undefined;
  /**
   * The records it showed before it started again (a cursor expired),
   * shown until its first page answers.
   */
  held: readonly unknown[] | undefined;
  /** How many records it loads again after starting again, if it does. */
  refill: number | undefined;
  /** A Load More's failure, shown until the list is tried again. */
  failure: GraspError | undefined;
  snapshot: PagerSnapshot;
  /** The page values its snapshot shows, to tell a new one. */
  shown: readonly unknown[];
  readonly listeners: Set<() => void>;
  evict: ReturnType<typeof setTimeout> | undefined;
  loadMore: (pageSize?: number) => Promise<void>;
}

/** A page's records, whether more follow and where, as core pushed it. */
export const pageOf = (value: unknown): PageValue | undefined =>
  isPlainObject(value) &&
  Array.isArray(value.items) &&
  typeof value.hasMore === "boolean" &&
  (value.nextCursor === null || typeof value.nextCursor === "string")
    ? {
        items: value.items,
        hasMore: value.hasMore,
        nextCursor: value.nextCursor,
        ...(typeof value.splitCursor === "string"
          ? { splitCursor: value.splitCursor }
          : {}),
      }
    : undefined;

/**
 * Whether `size` is a page size a list asks for: 1 up to the most records
 * one read may examine, which no page answers past.
 */
export const isPageSize = (size: unknown): size is number =>
  typeof size === "number" &&
  Number.isInteger(size) &&
  size >= 1 &&
  size <= queryMaxScannedEntries;

/** A page size a list can't ask for, named by `name`. */
export const pageSizeError = (name: string): GraspError =>
  clientError("contract.invalid_args", {
    issues: [
      {
        code: "invalid_page_size",
        message: `${name} is a whole number from 1 to ${queryMaxScannedEntries}.`,
        path: [name],
      },
    ],
  });

/** What a skipped list shows: nothing, and nothing to load. */
export const skippedPage: PagerSnapshot = Object.freeze({
  view: Object.freeze({
    items: [],
    hasMore: false,
    isLoading: false,
    loadMore: async (): Promise<void> => {
      // A skipped list loads nothing.
    },
  }),
  error: undefined,
});

/** What `page`'s own query answered, if it answered a page. */
export const ownPage = (page: ListPage): PageValue | undefined =>
  page.entry.snapshot.error === undefined
    ? pageOf(page.entry.snapshot.value)
    : undefined;

/** What `page` shows now: what it holds, else its own answer. */
export const shownPage = (page: ListPage): PageValue | undefined =>
  page.held ?? ownPage(page);

/**
 * What `page` shows once core pushed it since it was followed: never an
 * answer cached from before (a list started again may get one), whose
 * cursor may no longer apply.
 */
export const freshPage = (page: ListPage): PageValue | undefined =>
  (page.entry.live?.revision ?? 0) > 0 ? shownPage(page) : undefined;

/**
 * What a list's readers see: the records of its pages in order, up to the
 * first that shows nothing yet; a page's failure or the list's own
 * (`failure`); loading while any page shows nothing yet.
 */
export const snapshotOf = (
  pager: Pager
): { snapshot: PagerSnapshot; shown: unknown[] } => {
  const items: unknown[] = [];
  const shown: unknown[] = [];
  let hasMore = false;
  let isLoading = false;
  let error: GraspError | undefined;
  for (const page of pager.pages) {
    const own = ownPage(page);
    const value = page.held ?? own;
    ({ error } = page.entry.snapshot);
    if (error !== undefined) {
      break;
    }
    if (value === undefined) {
      isLoading = pager.failure === undefined;
      break;
    }
    // By what core pushed, or what the page held: the same objects until
    // either changes.
    shown.push(page.held ?? page.entry.snapshot.value);
    items.push(...value.items);
    ({ hasMore } = value);
  }
  // Started again: what it showed stays until its first page answers.
  const restarting = pager.held !== undefined;
  return {
    snapshot: {
      view: {
        items: restarting ? [...(pager.held ?? [])] : items,
        hasMore,
        isLoading,
        loadMore: pager.loadMore,
      },
      error: error ?? pager.failure,
    },
    shown: restarting ? [pager.held] : shown,
  };
};

/**
 * Tells `pager`'s readers of its new snapshot, if it is new: another
 * page's value, failure, loading state or whether more follow.
 */
export const pagerChanged = (pager: Pager): void => {
  const { snapshot, shown } = snapshotOf(pager);
  const before = pager.snapshot;
  if (
    snapshot.error === before.error &&
    snapshot.view.hasMore === before.view.hasMore &&
    snapshot.view.isLoading === before.view.isLoading &&
    shown.length === pager.shown.length &&
    shown.every((value, position) => value === pager.shown[position])
  ) {
    return;
  }
  pager.shown = shown;
  pager.snapshot = snapshot;
  for (const listener of pager.listeners) {
    listener();
  }
};

/** Records `failure` as `pager`'s, to throw while rendering, and answers it. */
export const failPager = (pager: Pager, failure: GraspError): GraspError => {
  pager.failure = failure;
  pagerChanged(pager);
  return failure;
};
