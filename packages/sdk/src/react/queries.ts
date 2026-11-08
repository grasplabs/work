import { useSyncExternalStore } from "react";

import { clientInternals, loading, skippedPage } from "../client-core.ts";
import type {
  PaginatedQueryView,
  PagerSnapshot,
  QueryReference,
  QuerySnapshot,
} from "../client-core.ts";
import type { ArgsOf, ReturnOf } from "../function-references.ts";
import type { PaginationResult } from "../query-reads.ts";
import { useClient } from "./provider.ts";

export const noSubscription = (): (() => void) => () => {
  // Nothing to stop: a skipped query reads nothing.
};

/**
 * The current result of the query `reference` names with `args`, kept up
 * to date: its declared value, or `undefined` while it loads or when
 * `args` is `"skip"`. Check for loading with `=== undefined`. A failure
 * is thrown to the page's error boundary.
 */
export const useQuery = <Reference extends QueryReference>(
  reference: Reference,
  args: ArgsOf<Reference> | "skip"
): ReturnOf<Reference> | undefined => {
  const internals = clientInternals(useClient());
  const entry = args === "skip" ? undefined : internals.entry(reference, args);
  const snapshot: QuerySnapshot = useSyncExternalStore(
    (onChange) =>
      entry === undefined
        ? noSubscription()
        : internals.subscribe(entry, onChange),
    () => entry?.snapshot ?? loading
  );
  if (snapshot.error !== undefined) {
    throw snapshot.error;
  }
  // SAFETY: the host validated the value against the reference's declared
  // return, which `Reference` carries as its type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return snapshot.value as ReturnOf<Reference> | undefined;
};

/**
 * The record a query of pages answers each of: `any` for a query whose
 * answer is `any` (core's stand-ins while an App's server code doesn't
 * register, generate.ts `symbolicModules`), as its other answers are,
 * where inferring from `any` would make it `unknown`.
 */
export type PageItemOf<Reference> = 0 extends 1 & ReturnOf<Reference>
  ? // oxlint-disable-next-line typescript/no-explicit-any -- as its answer is
    any
  : ReturnOf<Reference> extends PaginationResult<infer Item>
    ? Item
    : never;

/**
 * What a paginated list of `Reference` takes besides its options: the
 * query's arguments without `pagination`, which the list supplies; never
 * for a query that doesn't take `pagination` and answer pages.
 */
export type PaginatedArgsOf<Reference> =
  "pagination" extends keyof ArgsOf<Reference>
    ? ReturnOf<Reference> extends PaginationResult<unknown>
      ? Omit<ArgsOf<Reference>, "pagination"> & { readonly pagination?: never }
      : never
    : never;

/** How a paginated list starts. */
interface PaginatedQueryOptions {
  /**
   * How many records it shows first, and loads more by unless a Load More
   * says: a whole number from 1 to 100.
   */
  readonly initialPageSize: number;
}

/**
 * A live paginated list of the query `reference` names (spec 10.6): one
 * that takes the reserved `pagination` argument and answers pages, read
 * with `args` (its other arguments, or `"skip"`). It shows `items`, the
 * ordered records loaded so far, kept up to date as records are saved,
 * moved or deleted, never with one twice or one missing between pages;
 * `hasMore`; `isLoading`, while the first records or more load; and
 * `loadMore`, stable, which loads `initialPageSize` more (or as many as
 * it is given). Changing `args` or `initialPageSize` starts the list
 * again; equal arguments in a new object don't. A failure is thrown to
 * the page's error boundary, as a query's is.
 */
export const usePaginatedQuery = <Reference extends QueryReference>(
  reference: Reference,
  args: PaginatedArgsOf<Reference> | "skip",
  options: PaginatedQueryOptions
): PaginatedQueryView<PageItemOf<Reference>> => {
  const internals = clientInternals(useClient());
  const pager =
    args === "skip"
      ? undefined
      : internals.pager(reference, args, options.initialPageSize);
  const snapshot: PagerSnapshot = useSyncExternalStore(
    (onChange) =>
      pager === undefined
        ? noSubscription()
        : internals.subscribePager(pager, onChange),
    () => pager?.snapshot ?? skippedPage
  );
  if (snapshot.error !== undefined) {
    throw snapshot.error;
  }
  // SAFETY: the host validated each page against the reference's declared
  // return, whose records `PageItemOf` names.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return snapshot.view as PaginatedQueryView<PageItemOf<Reference>>;
};

/**
 * Reads again every query of the page that failed and is still read: for
 * a part of a page that shows its own failure with a way to try again,
 * as `DataGrid` does. The page's error boundary does the same.
 */
export const useRetryFailed = (): (() => void) => {
  const internals = clientInternals(useClient());
  return () => {
    internals.retryFailed();
  };
};
