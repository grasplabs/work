import { isRecord } from "@grasp-os/shared/json";

import {
  TestAssertionError,
  canonical,
  disposed,
  requestFor,
  settled,
} from "./app-test-session.ts";
import type { AppTestSubscription, RunningTest } from "./app-test-session.ts";
import type { LiveQuery } from "./app-test-types.ts";

/**
 * The most snapshots a live query keeps that `next` hasn't taken: one
 * more fails the test.
 */
const maxBufferedSnapshots = 100;

/** The most of a snapshot a failure shows. */
const maxShownSnapshot = 300;

/** `value` as a failure shows it, cut short. */
const shown = (value: unknown): string => {
  const text = canonical(value);
  return text.length > maxShownSnapshot
    ? `${text.slice(0, maxShownSnapshot)}…`
    : text;
};

/** The function a reference names, for a failure's text. */
const contractOf = (reference: unknown): string =>
  isRecord(reference) && typeof reference.name === "string"
    ? reference.name
    : "a query";

/** A push of core's, as far as a live query reads it. */
const readPush = (
  push: unknown
): { revision: number; result: unknown } | undefined =>
  isRecord(push) &&
  typeof push.revision === "number" &&
  Number.isSafeInteger(push.revision)
    ? { revision: push.revision, result: push.result }
    : undefined;

/**
 * How many times in a row core may let go of a live query, with no
 * snapshot in between, before the test fails: on that loss, it does. Core
 * lets go of one it can't keep fresh for now (a read that met a
 * concurrent write, a store that restarted), and a page follows it
 * again from a fresh read; so does a test, but one core can't keep
 * following at all fails it.
 */
const maxLostInARow = 5;

/** How long a test waits to follow again after each loss in a row, in ms. */
const refollowMs = 50;

/** One subscription to a live query, as the test follows it. */
interface Attempt {
  handle: AppTestSubscription | undefined;
}

/**
 * Follows `reference` with `args` as principal `name` (`subscribe`): the
 * snapshots core pushes, one at a time and in order, are kept until
 * `next` takes them. Lost, it follows again, as a page does, from a
 * fresh read: a new subscription, whose predecessor's late pushes are
 * dropped.
 */
