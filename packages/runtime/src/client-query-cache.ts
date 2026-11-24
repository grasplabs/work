import { functionRequestMaxBytes } from "@grasp-os/shared/function-limits";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import type { AccessFence } from "./access-fence.ts";
import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import { keepMs, loading, show, wanted } from "./client-query-entry.ts";
import type { QueryEntry } from "./client-query-entry.ts";
import {
  QueryFollower,
  unfollow,
  waitsToFollow,
} from "./client-query-following.ts";
import { QueryReader } from "./client-query-reads.ts";
import { inputOf, readReference } from "./client-request.ts";
import type { ReadReference } from "./client-request.ts";
import type { ClientTransport } from "./client-transport.ts";

/**
 * The client's queries, by reference and normalized arguments, shared by
 * the components and imperative reads that read them: followed while a
 * component reads one, read from the host otherwise, and dropped once
 * nothing has read one for a while.
 */
export class QueryCache {
  readonly #queries = new Map<string, QueryEntry>();
  readonly #follower: QueryFollower;
  readonly #reader: QueryReader;

  constructor(transport: ClientTransport, fence: AccessFence) {
    this.#follower = new QueryFollower(transport, fence, {
      onAccessChanged: (error) => {
        this.#accessChanged(error);
      },
    });
    this.#reader = new QueryReader(fence);
  }

  /** See `ClientInternals.entry`. */
  entry(reference: unknown, args: unknown): QueryEntry {
    const read = readReference(reference, "query");
    return this.entryFor(read, inputOf(args));
  }

  /**
   * The shared entry of `read` with `input`, made if there is none: the
   * query.
   */
  entryFor(read: ReadReference, input: Json): QueryEntry {
    // A query's request is bounded as a submission's is, before it is sent.
    const request = JSON.stringify({
      reference: read,
      args: input,
    });
    if (
      new TextEncoder().encode(request).byteLength > functionRequestMaxBytes
    ) {
      throw clientError("contract.input_too_large", {
        maxBytes: functionRequestMaxBytes,
      });
    }
    const key = canonicalJson([read.name, input]);
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
    };
    this.#queries.set(key, entry);
    // Made for a render that may never subscribe: let go of it unless one does.
    this.release(entry);
    return entry;
  }

  /** See `ClientInternals.subscribe`. */
  subscribe(entry: QueryEntry, onChange: () => void): () => void {
    entry.listeners.add(onChange);
    clearTimeout(entry.evict);
    entry.evict = undefined;
    // Dropped while its render waited to commit: cached again, unless
    // another reader has made the query's entry anew meanwhile.
    if (!this.#queries.has(entry.key)) {
      this.#queries.set(entry.key, entry);
    }
    if (entry.live === undefined && entry.snapshot.error === undefined) {
      this.follow(entry, 0);
    }
    return () => {
      entry.listeners.delete(onChange);
      // Released once the task that let go of it ends without another
      // reader: React resubscribes a component within one commit, and
      // that keeps the subscription rather than follow the query anew.
      queueMicrotask(() => {
        if (entry.listeners.size === 0) {
          unfollow(entry);
        }
      });
      this.release(entry);
    };
  }

  /** See `QueryFollower.follow`. */
  follow(entry: QueryEntry, failures: number): void {
    this.#follower.follow(entry, failures);
  }

  /** See `QueryReader.readCurrent`. */
  async readCurrent(entry: QueryEntry): Promise<unknown> {
    return await this.#reader.readCurrent(entry);
  }

  /** The queries part of `ClientInternals.retryFailed`. */
  retryFailed(): void {
    for (const entry of this.#queries.values()) {
      if (entry.snapshot.error !== undefined) {
        show(entry, loading);
        if (entry.listeners.size === 0) {
          continue;
        }
        if (entry.live === undefined) {
          this.follow(entry, 0);
        }
      }
    }
  }

  /** Drops `entry` once nothing has read it for a while. */
  release(entry: QueryEntry): void {
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

  /** The queries part of a fence (`AccessFence.fence`). */
  fence(refusal: GraspError): void {
    for (const entry of this.#queries.values()) {
      unfollow(entry);
      entry.reading?.stop.abort();
      entry.reading = undefined;
      entry.shown = entry.sent;
      entry.stale = true;
      show(entry, { value: undefined, error: refusal });
    }
  }

  /**
   * The person's roles in the App dropped (`page.access_changed`,
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
  #accessChanged(error: GraspError): void {
    for (const entry of this.#queries.values()) {
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
      } else if (waitsToFollow(entry.live)) {
        show(entry, { value: undefined, error });
      }
    }
  }

  /**
   * After a change the host confirmed: every query of the App is marked
   * old, so an imperative read doesn't join one sent before it.
   */
  changed(): void {
    // Core pushes what the change made out of date to every followed
    // query: the marks only keep a later imperative read from joining an
    // older one (`#readCurrent`).
    for (const entry of this.#queries.values()) {
      entry.stale = true;
      entry.changes += 1;
      // Kept for a remount but followed by no one: core pushes it
      // nothing, so what it holds may be from before the change. The
      // next reader waits for it afresh, never starting from that (a
      // form whose defaults come from it would save an old revision).
      if (entry.live === undefined && entry.listeners.size === 0) {
        show(entry, loading);
      }
    }
  }
}
