import {
  appFilesPath,
  chunksOf,
  fileChunkHashHeader,
  fileLimits,
  isFileType,
} from "@grasp-os/shared/app-file-limits";
import type {
  FileDescription,
  FileType,
} from "@grasp-os/shared/app-file-limits";
import {
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screen-limits";

import type { TransferProgress } from "./client-files.ts";
import { isPlainObject } from "./value-descriptor.ts";

// The page's side of core's file channel (core's app-file-route.ts): what
// the trusted page around a screen's frame does with the files the frame
// hands it, and what a host's own bootstrap would do. It speaks to core
// for one App's screen, under that screen's lease, and never hands the
// frame anything but the outcome: no URL, no lease, no request.
//
// An upload declares its name, type, size and hash before any byte,
// sends its chunks one at a time, each with its own hash, and has core
// check the whole before it is published. What breaks on the way is
// resumed under the same upload, never started again under a fresh one:
// a chunk whose answer was lost is sent again once core said which it
// holds (it keeps each once); a finish whose answer was lost is asked
// again. Cancelling asks core, whose answer says whether the upload was
// cancelled or published first.

/** How the channel reaches core: a path on its origin, and the request. */
export type CoreFetch = (path: string, init: RequestInit) => Promise<Response>;

/** One App's screen's file channel, under its lease. */
export interface FileChannelOptions {
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

/** What an upload is told: to cancel, and where it is. */
interface UploadHooks {
  readonly cancel: AbortSignal;
  readonly onProgress: (progress: TransferProgress) => void;
}

/** A request, with a JSON body to send when it has one. */
type ChannelInit = RequestInit & { readonly json?: unknown };

/** A refusal core answered, with its code. */
const refusal = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const cancelledError = (): Error =>
  refusal("file.cancelled", "The upload was cancelled.");

/** How often a lost request is sent again before the channel gives up. */
const attempts = 5;

/** The wait before retry `attempt` (1 for the first), backed off, jittered. */
const backoff = (attempt: number): number => {
  const base = Math.min(250 * 2 ** (attempt - 1), 8000);
  return base / 2 + Math.random() * (base / 2);
};

/** Waits `ms`, or until `signal` aborts, whichever comes first. */
const sleep = async (
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
  await promise;
  clearTimeout(timer);
  signal?.removeEventListener("abort", done);
};

/** The code of a failure, if it has one. */
const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;

/** Whether a failure is a lost answer, worth sending again unchanged. */
const isLost = (error: unknown): boolean => {
  const code = codeOf(error);
  return (
    code === undefined ||
    code === "internal.unexpected" ||
    code === "screen.rate_limited"
  );
};

/** A fresh upload key: 128 random bits, in hex. */
const freshKey = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

/** The lower-case hex SHA-256 of `bytes`. */
const sha256Of = async (bytes: ArrayBuffer): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

/** A response's JSON body. */
const bodyOf = async (response: Response): Promise<unknown> =>
  await response.json();

/** What core answers of an upload: its ID, state and the chunks it holds. */
interface UploadState {
  readonly file: string;
  readonly state: "uploading" | "published" | "cancelled";
  readonly received: readonly number[];
}

const isState = (value: unknown): value is UploadState["state"] =>
  value === "uploading" || value === "published" || value === "cancelled";

const readState = (value: unknown): UploadState => {
  if (
    !isPlainObject(value) ||
    typeof value.file !== "string" ||
    !isState(value.state) ||
    !Array.isArray(value.received)
  ) {
    throw new Error("Core's answer about an upload isn't one.");
  }
  const received = value.received.filter((index): index is number =>
    Number.isSafeInteger(index)
  );
  return { file: value.file, state: value.state, received };
};

const readDescription = (value: unknown): FileDescription => {
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isFileType(value.mimeType) ||
    typeof value.size !== "number"
  ) {
    throw new Error("Core's answer about a file isn't one.");
  }
  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
  };
};

/**
 * The type `blob` says it is, if a file may be one, checked with its size
 * before any byte is sent (core checks both again, and the bytes too).
 */
const uploadable = (blob: Blob): FileType => {
  const type = blob.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isFileType(type)) {
    throw refusal(
      "file.type_unsupported",
      "Only PNG, JPEG, GIF and WebP images, PDFs, and plain text or CSV files can be uploaded."
    );
  }
  if (blob.size > fileLimits.bytes) {
    throw refusal(
      "file.too_large",
      `A file is at most ${fileLimits.bytes / 1024 / 1024} MB.`
    );
  }
  return type;
};

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

/** A signal aborted once `ms` pass without a `touch`; `stop` lets it go. */
interface StallWatch {
  readonly signal: AbortSignal;
  readonly touch: () => void;
  readonly stop: () => void;
}

