import type { AccessFence } from "./access-fence.ts";
import { readRejection } from "./call-answers.ts";
import type { GraspError } from "./client-error.ts";
import { readPush, show } from "./client-query-entry.ts";
import type { Live, QueryEntry } from "./client-query-entry.ts";
import { waitAfter } from "./client-retry.ts";
import { endsFollowing, followDelay, steadyMs } from "./client-shared.ts";
import type { ClientTransport } from "./client-transport.ts";
import { fences, nothingRanCodes } from "./refusals.ts";

/**
 * What core ends a followed query with once the person's roles in its App
 * dropped: nothing read under the old roles is shown again
 * (`#accessChanged`), and the query is followed again under the new.
 */
const accessChangedCode = "page.access_changed";

/** Whether `live` is still what `entry` shows. */
const isCurrent = (entry: QueryEntry, live: Live): boolean =>
  entry.live === live && !live.stopped;

/** Stops `live`: released, its retry cancelled, nothing of it shown. */
export const stop = (live: Live): void => {
  live.stopped = true;
  clearTimeout(live.retry);
  live.release?.();
  live.release = undefined;
};

/** Stops following `entry`'s query: no component reads it any more. */
export const unfollow = (entry: QueryEntry): void => {
  const { live } = entry;
  entry.live = undefined;
  if (live !== undefined) {
    stop(live);
  }
};

/**
 * Whether `live` shows nothing core pushed it: lost and waiting to
 * follow again, or not yet pushed to, answered or not.
 */
export const waitsToFollow = (live: Live): boolean =>
  live.retry !== undefined || live.revision === 0;

/** What following a query tells the rest of the client. */
export interface FollowerEvents {
  /** Core ended a followed query as `page.access_changed` (`#accessChanged`). */
  readonly onAccessChanged: (error: GraspError) => void;
}

/** Follows queries over the frame: one subscription per query, pushed to by core. */
export class QueryFollower {
  readonly #transport: ClientTransport;
  readonly #fence: AccessFence;
  readonly #events: FollowerEvents;
  /** How many subscriptions the client made: each is numbered by it. */
  #attempts = 0;

  constructor(
    transport: ClientTransport,
    fence: AccessFence,
    events: FollowerEvents
  ) {
    this.#transport = transport;
    this.#fence = fence;
    this.#events = events;
  }

  /**
   * Follows `entry`'s query: subscribes, and shows each push of core's
   * in order (see client-core.ts). `failures` is how often in a row it was
   * lost before.
   */
  follow(entry: QueryEntry, failures: number): void {
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

  async #connect(entry: QueryEntry, live: Live): Promise<void> {
    let handle: { release: () => void };
    try {
      handle = await this.#transport.watch(
        entry.request,
        (push) => {
          if (isCurrent(entry, live)) {
            this.#pushed(entry, live, push);
          }
        },
        () => {
          if (isCurrent(entry, live)) {
            this.#lost(entry, live);
          }
        }
      );
    } catch (error) {
      if (!isCurrent(entry, live)) {
        return;
      }
      const settled = readRejection(error);
      if (settled.kind === "failed") {
        if (fences(settled.error.code)) {
          this.#fence.fence(settled.error);
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
    if (isCurrent(entry, live)) {
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
        this.#fence.fence(error);
        return;
      }
      if (endsFollowing(error.code) || error.retryable) {
        stop(live);
        entry.live = undefined;
      }
      if (error.code === accessChangedCode) {
        this.#events.onAccessChanged(error);
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
        if (isCurrent(entry, live) && entry.listeners.size > 0) {
          this.follow(entry, failures);
        }
      },
      Math.max(atLeastMs, followDelay(Math.max(0, failures - 1)))
    );
  }
}
