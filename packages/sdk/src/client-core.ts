import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import {
  functionRequestMaxBytes,
  streamIdleCancelMs,
} from "@grasp-os/shared/operation-limits";
import {
  liveWindowMaxItems,
  queryMaxResults,
} from "@grasp-os/shared/store-limits";

import {
  clientError,
  fences,
  fencingRefusalOf,
  GraspError,
  issueDetails,
  nothingRanCodes,
  hidesOutcome,
  readAnswer,
  refusedBeforeCallCodes,
  readRejection,
  settlesSubmission,
} from "./client-error.ts";
import type { Settled } from "./client-error.ts";
import { PortableTransport } from "./client-portable.ts";
import type { PortableClientOptions } from "./client-portable.ts";
import type {
  ArgsOf,
  OperationReference,
  ProgressOf,
  ReferenceKind,
  ReturnOf,
} from "./references.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";
import { readDescriptor } from "./value-read.ts";

// The session client (spec 10.1, 10.7.1): the one object a screen's
// queries, mutations and actions go through. The platform makes one per
// App session and mounts it (screen-runtime.ts); App code reaches it
// through `useClient()` and the hooks of `@grasp-os/sdk/react`, and gets
// direct values and structured errors (client-error.ts), never a
// transport envelope.
//
// It owns what every screen would otherwise write again: reading the
// generated reference, normalizing the arguments with the same native
// interpreter the host uses, one logical submission per explicit call,
// receipt recovery after a lost response, and live queries (spec 11):
// over the platform's frame, one subscription per query, shared by the
// components that read it, whose snapshots core pushes after every write
// that changed what the query read, whoever made it, ordered and
// authorized, followed again after a lost connection; a screen there
// never reads a query again on its own. A portable host has no such
// connection yet: its queries are read again after a change this client
// confirmed. Failure modes, and how each is closed:
//
// - A lost response turns a saved change into a second one: every
//   mutation carries an idempotency key, the caller's or a fresh random
//   one, and a retry after a lost response sends the very same request,
//   so the host answers its receipt instead of saving again.
// - An uncertain outcome passes for success or failure: a mutation or
//   action whose response was lost is sent again under its key until the
//   host answers, for `lostBudgetMs` at most, then rejects as uncertain
//   with its key; it resolves only on the host's own answer. The host
//   keeps a receipt of each (a mutation's with its commit, an action's in
//   its invocation's object), so the resend answers what the first did,
//   or joins it while it still runs, and never runs it a second time. An
//   outcome the host itself can't tell (`operation.sandbox_lost`) is that
//   receipt: it rejects at once, with its key.
// - Retries spend the person's request budget: reads run at most
//   `maxReadsInFlight` at once (re-reads after changes, on a portable
//   host, gathered first), a refusal for the budget waits as long as it
//   says, a save is sent again for `submissionBudgetMs` rather than a few
//   quick tries, and a followed query waits as a refusal of it says.
// - Cancelling unlocks a duplicate: aborting stops the caller waiting,
//   never the submission, which keeps reconciling under its key; a call
//   with the same key and input joins it rather than send it again.
// - A delayed answer overwrites a newer one: a followed query shows only
//   its subscription's pushes, each numbered by core, an older or repeated
//   one dropped, and a push of an earlier subscription dropped too; an
//   imperative read's answer answers its caller and is shown only while
//   nobody follows the query. Reads are numbered too, an answer older
//   than the one shown dropped, and a push counts every read sent before
//   it as older, so none of them replaces it once nobody follows.
// - A lost connection leaves a screen silently stale, or hammers core:
//   once core lets go of a subscription, the query keeps its last
//   authorized snapshot and follows again after a delay from 250 ms up
//   to 30 seconds, fully jittered; a fresh subscription starts with a
//   fresh read. A refusal of the person or the build stops it for good.
// - Data outlives the access it was read under: a refusal of the person
//   or the build (`fences`), from a call or as a pushed result, clears
//   every cached result and stops every subscription, and every answer
//   to a request sent before it is dropped.
// - One person's submission is sent as another's: a key whose outcome was
//   left unknown is sent again only within the generation it was sent
//   under; after someone else signed in, or access was lost, it is
//   refused unsent as `auth.principal_changed`.
// - Subscriptions pile up: a query is followed only while a component
//   reads it, released as soon as the last one stops (a skipped query
//   follows nothing); core bounds what a page follows.
// - Invocation options travel as arguments: options are read on their
//   own, strictly, and only the normalized input is sent.
// - A malformed reference or argument reaches the host: references are
//   read as data, their descriptors checked, and arguments validated
//   before anything is sent; the host checks all of it again.
//
// A streaming action (spec 10.7.6, `stream`) is followed rather than
// answered: its progress snapshots, then its result, over the transport's
// `stream`. More ways it can fail:
// - A reference of the wrong mode runs anyway: `action` takes only a
//   single-answer reference and `stream` only a streaming one, refused
//   before anything is sent (`contract.mode_mismatch`); the host refuses
//   them too.
// - A lost connection runs it again: the client attaches to the same
//   invocation under the same key (`attach`), which never starts one, and
//   gets its latest progress and its result; while it does, the caller is
//   told it is recovering. If it can't, it rejects
//   `stream.outcome_unknown` with the key, never a made-up outcome.
// - Progress is applied unchecked, or out of order: each snapshot is
//   validated against the reference's own `stream` descriptor and handed
//   on only if newer than the last (a gap is snapshots the host replaced
//   with a newer one), frozen, so no caller changes another's.
// - A callback's failure turns into the action's: a throwing `onProgress`
//   is only no longer called; the result is still the action's.
// - Stopping following cancels another follower's run: aborting lets go
//   of this caller's connection only; the host cancels the run once no
//   one follows it. Cancelling it for everyone is a command of its own.
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
// - A portable host shows a cached larger window older than the one
//   shown, or a Load More never ends: there, a Load More reads the larger
//   window afresh and settles by that one read (`#settleWindow`): shown,
//   or the Load More rejects with its failure (writes tearing it, the
//   person's budget spent partway, with when to try again), the window
//   shown kept; a window is never read again on its own.
// - One person's list carries over to the next: when someone else signs
//   in, every list starts again at its first page, its failure cleared.

/**
 * How the client reaches the host: one call of the App `app`, its
 * request as JSON text, answered with core's `{ result }` (spec 32.6), or
 * rejected with a coded refusal; a rejection without a code is a lost
 * response.
 */
export interface ClientTransport {
  call: (request: string, app: string) => Promise<unknown>;
  /**
   * Follows the query `request` names (spec 11): `onSnapshot` gets each
   * push of core's (`{ revision, result }`), and `onLost` is called once
   * core, or the connection to it, let go of the subscription. Resolves
   * with what releases it, or rejects as `call` does. A portable host
   * has no transport, and reads its queries again after changes.
   */
  watch: (
    request: string,
    onSnapshot: (push: unknown) => void,
    onLost: () => void
  ) => Promise<{ release: () => void }>;
  /**
   * Follows one of a streaming action's invocations: `start` starts it
   * (or joins it under the same key and input), `attach` only reads it
   * again. `onFrame` gets each frame core sent, as data, then
   * `{ type: "closed" }` once the connection ends; the promise resolves
   * once it is open, with how to let go of it, or rejects as `call` does.
   * A transport without it runs no streaming action.
   */
  stream?: (
    what: "stream" | "attach",
    request: string,
    onFrame: (frame: unknown) => void
  ) => Promise<StreamLink>;
  /** Cancels the invocation `request` names, for everyone following it. */
  cancelStream?: (request: string) => Promise<unknown>;
}

/**
 * Calls the client refused before sending them, because what they were
 * bound to changed (`Bound`), by the error thrown: each settles as its
 * refusal, and never fences on its own, since the change that made it
 * stale fenced already.
 */
const unsentCalls = new WeakMap<object, GraspError>();

/** An error for a call refused unsent as `refusal` (`unsentCalls`). */
const unsent = (refusal: GraspError): Error => {
  const error = new Error(refusal.message);
  unsentCalls.set(error, refusal);
  return error;
};

/**
 * What a call through a portable host's transport is bound to: the fence
 * generation it began under, and the person it began for (a submission)
 * or its first attempt was sent for. A call that finds either changed is
 * refused before it is sent.
 */
interface Bound {
  readonly generation?: number;
  principal?: string;
}

/** A connection to a streaming action's invocation, as the transport opened it. */
export interface StreamLink {
  /** Lets go of it: the invocation goes on for anyone else following it. */
  readonly release: () => unknown;
}

/** Options of a query call. */
export interface QueryOptions {
  /** Stops this caller waiting; other readers of the query keep it. */
  readonly signal?: AbortSignal;
}

/** Options of a mutation or action call. */
export interface SubmitOptions {
  /**
   * Stops this caller waiting. The submission itself goes on: aborting
   * never rolls back a commit or lets the same change be sent again.
   */
  readonly signal?: AbortSignal;
  /**
   * The caller's key for this logical submission: 1 to 128 printable
   * ASCII characters. The same key with the same input recovers the
   * first call's outcome; with other input it is refused
   * (`submission.key_conflict`); one whose receipt expired is refused
   * (`submission.expired`). Without one, every call is a new submission.
   */
  readonly idempotencyKey?: string;
}

/** A public query reference. */
export type QueryReference = OperationReference<unknown, unknown, "query">;
/** A public mutation reference. */
export type MutationReference = OperationReference<
  unknown,
  unknown,
  "mutation"
>;
/** A public action reference that answers once (not a stream). */
export type ActionReference = OperationReference<unknown, unknown, "action">;
/** A public reference to an action that streams its progress. */
export type StreamReference = OperationReference<
  unknown,
  unknown,
  "action",
  "public",
  unknown
> & {
  // Spelled out: compared through its type parameters alone, a reference
  // that answers once (its progress `never`) would pass for one that
  // streams.
  readonly mode: "stream";
};

/** Options of a streaming action's call through `client.stream`. */
export interface StreamOptions<Progress> extends SubmitOptions {
  /**
   * Gets each progress snapshot, newer than the last, frozen. If it
   * throws, it is no longer called; the call goes on.
   */
  readonly onProgress: (progress: Progress) => void;
}

/** The arguments of `client.stream`: its input, then its options. */
export type StreamArguments<Reference> = [
  args: ArgsOf<Reference>,
  options: StreamOptions<ProgressOf<Reference>>,
];

/**
 * The arguments of a call of `Reference`, then its options. The input may
 * be left out only when it is empty or every field of it is optional or
 * defaulted; to pass options then, write `call({}, options)`.
 */
export type CallArguments<Reference, Options> =
  Record<never, never> extends ArgsOf<Reference>
    ? [args?: ArgsOf<Reference>, options?: Options]
    : [args: ArgsOf<Reference>, options?: Options];

/** A reference as the client read it: what it sends, and its input's descriptor. */
export interface ReadReference {
  readonly kind: ReferenceKind;
  /** The descriptor of its progress, for a streaming action only. */
  readonly stream: ValueDescriptor | undefined;
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly contractId: string;
  readonly fingerprint: string;
  readonly args: ValueDescriptor;
}

