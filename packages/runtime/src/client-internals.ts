import type { GraspError } from "./client-error.ts";
import type { QueryEntry } from "./client-query-entry.ts";
import type { ReadReference } from "./client-request.ts";
import type { DecisionTransport } from "./client-transport.ts";
import type { ReferenceKind } from "./function-references.ts";
import type { PageFunction, PageWorkflow } from "./page-functions.ts";
import type { Pager } from "./pager.ts";
import type { StreamEvents } from "./streams.ts";

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
   * releases its pages' subscriptions.
   */
  subscribePager: (pager: Pager, onChange: () => void) => () => void;
  /** Reads again every query that failed and is still read. */
  retryFailed: () => void;
  /**
   * `value`, a reference, as a call of `kind` sends it; or
   * `contract.invalid_request`.
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
  /**
   * How decisions are answered through the trusted host
   * (workflow-respond.ts); none without one.
   */
  readonly decisions: DecisionTransport | undefined;
  /**
   * Clears everything the client holds: the person or build lost access.
   * Given `startedUnder`, the fence count a request began under
   * (`fences`), only if no fence came since: a late refusal of an older
   * request would clear what was recovered after it.
   */
  fence: (refusal: GraspError, startedUnder?: number) => void;
  /** How many times the client was fenced: what a file preview follows. */
  fences: () => number;
  /** What the latest fence was for, if there was one. */
  fencedBy: () => GraspError | undefined;
  /** Calls `onFence` at every fence, until the function it answers is called. */
  onFence: (onFence: () => void) => () => void;
  /**
   * Calls `onDeleted` with the id of each file `files.delete` deleted,
   * once core recorded it, until the function it answers is called: each
   * view of it shows it gone.
   */
  onFileDeleted: (onDeleted: (id: string) => void) => () => void;
  /**
   * Whether `files.delete` deleted file `id` through this client: a view
   * asked for it later shows it gone, never reading it again.
   */
  fileDeleted: (id: string) => boolean;
  /**
   * The release's public function `reference` names, as the page's build
   * describes it, found by its name alone; undefined when it names none.
   */
  functionOf: (reference: unknown) => PageFunction | undefined;
  /**
   * The workflow the release declares under `alias`, as the page's build
   * describes it; undefined when it declares none.
   */
  workflowOf: (alias: string) => PageWorkflow | undefined;
  /** Replaces the release's functions: a preview's draft changed them. */
  useFunctions: (functions: unknown) => void;
}