const stallWatch = (ms: number): StallWatch => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    clearTimeout(timer);
  };
  const touch = (): void => {
    stop();
    timer = setTimeout(() => {
      controller.abort(new DOMException("Nothing arrived.", "TimeoutError"));
    }, ms);
  };
  touch();
  return { signal: controller.signal, touch, stop };
};

/**
 * `response`, its body read through `watch`: each piece that arrives
 * puts its stall off again, and the end or a cancel lets it go. Its
 * reader reads it as it comes (a download does): a body no one reads
 * counts as stalled.
 */
const following = (response: Response, watch: StallWatch): Response => {
  const { body } = response;
  if (body === null) {
    watch.stop();
    return response;
  }
  const reader = body.getReader();
  // Read on demand only (no high-water mark): nothing is read ahead of
  // its reader, so what core stops sending is never already buffered.
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            watch.stop();
            controller.close();
            return;
          }
          watch.touch();
          controller.enqueue(value);
        } catch (error) {
          watch.stop();
          throw error;
        }
      },
      cancel: async (reason) => {
        watch.stop();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/** The file channel of one App's screen (see the header). */
export const fileChannel = ({
  app,
  lease,
  person,
  fetch,
  chunkMs = fileLimits.chunkSendMs,
}: FileChannelOptions) => {
  const base = (resource: string): string =>
    `${appFilesPath}/${encodeURIComponent(app)}/${encodeURIComponent(resource)}`;

  /** One request; core's refusal thrown with its code, a lost one without. */
  const send = async (path: string, init: ChannelInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set(screenLeaseHeader, lease);
    // The person can wait on a connection coming back: the request's cancel
    // and time limit stop that wait too, not only the fetch after it.
    // A request stopped before it starts asks for no one.
    init.signal?.throwIfAborted();
    headers.set(screenPersonHeader, await unlessAborted(person(), init.signal));
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
   * channel is sent: `cancel` stops it at once, and none waits forever.
   * With `bounded: true` one that takes longer than `chunkMs`, its body
   * read included, is lost (no code), so it is sent again. With
   * `bounded: "progress"` (a file's bytes, however large) it is lost only
   * once `chunkMs` pass with nothing arriving: before its headers, sent
   * again; while its body is read, the read fails, so a stalled transfer
   * ends and frees what it held.
   */
  const attempt = async <Answer>(
    path: string,
    init: ChannelInit,
    read: (response: Response) => Promise<Answer>,
    { cancel, bounded }: { cancel?: AbortSignal; bounded: true | "progress" }
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
    options: { cancel?: AbortSignal; bounded: true | "progress" }
  ): Promise<Answer> => {
    for (let tried = 1; ; tried += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        return await attempt(path, init, read, options);
      } catch (error) {
        if (!isLost(error) || tried >= attempts) {
          throw error;
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- backing off between attempts
      await sleep(backoff(tried), options.cancel);
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
      cancel === undefined ? { bounded: true } : { cancel, bounded: true }
    );

  /**
   * The chunks of upload `file` core holds. Cancelling stops the question
   * at once, so the cancellation reaches core under the same upload.
   */
  const held = async (
    resource: string,
    file: string,
    cancel: AbortSignal
  ): Promise<Set<number>> => {
    const state = await stateAt(
      `${base(resource)}/uploads/${file}`,
      {},
      cancel
    );
    return new Set(state.received);
  };

  /** Cancels upload `file`: its ID if core published it first. */
  const cancelled = async (resource: string, file: string): Promise<string> => {
    const state = await stateAt(`${base(resource)}/uploads/${file}`, {
      method: "DELETE",
    });
    if (state.state === "published") {
      return state.file;
    }
    throw cancelledError();
  };

  /**
   * Sends chunk `index` of `blob` to upload `file`, once: a lost one is
   * resumed from what core holds (`sendMissing`). A chunk that still lands
   * is core's to keep or drop (write-once).
   */
  const sendChunk = async (
    resource: string,
    file: string,
    blob: Blob,
    index: number,
    cancel: AbortSignal
  ): Promise<void> => {
    const bytes = await blob
      .slice(index * fileLimits.chunkBytes, (index + 1) * fileLimits.chunkBytes)
      .arrayBuffer();
    await attempt(
      `${base(resource)}/uploads/${file}/chunks/${index}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          [fileChunkHashHeader]: await sha256Of(bytes),
        },
        body: bytes,
      },
      async (response) => {
        await response.arrayBuffer();
      },
      { cancel, bounded: true }
    );
  };

  /**
   * Sends the chunks of `blob` core doesn't hold, one at a time, resuming
   * from what core holds after a lost one. False once cancelled.
   */
  const sendMissing = async (
    resource: string,
    file: string,
    blob: Blob,
    holding: Set<number>,
    { cancel, onProgress }: UploadHooks
  ): Promise<boolean> => {
    let holds = holding;
    let lost = 0;
    for (let index = 0; index < chunksOf(blob.size); index += 1) {
      if (cancel.aborted) {
        return false;
      }
      if (!holds.has(index)) {
        onProgress({
          phase: "uploading",
          bytesUploaded: Math.min(
            blob.size,
            holds.size * fileLimits.chunkBytes
          ),
          bytesTotal: blob.size,
        });
        try {
          // oxlint-disable-next-line no-await-in-loop -- one chunk at a time: backpressure
          await sendChunk(resource, file, blob, index, cancel);
          holds.add(index);
          // Progress: losses before it don't count against the next one.
          lost = 0;
        } catch (error) {
          if (cancel.aborted) {
            return false;
          }
          lost += 1;
          if (!isLost(error) || lost >= attempts) {
            throw error;
          }
          // oxlint-disable-next-line no-await-in-loop -- backing off, then resuming
          await sleep(backoff(lost), cancel);
          try {
            const before = holds.size;
            // oxlint-disable-next-line no-await-in-loop -- resumed from what core holds
            holds = await held(resource, file, cancel);
            // Core holds more than before (the chunk whose answer was
            // lost among them): progress, as a chunk answered is.
            if (holds.size > before) {
              lost = 0;
            }
          } catch (heldError) {
            if (cancel.aborted) {
              return false;
            }
            throw heldError;
          }
          index = -1;
        }
      }
    }
    return true;
  };

  /**
   * Asks core to check and publish upload `file`; cancelling meanwhile
   * asks core to cancel it as well, and core, which takes one after the
   * other, says which came first: the file when publication did, a
   * `file.cancelled` refusal when the cancellation did. Once cancelled,
   * the cancellation's answer settles it, the finish's own answer (which
   * may never come) consumed whenever it does.
   */
  const finishing = async (
    resource: string,
    file: string,
    cancel: AbortSignal
  ): Promise<string> => {
    const { promise: abortSeen, resolve: seeAbort } =
      Promise.withResolvers<"cancelled">();
    // The cancellation's outcome as a settled result, so a refusal no one
    // awaits yet is never unhandled.
    let cancelling: Promise<{ file: string } | { error: unknown }> | undefined;
    const onAbort = (): void => {
      cancelling = (async () => {
        try {
          return { file: await cancelled(resource, file) };
        } catch (error) {
          return { error };
        }
      })();
      seeAbort("cancelled");
    };
    cancel.addEventListener("abort", onAbort, { once: true });
    if (cancel.aborted) {
      onAbort();
    }
    const finish = (async (): Promise<
      { state: UploadState } | { error: unknown }
    > => {
      try {
        return {
          state: await stateAt(`${base(resource)}/uploads/${file}/finish`, {
            method: "POST",
          }),
        };
      } catch (error) {
        return { error };
      }
    })();
    const first = await Promise.race([finish, abortSeen]);
    cancel.removeEventListener("abort", onAbort);
    if (cancelling !== undefined) {
      const outcome = await cancelling;
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.file;
    }
    if (first === "cancelled") {
      throw cancelledError();
    }
    if ("state" in first && first.state.state === "published") {
      return first.state.file;
    }
    if ("error" in first && first.error instanceof Error) {
      throw first.error;
    }
    throw cancelledError();
  };

  /**
   * What an upload that failed for good after its start (`error`) answers:
   * it is cancelled, so it holds none of the person's open uploads until
   * it expires. Its file when core says publication came first (a finish
   * whose answer was lost); otherwise `error`, also when the cancellation
   * couldn't be sent.
   */
  const givenUp = async (
    resource: string,
    file: string,
    error: unknown
  ): Promise<string> => {
    try {
      return await cancelled(resource, file);
    } catch {
      throw error;
    }
  };

  /**
   * Sends what core doesn't hold of `blob` and finishes upload `file`,
   * round after round while a finish finds a chunk missing; cancelled
   * when `hooks.cancel` aborts.
   */
  const sendAndFinish = async (
    resource: string,
    file: string,
    blob: Blob,
    begun: UploadState,
    hooks: UploadHooks
  ): Promise<string> => {
    let holding = new Set(begun.received);
    for (let round = 1; ; round += 1) {
      if (
        hooks.cancel.aborted ||
        // oxlint-disable-next-line no-await-in-loop -- a round after a finish found chunks missing
        !(await sendMissing(resource, file, blob, holding, hooks))
      ) {
        // oxlint-disable-next-line no-await-in-loop -- once, then out
        return await cancelled(resource, file);
      }
      hooks.onProgress({
        phase: "verifying",
        bytesUploaded: blob.size,
        bytesTotal: blob.size,
      });
      try {
        // oxlint-disable-next-line no-await-in-loop -- once all chunks are in
        return await finishing(resource, file, hooks.cancel);
      } catch (error) {
        if (codeOf(error) !== "file.incomplete" || round >= attempts) {
          throw error;
        }
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- resumed from what core holds
        holding = await held(resource, file, hooks.cancel);
      } catch (error) {
        // Cancelled meanwhile: the next round sends the cancellation.
        if (!hooks.cancel.aborted) {
          throw error;
        }
      }
    }
  };

  /**
   * Uploads `blob` as `name` through `resource`, resuming what breaks
   * under the same upload; answers its ID once core published it.
   */
  const upload = async (
    resource: string,
    blob: Blob,
    name: string,
    hooks: UploadHooks
  ): Promise<string> => {
    const type = uploadable(blob);
    if (hooks.cancel.aborted) {
      throw cancelledError();
    }
    // A start sent again after a lost answer finds the upload it made:
    // the key is this upload's, the same however often it is sent.
    const start: ChannelInit = {
      method: "POST",
      json: {
        name,
        type,
        size: blob.size,
        sha256: await sha256Of(await blob.arrayBuffer()),
        key: freshKey(),
      },
    };
    const startPath = `${base(resource)}/uploads`;
    // Cancelled before any start was sent: no upload could have begun.
    if (hooks.cancel.aborted) {
      throw cancelledError();
    }
    let begun: UploadState;
    try {
      begun = await stateAt(startPath, start, hooks.cancel);
    } catch (error) {
      if (!hooks.cancel.aborted) {
        throw error;
      }
      // Cancelled while starting: the start may have reached core, so it
      // is sent again under its key to find the upload it made, which is
      // then cancelled. Cancelled is said only once core says so: should
      // finding it fail, that failure is the answer, since an upload may
      // hold a place until it expires (`fileLimits.uploadMs`).
      const found = await stateAt(startPath, start);
      return await cancelled(resource, found.file);
    }
    const { file } = begun;
    try {
      return await sendAndFinish(resource, file, blob, begun, hooks);
    } catch (error) {
      if (hooks.cancel.aborted) {
        throw error;
      }
      return await givenUp(resource, file, error);
    }
  };

  return {
    upload,
    /** What file `file` is, if the person may read it. */
    describe: async (
      resource: string,
      file: string,
      signal?: AbortSignal
    ): Promise<FileDescription> =>
      await sendAgain(
        `${base(resource)}/files/${encodeURIComponent(file)}`,
        {},
        async (response) => readDescription(await bodyOf(response)),
        signal === undefined
          ? { bounded: true }
          : { cancel: signal, bounded: true }
      ),
    /** File `file`'s bytes, as core's attachment response, its body unread. */
    content: async (
      resource: string,
      file: string,
      signal?: AbortSignal
    ): Promise<Response> =>
      await sendAgain(
        `${base(resource)}/files/${encodeURIComponent(file)}/content`,
        {},
        // Its body is the reader's: a download streams it, given up on
        // only once its bytes stop coming.
        async (response) => await Promise.resolve(response),
        signal === undefined
          ? { bounded: "progress" }
          : { cancel: signal, bounded: "progress" }
      ),
    /**
     * The bytes of file `file`, a previewable image, for the page to show
     * in its frame: audited as a preview, never as a download.
     */
    preview: async (
      resource: string,
      file: string,
      signal?: AbortSignal
    ): Promise<Response> =>
      await sendAgain(
        `${base(resource)}/files/${encodeURIComponent(file)}/preview`,
        {},
        async (response) => await Promise.resolve(response),
        signal === undefined
          ? { bounded: "progress" }
          : { cancel: signal, bounded: "progress" }
      ),
    /** Deletes file `file`, under the caller's key if any. */
    delete: async (
      resource: string,
      file: string,
      idempotencyKey?: string,
      signal?: AbortSignal
    ): Promise<void> => {
      await sendAgain(
        `${base(resource)}/files/${encodeURIComponent(file)}/delete`,
        {
          method: "POST",
          json: idempotencyKey === undefined ? {} : { idempotencyKey },
        },
        async (response) => {
          await response.arrayBuffer();
        },
        signal === undefined
          ? { bounded: true }
          : { cancel: signal, bounded: true }
      );
    },
  };
};

/** One App's screen's file channel. */
export type FileChannel = ReturnType<typeof fileChannel>;