const fingerprintPattern = /^[0-9a-f]{64}$/u;

/** References read already, by the object App code passes. */
const readReferences = new WeakMap<object, ReadReference>();

/** Whether `value` names a public function of `kind`, of either mode. */
const isReferenceOf = (
  value: unknown,
  kind: ReferenceKind
): value is Record<string, unknown> & {
  resourceId: string;
  resourceVersion: number;
  contractId: string;
  fingerprint: string;
  mode: "single" | "stream";
} =>
  isPlainObject(value) &&
  value.kind === kind &&
  value.visibility === "public" &&
  (value.mode === "single" || (kind === "action" && value.mode === "stream")) &&
  typeof value.resourceId === "string" &&
  Number.isInteger(value.resourceVersion) &&
  typeof value.contractId === "string" &&
  typeof value.fingerprint === "string" &&
  fingerprintPattern.test(value.fingerprint);

/**
 * `value` as a public reference of `kind` and `mode`, read as data, its
 * descriptors checked; `contract.mode_mismatch` for an action of the
 * other mode, `contract.invalid_request` for anything else.
 */
const readReference = (
  value: unknown,
  kind: ReferenceKind,
  mode: "single" | "stream" = "single"
): ReadReference => {
  const known =
    typeof value === "object" && value !== null
      ? readReferences.get(value)
      : undefined;
  if (
    known !== undefined &&
    known.kind === kind &&
    (known.stream !== undefined) === (mode === "stream")
  ) {
    return known;
  }
  if (!isReferenceOf(value, kind)) {
    throw clientError("contract.invalid_request");
  }
  if (value.mode !== mode) {
    throw clientError("contract.mode_mismatch");
  }
  let args: ValueDescriptor;
  let stream: ValueDescriptor | undefined;
  try {
    args = readDescriptor(value.args, 1, { nodes: 0 });
    stream =
      mode === "stream"
        ? readDescriptor(value.stream, 1, { nodes: 0 })
        : undefined;
  } catch {
    throw clientError("contract.invalid_request");
  }
  const read: ReadReference = {
    kind,
    stream,
    resourceId: value.resourceId,
    resourceVersion: value.resourceVersion,
    contractId: value.contractId,
    fingerprint: value.fingerprint,
    args,
  };
  readReferences.set(value, read);
  return read;
};

/** What a request names of a reference: exactly what the host reads. */
const wireReference = (reference: ReadReference) => ({
  resourceId: reference.resourceId,
  resourceVersion: reference.resourceVersion,
  contractId: reference.contractId,
  fingerprint: reference.fingerprint,
  kind: reference.kind,
});

/**
 * `args` normalized as the host normalizes them (defaults filled in,
 * strings trimmed), an omitted input as `{}`; or `contract.invalid_args`
 * with what is wrong, before anything is sent.
 */
const normalized = (reference: ReadReference, args: unknown): Json => {
  const checked = validateValue(reference.args, args ?? {});
  if (checked.issues !== undefined) {
    throw clientError("contract.invalid_args", {
      issues: issueDetails(checked.issues),
    });
  }
  // SAFETY: the interpreter answers a fresh JSON copy of what it accepted.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return checked.value as Json;
};

const queryOptionKeys: ReadonlySet<string> = new Set(["signal"]);
const submitOptionKeys: ReadonlySet<string> = new Set([
  "signal",
  "idempotencyKey",
]);
const streamOptionKeys: ReadonlySet<string> = new Set([
  ...submitOptionKeys,
  "onProgress",
]);

const keyPattern = /^[ -~]{1,128}$/u;

/**
 * Invocation options, read on their own and strictly: an unknown key is
 * refused rather than passed on, and nothing of them is sent but a key.
 */
const readOptions = (
  options: unknown,
  allowed: ReadonlySet<string>
): {
  signal?: AbortSignal;
  idempotencyKey?: string;
  onProgress?: (progress: unknown) => void;
} => {
  if (options === undefined) {
    return {};
  }
  if (!isPlainObject(options)) {
    throw new TypeError("Call options are an object.");
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new TypeError(`"${key}" isn't an option of this call.`);
    }
  }
  const { signal, idempotencyKey, onProgress } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("signal is an AbortSignal.");
  }
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new TypeError("onProgress is a function.");
  }
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== "string" || !keyPattern.test(idempotencyKey))
  ) {
    throw clientError("submission.key_invalid");
  }
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(typeof onProgress === "function"
      ? {
          // SAFETY: a function App code passed; it gets what it asked for.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          onProgress: onProgress as (progress: unknown) => void,
        }
      : {}),
  };
};

/** A fresh logical submission key: 128 random bits, in hex. */
const freshKey = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

/** How long to wait before retry `attempt` (1 for the first): backed off, jittered. */
const retryDelay = (attempt: number): number => {
  const base = Math.min(250 * 2 ** (attempt - 1), 30_000);
  return base / 2 + Math.random() * (base / 2);
};

/**
 * How long to wait for a request budget to give back a request, when a
 * refusal as `screen.rate_limited` didn't say.
 */
const rateLimitedWaitMs = 1000;

/**
 * How long to wait before attempt `attempt` + 1 after `settled`: a
 * refusal for the request budget waits at least as long as it said (or
 * `rateLimitedWaitMs`), so retries never spend a budget that is empty.
 */
const waitAfter = (settled: Settled, attempt: number): number => {
  const backoff = retryDelay(attempt);
  if (
    settled.kind !== "failed" ||
    settled.error.code !== "screen.rate_limited"
  ) {
    return backoff;
  }
  const { details } = settled.error;
  const hinted = isPlainObject(details) ? details.retryAfterMs : undefined;
  const said = typeof hinted === "number" ? hinted : rateLimitedWaitMs;
  // As long as the budget takes to give one back, and a little more, so
  // calls refused together don't all ask again at the same moment.
  return said + Math.random() * said;
};

/** Resolves after `ms`, or as soon as `signal` aborts. */
const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<null>();
  const done = (): void => {
    resolve(null);
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  if (signal?.aborted === true) {
    done();
  }
  try {
    await promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
  }
};

/** Waits for `work` without letting its failure surface unhandled. */
const observe = async (work: Promise<unknown>): Promise<void> => {
  try {
    await work;
  } catch {
    // Its own caller, if it still has one, hears of it.
  }
};

/**
 * `work`, or `cancelled` as soon as `signal` aborts: only the caller
 * stops waiting, and `work` goes on.
 */
