import type { Json } from "@grasp-os/shared/json";
import { operationErrors } from "@grasp-os/shared/operations";
import type { OperationResult } from "@grasp-os/shared/operations";
import {
  liveWindowMaxItems,
  queryMaxResults,
} from "@grasp-os/shared/store-limits";
import { queryErrors } from "@grasp-os/shared/stores";

import type { OpenStore } from "./data-stores.ts";
import { callOperation, sharedBudget } from "./operations.ts";
import type {
  HostedApp,
  Invocation,
  OperationReference,
  SharedBudget,
} from "./operations.ts";

// A paginated list's window (spec 10.6, 11.6): what `usePaginatedQuery`
// shows, the first `extent` records of a public query that takes the
// reserved `pagination` argument and answers pages (spec 9.2). The screen
// asks for a window by its extent only; core reads it here, from the
// start, page after page through the query's own handler, each page's
// cursor handed straight to the next, and answers the records with
// whether more follow. A live list is read whole again at every change
// (query-subscriptions.ts), and a Load More is a larger window read whole,
// never a page appended to what the screen holds.
//
// Threat model, and how each is closed:
//
// - A window mixes two states of the store, so a record inserted, moved
//   or deleted between two of its pages shows twice or not at all: every
//   page is one state of the store (`readConsistently`), with the
//   generation of each table it read; the pages must agree on every
//   table, and after the last page the store's generations must still be
//   those, so every page saw the store as it is then. A window that isn't
//   one state is read again, `windowMaxReads` times at most, then refused
//   as `query.concurrent_change` (retryable), never answered torn or in
//   part. A cursor of core's own refused between pages (the person's
//   roles changed meanwhile, so the scope it was sealed for did) is a
//   torn read too. The store can't hold one state across the pages: each
//   is a sandboxed run of App code, and holding the store's writes for it
//   would let one person's list stall every writer of the App. So a list
//   on a table written faster than its window reads settles as that
//   refusal: core pushes it to a list with nothing shown yet, which fails
//   its Load More (the window shown stays), and reads a shown window again
//   on its budget.
// - A cursor forged, edited or replayed, across people, Apps or queries:
//   a window's cursors never leave core, so a live list has none to
//   forge; each is the store's own sealed statement, bound to the person,
//   their roles, the App, its version and the query (store-cursors.ts),
//   opened by the store before the next page is read. A screen's own
//   foreground page reads (`client.query` with `pagination`) carry a
//   cursor the store checks the same way.
// - A window reaches records the person can't read: every page runs as
//   the caller's invocation, the person's own, through the App's role
//   check and the table's access, exactly as a call of the query would;
//   a window grants nothing a call doesn't.
// - A window grows without bound, or costs without bound: its extent is
//   at most `liveWindowMaxItems` (the request is refused past it), each
//   page at most `queryMaxResults`, at most `windowMaxPages` pages per
//   read however short a handler's pages are (past them the window is
//   refused, never answered short of its extent), all within the one
//   invocation's deadline and one read budget for every page and every
//   read again (`sharedBudget`); its answer is bounded as any push or
//   answer is. Every page is charged: the caller pays `windowPages` of
//   the person's requests (or, for a read a write caused, of their live
//   reads) before the window is read, and `charge` is asked for every
//   page past those, every read again included; once it refuses, the
//   window is refused as `screen.rate_limited`, the caller's refusal: on
//   a request, with how long to wait; on a live list, a wait for the
//   budget that keeps the window shown and watched
//   (query-subscriptions.ts).
// - The caller passes `pagination` itself, to page from a place of its
//   choosing: the reserved argument is refused in a window's input
//   (`contract.invalid_args`); core alone supplies it.
// - A query that doesn't page is read as a list: one whose arguments
//   don't declare `pagination`, or whose answer isn't a page, is refused
//   (`contract.not_paginated`).

/** How many times a window is read before a torn one is refused. */
const windowMaxReads = 3;

/**
 * The pages a window of `extent` records takes at least, as its caller
 * pays for it first: at most 10, within every budget's burst.
 */
export const windowPages = (extent: number): number =>
  Math.max(
    1,
    Math.ceil(Math.min(extent, liveWindowMaxItems) / queryMaxResults)
  );

