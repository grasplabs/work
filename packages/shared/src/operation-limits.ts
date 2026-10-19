// The bounds and rules of an App's server functions (queries, mutations and
// actions) that both sides check: the SDK where they are declared and
// thrown from, and core's operation host, which trusts nothing App code
// sends. Free of dependencies, like store-limits.ts, because the SDK's
// root module can't bring Zod along.

import { platformErrorNamespaces } from "./error-namespaces.ts";
import { platformLimits } from "./platform-limits.ts";

/**
 * The most bytes of one operation's input, as UTF-8 JSON: the public
 * operation input limit of spec 18.1, checked on the input as sent, before
 * it is validated, for a call from a screen, an agent, a workflow or
 * another of the App's functions alike. A store's own bound on one
 * transaction (`commitMaxInputBytes`) is larger and separate.
 */
export const operationInputMaxBytes = platformLimits.operationInputBytes;

/**
 * The most bytes of one call's request as a screen or agent sends it, as
 * UTF-8 JSON: the input's own bound and room for the reference and options
 * around it. Every transport reads no more than this before parsing.
 */
export const functionRequestMaxBytes = operationInputMaxBytes + 4 * 1024;

/**
 * The most bytes of what one operation returns, as UTF-8 JSON: the public
 * operation output limit of spec 18.1, for a query, a mutation or an
 * action, whoever called it, and an App's export answering another App.
 * Larger data is paginated. It fits a workflow step's result, and leaves
 * a mutation's commit room for its writes (`stagedMaxBytes`).
 */
export const operationResultMaxBytes = platformLimits.operationOutputBytes;

/**
 * The most times one caller's call reads the store, the function it named
 * and every function nested in it together: reads past it are refused
 * (`operation.read_limit`). One invocation alone reaches its host calls
 * first (`platformLimits.invocationHostCalls`, 100); this bounds what its
 * nested calls read with it. Longer work pages, or is a workflow's.
 */
export const invocationMaxReads = 256;

/**
 * The most bytes of staged writes one mutation's reads may send the store
 * in all, as UTF-8 JSON: each read of a mutation that staged writes sends
 * them, and the store applies them, so this bounds what one call can make
 * the store do (`operation.read_limit` past it).
 */
export const stagedReadMaxBytes = 16 * 1024 * 1024;

/**
 * The most bytes of an `AppError`'s details, as UTF-8 JSON (spec 32.6):
 * an error reaches a screen, which is held to what it may receive.
 */
export const appErrorDetailsMaxBytes = 16 * 1024;

/** The most code units of an `AppError`'s message, which people read. */
export const appErrorMessageMaxLength = 500;

/** The most code units of an `AppError`'s code. */
export const appErrorCodeMaxLength = 100;

/**
 * An `AppError`'s code: two or more dot-separated lower-case segments,
 * each a letter then letters, digits or underscores, e.g. `note.not_found`.
 */
export const appErrorCodePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/**
 * The first segments an App's own error codes can't have: the platform's
 * error namespaces (error-namespaces.ts, held to the real families by its
 * test). An App that throws `data.conflict` would otherwise pass its own
 * failure off as the store's, and a caller that branches on the code would
 * act on a conflict that never happened.
 */
export const reservedErrorNamespaces: ReadonlySet<string> =
  platformErrorNamespaces;

/**
 * Whether `code` may be an App's own error code: the pattern, the length,
 * and none of the platform's namespaces.
 */
export const isAppErrorCode = (code: unknown): code is string =>
  typeof code === "string" &&
  code.length <= appErrorCodeMaxLength &&
  appErrorCodePattern.test(code) &&
  !reservedErrorNamespaces.has(code.slice(0, code.indexOf(".")));

/**
 * A registered path's segment: a letter, then letters, digits or
 * underscores, as a module export is named.
 */
export const operationSegmentPattern = /^[A-Za-z][A-Za-z0-9_]*$/u;

/** The most segments of one registered path, e.g. `notes.create` has 2. */
export const operationPathMaxSegments = 4;

/** The most code units of one registered path, dots included. */
export const operationPathMaxLength = 200;

