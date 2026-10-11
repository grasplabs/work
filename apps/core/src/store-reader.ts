import type { ReadScope } from "@grasp-os/shared/store-queries";
import type { ReadRequest } from "@grasp-os/shared/store-reads";
import { queryErrors } from "@grasp-os/shared/stores";

import type { OpenStore } from "./data-stores.ts";
import type { QueryAnswer } from "./store-queries.ts";

// The host's side of `ctx.db` reads for one invocation (GRA-243 D1-A):
// each read App code asks for goes through a `StoreReader`, which keeps,
// here on the host where App code can't touch it, what the invocation
// read and what it asserted.
//
// A query operation may read several times, each read its own call into
// the store, and a commit may land between two of them; spec 6.3 asks
// that such a query never be answered as though it saw one state. Every
// read answers the generation of the table it read (`sdk_tables`, moved
// on by each commit that changes the table's records, whether or not
// they matched), so `readConsistently` runs the operation, then checks
// that no table it read has moved on since; it runs it again, up to
// three more times, and then gives up with the retryable
// `query.concurrent_change`. A read that matched nothing still depends on
// its table, so a record inserted into it after is seen as a change.
//
// A `get` that asserted a revision on a record it found is recorded as a
// guard, for a mutation's commit to check (spec 9.2: even when the
// handler then changes nothing); GRA-244 hands `guards` to its commit.

/** How many times a query operation runs again before it gives up. */
export const queryMaxReruns = 3;

/** A revision a `get` asserted, for a commit to check again. */
export interface ReadGuard {
  readonly table: string;
  readonly id: string;
  readonly expectedRevision: number;
}

/** The host's record of one invocation's reads of one store. */
export class StoreReader {
  readonly #store: OpenStore;
  readonly #scope: ReadScope;
  /** The generation of each table read, as first read. */
  readonly #generations = new Map<string, number>();
  readonly #guards: ReadGuard[] = [];
  /**
   * Whether two reads of one table saw different generations: stale for
   * sure, known without asking the store again.
   */
  #torn = false;

  constructor(store: OpenStore, scope: ReadScope) {
    this.#store = store;
    this.#scope = scope;
  }

  /**
   * One read for the invocation, its scope the one core resolved; what it
   * depended on is recorded, never anything App code says it read.
   */
  async read(request: ReadRequest): Promise<QueryAnswer> {
    const { value, generations } = await this.#store.read(this.#scope, request);
    for (const [table, generation] of Object.entries(generations)) {
      const seen = this.#generations.get(table);
      if (seen === undefined) {
        this.#generations.set(table, generation);
      } else if (seen !== generation) {
        this.#torn = true;
      }
    }
    // Once per record: an operation reading a record again and again
    // still hands its commit one guard for it (a later assertion of
    // another revision would have failed its read with a conflict).
    if (
      request.kind === "get" &&
      request.expectedRevision !== null &&
      value !== null &&
      !this.#guards.some(
        ({ table, id }) => table === request.table && id === request.id
      )
    ) {
      this.#guards.push({
        table: request.table,
        id: request.id,
        expectedRevision: request.expectedRevision,
      });
    }
    return value;
  }

  /** The revisions the invocation's reads asserted, in order. */
  guards(): readonly ReadGuard[] {
    return [...this.#guards];
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
 * Runs `operation` (a query operation's handler, its reads through the
 * reader it is handed) until its reads were one state of the store: at
 * most once and `queryMaxReruns` times again, each run with a reader of
 * its own; then `query.concurrent_change`, retryable. What a run returns
 * is answered only once its reads are known current.
 */
export const readConsistently = async <Answer>(
  store: OpenStore,
  scope: ReadScope,
  operation: (reader: StoreReader) => Promise<Answer>
): Promise<Answer> => {
  for (let run = 0; run <= queryMaxReruns; run += 1) {
    const reader = new StoreReader(store, scope);
    let answer: { value: Answer } | { error: unknown };
    try {
      // One run after the other: a rerun exists only because the last
      // was stale.
      // oxlint-disable-next-line no-await-in-loop -- see above
      answer = { value: await operation(reader) };
    } catch (error) {
      answer = { error };
    }
    // An answer or a failure alike stands only if what was read is still
    // one state: a failure a torn read caused (a record not found between
    // two reads, `unique` across an insert) is a stale run too.
    // oxlint-disable-next-line no-await-in-loop -- see above
    if (await reader.isCurrent()) {
      if ("error" in answer) {
        throw answer.error;
      }
      return answer.value;
    }
  }
  throw queryErrors.create("query.concurrent_change", { retryable: true });
};