const waitFor = async <T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  cancelled: () => GraspError
): Promise<T> => {
  if (signal === undefined) {
    return await work;
  }
  void observe(work);
  const { promise, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => {
    reject(cancelled());
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    return await Promise.race([work, promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

/** What a query's readers see: its value (undefined while loading) or failure. */
export interface QuerySnapshot {
  readonly value: unknown;
  readonly error: GraspError | undefined;
}

/** A query with nothing to show yet, or a skipped one. */
export const loading: QuerySnapshot = Object.freeze({
  value: undefined,
  error: undefined,
});

/** A query's subscription, while components read it. */
interface Live {
  /** Its place among the client's subscriptions: a later one is newer. */
  readonly attempt: number;
  /** What releases it, once core answered. */
  release: (() => void) | undefined;
  /** The revision of the latest push shown. */
  revision: number;
  /**
   * How many times in a row it was lost before one lasted `steadyMs`: a
   * push alone doesn't reset it, so a subscription lost right after each
   * push still backs off.
   */
  failures: number;
  /** When it was made. */
  readonly since: number;
  retry: ReturnType<typeof setTimeout> | undefined;
  /** Released, ended, or fenced: nothing of it is shown any more. */
  stopped: boolean;
}

/** One query, by reference and normalized arguments, shared by its readers. */
export interface QueryEntry {
  readonly key: string;
  readonly reference: ReadReference;
  readonly input: Json;
  /** Its request as the host reads it. */
  readonly request: string;
  /** Whether it reads a paginated list's window (core's query-windows.ts). */
  readonly window: boolean;
  snapshot: QuerySnapshot;
  /** Components reading it now. */
  readonly listeners: Set<() => void>;
  /** Imperative reads waiting on it now. */
  interest: number;
  /** Its subscription, while components read it (over the frame). */
  live: Live | undefined;
  /** The number of the latest read sent, and of the one shown. */
  sent: number;
  shown: number;
  /** Set once a confirmed change may have made what it shows old. */
  stale: boolean;
  /**
   * How many confirmed changes marked it old: a read clears `stale` only
   * if none came after it was sent.
   */
  changes: number;
  reading:
    | { readonly done: Promise<unknown>; readonly stop: AbortController }
    | undefined;
  evict: ReturnType<typeof setTimeout> | undefined;
  /** How many snapshots it showed: a later one is newer. */
  settled: number;
}

/** Tells `entry`'s readers of its new snapshot. */
const show = (entry: QueryEntry, snapshot: QuerySnapshot): void => {
  entry.snapshot = snapshot;
  entry.settled += 1;
  for (const listener of entry.listeners) {
    listener();
  }
};

/** Whether anyone still waits on `entry`. */
const wanted = (entry: QueryEntry): boolean =>
  entry.listeners.size > 0 || entry.interest > 0;

/** Whether a read that settled as `settled` is worth sending again. */
const worthRetrying = (settled: Settled): boolean =>
  settled.kind === "lost" ||
  (settled.kind === "failed" && nothingRanCodes.has(settled.error.code));

/**
 * What core ends a followed query with once the person's roles in its App
 * dropped: nothing read under the old roles is shown again
 * (`#accessChanged`), and the query is followed again under the new.
 */
const accessChangedCode = "screen.access_changed";

/**
 * Refusals after which following a query again would only be refused
 * again: the App moved to another version, or the page follows too many.
 * (A refusal of the person or the build fences the whole client.)
 */
const endsFollowing = (code: string): boolean =>
  code.startsWith("version.") ||
  code === "app.not_running" ||
  code === "screen.too_many_queries" ||
  code === "screen.invalid" ||
  code.startsWith("contract.");

/** The least wait before following a query again. */
const minFollowMs = 250;

/**
 * How long to wait before following a query again after it was lost
 * `failures` times in a row: from 1 up to 30 seconds, fully jittered,
 * but never under `minFollowMs`.
 */
const followDelay = (failures: number): number =>
  Math.max(minFollowMs, Math.random() * Math.min(30_000, 1000 * 2 ** failures));

/** How long a subscription must last for its losses to count afresh. */
const steadyMs = 30_000;

/** A push of core's, read: its revision and result, or none if malformed. */
const readPush = (
  push: unknown
): { revision: number; settled: Settled } | undefined => {
  if (
    !isPlainObject(push) ||
    typeof push.revision !== "number" ||
    !Number.isSafeInteger(push.revision) ||
    push.revision < 1
  ) {
    return undefined;
  }
  const settled = readAnswer({ result: push.result });
  return settled.kind === "lost"
    ? undefined
    : { revision: push.revision, settled };
};

/**
 * Shows what read `number` of `entry` settled as, unless a newer read is
 * shown already or the query is followed (its pushes are what it shows),
 * and answers it: its value, or its failure thrown. A query that shows
 * data keeps it while its server is unreachable.
 */
const settleRead = (
  entry: QueryEntry,
  read: { readonly number: number; readonly changes: number },
  settled: Settled
): unknown => {
  const { number } = read;
  const newest = number > entry.shown && entry.live === undefined;
  // A change confirmed after the read was sent may be missing from it.
  const current = read.changes === entry.changes;
  if (settled.kind === "lost") {
    const error = clientError("operation.unreachable");
    if (newest && entry.snapshot.value === undefined) {
      entry.shown = number;
      show(entry, { value: undefined, error });
    }
    throw error;
  }
  if (settled.kind === "failed") {
    if (newest) {
      entry.shown = number;
      entry.stale &&= !current;
      show(entry, { value: undefined, error: settled.error });
    }
    throw settled.error;
  }
  if (newest) {
    entry.shown = number;
    entry.stale &&= !current;
    show(entry, { value: settled.value, error: undefined });
  }
  return settled.value;
};

/** How long a query no one reads stays cached: across a quick remount. */
const keepMs = 30_000;

/**
 * How often an imperative read tries before it gives up; one refused for
 * the request budget tries for as long as a submission would
 * (`submissionBudgetMs`), waiting as each refusal says.
 */
const imperativeAttempts = 5;

/**
 * How long a submission refused with a nothing-ran code (its budget used
 * up, the sandbox busy) is sent again, waiting as each refusal says.
 */
const submissionBudgetMs = 15_000;

/**
 * How long a mutation whose answers are lost is sent again under its key;
 * then it rejects as `submission.outcome_unknown`, its key recovering it.
 */
const lostBudgetMs = 5 * 60_000;

/** How many queries read at once: the rest wait, keeping room for saves. */
const maxReadsInFlight = 4;

/** How long confirmed changes are gathered into one round of re-reads. */
const changeGatherMs = 50;

/**
 * What the React hooks and the platform reach of a client, and App code
 * doesn't: the shared query entries, and trying failed queries again.
 */
export interface ClientInternals {
  /**
   * The shared entry of the query `reference` names with `args`, made if
   * there is none. Throws a structured error for a reference or
   * arguments the query can't take.
   */
  entry: (reference: unknown, args: unknown) => QueryEntry;
  /**
   * Adds a reader of `entry`, which `onChange` tells of every new
   * snapshot: over the frame it follows the query while it has one,
   * elsewhere it reads the query when it has nothing current. Answers the
   * function that removes the reader; the last one out releases the
   * subscription.
   */
  subscribe: (entry: QueryEntry, onChange: () => void) => () => void;
  /**
   * The shared paginated list of the query `reference` names with `args`
   * (without `pagination`) and `initialPageSize`, made if there is none.
   * Throws a structured error for a reference, arguments or page size a
   * list can't take.
   */
  pager: (reference: unknown, args: unknown, initialPageSize: unknown) => Pager;
  /**
   * Adds a reader of `pager`, which `onChange` tells of every new
   * snapshot; answers the function that removes it. The last one out
   * releases its window's subscription.
   */
  subscribePager: (pager: Pager, onChange: () => void) => () => void;
  /** Reads again every query that failed and is still read. */
  retryFailed: () => void;
  /**
   * `value` as a public, single-answer reference of `kind`, read as data,
   * its descriptor checked; or `contract.invalid_request`.
   */
  readReference: (value: unknown, kind: ReferenceKind) => ReadReference;
  /**
   * Runs the streaming action `reference` names, as `client.stream` does,
   * telling `events` how it goes: what `useStream` shows.
   */
  stream: (
    reference: unknown,
    args: unknown,
    options: unknown,
    events: StreamEvents
  ) => Promise<unknown>;
  /** How workflow runs reach the host (client-workflow.ts). */
  readonly workflowLink: WorkflowLink;
}

/**
 * What the workflow channel (client-workflow.ts) reaches of the client:
 * the transport's subscriptions, submissions under the client's own key
 * and fence rules, and its fences.
 */
export interface WorkflowLink {
  /** Follows a request, as queries are followed; none on a portable host. */
  readonly watch: ClientTransport["watch"] | undefined;
  /**
   * Sends `request`, a command of the workflow `target` names, as a
   * mutation is sent: under `key`, sent again under it while its answer
   * is lost (`onRecovering` told each time) or isn't one `read` accepts,
   * resolving with what `read` made of the host's answer once it is
   * durable, or rejecting with the host's refusal, or as uncertain with
   * the key.
   */
  readonly command: (
    target: SubmissionTarget,
    request: string,
    key: string,
    events: {
      readonly onRecovering: () => void;
      /** The answer, read; undefined for one that isn't an answer. */
      readonly read: (value: unknown) => unknown;
    }
  ) => Promise<unknown>;
  /** Clears everything the client holds: the person or build lost access. */
  readonly fence: (refusal: GraspError) => void;
  /** Calls `listener` at every fence; answers what stops calling it. */
  readonly onFence: (listener: (refusal: GraspError) => void) => () => void;
}

/** What a submission is scoped by: its App, contract and kind. */
export type SubmissionTarget = Pick<
  ReadReference,
  "kind" | "resourceId" | "contractId"
>;

/** How a streaming action's call goes, beyond its progress and result. */
export interface StreamEvents {
  /** It was admitted: `cancel` cancels it for everyone following it. */
  readonly onStarted: (cancel: () => Promise<void>) => void;
  /** Its connection was lost, and the client is attaching again. */
  readonly onRecovering: () => void;
  /** It is followed again after a lost connection. */
  readonly onAttached: () => void;
  /** A newer progress snapshot, frozen. */
  readonly onProgress: (progress: unknown) => void;
}

/** How a streaming action's connection ended. */
type Followed =
  | {
      readonly kind: "settled";
      readonly settled: Settled;
      /** Whether the invocation answered, rather than its connection being refused. */
      readonly answered: boolean;
    }
  | { readonly kind: "lost" }
  | { readonly kind: "aborted" };

/** How often a client starts a stream refused before it reached the invocation. */
const streamStartAttempts = 3;

/**
 * Whether a start refused as `followed` (the `refused`th refusal) is
 * worth sending again: only one refused before it reached the invocation
 * (`refusedBeforeCallCodes`). One the invocation answered settled its
 * receipt, which the same key only answers again.
 */
const startAgain = (
  followed: Followed,
  what: "stream" | "attach",
  refused: number
): boolean =>
  what === "stream" &&
  followed.kind === "settled" &&
  !followed.answered &&
  followed.settled.kind === "failed" &&
  refusedBeforeCallCodes.has(followed.settled.error.code) &&
  refused < streamStartAttempts;

/** How often a client attaches again to a stream whose connection was lost. */
const streamAttachAttempts = 8;

/**
 * How long a reconnect (`attach`) may take to open before it counts as one
 * that failed: as long as the host keeps a run no one follows, so one that
 * opens later finds nothing to follow anyway. A connection that arrives
 * after it is let go of at once, its frames never delivered.
 */
const streamAttachOpenMs = streamIdleCancelMs;

/**
 * How long a stream whose connection was lost is recovered for, however
 * the attempts go: past it, its outcome is unknown, with its key.
 */
const streamRecoverMs = 2 * 60_000;

/** Whether recovering a stream stops, after `tries` since `since`. */
const recoveryOver = (tries: number, since: number): boolean =>
  tries > streamAttachAttempts || Date.now() - since >= streamRecoverMs;

/** Whether `signal` was aborted, read afresh. */
const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

/** `value`, and everything in it, frozen: a snapshot no caller can change. */
const frozen = (value: unknown): unknown => {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      frozen(item);
    }
    Object.freeze(value);
  }
  return value;
};

/** A stream's frame, as the client reads it; anything else is undefined. */
const readFrame = (
  frame: unknown
):
  | { readonly type: "progress"; readonly seq: number; readonly value: unknown }
  | { readonly type: "result"; readonly settled: Settled }
  | { readonly type: "closed" }
  | undefined => {
  if (!isPlainObject(frame)) {
    return undefined;
  }
  if (
    frame.type === "progress" &&
    typeof frame.seq === "number" &&
    Number.isSafeInteger(frame.seq) &&
    "value" in frame
  ) {
    return { type: "progress", seq: frame.seq, value: frame.value };
  }
  if (frame.type === "result") {
    return { type: "result", settled: readAnswer({ result: frame.result }) };
  }
  if (frame.type === "refused") {
    const settled = readAnswer({
      result: { ok: false, error: frame.error },
    });
    return { type: "result", settled };
  }
  return frame.type === "closed" ? { type: "closed" } : undefined;
};
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
interface Extension {
  readonly extent: number;
  readonly entry: QueryEntry;
  stop: (() => void) | undefined;
  /** How many snapshots its entry had shown when it began. */
  readonly since: number;
  /** Whether its entry was current already: followed, and pushed to. */
  current: boolean;
  /**
   * On a portable host, until its own read settles: no other answer (a
   * read from before the Load More, say) is taken for its window.
   */
  awaitingRead: boolean;
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
const windowOf = (
  value: unknown
): { items: unknown[]; hasMore: boolean } | undefined =>
  isPlainObject(value) &&
  Array.isArray(value.items) &&
  typeof value.hasMore === "boolean"
    ? { items: value.items, hasMore: value.hasMore }
    : undefined;

/** Whether `size` is a page size a list asks for: 1 to `queryMaxResults`. */
const isPageSize = (size: unknown): size is number =>
  typeof size === "number" &&
  Number.isInteger(size) &&
  size >= 1 &&
  size <= queryMaxResults;

/** A page size a list can't ask for, named by `name`. */
const pageSizeError = (name: string): GraspError =>
  clientError("contract.invalid_args", {
    issues: [
      {
        code: "invalid_page_size",
        message: `${name} is a whole number from 1 to ${queryMaxResults}.`,
        path: [name],
      },
    ],
  });

/** Whether a descriptor (read as data) is an object with field `name`. */
const hasField = (descriptor: unknown, name: string): boolean =>
  isPlainObject(descriptor) &&
  descriptor.kind === "object" &&
  isPlainObject(descriptor.fields) &&
  Object.hasOwn(descriptor.fields, name);

/**
 * Whether `reference` takes the reserved `pagination` argument (spec
 * 9.2), as core checks a window's query; core checks every page it
 * answers too (`contract.not_paginated`).
 */
const declaresPages = (reference: unknown): boolean =>
  isPlainObject(reference) && hasField(reference.args, "pagination");

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

/** A submission in flight, by its scoped key. */
interface Submission {
  readonly input: string;
  readonly done: Promise<unknown>;
}

// Set by `GraspClient`'s static block, which alone reaches its private
// members, before any client exists.
let internalsOf: (client: GraspClient) => ClientInternals;

/**
 * `error`, an outcome the host can't tell, with the key it was sent
 * under among its details: a caller that let the client pick the key
 * can still recover the outcome by it, and not run the call afresh.
 */
const withKey = (error: GraspError, key: string): GraspError =>
  new GraspError({
    code: error.code,
    message: error.message,
    category: error.category,
    retryable: error.retryable,
    requestId: error.requestId,
    details: {
      ...(isPlainObject(error.details) ? error.details : {}),
      idempotencyKey: key,
    },
  });

/** Where a submission stands, for the attempt that settled as it did. */
interface SubmissionAttempt {
  readonly isAction: boolean;
  readonly key: string;
  /** When it was first sent. */
  readonly started: number;
  /** Since when its answers are lost, if they are. */
  readonly lostSince: number | undefined;
  readonly now: number;
}

/** What a submission does next: settle, fail, or send again. */
type SubmissionVerdict =
  | { readonly next: "settle"; readonly value: unknown }
  | { readonly next: "fail"; readonly error: GraspError }
  /** `unknown`: whether it committed can't be told, its answer lost. */
  | { readonly next: "retry"; readonly unknown: boolean };

/**
 * Whether `settled` was refused before anything of the submission ran:
 * a mutation commits all of itself or nothing; an action commits step by
 * step, so only a refusal before it reached the App ran nothing of it.
 */
const ranNothing = (settled: Settled, isAction: boolean): boolean =>
  settled.kind === "failed" &&
  (isAction ? refusedBeforeCallCodes : nothingRanCodes).has(settled.error.code);

/**
 * Whether, after `settled`, what the App's queries show may be out of
 * date: a confirmed change; an action's failure after a step, or its lost
 * answer, which undoes none of what it committed (its queries are read
 * again, the action itself is never run again); or records that moved on since this
 * client read them (`data.conflict`), so a draft kept for the person to
 * reload gets the record as it is now.
 */
const showsStale = (settled: Settled, isAction: boolean): boolean =>
  settled.kind === "value" ||
  (isAction && !ranNothing(settled, isAction)) ||
  (settled.kind === "failed" && settled.error.code === "data.conflict");

/**
 * Where a key left unknown is remembered: by App, operation and key, as
 * the host scopes a key's receipt; not by the App's version, so a resend
 * after a new release is still checked.
 */
const uncertainScope = (reference: SubmissionTarget, key: string): string =>
  canonicalJson([reference.resourceId, reference.contractId, key]);

/**
 * The code of the refusal `settled` is, if it withholds the outcome of
 * what may have run: one `hidesOutcome` names, after a lost answer
 * (`lost`), or, for an action, `operation.access_changed` or
 * `submission.expired`, which come only once something ran under its key
 * (its receipt, or its tombstone once the receipt expired): a form that
 * stays uncertain past the receipt still keeps its key.
 */
const ranUnderKeyCodes: ReadonlySet<string> = new Set([
  "operation.access_changed",
  "submission.expired",
]);

/** The code `settled` withholds an outcome with, if it does (see above). */
const withheldCode = (
  settled: Settled,
  lost: boolean,
  isAction: boolean
): string | undefined => {
  if (settled.kind !== "failed" || !hidesOutcome(settled.error.code)) {
    return undefined;
  }
  const { code } = settled.error;
  return lost || (isAction && ranUnderKeyCodes.has(code)) ? code : undefined;
};

/**
 * `answered` with its value read by `read`, when given: one `read` doesn't
 * accept is as good as lost.
 */
const readSettled = (
  answered: Settled,
  read: ((value: unknown) => unknown) | undefined
): Settled => {
  if (answered.kind !== "value" || read === undefined) {
    return answered;
  }
  const value = read(answered.value);
  return value === undefined ? { kind: "lost" } : { kind: "value", value };
};

/** What a submission does next after `settled` (see `#send`). */
const submissionVerdict = (
  settled: Settled,
  attempt: SubmissionAttempt
): SubmissionVerdict => {
  const { isAction, key, started, lostSince, now } = attempt;
  const outcomeUnknown = (refusal?: string) =>
    clientError(
      "submission.outcome_unknown",
      refusal === undefined
        ? { idempotencyKey: key }
        : { idempotencyKey: key, refusal }
    );
  if (settled.kind === "value") {
    return { next: "settle", value: settled.value };
  }
  if (
    lostSince !== undefined &&
    settled.kind === "failed" &&
    settled.error.category === "authorization"
  ) {
    // An earlier attempt's answer was lost, and access is gone or someone
    // else signed in: whether it committed is the person's to recover
    // with its key, not a failure, and it is never sent again for someone
    // else.
    return { next: "fail", error: outcomeUnknown() };
  }
  // A refusal that withholds the outcome of what may have run: after a
  // lost answer, or an action's `operation.access_changed`, which comes
  // only once something ran under its key. Still unknown, with the key:
  // never a definite failure that invites a resubmit under a fresh one.
  const withheld = withheldCode(settled, lostSince !== undefined, isAction);
  if (withheld !== undefined) {
    return { next: "fail", error: outcomeUnknown(withheld) };
  }
  // An answer lost, or an outcome the host itself can't tell.
  const unknown =
    settled.kind === "lost" || settled.error.category === "uncertain";
  if (unknown && isAction && settled.kind === "failed") {
    // The action's receipt holds what the host can't tell: sending it
    // again answers the same.
    return { next: "fail", error: withKey(settled.error, key) };
  }
  if (unknown) {
    // Sent again under its key, which recovers its receipt (or joins an
    // action still running), for as long as `lostBudgetMs`: never forever.
    return now - (lostSince ?? now) >= lostBudgetMs
      ? { next: "fail", error: outcomeUnknown() }
      : { next: "retry", unknown: true };
  }
  if (!ranNothing(settled, isAction)) {
    return { next: "fail", error: settled.error };
  }
  // A refusal that ran nothing (its budget, a busy sandbox) is sent again
  // for `submissionBudgetMs` from the call's start, or, once an answer was
  // lost, for `lostBudgetMs` from then, past which what the lost answer
  // would have said stays unknown, with its key.
  if (lostSince === undefined) {
    return now - started >= submissionBudgetMs
      ? { next: "fail", error: settled.error }
      : { next: "retry", unknown: false };
  }
  return now - lostSince >= lostBudgetMs
    ? { next: "fail", error: outcomeUnknown(settled.error.code) }
    : { next: "retry", unknown: false };
};

/**
 * The connection `opening` resolves with, or undefined once `signal`
 * aborts first: a caller who left stops waiting for an open that stalls,
 * and a connection that arrives after it left is let go of at once.
 */
const openedUnlessAborted = async (
  opening: Promise<StreamLink>,
  signal: AbortSignal | undefined
): Promise<StreamLink | undefined> => {
  if (signal === undefined) {
    return await opening;
  }
  const left = Promise.withResolvers<"left">();
  const onAbort = (): void => {
    left.resolve("left");
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    const first = await Promise.race([opening, left.promise]);
    if (first !== "left") {
      return first;
    }
    const letGo = async (): Promise<void> => {
      try {
        const late = await opening;
        await late.release();
      } catch {
        // Never opened, or gone already.
      }
    };
    // Nobody waits for it: the caller left already.
    void letGo();
    return undefined;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

/**
 * The session client: queries, mutations and actions of the App, for the
 * person using it. One per App session, made and mounted by the
 * platform; App code gets it from `useClient()`.
 */
export class GraspClient {
  readonly #transport: ClientTransport | undefined;
  readonly #portable: PortableTransport | undefined;
  /** Whose token a portable host's latest call was sent with. */
  #principal: string | undefined;
  readonly #queries = new Map<string, QueryEntry>();
  readonly #pagers = new Map<string, Pager>();
  readonly #submissions = new Map<string, Submission>();
  /** Moves on at every fence: answers to older requests are dropped. */
  #generation = 0;
  /** Reads under way, and the reads waiting for room (`maxReadsInFlight`). */
  #readsInFlight = 0;
  readonly #readWaiters: (() => void)[] = [];
  /** The Apps whose queries a gathered round of re-reads refreshes. */
  readonly #changedApps = new Set<string>();
  #gathering: ReturnType<typeof setTimeout> | undefined;
  /** What the latest fence was for. */
  #fencedBy: GraspError | undefined;
  /**
   * The keys of submissions whose outcome was left unknown, scoped by App
   * and operation as the host scopes them (`uncertainScope`), by the
   * generation they were sent under: one is sent again only within it,
   * never for someone who signed in since, as the host scopes keys by
   * person. Another operation under the same key never clears it.
   */
  readonly #uncertainKeys = new Map<string, number>();
  /** How many subscriptions the client made: each is numbered by it. */
  #attempts = 0;
  /** Told of every fence (`WorkflowLink.onFence`). */
  readonly #fenceListeners = new Set<(refusal: GraspError) => void>();

  /**
   * A portable host's client (`{ url, getToken }`, spec 10.7.1): its
   * bootstrap makes one per App session and mounts it with
   * `GraspProvider`; generated App code never makes one.
   *
   * Over a `ClientTransport`, for the platform only (screen-runtime.ts).
   * By design, not isolation: screen code shares the frame and could make
   * one, but gets nothing from it that `bridge()` doesn't already give it.
   */
  constructor(connection: PortableClientOptions | ClientTransport) {
    if ("call" in connection && typeof connection.call === "function") {
      this.#transport = connection;
      this.#portable = undefined;
    } else if ("url" in connection) {
      this.#transport = undefined;
      this.#portable = new PortableTransport(connection);
    } else {
      throw new TypeError("A client takes { url, getToken }.");
    }
  }

  static {
    internalsOf = (client) => ({
      entry: (reference, args) => client.#entry(reference, args),
      subscribe: (entry, onChange) => client.#subscribe(entry, onChange),
      pager: (reference, args, initialPageSize) =>
        client.#pager(reference, args, initialPageSize),
      subscribePager: (pager, onChange) =>
        client.#subscribePager(pager, onChange),
      retryFailed: () => {
        client.#retryFailed();
      },
      readReference,
      stream: async (reference, args, options, events) =>
        await client.#stream(reference, args, options, events),
      workflowLink: {
        watch: client.#transport?.watch,
        command: async (target, request, key, events) =>
          await client.#send(
            target,
            request,
            key,
            { scoped: canonicalJson([client.#generation, key]), input: "" },
            events
          ),
        fence: (refusal) => {
          client.#fence(refusal);
        },
        onFence: (listener) => {
          client.#fenceListeners.add(listener);
          return () => {
            client.#fenceListeners.delete(listener);
          };
        },
      },
    });
  }

  /**
   * A snapshot of the query `reference` names with `args`: its declared
   * result, or a rejection with a structured error. Aborting `signal`
   * stops only this caller waiting.
   */
  async query<Reference extends QueryReference>(
    reference: Reference,
    ...[args, options]: CallArguments<Reference, QueryOptions>
  ): Promise<ReturnOf<Reference>> {
    const { signal } = readOptions(options, queryOptionKeys);
    const entry = this.#entry(reference, args);
    if (signal?.aborted === true) {
      throw clientError("query.cancelled");
    }
    entry.interest += 1;
    try {
      const value = await waitFor(this.#readCurrent(entry), signal, () =>
        clientError("query.cancelled")
      );
      // SAFETY: the host validated the answer against the reference's
      // declared return, which `Reference` carries as its type.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return value as ReturnOf<Reference>;
    } finally {
      entry.interest -= 1;
      this.#release(entry);
    }
  }

  /**
   * Runs the mutation `reference` names with `args` as one logical
   * submission: resolves with its declared result once the host confirms
   * the commit, or rejects with a structured error. See `SubmitOptions`.
   */
  async mutation<Reference extends MutationReference>(
    reference: Reference,
    ...[args, options]: CallArguments<Reference, SubmitOptions>
  ): Promise<ReturnOf<Reference>> {
    const value = await this.#submit(
      readReference(reference, "mutation"),
      args,
      options
    );
    // SAFETY: as in `query`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return value as ReturnOf<Reference>;
  }

  /**
   * Runs the action `reference` names with `args`: resolves with its
   * declared result, or rejects with a structured error. A lost response
   * is recovered from its receipt under its key, never run again (see the
   * header). See `SubmitOptions`.
   */
  async action<Reference extends ActionReference>(
    reference: Reference,
    ...[args, options]: CallArguments<Reference, SubmitOptions>
  ): Promise<ReturnOf<Reference>> {
    const value = await this.#submit(
      readReference(reference, "action"),
      args,
      options
    );
    // SAFETY: as in `query`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return value as ReturnOf<Reference>;
  }

  /**
   * Runs the streaming action `reference` names with `args` (spec
   * 10.7.6): `options.onProgress` gets each newer progress snapshot, and
   * the promise resolves with the action's declared result, or rejects
   * with a structured error, `operation.cancelled` when it was cancelled.
   * A lost connection attaches to the same invocation again, never runs
   * it twice (see the header). Aborting `signal` stops only this caller
   * following it: the host cancels it once no one does.
   */
  async stream<Reference extends StreamReference>(
    reference: Reference,
    ...[args, options]: StreamArguments<Reference>
  ): Promise<ReturnOf<Reference>> {
    const value = await this.#stream(reference, args, options);
    // SAFETY: as in `query`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return value as ReturnOf<Reference>;
  }

  /** See `stream`; `events` are a hook's (`ClientInternals.stream`). */
  async #stream(
    reference: unknown,
    args: unknown,
    options: unknown,
    events?: StreamEvents
  ): Promise<unknown> {
    const read = readReference(reference, "action", "stream");
    const { signal, idempotencyKey, onProgress } = readOptions(
      options,
      streamOptionKeys
    );
    const input = normalized(read, args);
    const key = idempotencyKey ?? freshKey();
    const request = JSON.stringify({
      reference: wireReference(read),
      input,
      idempotencyKey: key,
    });
    if (
      new TextEncoder().encode(request).byteLength > functionRequestMaxBytes
    ) {
      throw clientError("contract.input_too_large", {
        maxBytes: functionRequestMaxBytes,
      });
    }
    const transport = this.#transport;
    if (
      transport === undefined ||
      transport.stream === undefined ||
      transport.cancelStream === undefined
    ) {
      throw clientError("stream.unavailable");
    }
    const open = transport.stream.bind(transport);
    const cancel = transport.cancelStream.bind(transport);
    if (signal?.aborted === true) {
      throw clientError("submission.cancelled", { sent: false });
    }
    let seen = 0;
    let listening = onProgress !== undefined;
    const progressed = (value: unknown): void => {
      events?.onProgress(value);
      if (!listening) {
        return;
      }
      try {
        onProgress?.(value);
      } catch {
        // Its failure is its own: it isn't called again, and the action
        // goes on (spec 10.7.6).
        listening = false;
      }
    };
    /** A snapshot, if newer than the last and as its descriptor allows. */
    const onProgressFrame = (frameSeq: number, value: unknown): void => {
      if (frameSeq <= seen || read.stream === undefined) {
        return;
      }
      const checked = validateValue(read.stream, value);
      if (checked.issues === undefined) {
        seen = frameSeq;
        progressed(frozen(checked.value));
      }
    };
    /** Resolves once the invocation first answered (true), or never will. */
    const opened = Promise.withResolvers<boolean>();
    /** Follows the invocation over one connection, until it ends. */
    const follow = async (what: "stream" | "attach"): Promise<Followed> => {
      const ended = Promise.withResolvers<Followed>();
      // Whether this connection still speaks for the caller: once it left,
      // or the connection ended, a frame it delivers late is dropped, so it
      // never reaches `onProgress` after the run settled for the caller.
      let live = true;
      const onFrame = (raw: unknown): void => {
        if (!live) {
          return;
        }
        const frame = readFrame(raw);
        if (frame?.type === "closed") {
          ended.resolve({ kind: "lost" });
        } else if (frame?.type === "result") {
          ended.resolve({
            kind: "settled",
            settled: frame.settled,
            answered: true,
          });
        } else if (frame?.type === "progress") {
          onProgressFrame(frame.seq, frame.value);
        }
      };
      let link: StreamLink;
      // A reconnect that doesn't open in time is given up on: it counts as
      // a failed attempt, never a wait without end.
      const stalled = new AbortController();
      const stall =
        what === "attach"
          ? setTimeout(() => {
              stalled.abort();
            }, streamAttachOpenMs)
          : undefined;
      try {
        const opening = open(what, request, onFrame);
        const arrived = await openedUnlessAborted(
          opening,
          signal === undefined
            ? stalled.signal
            : AbortSignal.any([signal, stalled.signal])
        );
        if (arrived === undefined) {
          live = false;
          return isAborted(signal) ? { kind: "aborted" } : { kind: "lost" };
        }
        link = arrived;
        opened.resolve(true);
      } catch (error) {
        live = false;
        return {
          kind: "settled",
          settled: readRejection(error),
          answered: false,
        };
      } finally {
        clearTimeout(stall);
      }
      if (what === "attach") {
        events?.onAttached();
      }
      const onAbort = (): void => {
        ended.resolve({ kind: "aborted" });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
      }
      try {
        return await ended.promise;
      } finally {
        live = false;
        signal?.removeEventListener("abort", onAbort);
        try {
          await link.release();
        } catch {
          // Gone already.
        }
      }
    };
    // A cancel asked for before the invocation answered waits for it: sent
    // before, it could reach the host ahead of the start and find nothing
    // to cancel, while the run then went ahead. One that never opened has
    // nothing to cancel.
    events?.onStarted(async () => {
      if (await opened.promise) {
        await this.#cancelStream(request, cancel);
      }
    });
    try {
      return await this.#settleStream(follow, {
        resourceId: read.resourceId,
        key,
        events,
        signal,
      });
    } finally {
      opened.resolve(false);
    }
  }

  /**
   * Follows a streaming action's invocation until it settles (see the
   * header): its value, or its failure thrown. Starts it once, then, once
   * a start may have reached the host, only ever attaches; a reconnect
   * refused before it reached the invocation goes on recovering; after
   * `streamAttachAttempts` it rejects `stream.outcome_unknown` with the key.
   */
  async #settleStream(
    follow: (what: "stream" | "attach") => Promise<Followed>,
    {
      resourceId,
      key,
      events,
      signal,
    }: {
      readonly resourceId: string;
      readonly key: string;
      readonly events: StreamEvents | undefined;
      readonly signal: AbortSignal | undefined;
    }
  ): Promise<unknown> {
    let refused = 0;
    // Once a start may have reached the host, only ever attach.
    let what: "stream" | "attach" = "stream";
    let recoveringSince: number | undefined;
    for (let tries = 1; ; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one connection after another
      const followed = await follow(what);
      if (followed.kind === "aborted") {
        // Its start may have reached the host, and what it ran saved
        // something: the App's queries are read again, as on every other
        // exit that leaves its outcome unknown.
        this.#changed(resourceId);
        throw clientError("stream.cancelled", { idempotencyKey: key });
      }
      const settled: Settled =
        followed.kind === "settled" ? followed.settled : { kind: "lost" };
      if (settled.kind === "value") {
        this.#changed(resourceId);
        return settled.value;
      }
      // A refusal of a reconnect before it reached the invocation (the
      // request budget) says nothing of the run: recovery goes on.
      const attachRefused =
        what === "attach" &&
        settled.kind === "failed" &&
        followed.kind === "settled" &&
        !followed.answered &&
        refusedBeforeCallCodes.has(settled.error.code);
      if (settled.kind === "failed" && !attachRefused) {
        const { error } = settled;
        if (fences(error.code)) {
          this.#fence(error);
        }
        refused += 1;
        if (!startAgain(followed, what, refused)) {
          this.#changed(resourceId);
          // An outcome the host can't tell carries the key, so a caller that
          // let the client pick it can still recover the receipt by it.
          throw error.category === "uncertain" ? withKey(error, key) : error;
        }
      } else {
        what = "attach";
        recoveringSince ??= Date.now();
        if (recoveryOver(tries, recoveringSince)) {
          // What it ran may have committed: the App's queries are read again.
          this.#changed(resourceId);
          throw clientError("stream.outcome_unknown", { idempotencyKey: key });
        }
        events?.onRecovering();
      }
      // A refused start waits as long as the refusal said; an attach comes
      // back before the host cancels a run no one follows.
      const wait =
        what === "stream" || attachRefused
          ? waitAfter(settled, tries)
          : Math.min(retryDelay(tries), streamIdleCancelMs / 2);
      // oxlint-disable-next-line no-await-in-loop -- one connection after another
      await sleep(wait, signal);
      if (isAborted(signal)) {
        // As above: it may have run, and saved something.
        this.#changed(resourceId);
        throw clientError("stream.cancelled", { idempotencyKey: key });
      }
    }
  }

  /**
   * Asks the host to cancel the invocation `request` names: resolves once
   * it acknowledged the request (`{ requested }`), whether or not the run
   * was still going; rejects a refusal with its error, and an answer that
   * isn't an acknowledgement, a lost one included, with
   * `operation.unreachable`, so a caller never takes an unconfirmed cancel
   * for one.
   */
  async #cancelStream(
    request: string,
    send: (text: string) => Promise<unknown>
  ): Promise<void> {
    let answer: unknown;
    try {
      answer = await send(request);
    } catch (error) {
      const settled = readRejection(error);
      if (settled.kind === "failed") {
        if (fences(settled.error.code)) {
          this.#fence(settled.error);
        }
        throw settled.error;
      }
      throw clientError("operation.unreachable");
    }
    if (!isPlainObject(answer) || typeof answer.requested !== "boolean") {
      throw clientError("operation.unreachable");
    }
  }

  /** See `ClientInternals.entry`. */
  #entry(reference: unknown, args: unknown): QueryEntry {
    const read = readReference(reference, "query");
    return this.#entryFor(read, normalized(read, args));
  }

  /**
   * The shared entry of `read` with `input`, made if there is none: the
   * query, or with `extent` a paginated list's window of it.
   */
  #entryFor(read: ReadReference, input: Json, extent?: number): QueryEntry {
    // A query's request is bounded as a submission's is, before it is sent.
    const request = JSON.stringify({
      reference: wireReference(read),
      input,
      ...(extent === undefined ? {} : { window: { extent } }),
    });
    if (
      new TextEncoder().encode(request).byteLength > functionRequestMaxBytes
    ) {
      throw clientError("contract.input_too_large", {
        maxBytes: functionRequestMaxBytes,
      });
    }
    const key = canonicalJson([
      read.resourceId,
      read.resourceVersion,
      read.contractId,
      read.fingerprint,
      input,
      ...(extent === undefined ? [] : [{ window: extent }]),
    ]);
    const known = this.#queries.get(key);
    if (known !== undefined) {
      return known;
    }
    const entry: QueryEntry = {
      key,
      reference: read,
      input,
      request,
      snapshot: loading,
      listeners: new Set(),
      interest: 0,
      live: undefined,
      sent: 0,
      shown: 0,
      stale: false,
      changes: 0,
      reading: undefined,
      evict: undefined,
      settled: 0,
      window: extent !== undefined,
    };
    this.#queries.set(key, entry);
    // Made for a render that may never subscribe: let go of it unless one does.
    this.#release(entry);
    return entry;
  }

  /** See `ClientInternals.subscribe`. */
  #subscribe(entry: QueryEntry, onChange: () => void): () => void {
    entry.listeners.add(onChange);
    clearTimeout(entry.evict);
    entry.evict = undefined;
    // Dropped while its render waited to commit: cached again, unless
    // another reader has made the query's entry anew meanwhile.
    if (!this.#queries.has(entry.key)) {
      this.#queries.set(entry.key, entry);
    }
    if (this.#transport === undefined) {
      const current = entry.snapshot.value !== undefined && !entry.stale;
      if (
        entry.reading === undefined &&
        !current &&
        entry.snapshot.error === undefined
      ) {
        this.#refresh(entry);
      }
    } else if (entry.live === undefined && entry.snapshot.error === undefined) {
      this.#follow(entry, 0);
    }
    return () => {
      entry.listeners.delete(onChange);
      // Released once the task that let go of it ends without another
      // reader: React resubscribes a component within one commit, and
      // that keeps the subscription rather than follow the query anew.
      queueMicrotask(() => {
        if (entry.listeners.size === 0) {
          GraspClient.#unfollow(entry);
        }
      });
      this.#release(entry);
    };
  }

  /** See `ClientInternals.retryFailed`. */
  #retryFailed(): void {
    for (const pager of this.#pagers.values()) {
      pager.failure = undefined;
    }
    for (const entry of this.#queries.values()) {
      if (entry.snapshot.error !== undefined) {
        show(entry, loading);
        if (entry.listeners.size === 0) {
          continue;
        }
        if (this.#transport === undefined) {
          this.#refresh(entry);
        } else if (entry.live === undefined) {
          this.#follow(entry, 0);
        }
      } else if (
        // A window shown whose refresh failed in a way that may pass: it
        // stays shown, and old, until it is tried again (`#settleWindow`).
        this.#transport === undefined &&
        entry.stale &&
        entry.reading === undefined &&
        entry.listeners.size > 0
      ) {
        this.#refresh(entry);
      }
    }
    for (const pager of this.#pagers.values()) {
      GraspClient.#pagerChanged(pager);
    }
  }

  /** See `ClientInternals.pager`. */
  #pager(reference: unknown, args: unknown, initialPageSize: unknown): Pager {
    if (!isPageSize(initialPageSize)) {
      throw pageSizeError("initialPageSize");
    }
    const read = readReference(reference, "query");
    if (!declaresPages(reference)) {
      throw clientError("contract.not_paginated");
    }
    const input = GraspClient.#listInput(read, args);
    const key = canonicalJson([
      read.resourceId,
      read.resourceVersion,
      read.contractId,
      read.fingerprint,
      input,
      initialPageSize,
    ]);
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
    const current = this.#entryFor(read, input, initialPageSize);
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
      snapshot: GraspClient.#snapshotOf(current, undefined, false, loadMore),
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

  /**
   * A list's arguments, without `pagination`, normalized as the host
   * normalizes them: checked with a placeholder page, which is then left
   * out. `pagination` among them is refused: the client supplies it.
   */
  static #listInput(read: ReadReference, args: unknown): Json {
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
    const page = { pageSize: 1, cursor: null };
    let withPage: unknown = args;
    if (args === undefined) {
      withPage = { pagination: page };
    } else if (isPlainObject(args)) {
      withPage = { ...args, pagination: page };
    }
    const checked = normalized(read, withPage);
    if (!isPlainObject(checked)) {
      throw clientError("contract.not_paginated");
    }
    return Object.fromEntries(
      Object.entries(checked).filter(([name]) => name !== "pagination")
    );
  }

  /** See `ClientInternals.subscribePager`. */
  #subscribePager(pager: Pager, onChange: () => void): () => void {
    pager.listeners.add(onChange);
    clearTimeout(pager.evict);
    pager.evict = undefined;
    if (!this.#pagers.has(pager.key)) {
      this.#pagers.set(pager.key, pager);
    }
    pager.stopCurrent ??= this.#subscribe(pager.current, () => {
      GraspClient.#pagerChanged(pager);
    });
    GraspClient.#pagerChanged(pager);
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
   * list ends. A later reader, such as a screen that switched its
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
      pager.current = this.#entryFor(
        pager.reference,
        pager.input,
        pager.initialPageSize
      );
    }
    GraspClient.#pagerChanged(pager);
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
      throw GraspClient.#failPager(pager, pageSizeError("pageSize"));
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
      throw GraspClient.#failPager(
        pager,
        clientError("query.window_limit", { maxItems: liveWindowMaxItems })
      );
    }
    const entry = this.#entryFor(pager.reference, pager.input, extent);
    const extension: Extension = {
      extent,
      entry,
      stop: undefined,
      since: entry.settled,
      current: false,
      awaitingRead: this.#transport === undefined,
      done: Promise.withResolvers<null>(),
    };
    void observe(extension.done.promise);
    pager.extension = extension;
    // A read of it under way from before: older than the Load More. And
    // a follow from before, pushed to or not yet: its answer may be too.
    const older = entry.reading;
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
    handle.unsubscribe = this.#subscribe(entry, () => {
      GraspClient.#pagerChanged(pager);
    });
    if (handle.stopped) {
      handle.unsubscribe();
    }
    // The larger window is shown only from an answer that came after the
    // Load More began: one cached, or pushed to another list that follows
    // it, may be older than the window shown, as windows of one query are
    // read and pushed on their own. So it is read afresh: followed anew
    // over the frame, read again on a portable host.
    if (this.#transport === undefined) {
      // On a portable host, the read itself settles the Load More; its
      // readers see it loading at once.
      GraspClient.#pagerChanged(pager);
      void this.#readExtension(pager, extension, older);
      await extension.done.promise;
      return;
    }
    if (followedBefore !== undefined && entry.live === followedBefore) {
      GraspClient.#unfollow(entry);
      this.#follow(entry, 0);
    }
    // A window that shows a failure already fails the Load More at once:
    // following it again waits for the list to be tried again.
    extension.current = entry.snapshot.error !== undefined;
    GraspClient.#pagerChanged(pager);
    await extension.done.promise;
  }

  /**
   * Settles one read of a window on a portable host, the one way every
   * such read ends (core's query-windows.ts): its window is shown; or its
   * failure (writes kept tearing it, the person's budget spent partway, a
   * lost answer) is thrown to the read's caller, the window already shown
   * kept, or shown when nothing is, so a first load throws it. Never read
   * again here: a window too large for the person's budget is refused,
   * with when to try again, not started over.
   */
  static #settleWindow(
    entry: QueryEntry,
    read: { readonly number: number; readonly changes: number },
    settled: Settled
  ): unknown {
    // Only a failure that may pass keeps the window shown; any other is
    // shown, as an ordinary query's would be, and thrown while rendering.
    const passing =
      settled.kind === "lost" ||
      (settled.kind === "failed" &&
        (settled.error.retryable || nothingRanCodes.has(settled.error.code)));
    if (passing && entry.snapshot.value !== undefined) {
      throw settled.kind === "failed"
        ? settled.error
        : clientError("operation.unreachable");
    }
    return settleRead(entry, read, settled);
  }

  /**
   * Reads the larger window `extension` waits for afresh, on a portable
   * host, after any read of it from before the Load More (`older`), and
   * settles the Load More with
   * what that read came to (`#settleWindow`): shown, it is promoted;
   * failed, the Load More rejects, whoever else shows that window keeping
   * it.
   */
  async #readExtension(
    pager: Pager,
    extension: Extension,
    older: QueryEntry["reading"]
  ): Promise<void> {
    const { entry } = extension;
    // A read from before the Load More is waited out; one it started
    // (`#subscribe` reads a window it has nothing current of) is joined.
    if (older !== undefined && entry.reading === older) {
      await observe(older.done);
      // Given up on meanwhile (the list closed, a fence, someone else
      // signed in): nothing more is read for it.
      if (pager.extension !== extension) {
        return;
      }
    }
    try {
      await this.#read(entry);
    } catch (error) {
      if (pager.extension === extension) {
        GraspClient.#failExtension(
          pager,
          extension,
          error instanceof GraspError
            ? error
            : clientError("operation.unreachable")
        );
      }
      return;
    }
    // Its own read settled: only now is its window taken.
    extension.awaitingRead = false;
    extension.current = true;
    GraspClient.#pagerChanged(pager);
  }

  /**
   * Ends `extension` with `error`: the Load More rejects. A failure that
   * may pass (writes tearing the window, the person's budget, a busy
   * sandbox) keeps the list as it is, to try again; any other is the
   * list's failure, thrown while rendering.
   */
  static #failExtension(
    pager: Pager,
    extension: Extension,
    error: GraspError
  ): void {
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
    GraspClient.#pagerChanged(pager);
  }

  /** Fails every Load More waiting for `entry`'s window with `error`. */
  #failExtensionsOf(entry: QueryEntry, error: GraspError): void {
    for (const pager of this.#pagers.values()) {
      const { extension } = pager;
      if (extension?.entry === entry) {
        GraspClient.#failExtension(pager, extension, error);
      }
    }
  }

  /** Records `failure` as `pager`'s, to throw while rendering, and answers it. */
  static #failPager(pager: Pager, failure: GraspError): GraspError {
    pager.failure = failure;
    GraspClient.#pagerChanged(pager);
    return failure;
  }

  /**
   * Stops every Load More under way, as `reason` rejects it: the person
   * or their access changed, and a larger window read before isn't theirs
   * to show.
   */
  #cancelExtensions(reason: GraspError): void {
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
  #restartPagers(refusal?: GraspError): void {
    for (const pager of this.#pagers.values()) {
      if (pager.extent === pager.initialPageSize) {
        // Its snapshot shows what its first page shows now, read by a
        // remount at once, whether or not anyone listens meanwhile.
        GraspClient.#pagerChanged(pager);
        continue;
      }
      const before = pager.stopCurrent;
      pager.extent = pager.initialPageSize;
      pager.current = this.#entryFor(
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
          ? this.#subscribe(pager.current, () => {
              GraspClient.#pagerChanged(pager);
            })
          : undefined;
      before?.();
      GraspClient.#pagerChanged(pager);
    }
  }

  /**
   * Something `pager` shows changed: its Load More's window shows once
   * core pushed it after the Load More began (or at once, when it was
   * current already), or fails it; then the list's readers are told of
   * its new snapshot, if it is new.
   */
  static #pagerChanged(pager: Pager): void {
    const { extension } = pager;
    if (extension !== undefined) {
      const { entry } = extension;
      const fresh =
        !extension.awaitingRead &&
        (extension.current || entry.settled > extension.since);
      const { error } = entry.snapshot;
      if (fresh && error !== undefined) {
        // Writes kept the larger window from being read whole, say: the
        // Load More fails, the window shown stays, a later one afresh.
        GraspClient.#failExtension(pager, extension, error);
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
    const next = GraspClient.#snapshotOf(
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
  }

  /**
   * What a list's readers see (spec 10.6's states): the window `current`
   * shows, or its failure or the list's own (`failure`); loading until the
   * first window shows, and while a Load More is `extending` it.
   */
  static #snapshotOf(
    current: QueryEntry,
    failure: GraspError | undefined,
    extending: boolean,
    loadMore: Pager["loadMore"]
  ): PagerSnapshot {
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
  }

  /** Drops `entry` once nothing has read it for a while. */
  #release(entry: QueryEntry): void {
    if (wanted(entry) || entry.evict !== undefined) {
      return;
    }
    entry.evict = setTimeout(() => {
      entry.evict = undefined;
      if (!wanted(entry)) {
        entry.reading?.stop.abort();
        entry.reading = undefined;
        this.#queries.delete(entry.key);
      }
    }, keepMs);
  }

  /**
   * Follows `entry`'s query: subscribes, and shows each push of core's
   * in order (see the header). `failures` is how often in a row it was
   * lost before.
   */
  #follow(entry: QueryEntry, failures: number): void {
    this.#attempts += 1;
    const live: Live = {
      attempt: this.#attempts,
      release: undefined,
      revision: 0,
      failures,
      since: Date.now(),
      retry: undefined,
      stopped: false,
    };
    entry.live = live;
    void this.#connect(entry, live);
  }

  /** Whether `live` is still what `entry` shows. */
  static #current(entry: QueryEntry, live: Live): boolean {
    return entry.live === live && !live.stopped;
  }

  async #connect(entry: QueryEntry, live: Live): Promise<void> {
    const watch = this.#transport?.watch;
    if (watch === undefined) {
      return;
    }
    let handle: { release: () => void };
    try {
      handle = await watch(
        entry.request,
        (push) => {
          if (GraspClient.#current(entry, live)) {
            this.#pushed(entry, live, push);
          }
        },
        () => {
          if (GraspClient.#current(entry, live)) {
            this.#lost(entry, live);
          }
        }
      );
    } catch (error) {
      if (!GraspClient.#current(entry, live)) {
        return;
      }
      const settled = readRejection(error);
      if (settled.kind === "failed") {
        if (fences(settled.error.code)) {
          this.#fence(settled.error);
          return;
        }
        if (!nothingRanCodes.has(settled.error.code)) {
          live.stopped = true;
          entry.live = undefined;
          show(entry, { value: undefined, error: settled.error });
          return;
        }
      }
      // A refusal for the request budget says how long to wait: never
      // less than that, whatever the backoff would allow.
      this.#lost(
        entry,
        live,
        settled.kind === "failed" ? waitAfter(settled, 1) : 0
      );
      return;
    }
    if (GraspClient.#current(entry, live)) {
      live.release = handle.release;
    } else {
      handle.release();
    }
  }

  /** Shows a push of `live`'s, unless it is older than one shown. */
  #pushed(entry: QueryEntry, live: Live, push: unknown): void {
    const read = readPush(push);
    if (read === undefined || read.revision <= live.revision) {
      return;
    }
    live.revision = read.revision;
    // Every read sent before this push is older than it: one answered
    // later, once nobody follows the query, never replaces it.
    entry.shown = entry.sent;
    const { settled } = read;
    if (settled.kind === "value") {
      show(entry, { value: settled.value, error: undefined });
      return;
    }
    if (settled.kind === "failed") {
      const { error } = settled;
      if (fences(error.code)) {
        this.#fence(error);
        return;
      }
      if (error.retryable && entry.snapshot.value !== undefined) {
        // A paginated list's window core couldn't read whole while writes
        // landed (`query.concurrent_change`, its last push): what it
        // shows stays, and it follows again, backing off, once core lets
        // go of it. A Load More waiting for this window afresh fails now,
        // rather than wait on a read writes may keep tearing; whoever
        // else shows the window keeps it.
        this.#failExtensionsOf(entry, error);
        return;
      }
      if (endsFollowing(error.code) || error.retryable) {
        GraspClient.#stop(live);
        entry.live = undefined;
      }
      if (error.code === accessChangedCode) {
        this.#accessChanged(entry.reference.resourceId, error);
      }
      show(entry, { value: undefined, error });
    }
  }

  /**
   * Core, or the connection to it, let go of `live`: keeps the last
   * snapshot and follows again after a jittered delay.
   */
  #lost(entry: QueryEntry, live: Live, atLeastMs = 0): void {
    live.release = undefined;
    const failures =
      Date.now() - live.since >= steadyMs ? 0 : live.failures + 1;
    live.retry = setTimeout(
      () => {
        if (GraspClient.#current(entry, live) && entry.listeners.size > 0) {
          this.#follow(entry, failures);
        }
      },
      Math.max(atLeastMs, followDelay(Math.max(0, failures - 1)))
    );
  }

  /** Stops `live`: released, its retry cancelled, nothing of it shown. */
  static #stop(live: Live): void {
    live.stopped = true;
    clearTimeout(live.retry);
    live.release?.();
    live.release = undefined;
  }

  /** Stops following `entry`'s query: no component reads it any more. */
  static #unfollow(entry: QueryEntry): void {
    const { live } = entry;
    entry.live = undefined;
    if (live !== undefined) {
      GraspClient.#stop(live);
    }
  }

  /**
   * Reads `entry` for an imperative caller: a read under way that a change
   * confirmed since may not see is waited out first, so the answer is of
   * after every change this client confirmed before the call.
   */
  async #readCurrent(entry: QueryEntry): Promise<unknown> {
    if (entry.reading !== undefined && entry.stale) {
      await observe(entry.reading.done);
    }
    return await this.#read(entry);
  }

  /** Reads `entry` again for its readers, failures shown through its snapshot. */
  #refresh(entry: QueryEntry): void {
    void observe(this.#read(entry));
  }

  /**
   * Reads `entry` from the host, joining a read already under way:
   * resolves with its value, or rejects with why it failed. The answer
   * is shown to its readers unless a newer one is, or a fence came
   * between. A lost response is read again, for as long as a component
   * reads the query, or a few times for an imperative read alone. A
   * change confirmed while it was under way reads it again after.
   */
  async #read(entry: QueryEntry): Promise<unknown> {
    if (entry.reading !== undefined) {
      return await entry.reading.done;
    }
    entry.sent += 1;
    const number = entry.sent;
    const { changes } = entry;
    const generation = this.#generation;
    const stop = new AbortController();
    const { request } = entry;
    /** Why the read stops early: a fence came between, or no one waits. */
    const interrupted = (): GraspError | undefined => {
      if (generation !== this.#generation) {
        return this.#fencedBy ?? clientError("query.cancelled");
      }
      return stop.signal.aborted ? clientError("query.cancelled") : undefined;
    };
    const bound: Bound = { generation };
    const attempt = async (): Promise<unknown> => {
      const started = Date.now();
      for (let tries = 1; ; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        const release = await this.#readRoom(stop.signal);
        let settled: Settled;
        try {
          const early = interrupted();
          if (early !== undefined) {
            throw early;
          }
          // oxlint-disable-next-line no-await-in-loop -- one attempt after another
          settled = await this.#call(
            request,
            entry.reference.resourceId,
            bound
          );
        } finally {
          release();
        }
        if (settled.kind === "failed" && fences(settled.error.code)) {
          // The fence showed it to every reader already.
          throw settled.error;
        }
        const stopped = interrupted();
        if (stopped !== undefined) {
          throw stopped;
        }
        const waitingForBudget =
          settled.kind === "failed" &&
          settled.error.code === "screen.rate_limited" &&
          Date.now() - started < submissionBudgetMs;
        const keepTrying =
          entry.listeners.size > 0 ||
          tries < imperativeAttempts ||
          waitingForBudget;
        // A window is never read again here: whatever its read came to
        // is the list's to settle, as over the frame (`#settleWindow`).
        if (entry.window) {
          return GraspClient.#settleWindow(entry, { number, changes }, settled);
        }
        if (!worthRetrying(settled) || !keepTrying || !wanted(entry)) {
          return settleRead(entry, { number, changes }, settled);
        }
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        await sleep(waitAfter(settled, tries), stop.signal);
        const late = interrupted();
        if (late !== undefined) {
          throw late;
        }
      }
    };
    const done = attempt();
    entry.reading = { done, stop };
    let failed = false;
    try {
      return await done;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (entry.reading?.done === done) {
        entry.reading = undefined;
        // A window whose read failed (writes tearing it, the person's
        // budget spent) is read again only at the next change, never at
        // once: an immediate read would only fail, and spend, again.
        if (
          !(failed && entry.window) &&
          entry.stale &&
          entry.listeners.size > 0 &&
          entry.live === undefined &&
          this.#transport === undefined &&
          generation === this.#generation
        ) {
          this.#refresh(entry);
        }
      }
    }
  }

  /**
   * One call through the transport, settled. A refusal of the person or
   * the build fences every cache before its caller hears of it.
   */
  async #call(request: string, app: string, bound: Bound): Promise<Settled> {
    let settled: Settled;
    try {
      settled = readAnswer(await this.#through(request, app, bound));
    } catch (error) {
      const refusal =
        typeof error === "object" && error !== null
          ? unsentCalls.get(error)
          : undefined;
      if (refusal !== undefined) {
        return { kind: "failed", error: refusal };
      }
      settled = readRejection(error);
    }
    // A refusal of a request sent before the latest fence is of who or
    // what that fence already cleared: it doesn't fence whoever came after.
    const current =
      bound.generation === undefined || bound.generation === this.#generation;
    const fencing =
      settled.kind === "failed" ? fencingRefusalOf(settled.error) : undefined;
    if (current && fencing !== undefined) {
      this.#fence(fencing);
    }
    return settled;
  }

  /**
   * Sends `request` through the transport. A portable host's token is
   * asked for first: when it is someone else's than the last call's, all
   * the client holds is cleared before anything is sent with it
   * (`#switchPrincipal`), and a call bound to before is refused unsent.
   */
  async #through(request: string, app: string, bound: Bound): Promise<unknown> {
    // Fenced since the call began (a retry of a lost answer among them):
    // refused unsent, as the fence was, whichever way the host is reached.
    this.#refuseIfFenced(bound);
    const portable = this.#portable;
    if (portable === undefined) {
      return await this.#transport?.call(request, app);
    }
    const token = await portable.token();
    if (this.#principal !== undefined && token.principal !== this.#principal) {
      this.#switchPrincipal();
    }
    this.#principal = token.principal;
    if (bound.principal !== undefined && bound.principal !== token.principal) {
      throw unsent(clientError("auth.principal_changed"));
    }
    // Asking for the token may itself have found someone else signed in.
    this.#refuseIfFenced(bound);
    bound.principal = token.principal;
    return await portable.send(request, app, token.text);
  }

  /** Refuses, unsent, a call bound to a generation before the latest fence. */
  #refuseIfFenced(bound: Bound): void {
    if (
      bound.generation !== undefined &&
      bound.generation !== this.#generation
    ) {
      throw unsent(this.#fencedBy ?? clientError("auth.principal_changed"));
    }
  }

  /**
   * Someone else signed in on a portable host: drops every result held
   * and every answer still to come for the person before, and reads
   * again what is read now, for the person now. Submissions in flight
   * are no longer joined; theirs stay theirs (`#send`).
   */
  #switchPrincipal(): void {
    this.#generation += 1;
    this.#fencedBy = clientError("auth.principal_changed");
    this.#submissions.clear();
    this.#cancelExtensions(this.#fencedBy);
    for (const entry of this.#queries.values()) {
      entry.reading?.stop.abort();
      entry.reading = undefined;
      entry.shown = entry.sent;
      entry.stale = true;
      show(entry, loading);
    }
    // Lists start again at their first page before anything is read, so
    // the person now pays for no window loaded by the person before.
    this.#restartPagers();
    for (const entry of this.#queries.values()) {
      if (entry.listeners.size > 0 && entry.reading === undefined) {
        this.#refresh(entry);
      }
    }
    this.#tellFence(this.#fencedBy);
  }

  /** Tells the fence's listeners (`WorkflowLink.onFence`) of `refusal`. */
  #tellFence(refusal: GraspError): void {
    for (const listener of this.#fenceListeners) {
      listener(refusal);
    }
  }

  /**
   * Clears every cached result: the person, or the build, lost access
   * (`refusal` says how). Reads under way are dropped, and every query
   * shows the refusal in place of its data; trying again
   * (`retryFailed`) reads it afresh.
   */
  #fence(refusal: GraspError): void {
    this.#generation += 1;
    this.#fencedBy = refusal;
    // Nothing of anyone's is held now: whoever's token comes next starts
    // afresh, without a switch to refuse calls over, and joins no save
    // made before.
    this.#principal = undefined;
    this.#submissions.clear();
    this.#cancelExtensions(refusal);
    for (const entry of this.#queries.values()) {
      GraspClient.#unfollow(entry);
      entry.reading?.stop.abort();
      entry.reading = undefined;
      entry.shown = entry.sent;
      entry.stale = true;
      show(entry, { value: undefined, error: refusal });
    }
    // How far the person loaded is theirs too: tried again, whoever is
    // signed in then starts at the first page.
    this.#restartPagers(refusal);
    this.#tellFence(refusal);
  }

  /**
   * The person's roles in App `resourceId` dropped (`screen.access_changed`,
   * pushed as a followed query's last result): what any query of the App
   * keeps that nobody reads was read under the old roles: forgotten, so
   * whoever reads it next reads it afresh, under the new. One read but
   * not followed (a `query()` under way) keeps nothing a read sent before
   * answers: that answer goes to its caller only. One whose following
   * was lost and waits to follow again (or whose new following core has
   * not answered or pushed to yet) shows no more what it kept, until its
   * next push. A followed query is left to its own pushes: core ends each
   * with this, and one that followed again since shows what it read
   * under the new roles.
   */
  #accessChanged(resourceId: string, error: GraspError): void {
    for (const entry of this.#queries.values()) {
      if (entry.reference.resourceId !== resourceId) {
        continue;
      }
      if (!wanted(entry)) {
        clearTimeout(entry.evict);
        entry.evict = undefined;
        entry.reading?.stop.abort();
        entry.reading = undefined;
        this.#queries.delete(entry.key);
        show(entry, loading);
      } else if (entry.live === undefined) {
        entry.shown = entry.sent;
        entry.stale = true;
        entry.changes += 1;
        if (entry.listeners.size === 0) {
          show(entry, loading);
        }
      } else if (GraspClient.#waitsToFollow(entry.live)) {
        show(entry, { value: undefined, error });
      }
    }
  }

  /**
   * Whether `live` shows nothing core pushed it: lost and waiting to
   * follow again, or not yet pushed to, answered or not.
   */
  static #waitsToFollow(live: Live): boolean {
    return live.retry !== undefined || live.revision === 0;
  }

  /**
   * After a change the host confirmed: every query of the same App is
   * read again where it is read (after a read under way, which may not
   * see the change), and marked old where it isn't, so no screen keeps
   * showing what the change made out of date.
   */
  #changed(resourceId: string): void {
    for (const entry of this.#queries.values()) {
      if (entry.reference.resourceId === resourceId) {
        entry.stale = true;
        entry.changes += 1;
      }
    }
    // Over the frame, core pushes what the change made out of date: the
    // marks above only keep a later imperative read from joining an
    // older one (`#readCurrent`). Elsewhere, changes in quick succession
    // share one round of re-reads.
    if (this.#transport !== undefined) {
      return;
    }
    this.#changedApps.add(resourceId);
    if (this.#gathering !== undefined) {
      return;
    }
    this.#gathering = setTimeout(() => {
      this.#gathering = undefined;
      const changed = new Set(this.#changedApps);
      this.#changedApps.clear();
      for (const entry of this.#queries.values()) {
        if (
          changed.has(entry.reference.resourceId) &&
          entry.stale &&
          entry.listeners.size > 0 &&
          entry.reading === undefined
        ) {
          this.#refresh(entry);
        }
      }
    }, changeGatherMs);
  }

  /**
   * Waits for room among the reads under way (`maxReadsInFlight`), or
   * until `signal` aborts: what it answers gives the room back.
   */
  async #readRoom(signal: AbortSignal): Promise<() => void> {
    while (this.#readsInFlight >= maxReadsInFlight && !signal.aborted) {
      const { promise, resolve } = Promise.withResolvers<null>();
      const wake = (): void => {
        resolve(null);
      };
      this.#readWaiters.push(wake);
      signal.addEventListener("abort", wake, { once: true });
      try {
        // oxlint-disable-next-line no-await-in-loop -- one wait after another
        await promise;
      } finally {
        signal.removeEventListener("abort", wake);
        const waiting = this.#readWaiters.indexOf(wake);
        if (waiting !== -1) {
          this.#readWaiters.splice(waiting, 1);
        }
      }
    }
    this.#readsInFlight += 1;
    let given = false;
    return () => {
      if (!given) {
        given = true;
        this.#readsInFlight -= 1;
        this.#readWaiters.shift()?.();
      }
    };
  }

  /** Sends one submission (see the header), and waits as its caller asked. */
  async #submit(
    reference: ReadReference,
    args: unknown,
    options: unknown
  ): Promise<unknown> {
    const { signal, idempotencyKey } = readOptions(options, submitOptionKeys);
    const input = normalized(reference, args);
    // A key an unknown outcome was left under is the person's it was sent
    // for: sent again for someone who signed in since, the host would take
    // it as theirs, and commit the first person's change as them.
    const sentUnder =
      idempotencyKey === undefined
        ? undefined
        : this.#uncertainKeys.get(uncertainScope(reference, idempotencyKey));
    if (sentUnder !== undefined && sentUnder !== this.#generation) {
      throw clientError("auth.principal_changed");
    }
    const key = idempotencyKey ?? freshKey();
    const request = JSON.stringify({
      reference: wireReference(reference),
      input,
      idempotencyKey: key,
    });
    if (
      new TextEncoder().encode(request).byteLength > functionRequestMaxBytes
    ) {
      throw clientError("contract.input_too_large", {
        maxBytes: functionRequestMaxBytes,
      });
    }
    if (signal?.aborted === true) {
      throw clientError("submission.cancelled", { sent: false });
    }
    // Joined only by a call for the same person, as the host scopes keys:
    // within one generation, which a switch of person or a fence ends
    // (each also drops the joins). Not by the person's ID, which the first
    // token only tells after the first save was keyed.
    const scoped = canonicalJson([
      this.#generation,
      reference.resourceId,
      reference.resourceVersion,
      reference.contractId,
      reference.kind,
      key,
    ]);
    const inputText = canonicalJson(input);
    const joined = this.#submissions.get(scoped);
    // The same key and input while the first is in flight: the same
    // submission. Other input under the key is the host's to refuse.
    const done =
      joined?.input === inputText
        ? joined.done
        : this.#send(reference, request, key, { scoped, input: inputText });
    return await waitFor(done, signal, () =>
      clientError("submission.cancelled", { sent: true })
    );
  }

  /**
   * Sends `request` until the host settles it: a lost response under the
   * same key until the host answers from its receipt, a refusal that ran
   * nothing a few times. Kept among the submissions in flight until it
   * settles.
   */
  async #send(
    reference: SubmissionTarget,
    request: string,
    key: string,
    held: { readonly scoped: string; readonly input: string },
    events?: {
      readonly onRecovering: () => void;
      readonly read: (value: unknown) => unknown;
    }
  ): Promise<unknown> {
    const isAction = reference.kind === "action";
    // Bound to the person and the fence it was called under: one who signs
    // in while it waits for its token never gets it sent as theirs.
    const bound: Bound = { generation: this.#generation };
    if (this.#principal !== undefined) {
      bound.principal = this.#principal;
    }
    const run = async (): Promise<unknown> => {
      const started = Date.now();
      let lostSince: number | undefined;
      for (let tries = 1; ; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        const answered = await this.#call(request, reference.resourceId, bound);
        // An answer that isn't one says nothing of the outcome: it is
        // recovered under the same key, as a lost one is, never taken for
        // a refusal that would leave the caller to send it afresh.
        const settled = readSettled(answered, events?.read);
        if (showsStale(settled, isAction)) {
          this.#changed(reference.resourceId);
        }
        const now = Date.now();
        const verdict = submissionVerdict(settled, {
          isAction,
          key,
          started,
          lostSince,
          now,
        });
        if (verdict.next === "settle") {
          this.#uncertainKeys.delete(uncertainScope(reference, key));
          return verdict.value;
        }
        if (verdict.next === "fail") {
          if (verdict.error.category === "uncertain") {
            this.#uncertainKeys.set(
              uncertainScope(reference, key),
              bound.generation ?? this.#generation
            );
          } else if (settlesSubmission(verdict.error)) {
            this.#uncertainKeys.delete(uncertainScope(reference, key));
          }
          throw verdict.error;
        }
        if (verdict.unknown) {
          lostSince ??= now;
          events?.onRecovering();
        }
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        await sleep(waitAfter(settled, tries));
      }
    };
    const done = run();
    this.#submissions.set(held.scoped, { input: held.input, done });
    try {
      return await done;
    } finally {
      if (this.#submissions.get(held.scoped)?.done === done) {
        this.#submissions.delete(held.scoped);
      }
    }
  }
}

/** Each client's internals, made once. */
const madeInternals = new WeakMap<GraspClient, ClientInternals>();

/**
 * The internals of `client`, for the hooks and the platform: the same
 * object every time, so a hook's subscribe function built on them keeps
 * its identity across renders, and React doesn't resubscribe each one.
 */
export const clientInternals = (client: GraspClient): ClientInternals => {
  let internals = madeInternals.get(client);
  if (internals === undefined) {
    internals = internalsOf(client);
    madeInternals.set(client, internals);
  }
  return internals;
};