/**
 * A path a store permission or a store resource names, one of a store's
 * public operations: one to four segments (`operationSegmentPattern`),
 * dotted. A permission's action is at most 64 code units, so a store
 * operation shared with other consumers is too.
 */
export const storeOperationPathPattern =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,3}$/u;

/** The most code units of a store operation's path, as a permission names it. */
export const storeOperationPathMaxLength = 64;

/** The most functions one App registers, public and internal together. */
export const appMaxOperations = 256;

/** The most references one function's `uses` lists. */
export const usesMaxEntries = 64;

/**
 * A resource's alias, as `ctx.resources.<alias>` names it: a letter, then
 * letters, digits or underscores, at most 64 code units.
 */
export const resourceAliasPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/**
 * The most UTF-16 code units of a knowledge search's text: Knowledge's own
 * limit (`searchQuerySchema`), which an App's knowledge resource is held
 * to as well, so a longer one is refused up front as arguments that don't
 * fit, never deep in Knowledge.
 */
export const knowledgeSearchMaxLength = 500;

// Foreground streaming actions (spec 10.7.6): an action that declares
// `stream` emits bounded progress snapshots while it runs, each complete,
// so a slow reader only ever needs the latest. These bound what one
// invocation holds and sends.

/**
 * The most bytes of one progress snapshot, as UTF-8 JSON: what an
 * operation may return (`operationResultMaxBytes`), since a snapshot is
 * delivered to a screen as an answer is.
 */
export const streamProgressMaxBytes = operationResultMaxBytes;

/**
 * The most snapshots one invocation emits: past it, `ctx.emit` is refused
 * (`operation.emit_limit`). The host keeps only the latest, so this bounds
 * the work of validating them, never what is held.
 */
export const streamMaxEmits = 1000;

/**
 * How long a running stream waits, once no screen follows it, before the
 * host asks it to stop: long enough to reconnect, never long enough to
 * turn it into background work.
 */
export const streamIdleCancelMs = 10_000;

/**
 * How long a finished stream's terminal receipt (its result, and the last
 * progress) is kept for a screen that lost its connection to read again.
 */
export const streamRetentionMs = 15 * 60_000;

/**
 * How long a stream's tombstone is kept after its receipt: a key reused
 * within it is refused as expired (`submission.expired`). Past it nothing
 * of the invocation is left, so the same key starts a fresh run, external
 * effects included. That is what 10.7.1 promises of every key: it
 * deduplicates only while evidence of it is kept. The session client
 * makes a fresh random key for every call and reuses one only to
 * recover a call still within its receipt; a caller that passes its own
 * key for long-lived business intent needs a durable business record
 * instead.
 */
export const streamTombstoneMs = 24 * 60 * 60_000;

/**
 * The most streaming actions one person runs at once in one App, beyond
 * which a start is refused (`operation.stream_limit`). A screen follows
 * one or two at a time (a draft, an export); each holds a sandbox run for
 * up to a server invocation's wall time (60 s) and an object with its
 * receipt, so four leaves room for a screen and a second tab while a
 * screen that starts them in a loop can't hold more of the deployment's
 * sandbox than that. The request rate limit alone would let it hold
 * dozens.
 */
export const streamMaxRunning = 4;

/**
 * The most plain (non-streaming) actions one person runs at once in one
 * App through its invocation objects, beyond which a start is refused
 * (`operation.action_limit`). Such a run outlives the request that
 * started it, so its caller can come back for its receipt, and no idle
 * cancel ends it: this, with its deadline, is its only bound. A screen
 * and a second tab firing actions from a form, a list's row buttons or a
 * bulk edit stay well within sixteen; a screen that fires them in a loop
 * can't hold more of the App's sandbox than that, leaving its other
 * members room (the on-prem sandbox caps sessions per App).
 */
export const actionMaxRunning = 16;

/**
 * How long a plain action's invocation may run: as long as a screen's
 * direct call (core's app-function-route.ts), never the 60 s a streaming
 * action, which someone follows, gets.
 */
export const actionInvocationWallMs = 30_000;
