import { AccessFence } from "./access-fence.ts";
import { clientError } from "./client-error.ts";
import { ClientFiles } from "./client-files.ts";
import type { ClientInternals } from "./client-internals.ts";
import { ClientLinks } from "./client-links.ts";
import { QueryCache } from "./client-query-cache.ts";
import {
  queryOptionKeys,
  readOptions,
  readReference,
} from "./client-request.ts";
import { waitFor } from "./client-retry.ts";
import type { ClientTransport } from "./client-transport.ts";
import type {
  FunctionArgs,
  FunctionReference,
  ProgressOf,
  FunctionReturn,
  Streaming,
} from "./function-references.ts";
import { referenceName } from "./function-references.ts";
import { readPageBuild } from "./page-functions.ts";
import type { PageBuild } from "./page-functions.ts";
import { Pagers } from "./paginated-query.ts";
import { fences } from "./refusals.ts";
import { Streams } from "./streams.ts";
import { Submissions } from "./submissions.ts";

// The session client: the one object a page's
// queries, mutations and actions go through. The platform makes one per
// App session and mounts it (page-runtime.ts); App code reaches it
// through `useClient()` and the hooks of `@grasp-os/sdk/react`, and gets
// direct values and structured errors (client-error.ts), never a
// transport envelope.
//
// It owns what every page would otherwise write again: reading the
// generated reference, normalizing the arguments with the same native
// interpreter the host uses, one logical submission per explicit call,
// receipt recovery after a lost response, and live queries:
// over the platform's frame, one subscription per query, shared by the
// components that read it, whose snapshots core pushes after every write
// that changed what the query read, whoever made it, ordered and
// authorized, followed again after a lost connection; a client never
// reads a followed query again on its own. Failure modes, and how each
// is closed:
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
//   outcome the host itself can't tell (`function.sandbox_lost`) is that
//   receipt: it rejects at once, with its key.
// - Retries spend the person's request budget: reads run at most
//   `maxReadsInFlight` at once, a refusal for the budget waits as long as it
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
// - A lost connection leaves a page silently stale, or hammers core:
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
//   under; after access was lost, it is refused unsent as
//   `auth.principal_changed`.
// - Subscriptions pile up: a query is followed only while a component
//   reads it, released as soon as the last one stops (a skipped query
//   follows nothing); core bounds what a page follows.
// - Invocation options travel as arguments: options are read on their
//   own, strictly, and only the normalized input is sent.
// - A malformed reference or argument reaches the host: references are
//   read as data, their descriptors checked, and arguments validated
//   before anything is sent; the host checks all of it again.
//

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
export type QueryReference = FunctionReference<"query">;
/** A public mutation reference. */
export type MutationReference = FunctionReference<"mutation">;
/** A public action reference that answers once (not a stream). */
export type ActionReference = FunctionReference<"action">;
/** A public reference to an action that streams its progress. */
export type StreamReference = FunctionReference<
  "action",
  "public",
  unknown,
  unknown,
  unknown
>;

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
  args: FunctionArgs<Reference>,
  options: StreamOptions<ProgressOf<Reference>>,
];

/**
 * The arguments of a call of `Reference`, then its options. The input may
 * be left out only when it is empty or every field of it is optional or
 * defaulted; to pass options then, write `call({}, options)`.
 */
export type CallArguments<Reference, Options> =
  Record<never, never> extends FunctionArgs<Reference>
    ? [args?: FunctionArgs<Reference>, options?: Options]
    : [args: FunctionArgs<Reference>, options?: Options];

// Set by `GraspClient`'s static block, which alone reaches its private
// members, before any client exists.
let internalsOf: (client: GraspClient) => ClientInternals;

/**
 * The session client: queries, mutations and actions of the App, for the
 * person using it. One per App session, made and mounted by the
 * platform; App code gets it from `useClient()`.
 */
export class GraspClient {
  readonly #transport: ClientTransport;
  readonly #fence: AccessFence;
  readonly #queries: QueryCache;
  readonly #pagers: Pagers;
  readonly #submissions: Submissions;
  readonly #streams: Streams;
  /** Told of each file `files.delete` deleted (`onFileDeleted`). */
  readonly #deletionListeners = new Set<(id: string) => void>();
  /**
   * The files `files.delete` deleted (`fileDeleted`): ids are never
   * reused, and one session deletes few.
   */
  readonly #deletedFiles = new Set<string>();
  /**
   * What holds unsaved edits or an unknown outcome now (`guardLeave`):
   * the host confirms leaving the App while any does.
   */
  readonly #leaveGuards = new Set<object>();
  /**
   * The release's public functions the page was built with, by name, and
   * its workflows, by alias (page-functions.ts): what a form checks a
   * submission with, a grid reads its columns from and `useWorkflow`
   * reads a workflow's events and decisions from. Replaced as a
   * preview's draft changes.
   */
  #build: PageBuild;

  /**
   * The App's files: downloading and deleting them through a files
   * resource the App declares. Uploads and previews are
   * `useUpload`'s and `useFile`'s.
   */
  readonly files: ClientFiles;

  /**
   * The App's external links: opening a URL through a links resource the
   * App declares, by the host, with no opener or referrer.
   */
  readonly links: ClientLinks;

  /**
   * Says whether `holder` (a form) holds unsaved edits or a submission
   * whose outcome isn't known now: the host is told once whether any does,
   * each time that changes, and confirms leaving the App while any does.
   */
  guardLeave(holder: object, guarded: boolean): void {
    const before = this.#leaveGuards.size > 0;
    if (guarded) {
      this.#leaveGuards.add(holder);
    } else {
      this.#leaveGuards.delete(holder);
    }
    const after = this.#leaveGuards.size > 0;
    if (before !== after) {
      this.#transport.leaveGuard?.(after);
    }
  }

