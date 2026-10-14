import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";

import {
  clientError,
  fences,
  GraspError,
  issueDetails,
  nothingRanCodes,
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
// receipt recovery after a lost response, sharing one query among the
// components that read it, ordering its snapshots and reading them again
// after a change this client confirmed. Live updates from other clients
// are GRA-252's, through this same entry. Failure modes, and how each is
// closed:
//
// - A lost response turns a saved change into a second one: every
//   mutation carries an idempotency key, the caller's or a fresh random
//   one, and a retry after a lost response sends the very same request,
//   so the host answers its receipt instead of saving again.
// - An uncertain outcome passes for success or failure: a mutation whose
//   response was lost is retried under its key until the host answers,
//   for `lostBudgetMs` at most, then rejects as uncertain with its key;
//   it resolves only on the host's committed answer. An action's lost
//   response is never sent again (it may have reached outside):
//   `submission.outcome_unknown`, with the key. The host keeps no
//   receipt of a whole action: a deliberate call with that key runs it
//   again, its completed steps reconciled by the keys operations.ts
//   derives from it, not repeated.
// - Retries spend the person's request budget: re-reads after changes are
//   gathered and at most `maxReadsInFlight` run at once, a refusal for
//   the budget waits as long as it says, and a save is sent again for
//   `submissionBudgetMs` rather than a few quick tries.
// - Cancelling unlocks a duplicate: aborting stops the caller waiting,
//   never the submission, which keeps reconciling under its key; a call
//   with the same key and input joins it rather than send it again.
// - A delayed answer overwrites a newer one: each read of a query is
//   numbered, and an answer older than the one shown is dropped.
// - Data outlives the access it was read under: a refusal of the person
//   or the build (`fences`) clears every cached result, and every answer
//   to a request sent before it is dropped.
// - One person's submission is sent as another's: a key whose outcome was
//   left unknown is sent again only within the generation it was sent
//   under; after someone else signed in, or access was lost, it is
//   refused unsent as `auth.principal_changed`.
// - Invocation options travel as arguments: options are read on their
//   own, strictly, and only the normalized input is sent.
// - A malformed reference or argument reaches the host: references are
//   read as data, their descriptors checked, and arguments validated
//   before anything is sent; the host checks all of it again.

/**
 * How the client reaches the host: one call of the App `app`, its
 * request as JSON text, answered with core's `{ result }` (spec 32.6), or
 * rejected with a coded refusal; a rejection without a code is a lost
 * response.
 */
export interface ClientTransport {
  call: (request: string, app: string) => Promise<unknown>;
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
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly contractId: string;
  readonly fingerprint: string;
  readonly args: ValueDescriptor;
}

const fingerprintPattern = /^[0-9a-f]{64}$/u;

/** References read already, by the object App code passes. */
const readReferences = new WeakMap<object, ReadReference>();

/** Whether `value` names a public, single-answer function of `kind`. */
const isReferenceOf = (
  value: unknown,
  kind: ReferenceKind
): value is Record<string, unknown> & {
  resourceId: string;
  resourceVersion: number;
  contractId: string;
  fingerprint: string;
} =>
  isPlainObject(value) &&
  value.kind === kind &&
  value.visibility === "public" &&
  value.mode === "single" &&
  typeof value.resourceId === "string" &&
  Number.isInteger(value.resourceVersion) &&
  typeof value.contractId === "string" &&
  typeof value.fingerprint === "string" &&
  fingerprintPattern.test(value.fingerprint);

/**
 * `value` as a public, single-answer reference of `kind`, read as data,
 * its descriptor checked; or `contract.invalid_request`.
 */
const readReference = (value: unknown, kind: ReferenceKind): ReadReference => {
  const known =
    typeof value === "object" && value !== null
      ? readReferences.get(value)
      : undefined;
  if (known !== undefined && known.kind === kind) {
    return known;
  }
  if (!isReferenceOf(value, kind)) {
    throw clientError("contract.invalid_request");
  }
  let args: ValueDescriptor;
  try {
    args = readDescriptor(value.args, 1, { nodes: 0 });
  } catch {
    throw clientError("contract.invalid_request");
  }
  const read: ReadReference = {
    kind,
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

const keyPattern = /^[ -~]{1,128}$/u;

/**
 * Invocation options, read on their own and strictly: an unknown key is
 * refused rather than passed on, and nothing of them is sent but a key.
 */
const readOptions = (
  options: unknown,
  allowed: ReadonlySet<string>
): { signal?: AbortSignal; idempotencyKey?: string } => {
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
  const { signal, idempotencyKey } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("signal is an AbortSignal.");
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

/** One query, by reference and normalized arguments, shared by its readers. */
export interface QueryEntry {
  readonly key: string;
  readonly reference: ReadReference;
  readonly input: Json;
  snapshot: QuerySnapshot;
  /** Components reading it now. */
  readonly listeners: Set<() => void>;
  /** Imperative reads waiting on it now. */
  interest: number;
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
}

/** Tells `entry`'s readers of its new snapshot. */
const show = (entry: QueryEntry, snapshot: QuerySnapshot): void => {
  entry.snapshot = snapshot;
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
 * Shows what read `number` of `entry` settled as, unless a newer read is
 * shown already, and answers it: its value, or its failure thrown. A
 * query that shows data keeps it while its server is unreachable.
 */
const settleRead = (
  entry: QueryEntry,
  read: { readonly number: number; readonly changes: number },
  settled: Settled
): unknown => {
  const { number } = read;
  const newest = number > entry.shown;
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
   * snapshot, and reads the query when it has nothing current. Answers
   * the function that removes the reader.
   */
  subscribe: (entry: QueryEntry, onChange: () => void) => () => void;
  /** Reads again every query that failed and is still read. */
  retryFailed: () => void;
  /**
   * `value` as a public, single-answer reference of `kind`, read as data,
   * its descriptor checked; or `contract.invalid_request`.
   */
  readReference: (value: unknown, kind: ReferenceKind) => ReadReference;
}

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
 * again, the action itself never is); or records that moved on since this
 * client read them (`data.conflict`), so a draft kept for the person to
 * reload gets the record as it is now.
 */
const showsStale = (settled: Settled, isAction: boolean): boolean =>
  settled.kind === "value" ||
  (isAction && !ranNothing(settled, isAction)) ||
  (settled.kind === "failed" && settled.error.code === "data.conflict");

/** What a submission does next after `settled` (see `#send`). */
const submissionVerdict = (
  settled: Settled,
  attempt: SubmissionAttempt
): SubmissionVerdict => {
  const { isAction, key, started, lostSince, now } = attempt;
  const outcomeUnknown = () =>
    clientError("submission.outcome_unknown", { idempotencyKey: key });
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
  // An answer lost, or an outcome the host itself can't tell.
  const unknown =
    settled.kind === "lost" || settled.error.category === "uncertain";
  if (unknown && isAction) {
    return {
      next: "fail",
      error:
        settled.kind === "lost"
          ? outcomeUnknown()
          : withKey(settled.error, key),
    };
  }
  if (unknown) {
    // A mutation is sent again under its key, which recovers its receipt,
    // for as long as `lostBudgetMs`: never forever.
    return now - (lostSince ?? now) >= lostBudgetMs
      ? { next: "fail", error: outcomeUnknown() }
      : { next: "retry", unknown: true };
  }
  if (!ranNothing(settled, isAction) || now - started >= submissionBudgetMs) {
    return { next: "fail", error: settled.error };
  }
  return { next: "retry", unknown: false };
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
   * The keys of submissions whose outcome was left unknown, by the
   * generation they were sent under: one is sent again only within it,
   * never for someone who signed in since, as the host scopes keys by
   * person.
   */
  readonly #uncertainKeys = new Map<string, number>();

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
      retryFailed: () => {
        client.#retryFailed();
      },
      readReference,
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
   * is never sent again (see the header). See `SubmitOptions`.
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

  /** See `ClientInternals.entry`. */
  #entry(reference: unknown, args: unknown): QueryEntry {
    const read = readReference(reference, "query");
    const input = normalized(read, args);
    // A query's request is bounded as a submission's is, before it is sent.
    const request = JSON.stringify({ reference: wireReference(read), input });
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
    ]);
    const known = this.#queries.get(key);
    if (known !== undefined) {
      return known;
    }
    const entry: QueryEntry = {
      key,
      reference: read,
      input,
      snapshot: loading,
      listeners: new Set(),
      interest: 0,
      sent: 0,
      shown: 0,
      stale: false,
      changes: 0,
      reading: undefined,
      evict: undefined,
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
    const current = entry.snapshot.value !== undefined && !entry.stale;
    if (
      entry.reading === undefined &&
      !current &&
      entry.snapshot.error === undefined
    ) {
      this.#refresh(entry);
    }
    return () => {
      entry.listeners.delete(onChange);
      this.#release(entry);
    };
  }

  /** See `ClientInternals.retryFailed`. */
  #retryFailed(): void {
    for (const entry of this.#queries.values()) {
      if (entry.snapshot.error !== undefined) {
        show(entry, loading);
        if (entry.listeners.size > 0) {
          this.#refresh(entry);
        }
      }
    }
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
    const request = JSON.stringify({
      reference: wireReference(entry.reference),
      input: entry.input,
    });
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
    try {
      return await done;
    } finally {
      if (entry.reading?.done === done) {
        entry.reading = undefined;
        if (
          entry.stale &&
          entry.listeners.size > 0 &&
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
    if (current && settled.kind === "failed" && fences(settled.error.code)) {
      this.#fence(settled.error);
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
    for (const entry of this.#queries.values()) {
      entry.reading?.stop.abort();
      entry.reading = undefined;
      entry.shown = entry.sent;
      entry.stale = true;
      show(entry, loading);
      if (entry.listeners.size > 0) {
        this.#refresh(entry);
      }
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
    for (const entry of this.#queries.values()) {
      entry.reading?.stop.abort();
      entry.reading = undefined;
      entry.shown = entry.sent;
      entry.stale = true;
      show(entry, { value: undefined, error: refusal });
    }
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
    // Changes in quick succession share one round of re-reads.
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
        : this.#uncertainKeys.get(idempotencyKey);
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
   * Sends `request` until the host settles it: a mutation's lost
   * response under the same key until the host answers, a refusal that
   * ran nothing a few times; never an action's lost response. Kept among
   * the submissions in flight until it settles.
   */
  async #send(
    reference: ReadReference,
    request: string,
    key: string,
    held: { readonly scoped: string; readonly input: string }
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
        const settled = await this.#call(request, reference.resourceId, bound);
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
          this.#uncertainKeys.delete(key);
          return verdict.value;
        }
        if (verdict.next === "fail") {
          if (verdict.error.category === "uncertain") {
            this.#uncertainKeys.set(key, bound.generation ?? this.#generation);
          } else if (settlesSubmission(verdict.error)) {
            this.#uncertainKeys.delete(key);
          }
          throw verdict.error;
        }
        if (verdict.unknown) {
          lostSince ??= now;
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

/** The internals of `client`, for the hooks and the platform. */
export const clientInternals = (client: GraspClient): ClientInternals =>
  internalsOf(client);
