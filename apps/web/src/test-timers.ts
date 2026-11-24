import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";

type Timers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;

// Keeps the timers `on.setTimeout` starts until they run or are cleared,
// and returns what cancels those still waiting and every one started after.
// Only `setTimeout` with a callback is tracked: not `setInterval`,
// `setImmediate` or animation frames. `util.promisify(setTimeout)` still
// gives Node's own promise timer, which is not tracked either.
export const trackTimers = (on: Timers): (() => void) => {
  const { setTimeout: start, clearTimeout: stop } = on;
  const waiting = new Set<ReturnType<typeof start>>();
  let closing = false;
  const setTimeout = (
    run: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const timer = start(() => {
      waiting.delete(timer);
      run(...args);
    }, ms);
    if (closing) {
      stop(timer);
    } else {
      waiting.add(timer);
    }
    return timer;
  };
  // What `util.promisify(setTimeout)` gives, as on Node's own.
  Object.assign(setTimeout, { [promisify.custom]: wait });
  Object.assign(on, {
    setTimeout,
    clearTimeout: (timer?: ReturnType<typeof start>) => {
      if (timer !== undefined) {
        waiting.delete(timer);
      }
      stop(timer);
    },
  });
  return () => {
    closing = true;
    for (const timer of waiting) {
      stop(timer);
    }
    waiting.clear();
  };
};
