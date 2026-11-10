import { appFilesPath, fileLimits } from "@grasp-os/shared/app-file-limits";
import {
  pageLeaseHeader,
  pagePersonHeader,
} from "@grasp-os/shared/page-limits";

import { refusal, retryDelay, sleep } from "./client-shared.ts";
import { readState } from "./file-answers.ts";
import type { UploadState } from "./file-answers.ts";
import { following, stallWatch } from "./stall-watch.ts";
import { isPlainObject } from "./value-descriptor.ts";

// How the file channel (file-channel.ts) sends its requests to core: each
// under the page's lease and for its person, none waiting forever, and a
// lost one sent again unchanged, so the same upload under the same key.

/** How the channel reaches core: a path on its origin, and the request. */
export type CoreFetch = (path: string, init: RequestInit) => Promise<Response>;

/** What one App's page's file requests go under: its lease and person. */
export interface FileRequestsOptions {
  readonly app: string;
  readonly lease: string;
  /**
   * The person the frame was opened for, named on every request so core
   * refuses one whose session is someone else's (core's `personRefusal`).
   * Asked per request: a page whose connection turned out to be someone
   * else's throws, and nothing is sent.
   */
  readonly person: () => Promise<string>;
  readonly fetch: CoreFetch;
  /**
   * How long one request of an upload (a chunk's, the longest, among
   * them) or a small answer may take before it counts as lost and is sent
   * again; `fileLimits.chunkSendMs` unless given.
   */
  readonly chunkMs?: number;
}

/** A request, with a JSON body to send when it has one. */
export type ChannelInit = RequestInit & { readonly json?: unknown };

/**
 * What stops a request: `cancel` at once, and its time limit. `true`
 * bounds the whole request by the limit; `"progress"` (a file's bytes,
 * however large) only the time with nothing arriving.
 */
export interface Bounds {
  readonly cancel?: AbortSignal | undefined;
  readonly bounded: true | "progress";
}

/** How often a lost request is sent again before the channel gives up. */
export const attempts = 5;

/** The longest the channel waits before it sends a lost request again. */
export const retryCapMs = 8000;

/** The code of a failure, if it has one. */
export const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;

/** Whether a failure is a lost answer, worth sending again unchanged. */
export const isLost = (error: unknown): boolean => {
  const code = codeOf(error);
  return (
    code === undefined ||
    code === "internal.unexpected" ||
    code === "page.rate_limited" ||
    // Its body took core too long to read: sent again, or resumed.
    code === "request.timeout"
  );
};

/** A response's JSON body. */
export const bodyOf = async (response: Response): Promise<unknown> =>
  await response.json();

/**
 * What `waiting` answers, or `signal`'s reason once it aborts first: a
 * wait the request's cancel and time limit stop, as they stop `fetch`.
 */
const unlessAborted = async <T>(
  waiting: Promise<T>,
  signal: AbortSignal | null | undefined
): Promise<T> => {
  if (signal === null || signal === undefined) {
    return await waiting;
  }
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const abort = (): void => {
    reject(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([waiting, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

/** The requests of one App's page's file channel. */
export const fileRequests = ({
  app,
  lease,
  person,
  fetch,
  chunkMs = fileLimits.chunkSendMs,
}: FileRequestsOptions) => {
  /** The path of `resource`'s files, under which every request goes. */
  const base = (resource: string): string =>
    `${appFilesPath}/${encodeURIComponent(app)}/${encodeURIComponent(resource)}`;

  /** One request; core's refusal thrown with its code, a lost one without. */
  const send = async (path: string, init: ChannelInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set(pageLeaseHeader, lease);
    // The person can wait on a connection coming back: the request's cancel
    // and time limit stop that wait too, not only the fetch after it.
    // A request stopped before it starts asks for no one.
    init.signal?.throwIfAborted();
    headers.set(pagePersonHeader, await unlessAborted(person(), init.signal));
    const { json, ...rest } = init;
    if (json !== undefined) {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(path, {
      ...rest,
      headers,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    if (response.ok) {
      return response;
    }
    let payload: unknown;
    try {
      payload = await bodyOf(response);
    } catch {
      payload = undefined;
    }
    if (
      isPlainObject(payload) &&
      typeof payload.code === "string" &&
      typeof payload.message === "string"
    ) {
      throw refusal(payload.code, payload.message);
    }
    throw new Error(`Core answered ${response.status}.`);
  };

  /**
   * One request, and `read` of its answer, as every request of the
   * channel is sent (`Bounds`). One that takes longer than `chunkMs` is
   * lost (no code), so it is sent again; bounded by progress, before its
   * headers, the same, and while its body is read, the read fails, so a
   * stalled transfer ends and frees what it held.
   */
  const attempt = async <Answer>(
    path: string,
    init: ChannelInit,
    read: (response: Response) => Promise<Answer>,
    { cancel, bounded }: Bounds
  ): Promise<Answer> => {
    const watch = bounded === "progress" ? stallWatch(chunkMs) : undefined;
    const limit = watch?.signal ?? AbortSignal.timeout(chunkMs);
    const signals = [cancel, limit].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );
    try {
      const response = await send(path, {
        ...init,
        signal: AbortSignal.any(signals),
      });
      // Its headers came: progress, so the body's first piece gets a
      // whole stall's time of its own.
      watch?.touch();
      return await read(
        watch === undefined ? response : following(response, watch)
      );
    } catch (error) {
      watch?.stop();
      if (limit.aborted && cancel?.aborted !== true) {
        throw new Error("A request's answer took too long.", { cause: error });
      }
      throw error;
    }
  };

  /**
   * `attempt`, sent again while the answer is lost (a connection that
   * drops partway through the body too), up to `attempts` times: the same
   * request each time, so the same upload, under the same key. `cancel`
   * stops it, a wait between attempts too.
   */
  const sendAgain = async <Answer>(
    path: string,
    init: ChannelInit,
    read: (response: Response) => Promise<Answer>,
    bounds: Bounds
  ): Promise<Answer> => {
    for (let tried = 1; ; tried += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        return await attempt(path, init, read, bounds);
      } catch (error) {
        if (!isLost(error) || tried >= attempts) {
          throw error;
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- backing off between attempts
      await sleep(retryDelay(tried, retryCapMs), bounds.cancel);
    }
  };

  /** An upload's state, as core answers `path`, each attempt bounded. */
  const stateAt = async (
    path: string,
    init: ChannelInit,
    cancel?: AbortSignal
  ): Promise<UploadState> =>
    await sendAgain(
      path,
      init,
      async (response) => readState(await bodyOf(response)),
      { cancel, bounded: true }
    );

  return { base, attempt, sendAgain, stateAt };
};

/** The requests of one App's page's file channel. */
export type FileRequests = ReturnType<typeof fileRequests>;