  /**
   * The client over a `ClientTransport`, for the platform only
   * (page-runtime.ts). By design, not isolation: page code shares the
   * frame and could make one, but gets nothing from it that `bridge()`
   * doesn't already give it. `functions` is the page build's
   * `.grasp/functions.ts` (`functions`), read as data: without it, the
   * client's forms and grids find no function.
   */
  constructor(transport: ClientTransport, functions?: unknown) {
    this.#transport = transport;
    this.#build = readPageBuild(functions);
    this.#fence = new AccessFence(transport, (refusal) => {
      // Nothing of anyone's is held now: whoever comes next joins no save
      // made before.
      this.#submissions.clear();
      this.#pagers.cancelLoads(refusal);
      this.#queries.fence(refusal);
      // How far the person loaded is theirs too: tried again, whoever is
      // signed in then starts at the first page.
      this.#pagers.restartPagers(refusal);
    });
    this.#queries = new QueryCache(transport, this.#fence);
    this.#pagers = new Pagers(this.#queries);
    const changed = (): void => {
      this.#queries.changed();
    };
    this.#submissions = new Submissions(this.#fence, changed);
    this.#streams = new Streams(transport, this.#fence, changed);
    this.links = new ClientLinks(transport.links);
    // A refusal fences the client only if no fence came since its request
    // started: a late one would undo what the page recovered since.
    this.files = new ClientFiles(
      this.#transport.files,
      (error, startedUnder) => {
        if (fences(error.code) && startedUnder === this.#fence.generation) {
          this.#fence.fence(error);
        }
      },
      () => this.#fence.generation,
      (id) => {
        this.#deletedFiles.add(id);
        for (const listener of this.#deletionListeners) {
          // One view failing never changes the deletion's outcome, nor
          // keeps the others from showing the file gone.
          try {
            listener(id);
          } catch {
            // The view's own failure, shown by the view.
          }
        }
      }
    );
  }

  static {
    internalsOf = (client) => ({
      entry: (reference, args) => client.#queries.entry(reference, args),
      subscribe: (entry, onChange) =>
        client.#queries.subscribe(entry, onChange),
      pager: (reference, args, initialPageSize) =>
        client.#pagers.pager(reference, args, initialPageSize),
      subscribePager: (pager, onChange) =>
        client.#pagers.subscribePager(pager, onChange),
      retryFailed: () => {
        client.#retryFailed();
      },
      readReference,
      stream: async (reference, args, options, events) =>
        await client.#streams.stream(reference, args, options, events),
      decisions: client.#transport.decisions,
      fence: (refusal, startedUnder) => {
        if (
          startedUnder === undefined ||
          startedUnder === client.#fence.generation
        ) {
          client.#fence.fence(refusal);
        }
      },
      fences: () => client.#fence.generation,
      fencedBy: () => client.#fence.fencedBy,
      onFence: (onFence) => client.#fence.onFence(onFence),
      onFileDeleted: (onDeleted) => {
        client.#deletionListeners.add(onDeleted);
        return () => {
          client.#deletionListeners.delete(onDeleted);
        };
      },
      fileDeleted: (id) => client.#deletedFiles.has(id),
      functionOf: (reference) => {
        const name = referenceName(reference);
        return name === undefined
          ? undefined
          : client.#build.functions.get(name);
      },
      workflowOf: (alias) => client.#build.workflows.get(alias),
      useFunctions: (functions) => {
        client.#build = readPageBuild(functions, client.#build);
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
  ): Promise<FunctionReturn<Reference>> {
    const { signal } = readOptions(options, queryOptionKeys);
    const entry = this.#queries.entry(reference, args);
    if (signal?.aborted === true) {
      throw clientError("query.cancelled");
    }
    entry.interest += 1;
    try {
      const value = await waitFor(
        this.#queries.readCurrent(entry),
        signal,
        () => clientError("query.cancelled")
      );
      // SAFETY: the host validated the answer against the reference's
      // declared return, which `Reference` carries as its type.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return value as FunctionReturn<Reference>;
    } finally {
      entry.interest -= 1;
      this.#queries.release(entry);
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
  ): Promise<FunctionReturn<Reference>> {
    const value = await this.#submissions.submit(
      readReference(reference, "mutation"),
      args,
      options
    );
    // SAFETY: as in `query`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return value as FunctionReturn<Reference>;
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
  ): Promise<FunctionReturn<Reference>> {
    const value = await this.#submissions.submit(
      readReference(reference, "action"),
      args,
      options
    );
    // SAFETY: as in `query`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return value as FunctionReturn<Reference>;
  }

  /**
   * Runs the streaming action `reference` names with `args`:
   * `options.onProgress` gets each newer progress snapshot, and
   * the promise resolves with the action's declared result, or rejects
   * with a structured error, `function.cancelled` when it was cancelled.
   * A lost connection attaches to the same invocation again, never runs
   * it twice (see the header). Aborting `signal` stops only this caller
   * following it: the host cancels it once no one does.
   */
  async stream<Reference extends StreamReference>(
    reference: Streaming<Reference>,
    ...[args, options]: StreamArguments<Reference>
  ): Promise<FunctionReturn<Reference>> {
    const value = await this.#streams.stream(reference, args, options);
    // SAFETY: as in `query`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return value as FunctionReturn<Reference>;
  }

  /** See `ClientInternals.retryFailed`. */
  #retryFailed(): void {
    this.#pagers.clearFailures();
    this.#queries.retryFailed();
    this.#pagers.changedAll();
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