/**
 * The most pages one read of a window takes: enough for the largest
 * window in pages of ten records. A handler whose pages are shorter still
 * has its window refused (`operation.read_limit`) rather than cut short.
 */
const windowMaxPages = liveWindowMaxItems / 10;

/** The codes of a cursor the store refused: core's own, sealed for another scope. */
const cursorRefusals: ReadonlySet<string> = new Set([
  "data.invalid_cursor",
  "data.cursor_expired",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether an operation's argument descriptor declares `pagination`. */
const takesPages = (args: unknown): boolean =>
  isObject(args) &&
  args.kind === "object" &&
  isObject(args.fields) &&
  Object.hasOwn(args.fields, "pagination");

/** Whether `value`, part of a JSON answer, is a list. */
const isList = (value: unknown): value is Json[] => Array.isArray(value);

/** One page as a query answered it, or undefined when it isn't one. */
const pageOf = (
  value: Json
):
  | { items: Json[]; hasMore: false }
  | { items: Json[]; hasMore: true; nextCursor: string }
  | undefined => {
  if (!isObject(value) || !isList(value.items)) {
    return undefined;
  }
  const { items, hasMore, nextCursor } = value;
  if (hasMore === false && nextCursor === null) {
    return { items, hasMore };
  }
  if (hasMore === true && typeof nextCursor === "string") {
    return { items, hasMore, nextCursor };
  }
  return undefined;
};

/**
 * Adds `page`'s read set to `into`: false when they disagree on a table,
 * which means the two reads saw two states of the store.
 */
const merged = (
  into: Record<string, number>,
  page: Record<string, number>
): boolean => {
  for (const [table, generation] of Object.entries(page)) {
    // Its own entries only: a table may be named as anything an object
    // inherits (`constructor`).
    const known = Object.hasOwn(into, table) ? into[table] : undefined;
    if (known !== undefined && known !== generation) {
      return false;
    }
    // Defined, not assigned: `__proto__` is a name like any other here.
    Object.defineProperty(into, table, {
      value: generation,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return true;
};

/** Whether every table of `readSet` is still at its generation in `store`. */
const isCurrent = async (
  store: OpenStore,
  readSet: Record<string, number>
): Promise<boolean> => {
  const tables = Object.keys(readSet);
  if (tables.length === 0) {
    return true;
  }
  const current = await store.generations(tables);
  return tables.every((table) => current[table] === readSet[table]);
};

/** What one read of a window came to. */
type WindowRead =
  | {
      readonly kind: "window";
      readonly items: Json[];
      readonly hasMore: boolean;
      readonly readSet: Record<string, number>;
    }
  | {
      readonly kind: "failed";
      readonly result: OperationResult;
      readonly readSet: Record<string, number>;
    }
  | { readonly kind: "torn" };

/** What a window is read for: the query, its caller and its input. */
export interface WindowRequest {
  readonly app: HostedApp;
  readonly invocation: Invocation;
  readonly reference: OperationReference;
  /** The operation's argument descriptor, as the release declares it. */
  readonly args: unknown;
  /** The caller's input, without `pagination`. */
  readonly input: unknown;
  /** How many records the window holds at most. */
  readonly extent: number;
  /**
   * Charges `pages` more pages to the person's budget, past the
   * `windowPages(extent)` the caller paid: throws the caller's own
   * refusal (`screen.rate_limited`) once it is spent.
   */
  readonly charge: (pages: number) => Promise<void>;
}

/** What one read of a window spends, beside its own pages. */
interface Spending {
  readonly budget: SharedBudget;
  /** Pages read so far, every read of the window together. */
  pages: number;
  /** Records read so far, every read of the window together. */
  items: number;
  /** Pages charged so far past what the caller paid. */
  charged: number;
}

/**
 * Pages of the shortest a handler may answer that cost one full page: a
 * window's pages are charged by the records they read, at least one for
 * every this many pages, however short (`windowMaxPages`).
 */
const pagesPerCharge = queryMaxResults / 10;

/**
 * Charges the page just read, past what the caller paid: one request
 * for every full page's worth of records read, every read of the window
 * together, and at least one for every `pagesPerCharge` pages. So a
 * handler's short pages cost what a window of full pages would, and a
 * window read again costs again.
 */
const chargePage = async (
  request: WindowRequest,
  spending: Spending,
  read: number
): Promise<void> => {
  spending.pages += 1;
  spending.items += read;
  const owed =
    Math.max(
      Math.ceil(spending.items / queryMaxResults),
      Math.ceil(spending.pages / pagesPerCharge)
    ) -
    windowPages(request.extent) -
    spending.charged;
  if (owed > 0) {
    spending.charged += owed;
    await request.charge(owed);
  }
};

/** Reads the window once, page after page from the start. */
const readOnce = async (
  request: WindowRequest,
  input: Record<string, Json>,
  spending: Spending
): Promise<WindowRead> => {
  const { app, invocation, reference, extent } = request;
  const items: Json[] = [];
  const readSet: Record<string, number> = {};
  let cursor: string | null = null;
  // Read until the window is full or the query ends: a handler may answer
  // short pages, charged by the records they read past what was paid
  // (`chargePage`), all within the window's one read budget.
  for (let page = 0; page < windowMaxPages; page += 1) {
    const pageSize = Math.min(queryMaxResults, extent - items.length);
    let pageReads: Record<string, number> = {};
    // One page after the other: each starts at the cursor of the last.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const result = await callOperation(
      app,
      {
        ...invocation,
        observeReads: (reads) => {
          pageReads = reads;
        },
      },
      reference,
      { ...input, pagination: { pageSize, cursor } },
      { budget: spending.budget }
    );
    const answered = result.ok ? pageOf(result.value) : undefined;
    // Every page read is charged, whatever it came to.
    // oxlint-disable-next-line no-await-in-loop -- see above
    await chargePage(request, spending, answered?.items.length ?? 0);
    if (!merged(readSet, pageReads)) {
      return { kind: "torn" };
    }
    if (!result.ok) {
      return cursor !== null && cursorRefusals.has(result.error.code)
        ? { kind: "torn" }
        : { kind: "failed", result, readSet };
    }
    if (answered === undefined) {
      throw operationErrors.create("contract.not_paginated");
    }
    items.push(...answered.items);
    // A handler that answered more than it was asked: the window ends at
    // its extent, and more follow.
    if (!answered.hasMore || items.length >= extent) {
      return {
        kind: "window",
        items: items.slice(0, extent),
        hasMore: answered.hasMore || items.length > extent,
        readSet,
      };
    }
    cursor = answered.nextCursor;
  }
  // Pages too short to fill the window within its bound: refused, never
  // answered as a window shorter than asked, which would leave a Load More
  // adding nothing.
  throw operationErrors.create("operation.read_limit", {
    maxPages: windowMaxPages,
  });
};

/**
 * Reads the window `request` names (see the header): its records and
 * whether more follow, as one state of the store, or why not. `observe`
 * is told what it read, once that stands: what a live list watches.
 * Throws a coded refusal for a query or input a window can't take.
 */
export const readWindow = async (
  request: WindowRequest,
  observe?: (readSet: Record<string, number>) => void
): Promise<OperationResult> => {
  if (!takesPages(request.args)) {
    throw operationErrors.create("contract.not_paginated");
  }
  const { input } = request;
  if (!isObject(input) || Object.hasOwn(input, "pagination")) {
    // `pagination` is core's to supply: a caller never pages a window.
    throw operationErrors.create("contract.invalid_args");
  }
  // SAFETY: the input crossed as JSON text, parsed.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const json = input as Record<string, Json>;
  const spending: Spending = {
    budget: sharedBudget(),
    pages: 0,
    items: 0,
    charged: 0,
  };
  for (let attempt = 0; attempt < windowMaxReads; attempt += 1) {
    // One read after the other: another only once the last was torn.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const read = await readOnce(request, json, spending);
    if (read.kind === "torn") {
      continue;
    }
    // A failure stands only as one state of the store, as a window does:
    // one assembled from pages that saw two states is read again.
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (await isCurrent(request.invocation.store, read.readSet)) {
      observe?.(read.readSet);
      return read.kind === "failed"
        ? read.result
        : { ok: true, value: { items: read.items, hasMore: read.hasMore } };
    }
  }
  throw queryErrors.create("query.concurrent_change", { retryable: true });
};
