/** Why work was stopped: it took too long, or its caller cancelled it. */
export type Stopped = "timeout" | "cancelled";

/** A deadline for one piece of work, as {@link deadline} makes it. */
export interface Deadline {
  /** Aborts when the time is up or the caller cancels. */
  signal: AbortSignal;
  /** Why the work was stopped, if it was. */
  stopped: () => Stopped | undefined;
  /** Ends the deadline: call it when the work ends, however it ends. */
  clear: () => void;
  /** When the time is up, in ms since the epoch. */
  endsAt: number;
}

/** Whether an abort's reason says time ran out: a `TimeoutError`. */
const isTimeoutReason = (reason: unknown): boolean =>
  typeof reason === "object" &&
  reason !== null &&
  "name" in reason &&
  reason.name === "TimeoutError";

/**
 * Ends work after `ms`, or when its caller cancels it. Its timer is cleared
 * when the work ends, so none outlives it (in core, to keep a Durable Object awake)
 * (`AbortSignal.timeout` can't be cleared).
 */
export const deadline = (ms: number, caller?: AbortSignal): Deadline => {
  const endsAt = Date.now() + ms;
  const timer = new AbortController();
  const handle = setTimeout(() => {
    timer.abort();
  }, ms);
  return {
    signal:
      caller === undefined
        ? timer.signal
        : AbortSignal.any([caller, timer.signal]),
    stopped: () => {
      if (caller?.aborted === true) {
        // A caller that ends the work for its own time running out (an
        // attempt's deadline, `AbortSignal.timeout`) stopped it for time.
        return isTimeoutReason(caller.reason) ? "timeout" : "cancelled";
      }
      return timer.signal.aborted ? "timeout" : undefined;
    },
    clear: () => {
      clearTimeout(handle);
    },
    endsAt,
  };
};

/**
 * Rejects with the signal's reason once it aborts: to race work against a
 * deadline that doesn't stop the work itself. It no longer listens once
 * it has settled.
 */
export const whenAborted = async (signal: AbortSignal): Promise<never> => {
  const aborted = Promise.withResolvers<never>();
  const abort = () => {
    aborted.reject(signal.reason);
  };
  if (signal.aborted) {
    abort();
  }
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await aborted.promise;
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

/**
 * What `work` answers, or, once `ms` are over or `caller` aborts, a
 * rejection: a `TimeoutError` for the time, the caller's reason for its
 * abort. Work that loses the race goes on, unheard: its answer or its
 * failure is dropped, never left unhandled. Every timer and listener is
 * gone once it settles.
 */
export const withinTime = async <T>(
  work: () => Promise<T>,
  ms: number,
  caller?: AbortSignal
): Promise<T> => {
  const limit = deadline(ms, caller);
  const stop = Promise.withResolvers<never>();
  const onAbort = () => {
    stop.reject(
      limit.stopped() === "timeout" && caller?.aborted !== true
        ? new DOMException("The work took too long", "TimeoutError")
        : limit.signal.reason
    );
  };
  limit.signal.addEventListener("abort", onAbort, { once: true });
  if (limit.signal.aborted) {
    onAbort();
  }
  const settled = (async () => {
    try {
      return { value: await work() };
    } catch (error) {
      return { error };
    }
  })();
  try {
    const outcome = await Promise.race([settled, stop.promise]);
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    limit.clear();
    limit.signal.removeEventListener("abort", onAbort);
  }
};
