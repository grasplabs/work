// What the page's client modules share: the session client
// (client-core.ts) and core's file and link channels (file-channel.ts,
// link-channel.ts). How a request is keyed and retried, how a followed
// query is followed again, and a refusal as core answers it.

/** A fresh idempotency key: 128 random bits, in hex. */
export const freshKey = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

/**
 * How long to wait before retry `attempt` (1 for the first): backed off
 * up to `capMs`, jittered.
 */
export const retryDelay = (attempt: number, capMs: number): number => {
  const base = Math.min(250 * 2 ** (attempt - 1), capMs);
  return base / 2 + Math.random() * (base / 2);
};

/** Resolves after `ms`, or as soon as `signal` aborts. */
export const sleep = async (
  ms: number,
  signal?: AbortSignal | null
): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<null>();
  const done = (): void => {
    resolve(null);
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  if (signal?.aborted === true) {
    done();
  }
  try {
    await promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
  }
};

/** A refusal core answered, with its code. */
export const refusal = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

/**
 * Refusals after which following a query or a run again would only be
 * refused again: the App moved to another version, the page follows too
 * many, or the request itself. (A refusal of the person or the build
 * fences the whole client.)
 */
export const endsFollowing = (code: string): boolean =>
  code.startsWith("version.") ||
  code === "app.not_running" ||
  code === "page.too_many_queries" ||
  code === "page.invalid" ||
  code.startsWith("contract.");

/** The least wait before following again. */
const minFollowMs = 250;

/**
 * How long to wait before following again after it was lost `failures`
 * times in a row: from 1 up to 30 seconds, fully jittered, but never
 * under `minFollowMs`.
 */
export const followDelay = (failures: number): number =>
  Math.max(minFollowMs, Math.random() * Math.min(30_000, 1000 * 2 ** failures));

/** How long a subscription must last for its losses to count afresh. */
export const steadyMs = 30_000;
