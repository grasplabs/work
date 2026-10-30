/**
 * What a page shows of a read its loader didn't wait for: the shell of
 * the page renders at once, from what the admin recorded itself, and
 * the part that needs a core's answer suspends until it comes. Read
 * again (a loader run once its answer went stale, or on Try again), the
 * page keeps showing the answer it has until the new one comes, rather
 * than the read's placeholder: stale while it revalidates.
 */
import { use, useDeferredValue, useEffect, useState } from "react";

/** A value a loader has, or will have. */
export type Deferred<T> = T | PromiseLike<T>;

/** A value already in, as `use` takes it: settled, so it reads it at once. */
interface SettledThenable<T> extends PromiseLike<T> {
  status: "fulfilled";
  value: T;
}

/**
 * `value` as a thenable already settled, marked as React marks one it
 * has read (`status`, `value`), so `use` returns it without suspending.
 * Not a Promise: one made while rendering one request and kept for the
 * next would be another request's I/O to the Workers runtime.
 */
const settledThenable = <T,>(value: T): SettledThenable<T> => ({
  status: "fulfilled",
  value,
  // A promise only when one is asked for, in the request asking.
  // oxlint-disable-next-line unicorn/no-thenable -- a thenable is what `use` takes
  then: async (onFulfilled, onRejected) =>
    await Promise.resolve(value).then(onFulfilled, onRejected),
});

/** Whether `value` is a thenable: a read still under way, as a loader hands it. */
const isThenable = <T,>(value: Deferred<T>): value is PromiseLike<T> =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "then") === "function";

/** Each value already in, as its settled thenable: the same one every render. */
const settledThenables = new WeakMap<object, SettledThenable<unknown>>();

/** `value` as a thenable: itself when it is a promise, else settled already. */
const thenableOf = <T,>(value: Deferred<T>): PromiseLike<T> => {
  if (isThenable(value)) {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return settledThenable(value);
  }
  const held = settledThenables.get(value);
  if (held !== undefined) {
    // SAFETY: held for `value` alone, as a thenable of it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return held as PromiseLike<T>;
  }
  const made = settledThenable(value);
  settledThenables.set(value, made);
  return made;
};

/**
 * `value` once it settles: the component suspends until it first does,
 * and later, while a new one is read, shows the one it had. Rendered
 * keyed by what it is of (an organization), so another one's never
 * shows in its place. `use` is called on every render, for a value as
 * for a promise: React requires a component to call it the same way
 * each time.
 */
export const useSettled = <T,>(value: Deferred<T>): T =>
  use(useDeferredValue(thenableOf(value)));

/** How often the words of an `Ago` are worked out again. */
const agoEveryMs = 30_000;

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** How long ago `at` was at `now`, in words: just now, or minutes, hours or days ago. */
export const agoWords = (at: number, now: number): string => {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return relative.format(-minutes, "minute");
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? relative.format(-hours, "hour")
    : relative.format(-Math.floor(hours / 24), "day");
};

/** How long ago `at` was, kept up to date while it shows. */
export const Ago = ({ at }: { at: string }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, agoEveryMs);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    // Rendered on the server a moment before the page hydrates: the words may move on in that moment.
    <time dateTime={at} suppressHydrationWarning>
      {agoWords(Date.parse(at), now)}
    </time>
  );
};
