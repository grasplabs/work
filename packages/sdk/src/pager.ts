import type { Json } from "@grasp-os/shared/json";
import { queryMaxResults } from "@grasp-os/shared/store-limits";

import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import { loading, show } from "./client-query-entry.ts";
import type { QueryEntry } from "./client-query-entry.ts";
import type { ReadReference } from "./client-request.ts";
import { nothingRanCodes } from "./refusals.ts";
import { isPlainObject } from "./value-descriptor.ts";

/**
 * What a paginated list shows (spec 10.6): the ordered records of its
 * loaded window, whether more follow, whether it is loading, and how to
 * load more. Pagination controls, not an operation result.
 */
export interface PaginatedQueryView<Item = unknown> {
  readonly items: Item[];
  readonly hasMore: boolean;
  readonly isLoading: boolean;
  /**
   * Loads `pageSize` more records (the list's `initialPageSize` unless
   * set, 1 to 100): resolves once the larger window shows, or at once
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

/** A Load More under way: the larger window, followed until core pushes it. */
export interface Extension {
  readonly extent: number;
  readonly entry: QueryEntry;
  stop: (() => void) | undefined;
  /** How many snapshots its entry had shown when it began. */
  readonly since: number;
  /** Whether its entry was current already: followed, and pushed to. */
  current: boolean;
  readonly done: PromiseWithResolvers<null>;
}

/** One paginated list, by reference, arguments and first page size. */
export interface Pager {
  readonly key: string;
  readonly reference: ReadReference;
  readonly input: Json;
  readonly initialPageSize: number;
  /** How many records its window holds at most: what it loaded so far. */
  extent: number;
  /** The query of the window it shows. */
  current: QueryEntry;
  /** What stops following it, while the list has readers. */
  stopCurrent: (() => void) | undefined;
  extension: Extension | undefined;
  /** What a Load More before the first window waits on. */
  first: PromiseWithResolvers<null> | undefined;
  /** A Load More's failure, shown until the list is tried again. */
  failure: GraspError | undefined;
  snapshot: PagerSnapshot;
  /** The window value its snapshot shows, to tell a new one. */
  shown: unknown;
  readonly listeners: Set<() => void>;
  evict: ReturnType<typeof setTimeout> | undefined;
  loadMore: (pageSize?: number) => Promise<void>;
}

/** A window's records and whether more follow, as core pushed it. */
export const windowOf = (
  value: unknown
): { items: unknown[]; hasMore: boolean } | undefined =>
  isPlainObject(value) &&
  Array.isArray(value.items) &&
  typeof value.hasMore === "boolean"
    ? { items: value.items, hasMore: value.hasMore }
    : undefined;

/** Whether `size` is a page size a list asks for: 1 to `queryMaxResults`. */
export const isPageSize = (size: unknown): size is number =>
  typeof size === "number" &&
  Number.isInteger(size) &&
  size >= 1 &&
  size <= queryMaxResults;

/** A page size a list can't ask for, named by `name`. */
export const pageSizeError = (name: string): GraspError =>
  clientError("contract.invalid_args", {
    issues: [
      {
        code: "invalid_page_size",
        message: `${name} is a whole number from 1 to ${queryMaxResults}.`,
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

/**
 * What a list's readers see (spec 10.6's states): the window `current`
 * shows, or its failure or the list's own (`failure`); loading until the
 * first window shows, and while a Load More is `extending` it.
 */
export const snapshotOf = (
  current: QueryEntry,
  failure: GraspError | undefined,
  extending: boolean,
  loadMore: Pager["loadMore"]
): PagerSnapshot => {
  const { error, value } = current.snapshot;
  const failed = error ?? failure;
  const window = error === undefined ? windowOf(value) : undefined;
  return {
    view: {
      items: window?.items ?? [],
      hasMore: window?.hasMore ?? false,
      isLoading: failed === undefined && (window === undefined || extending),
      loadMore,
    },
    error: failed,
  };
};

/**
 * Something `pager` shows changed: its Load More's window shows once
 * core pushed it after the Load More began (or at once, when it was
 * current already), or fails it; then the list's readers are told of
 * its new snapshot, if it is new.
 */
export const pagerChanged = (pager: Pager): void => {
  const { extension } = pager;
  if (extension !== undefined) {
    const { entry } = extension;
    const fresh = extension.current || entry.settled > extension.since;
    const { error } = entry.snapshot;
    if (fresh && error !== undefined) {
      // Writes kept the larger window from being read whole, say: the
      // Load More fails, the window shown stays, a later one afresh.
      // oxlint-disable-next-line no-use-before-define -- the two call each other
      failExtension(pager, extension, error);
      return;
    } else if (fresh && windowOf(entry.snapshot.value) !== undefined) {
      // The larger window, whole: it replaces the smaller one at once.
      const before = pager.stopCurrent;
      pager.current = entry;
      pager.stopCurrent = extension.stop;
      pager.extent = extension.extent;
      pager.extension = undefined;
      before?.();
      extension.done.resolve(null);
    }
  }
  const { error, value } = pager.current.snapshot;
  if (pager.first !== undefined) {
    if (error !== undefined) {
      pager.first.reject(error);
      pager.first = undefined;
    } else if (windowOf(value) !== undefined) {
      pager.first.resolve(null);
      pager.first = undefined;
    }
  }
  const next = snapshotOf(
    pager.current,
    pager.failure,
    pager.extension !== undefined,
    pager.loadMore
  );
  const before = pager.snapshot;
  if (
    next.error === before.error &&
    next.view.hasMore === before.view.hasMore &&
    next.view.isLoading === before.view.isLoading &&
    value === pager.shown
  ) {
    return;
  }
  pager.shown = value;
  pager.snapshot = next;
  for (const listener of pager.listeners) {
    listener();
  }
};

/**
 * Ends `extension` with `error`: the Load More rejects. A failure that
 * may pass (writes tearing the window, the person's budget, a busy
 * sandbox) keeps the list as it is, to try again; any other is the
 * list's failure, thrown while rendering.
 */
export const failExtension = (
  pager: Pager,
  extension: Extension,
  error: GraspError
): void => {
  pager.extension = undefined;
  extension.stop?.();
  if (error.retryable || nothingRanCodes.has(error.code)) {
    // Nothing of it stays to be taken for a fresh answer later.
    if (extension.entry.listeners.size === 0) {
      show(extension.entry, loading);
    }
  } else {
    pager.failure = error;
  }
  extension.done.reject(error);
  pagerChanged(pager);
};

/** Records `failure` as `pager`'s, to throw while rendering, and answers it. */
export const failPager = (pager: Pager, failure: GraspError): GraspError => {
  pager.failure = failure;
  pagerChanged(pager);
  return failure;
};