export const followed = async (
  run: RunningTest,
  name: string,
  reference: unknown,
  args: unknown
): Promise<LiveQuery<unknown>> => {
  const request = requestFor(reference, "query", args);
  const contract = contractOf(reference);
  const snapshots: unknown[] = [];
  let last: { value: unknown } | undefined;
  let failure: Error | undefined;
  let closed = false;
  let wake: (() => void) | undefined;
  let attempt: Attempt | undefined;
  let lostInARow = 0;
  const notify = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  const fail = (error: unknown): void => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    notify();
  };
  /** Whether `of` is what the test follows now, and still may. */
  const current = (of: Attempt): boolean =>
    !closed && failure === undefined && attempt === of;
  const pushed = (of: Attempt, push: unknown): void => {
    const read = readPush(push);
    if (!current(of) || read === undefined) {
      return;
    }
    lostInARow = 0;
    let value: unknown;
    try {
      value = settled(read.result);
    } catch (error) {
      fail(error);
      return;
    }
    // Dropping one unread could drop the very snapshot a `next` will
    // wait for, which would then wait until the test's deadline: the
    // test fails now, saying why.
    if (snapshots.length >= maxBufferedSnapshots) {
      const overflow = new TestAssertionError(
        `more than ${maxBufferedSnapshots} snapshots of the live query of ${contract} went unread: take them with live.next, or close it`
      );
      run.faults.add(overflow);
      fail(overflow);
      return;
    }
    snapshots.push(value);
    last = { value };
    notify();
  };
  const end = (): Attempt | undefined => {
    closed = true;
    snapshots.length = 0;
    notify();
    const ended = attempt;
    attempt = undefined;
    return ended;
  };
  // As the test ends: nothing of it is held in the isolate past it.
  // Registered before the first subscription is asked for, so a test
  // that ends meanwhile still lets go of what it is answered (`follow`).
  const drop = (): void => {
    const ended = end();
    if (ended?.handle !== undefined) {
      disposed(ended.handle);
    }
  };
  run.closers.add(drop);
  const follow = async (): Promise<void> => {
    const of: Attempt = { handle: undefined };
    attempt = of;
    let handle: AppTestSubscription;
    try {
      const answer = await run.session.subscribe(
        name,
        request,
        (push) => {
          pushed(of, push);
        },
        () => {
          // oxlint-disable-next-line no-use-before-define -- each loss follows again, which may be lost
          lost(of);
        }
      );
      if ("refusal" in answer) {
        // Throws the refusal it holds, as a call's: `t.rejectsCode` reads it.
        settled(JSON.parse(answer.refusal));
        throw new Error(
          "The test runner refused a live query without saying why."
        );
      }
      handle = answer.subscription;
    } catch (error) {
      // Refused: nothing is followed, nor followed again.
      if (attempt === of) {
        attempt = undefined;
      }
      throw error;
    }
    if (current(of)) {
      of.handle = handle;
    } else {
      // Lost, closed or ended meanwhile.
      disposed(handle);
    }
  };
  const lost = (of: Attempt): void => {
    if (!current(of)) {
      return;
    }
    attempt = undefined;
    if (of.handle !== undefined) {
      disposed(of.handle);
    }
    lostInARow += 1;
    if (lostInARow >= maxLostInARow) {
      // A fault of the run's, as an overflow is: the test fails even if it
      // never asks this live query for a snapshot again. So is a refusal
      // to follow it again (`again`).
      const gone = new TestAssertionError(
        `core stopped following the live query of ${contract} ${lostInARow} times in a row`
      );
      run.faults.add(gone);
      fail(gone);
      return;
    }
    const again = async (): Promise<void> => {
      if (closed || failure !== undefined) {
        return;
      }
      try {
        await follow();
      } catch (error) {
        if (closed) {
          return;
        }
        // Refused or failed for good, out of the test's sight: a fault of
        // the run's, as five losses in a row are.
        fail(error);
        if (failure !== undefined) {
          run.faults.add(failure);
        }
      }
    };
    setTimeout(() => {
      void again();
    }, refollowMs * lostInARow);
  };
  try {
    await follow();
  } catch (error) {
    run.closers.delete(drop);
    throw error;
  }
  const waitOn = {
    describe: () =>
      `live.next on ${contract}, ${last === undefined ? "with no snapshot yet" : `whose last snapshot was ${shown(last.value)}`}`,
  };
  return {
    next: async (predicate) => {
      for (;;) {
        while (snapshots.length > 0) {
          const value = snapshots.shift();
          if (predicate === undefined || predicate(value)) {
            return value;
          }
        }
        if (failure !== undefined) {
          throw failure;
        }
        if (closed) {
          throw new TestAssertionError(
            `live.next on ${contract} after it was closed`
          );
        }
        if (wake !== undefined) {
          throw new TestAssertionError(
            `live.next on ${contract} waits for one snapshot at a time`
          );
        }
        const { promise, resolve } = Promise.withResolvers<null>();
        wake = (): void => {
          resolve(null);
        };
        run.waiting.add(waitOn);
        try {
          // One snapshot after another, in the order core pushed them.
          // oxlint-disable-next-line no-await-in-loop -- see above
          await promise;
        } finally {
          run.waiting.delete(waitOn);
        }
      }
    },
    close: async () => {
      if (closed) {
        return;
      }
      const ended = end();
      run.closers.delete(drop);
      if (ended?.handle !== undefined) {
        try {
          await ended.handle.release();
        } finally {
          // Nothing else holds it now, even if core couldn't be told.
          disposed(ended.handle);
        }
      }
    },
  };
};
