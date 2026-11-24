import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { ReadRequest } from "@grasp-os/shared/store-reads";
import { queryErrors } from "@grasp-os/shared/stores";
import type { StagedWrites } from "@grasp-os/shared/stores";

import { queryMaxReruns } from "./call-limits.ts";
import type { OpenStore } from "./data-stores.ts";
import type { QueryAnswer } from "./store-queries.ts";

// The host's side of `ctx.db` reads for one invocation (GRA-243 D1-A):
// each read App code asks for goes through a `StoreReader`, which keeps,
// here on the host where App code can't touch it, what the invocation
// read.
//
// A query may read several times, each read its own call into
// the store, and a commit may land between two of them; spec 6.3 asks
// that such a query never be answered as though it saw one state. Every
// read answers the generation of the table it read (`sdk_tables`, moved
// on by each commit that changes the table's records, whether or not
// they matched), so `readConsistently` runs the query, then checks
// that no table it read has moved on since; it runs it again, up to
// three more times, and then gives up with the retryable
// `query.concurrent_change`. A read that matched nothing still depends on
// its table, so a record inserted into it after is seen as a change.
//
// A mutation's commit gets its read set (the generation of each table it
// read, `readSet`), and is refused once any of those tables moved on
// (function-host.ts), so its writes are protected by its transaction. A mutation's
// reads see the writes it staged so far (`staged`), as its commit would
// make them; the generations they answer are from before those writes.

/** `counts`, if an object, as its members that are counts. */
const countsOf = (counts: unknown): Record<string, number> =>
  typeof counts === "object" && counts !== null
    ? Object.fromEntries(
        Object.entries(counts).filter((entry): entry is [string, number] =>
          Number.isSafeInteger(entry[1])
        )
      )
    : {};

/**
 * What a failed read's error carries of the read (`details.generations`
 * and `details.sensitive`, StoreHost's `#readIn`), taken off it, so App
 * code never sees them; none for an error raised before the read looked
 * at a record.
 */
const takeReadDetails = (
  error: unknown
): {
  generations: Record<string, number>;
  sensitive: Record<string, number>;
} => {
  if (typeof error !== "object" || error === null) {
    return { generations: {}, sensitive: {} };
  }
  const details: unknown = Reflect.get(error, "details");
  if (typeof details !== "object" || details === null) {
    return { generations: {}, sensitive: {} };
  }
  const { generations, sensitive, ...rest }: Record<string, unknown> = {
    ...details,
  };
  Reflect.set(error, "details", rest);
  return { generations: countsOf(generations), sensitive: countsOf(sensitive) };
};

/**
 * Told how many records a read answered of each sensitive table it read
 * (`ReadResult.sensitive`), answered or failed alike.
 */
export type SensitiveSink = (sensitive: Record<string, number>) => void;

/** The host's record of one invocation's reads of one store. */
export class StoreReader {
  readonly #store: OpenStore;
  readonly #scope: ReadScope;
  /** A mutation's writes so far, which its reads see; none for a query. */
  readonly #staged: (() => StagedWrites | undefined) | undefined;
  /** The generation of each table read, as first read. */
  readonly #generations = new Map<string, number>();
  /**
   * Whether two reads of one table saw different generations: stale for
   * sure, known without asking the store again.
   */
  #torn = false;

  constructor(
    store: OpenStore,
    scope: ReadScope,
    staged?: () => StagedWrites | undefined
  ) {
    this.#store = store;
    this.#scope = scope;
    this.#staged = staged;
  }

  /**
   * One read for the invocation, its scope the one core resolved; what it
   * depended on is recorded, never anything App code says it read, and
   * what it answered of sensitive tables told to `sensitive`.
   */
  async read(
    request: ReadRequest,
    sensitive?: SensitiveSink
  ): Promise<QueryAnswer> {
    let result: Awaited<ReturnType<OpenStore["read"]>>;
    const staged = this.#staged?.();
    try {
      result = await this.#store.read(this.#scope, request, staged);
    } catch (error) {
      // A read that failed after it looked at records still depended on
      // them, and told something of them: count what the store says it
      // read, then fail as it did, without what it said of the read,
      // which is the host's own.
      const read = takeReadDetails(error);
      this.#record(read.generations);
      sensitive?.(read.sensitive);
      throw error;
    }
    const { value, generations } = result;
    this.#record(generations);
    sensitive?.(result.sensitive);
    return value;
  }

  /** Counts `generations` (by table) into the invocation's read set. */
  #record(generations: Readonly<Record<string, number>>): void {
    for (const [table, generation] of Object.entries(generations)) {
      const seen = this.#generations.get(table);
      if (seen === undefined) {
        this.#generations.set(table, generation);
      } else if (seen !== generation) {
        this.#torn = true;
      }
    }
  }

  /**
   * The generation of each table the invocation read, as first read: a
   * commit fenced on it fails once any of them moved on, a torn read set
   * (one table seen at two generations) included.
   */
  readSet(): Record<string, number> {
    return Object.fromEntries(this.#generations);
  }

  /**
   * Whether every table the invocation read is still at the generation it
   * read: its reads are then one state of the store.
   */
  async isCurrent(): Promise<boolean> {
    if (this.#torn) {
      return false;
    }
    if (this.#generations.size === 0) {
      return true;
    }
    const current = await this.#store.generations([
      ...this.#generations.keys(),
    ]);
    return [...this.#generations].every(
      ([table, generation]) => current[table] === generation
    );
  }
}

/**
 * Runs `handler` (a query's handler, its reads through the
 * reader it is handed) until its reads were one state of the store: at
 * most once and `queryMaxReruns` times again, each run with a reader of
 * its own; then `query.concurrent_change`, retryable. What a run returns
 * is answered only once its reads are known current. `observe`, if
 * given, is told the read set of the run that stands, answered or failed:
 * what a live query of it depends on (query-subscriptions.ts).
 */
export const readConsistently = async <Answer>(
  store: OpenStore,
  scope: ReadScope,
  handler: (reader: StoreReader) => Promise<Answer>,
  observe?: (readSet: Record<string, number>) => void
): Promise<Answer> => {
  for (let run = 0; run <= queryMaxReruns; run += 1) {
    const reader = new StoreReader(store, scope);
    let answer: { value: Answer } | { error: unknown };
    try {
      // One run after the other: a rerun exists only because the last
      // was stale.
      // oxlint-disable-next-line no-await-in-loop -- see above
      answer = { value: await handler(reader) };
    } catch (error) {
      answer = { error };
    }
    // An answer or a failure alike stands only if what was read is still
    // one state: a failure a torn read caused (a record not found between
    // two reads, `unique` across an insert) is a stale run too.
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (await reader.isCurrent()) {
      observe?.(reader.readSet());
      if ("error" in answer) {
        throw answer.error;
      }
      return answer.value;
    }
  }
  throw queryErrors.create("query.concurrent_change", { retryable: true });
};
