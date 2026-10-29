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
export type Deferred<T> = T | Promise<T>;

/**
 * A promise of `value` that is already settled, marked as React marks
 * one it has read (`status`, `value`), so `use` returns it without
 * suspending. Not an async function: that would hand back a new
 * promise, without the marks.
 */
// oxlint-disable-next-line typescript/promise-function-async -- see above
const settledThenable = <T,>(value: T): Promise<T> =>
  Object.assign(Promise.resolve(value), { status: "fulfilled", value });

/** Each value already in, as its settled promise: the same one every render. */
const settledThenables = new WeakMap<object, Promise<unknown>>();
const settledNull = settledThenable(null);

/** `value` as a promise: itself when it is one, else settled already. */
// oxlint-disable-next-line typescript/promise-function-async -- it returns the promise it is given, unwrapped
const thenableOf = <T,>(value: Deferred<T>): Promise<T> => {
  if (value instanceof Promise) {
    return value;
  }
  if (value === null) {
    // SAFETY: `value` is null, so a promise of null is a promise of `T`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return settledNull as Promise<T>;
  }
  if (typeof value !== "object") {
    return settledThenable(value);
  }
  const held = settledThenables.get(value);
  if (held !== undefined) {
    // SAFETY: held for `value` alone, as a promise of it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return held as Promise<T>;
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
