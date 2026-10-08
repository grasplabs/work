// Stream results: a step that returns a ReadableStream of bytes has it read
// to its end and kept in its run's own storage, before the step settles.
// The step's journaled value then names the attempt whose bytes were kept,
// how many there are, their SHA-256, and the SHA-256 of their chunks'
// digests (codec.ts, tag "Z"); the step, on its first run and on every
// replay, returns a fresh stream of them.
//
//   stream_chunks   the bytes, in chunks of `storedChunkBytes`, by step
//                   ordinal, attempt and index, each with its SHA-256
//
// Chunks are written as they are read, each in a write that first checks
// the attempt still holds the step: an attempt that was superseded stops
// reading, and writes nothing more. They are a step's result only once the
// step's commit names them, in the same write that checks they are all
// there; until then they are an upload in progress. An upload cut off (the
// process died, the object was evicted) is deleted when the step's next
// attempt is claimed, and one that failed or was superseded deletes its
// own.
//
// A reader is given only verified bytes: before the stream is handed out,
// the chunks' digests are checked against the digest list the commit
// named; each chunk is checked against its digest before it is enqueued;
// and the stream ends in an error, never a clean end, unless what it gave
// is the committed length and hash.
//
// Which streams are taken, and how the wrong ones fail, follow Cloudflare
// Workflows: a locked stream (by any reader, a BYOB one too) or one that
// can't be read is an InvalidStepReadableStreamError; chunks must be
// ArrayBuffers or typed arrays of at most 16 MiB. Named differences: a
// step's result may hold at most `maxBytes` (the host's
// `maxStreamOutputBytes`), and all of a run's stream results together at
// most `maxRunBytes` (`maxRunStreamBytes`), where Cloudflare's limit is
// the instance's whole storage.
import {
  brand,
  byteLengthOf,
  copyBytes,
  getterOf,
  invoke,
  isArrayBuffer,
  isDetached,
  methodOf,
  notOfKind,
  viewOf,
} from "./builtins.ts";
import type { StreamResult } from "./codec.ts";
import { errorRecord, namedError } from "./errors.ts";

/** The size of each stored chunk: well inside a SQLite value. */
const storedChunkBytes = 256 * 1024;

/** The largest chunk a stream may hand over, as Cloudflare Workflows'. */
const maxInputChunkBytes = 16 * 1024 * 1024;

/** The most a step's stream result may hold, unless the host says less. */
export const defaultMaxStreamBytes = 256 * 1024 * 1024;

/** The most all of a run's stream results may hold, unless the host says. */
export const defaultMaxRunStreamBytes = 1024 * 1024 * 1024;

const encoding = "identity";

/**
 * Why a step's stream can't be kept, from the stream itself or from what
 * it left in storage: the run fails with it. Anything else that fails
 * while a stream is kept is the engine's own, and isn't one of these.
 */
export class StreamResultError extends Error {
  constructor(name: string, message: string) {
    super(message);
    // One class, several names: the names are Cloudflare's.
    // oxlint-disable-next-line unicorn/custom-error-definition -- see above
    this.name = name;
  }
}

const unreadable = (): StreamResultError =>
  new StreamResultError(
    "InvalidStepReadableStreamError",
    "Step returned a ReadableStream that is already locked or otherwise unreadable. Return a fresh, unlocked ReadableStream from step.do()."
  );

const tooLarge = (message: string): StreamResultError =>
  new StreamResultError("StreamOutputStorageLimitError", message);

const streamLocked = getterOf(ReadableStream.prototype, "locked");
const getReader = methodOf(ReadableStream.prototype, "getReader");
const read = methodOf(ReadableStreamDefaultReader.prototype, "read");
const cancel = methodOf(ReadableStreamDefaultReader.prototype, "cancel");
const releaseLock = methodOf(
  ReadableStreamDefaultReader.prototype,
  "releaseLock"
);

/** Whether `value` is a ReadableStream, by its internal slots. */
export const isStream = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  brand(streamLocked, value) !== notOfKind;

export const createStreamChunks = (sql: SqlStorage): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS stream_chunks (
      ordinal INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      digest TEXT NOT NULL,
      PRIMARY KEY (ordinal, attempt, chunk_index)
    );
  `);
};

/** Deletes the chunks of one attempt, or of every attempt at the step. */
export const discardChunks = (
  sql: SqlStorage,
  ordinal: number,
  attempt?: number
): void => {
  const where =
    attempt === undefined
      ? { clause: "ordinal = ?", values: [ordinal] }
      : { clause: "ordinal = ? AND attempt = ?", values: [ordinal, attempt] };
  // The run's count of its stream bytes goes down by what goes, in the
  // same synchronous turn: one write, as every write of a turn is.
  sql.exec(
    `UPDATE run SET stream_bytes = stream_bytes - (SELECT COALESCE(SUM(LENGTH(bytes)), 0) FROM stream_chunks WHERE ${where.clause})`,
    ...where.values
  );
  sql.exec(`DELETE FROM stream_chunks WHERE ${where.clause}`, ...where.values);
};

interface ChunkSummary {
  chunks: number;
  length: number;
  first: number | null;
  last: number | null;
}

/** How many chunks of the attempt are stored, and their bytes in all. */
const summarise = (
  sql: SqlStorage,
  ordinal: number,
  attempt: number
): ChunkSummary =>
  sql
    .exec<{
      chunks: number;
      length: number;
      first: number | null;
      last: number | null;
    }>(
      "SELECT COUNT(*) AS chunks, COALESCE(SUM(LENGTH(bytes)), 0) AS length, MIN(chunk_index) AS first, MAX(chunk_index) AS last FROM stream_chunks WHERE ordinal = ? AND attempt = ?",
      ordinal,
      attempt
    )
    .one();

/**
 * Whether storage holds exactly the chunks `result` names: all of them,
 * indexed 0 to n - 1, with its length in bytes. Synchronous, so a commit
 * checks it in the same write that names them.
 */
export const isStoredWhole = (
  sql: SqlStorage,
  ordinal: number,
  result: StreamResult
): boolean => {
  const stored = summarise(sql, ordinal, result.attempt);
  return (
    stored.chunks === result.chunks &&
    stored.length === result.length &&
    (result.chunks === 0
      ? stored.first === null
      : stored.first === 0 && stored.last === result.chunks - 1)
  );
};

/** The bytes all of the run's stream chunks hold. */
/**
 * The bytes all of the run's stream chunks hold: the run's count, kept in
 * the writes that add and delete chunks, not a scan of them.
 */
const runStreamBytes = (sql: SqlStorage): number =>
  sql.exec<{ bytes: number }>("SELECT stream_bytes AS bytes FROM run").one()
    .bytes;

const hex = (digest: ArrayBuffer): string =>
  Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

const digestOf = async (bytes: Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", bytes));

const hexPattern = /^[\da-f]{64}$/u;

/** The digest of a list of chunk digests, in order: what a commit names. */
const listDigestOf = async (digests: string[]): Promise<string> => {
  const joined = new Uint8Array(digests.length * 32);
  for (const [index, digest] of digests.entries()) {
    for (let byte = 0; byte < 32; byte += 1) {
      joined[index * 32 + byte] = Number.parseInt(
        digest.slice(byte * 2, byte * 2 + 2),
        16
      );
    }
  }
  return await digestOf(joined);
};

/** An incremental SHA-256: bytes go in one write at a time. */
interface Hash {
  write: (bytes: Uint8Array) => Promise<void>;
  hex: () => Promise<string>;
  abandon: () => Promise<void>;
}

const hashing = (): Hash => {
  const stream = new crypto.DigestStream("SHA-256");
  const writer = stream.getWriter();
  return {
    write: async (bytes) => {
      await writer.write(bytes);
    },
    hex: async () => {
      await writer.close();
      return hex(await stream.digest);
    },
    abandon: async () => {
      // An abandoned hash rejects its digest and the writer's closed
      // promise; both are settled here, so neither is left unhandled.
      for (const settling of [
        async () => {
          await writer.abort();
        },
        async () => await stream.digest,
        async () => {
          await writer.closed;
        },
      ]) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one after the other, each may reject
          await settling();
        } catch {
          // Aborted, or closed or errored already: nothing to abandon.
        }
      }
    },
  };
};

const chunkRow = (
  sql: SqlStorage,
  ordinal: number,
  attempt: number,
  index: number
): ArrayBuffer | undefined => {
  const [row] = sql
    .exec<{ bytes: SqlStorageValue }>(
      "SELECT bytes FROM stream_chunks WHERE ordinal = ? AND attempt = ? AND chunk_index = ?",
      ordinal,
      attempt,
      index
    )
    .toArray();
  const bytes = row?.bytes;
  return typeof bytes === "object" && bytes !== null && isArrayBuffer(bytes)
    ? bytes
    : undefined;
};

/** Each stored chunk's digest, in order, or undefined if one is missing. */
const chunkDigests = (
  sql: SqlStorage,
  ordinal: number,
  attempt: number,
  chunks: number
): string[] | undefined => {
  const rows = sql
    .exec<{ chunk_index: number; digest: string }>(
      "SELECT chunk_index, digest FROM stream_chunks WHERE ordinal = ? AND attempt = ? ORDER BY chunk_index",
      ordinal,
      attempt
    )
    .toArray();
  const ordered =
    rows.length === chunks &&
    rows.every(
      (row, index) =>
        row.chunk_index === index &&
        typeof row.digest === "string" &&
        hexPattern.test(row.digest)
    );
  return ordered ? rows.map((row) => row.digest) : undefined;
};

const corruptStored = (ordinal: number): StreamResultError =>
  new StreamResultError(
    "WorkflowInternalError",
    `The stored stream output of step ${ordinal} is corrupt or incomplete`
  );

/**
 * Whether storage holds the chunks `result` names, with the digests it
 * names: what the stream is checked against before it is handed out.
 * Throws only what storage throws.
 */
const digestsVerified = async (
  sql: SqlStorage,
  ordinal: number,
  result: StreamResult
): Promise<string[] | undefined> => {
  if (!isStoredWhole(sql, ordinal, result)) {
    return undefined;
  }
  const digests = chunkDigests(sql, ordinal, result.attempt, result.chunks);
  if (digests === undefined) {
    return undefined;
  }
  return (await listDigestOf(digests)) === result.chunkDigest
    ? digests
    : undefined;
};

/** A replay's stream, or why its stored bytes can't be trusted. */
export type Replay =
  | { readonly stream: ReadableStream<Uint8Array> }
  | { readonly corrupt: Error };

/**
 * Who hears of a replayed stream's failures while it is read. An
 * activation passes one: then neither storage's own failure (`fault`) nor
 * bytes that aren't the committed ones (`corrupt`) ever reach the reader,
 * whose read just never settles, as every call of an activation that
 * stopped never settles. Without one (the host's own inspection), the
 * reader's stream errors.
 */
export interface ReplaySink {
  readonly fault: (error: unknown) => void;
  readonly corrupt: (error: Error) => void;
  /**
   * Whether the reader may no longer act (its activation is over, or the
   * attempt it reads in has ended): then a pull reads nothing, reports
   * nothing, and never settles.
   */
  readonly stopped: () => boolean;
}

/** What a pull of a stopped stream waits for: nothing, ever. */
const neverSettles = async (): Promise<never> =>
  await Promise.withResolvers<never>().promise;

/**
 * A fresh stream of a committed result's bytes, read from storage one
 * chunk at a time as it is pulled: each chunk is checked against its
 * committed digest before it is enqueued, and the stream ends cleanly
 * only when it gave exactly the committed length and hash. `corrupt` when
 * storage doesn't hold what the commit named. Storage's own failures
 * before the stream exists are thrown; those while it is read go to
 * `sink`, as do bytes found corrupt then.
 */
export const replayStream = async (
  sql: SqlStorage,
  ordinal: number,
  result: StreamResult,
  sink?: ReplaySink
): Promise<Replay> => {
  const digests = await digestsVerified(sql, ordinal, result);
  if (digests === undefined) {
    return {
      corrupt: namedError(
        "WorkflowInternalError",
        `The stored stream output of step ${ordinal} is corrupt or incomplete`
      ),
    };
  }
  const hash = hashing();
  let index = 0;
  let given = 0;
  /**
   * The reader cancelled the stream. A pull still out at an await (a
   * digest, the hash) finds this when it resumes and stops there: it
   * writes, enqueues and reports nothing, since the hash it would write
   * to is abandoned, and what failed then is no failure of the engine.
   */
  let cancelled = false;
  /** Ends the stream on a failure: to the sink, or as its error. */
  const stop = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    failure: { fault: unknown } | { corrupt: Error }
  ): Promise<void> => {
    await hash.abandon();
    if (cancelled) {
      return;
    }
    if (sink === undefined) {
      controller.error("fault" in failure ? failure.fault : failure.corrupt);
      return;
    }
    if ("fault" in failure) {
      sink.fault(failure.fault);
    } else {
      sink.corrupt(failure.corrupt);
    }
    await neverSettles();
  };
  /** The next chunk's bytes, verified; or why there are none. */
  const nextChunk = async (): Promise<
    | { bytes: Uint8Array }
    | { done: true }
    | { fault: unknown }
    | { corrupt: Error }
    | { cancelled: true }
  > => {
    try {
      if (index === result.chunks) {
        const sha256 = await hash.hex();
        if (cancelled) {
          return { cancelled };
        }
        return sha256 === result.sha256 && given === result.length
          ? { done: true }
          : { corrupt: corruptStored(ordinal) };
      }
      const stored = chunkRow(sql, ordinal, result.attempt, index);
      // A fresh array per chunk: what a reader does with it can't reach
      // storage or another reader.
      const bytes = stored === undefined ? undefined : new Uint8Array(stored);
      const digest = bytes === undefined ? undefined : await digestOf(bytes);
      if (cancelled) {
        return { cancelled };
      }
      if (
        bytes === undefined ||
        digest !== digests[index] ||
        given + bytes.byteLength > result.length
      ) {
        return { corrupt: corruptStored(ordinal) };
      }
      await hash.write(bytes);
      return cancelled ? { cancelled } : { bytes };
    } catch (error) {
      // Storage or hashing: the engine's own failure, not the stream's,
      // unless the reader cancelled while it was out (and so abandoned
      // the hash it failed on).
      return cancelled ? { cancelled } : { fault: error };
    }
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        if (sink?.stopped() === true) {
          await neverSettles();
        }
        const chunk = await nextChunk();
        if ("cancelled" in chunk) {
          return;
        }
        if (sink?.stopped() === true) {
          await hash.abandon();
          await neverSettles();
        }
        if ("done" in chunk) {
          controller.close();
          return;
        }
        if ("bytes" in chunk) {
          index += 1;
          given += chunk.bytes.byteLength;
          controller.enqueue(chunk.bytes);
          return;
        }
        await stop(controller, chunk);
      },
      cancel: async () => {
        cancelled = true;
        await hash.abandon();
      },
    },
    // Nothing is read ahead of what the reader asks for.
    { highWaterMark: 0 }
  );
  return { stream };
};

/** Storage holds what was read: the same chunks, digests and hash. */
const verifyStored = async (
  sql: SqlStorage,
  ordinal: number,
  result: StreamResult
): Promise<void> => {
  const digests = await digestsVerified(sql, ordinal, result);
  if (digests === undefined) {
    throw corruptStored(ordinal);
  }
  const hash = hashing();
  for (const [index, digest] of digests.entries()) {
    const stored = chunkRow(sql, ordinal, result.attempt, index);
    const bytes = stored === undefined ? undefined : new Uint8Array(stored);
    // oxlint-disable-next-line no-await-in-loop -- in order, one chunk at a time
    if (bytes === undefined || (await digestOf(bytes)) !== digest) {
      // oxlint-disable-next-line no-await-in-loop -- once, on the way out
      await hash.abandon();
      throw corruptStored(ordinal);
    }
    // oxlint-disable-next-line no-await-in-loop -- in order, one chunk at a time
    await hash.write(bytes);
  }
  if ((await hash.hex()) !== result.sha256) {
    throw corruptStored(ordinal);
  }
};

/** Bytes read from a source and not yet stored, in order. */
interface Pending {
  chunks: Uint8Array[];
  /** The bytes all of `chunks` hold. */
  bytes: number;
}

/**
 * Takes `size` bytes off the front of `pending`. The chunks it uses up are
 * walked by index and dropped together at the end, never one shift at a
 * time: a source of many tiny chunks costs linear time, not quadratic.
 */
const take = (pending: Pending, size: number): Uint8Array => {
  const out = new Uint8Array(size);
  let offset = 0;
  let first = 0;
  while (offset < size) {
    const head = pending.chunks[first];
    if (head === undefined) {
      throw new Error("fewer bytes pending than taken");
    }
    const wanted = size - offset;
    if (head.byteLength <= wanted) {
      out.set(head, offset);
      offset += head.byteLength;
      first += 1;
    } else {
      out.set(head.subarray(0, wanted), offset);
      pending.chunks[first] = head.subarray(wanted);
      offset += wanted;
    }
  }
  pending.chunks = pending.chunks.slice(first);
  pending.bytes -= size;
  return out;
};

const unsupportedChunk = (): StreamResultError =>
  new StreamResultError(
    "UnsupportedStreamChunkError",
    "Step returned a ReadableStream with unsupported chunk type. Only ArrayBuffer and TypedArray chunks are supported."
  );

/** A chunk whose buffer was transferred away, or can't be read at all. */
const unreadableChunk = (detail: string): StreamResultError =>
  new StreamResultError(
    "InvalidStepReadableStreamError",
    `Step returned a ReadableStream chunk that can't be read: ${detail}. Return chunks the stream no longer changes.`
  );

/** The buffer `value` holds its bytes in, when it is one we read. */
const bufferOf = (value: unknown): ArrayBuffer | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return isArrayBuffer(value) ? value : viewOf(value)?.buffer;
};

/**
 * A chunk's bytes, copied the moment it is read: its size read through the
 * built-in getters first, so an oversized chunk is never copied. Whatever
 * fails while a chunk is inspected or copied is the source's doing (its
 * buffer detached, say), never the engine's: an invalid stream.
 */
const chunkBytes = (value: unknown): Uint8Array => {
  let size: number | undefined;
  let bytes: Uint8Array | undefined;
  try {
    const buffer = bufferOf(value);
    if (buffer !== undefined && isDetached(buffer)) {
      throw unreadableChunk("its buffer is detached");
    }
    // A DataView is refused, as Cloudflare Workflows refuses it.
    size = byteLengthOf(value, { dataViews: false });
    if (size !== undefined && size <= maxInputChunkBytes) {
      bytes = copyBytes(value, { dataViews: false });
    }
  } catch (error) {
    if (error instanceof StreamResultError) {
      throw error;
    }
    throw unreadableChunk(errorRecord(error).message);
  }
  if (size === undefined) {
    throw unsupportedChunk();
  }
  if (size > maxInputChunkBytes) {
    throw new StreamResultError(
      "OversizedStreamChunkError",
      `Step returned a ReadableStream chunk larger than the maximum allowed size of ${maxInputChunkBytes} bytes. Return smaller chunks from step.do().`
    );
  }
  if (bytes === undefined) {
    throw unsupportedChunk();
  }
  return bytes;
};

interface ReadResult {
  done: boolean;
  value: unknown;
}

const stoppedReading = Symbol("stopped reading");

/**
 * Each read raced against the attempt's or activation's end, with one
 * subscription to that end for the whole upload, not one per read: a
 * source of many chunks leaves no reaction per chunk behind.
 */
interface Stop {
  race: (pendingRead: unknown) => Promise<unknown>;
}

const stopOf = (stopped: Promise<unknown>): Stop => {
  let isStopped = false;
  let current: ((value: typeof stoppedReading) => void) | undefined;
  const watching = async (): Promise<void> => {
    await stopped;
    isStopped = true;
    current?.(stoppedReading);
  };
  void watching();
  return {
    race: async (pendingRead) => {
      if (isStopped) {
        return stoppedReading;
      }
      const turn = Promise.withResolvers<unknown>();
      current = turn.resolve;
      const settling = async (): Promise<void> => {
        try {
          turn.resolve(await pendingRead);
        } catch (error) {
          turn.reject(error);
        }
      };
      void settling();
      try {
        return await turn.promise;
      } finally {
        current = undefined;
      }
    },
  };
};

/**
 * The next chunk, or stoppedReading once `stopped` settles first: a
 * superseded attempt stops at once, not at its source's next chunk.
 */
const readChunk = async (
  reader: object,
  stop: Stop
): Promise<ReadResult | typeof stoppedReading> => {
  let result: unknown;
  try {
    result = await stop.race(invoke(read, reader));
  } catch (error) {
    throw new StreamResultError(
      "InvalidStepReadableStreamError",
      // The source's own reason: read only through errorRecord, which is
      // total and bounded.
      `Failed to read from step ReadableStream output. ${errorRecord(error).message}`
    );
  }
  if (result === stoppedReading) {
    return stoppedReading;
  }
  // The runtime's own result object, not the stream source's.
  if (typeof result !== "object" || result === null) {
    throw unreadable();
  }
  return {
    done: Reflect.get(result, "done") === true,
    value: Reflect.get(result, "value"),
  };
};

/**
 * Lets go of the source: cancelled unless read to its end, without waiting
 * for the cancel, which is the source's own code and may never settle.
 */
const letGo = (reader: object, fullyRead: boolean): void => {
  if (!fullyRead) {
    const cancelling = async (): Promise<void> => {
      try {
        await invoke(
          cancel,
          reader,
          new Error("stream output consumption stopped before completion")
        );
      } catch {
        // The source errored already, or its cancel did.
      }
    };
    void cancelling();
  }
  try {
    invoke(releaseLock, reader);
  } catch {
    // Released already.
  }
};

/** Where an attempt's stream result goes, and while it may. */
export interface StreamTarget {
  readonly storage: DurableObjectStorage;
  readonly ordinal: number;
  readonly attempt: number;
  /**
   * Whether the attempt still holds its step: checked in the write that
   * stores each chunk. Throws what storage throws.
   */
  readonly holds: () => boolean;
  /** Settles when the activation stops: superseded, suspended, faulted. */
  readonly stopped: Promise<unknown>;
  readonly maxBytes: number;
  readonly maxRunBytes: number;
}

interface Upload {
  chunks: number;
  length: number;
  readonly digests: string[];
  readonly hash: Hash;
}

/** Stores one chunk if the attempt still holds its step. */
const store = async (
  target: StreamTarget,
  upload: Upload,
  bytes: Uint8Array
): Promise<boolean> => {
  const { storage, ordinal, attempt } = target;
  const digest = await digestOf(bytes);
  const stored = storage.transactionSync(() => {
    if (!target.holds()) {
      return false;
    }
    if (runStreamBytes(storage.sql) + bytes.byteLength > target.maxRunBytes) {
      throw tooLarge(
        `The run's stream outputs would hold more than the ${target.maxRunBytes} bytes a run's stream outputs may hold.`
      );
    }
    storage.sql.exec(
      "INSERT INTO stream_chunks (ordinal, attempt, chunk_index, bytes, digest) VALUES (?, ?, ?, ?, ?)",
      ordinal,
      attempt,
      upload.chunks,
      bytes,
      digest
    );
    storage.sql.exec(
      "UPDATE run SET stream_bytes = stream_bytes + ?",
      bytes.byteLength
    );
    return true;
  });
  if (stored) {
    upload.chunks += 1;
    upload.length += bytes.byteLength;
    upload.digests.push(digest);
    await upload.hash.write(bytes);
  }
  return stored;
};

/** Opens a reader on the stream; refused when it is locked. */
const open = (stream: object): object => {
  if (invoke(streamLocked, stream) === true) {
    throw unreadable();
  }
  let opened: unknown;
  try {
    opened = invoke(getReader, stream);
  } catch {
    throw unreadable();
  }
  if (typeof opened !== "object" || opened === null) {
    throw unreadable();
  }
  return opened;
};

/** Reads the source to its end into storage; false when superseded. */
const upload = async (
  reader: object,
  target: StreamTarget,
  state: Upload
): Promise<boolean> => {
  const stop = stopOf(target.stopped);
  const pending: Pending = { chunks: [], bytes: 0 };
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
    const next = await readChunk(reader, stop);
    if (next === stoppedReading) {
      return false;
    }
    if (next.done) {
      break;
    }
    const bytes = chunkBytes(next.value);
    // Counted on the bytes themselves, before they are kept.
    if (state.length + pending.bytes + bytes.byteLength > target.maxBytes) {
      throw tooLarge(
        `Step returned a ReadableStream of more than the ${target.maxBytes} bytes a step's stream output may hold.`
      );
    }
    if (bytes.byteLength > 0) {
      pending.chunks.push(bytes);
      pending.bytes += bytes.byteLength;
    }
    while (pending.bytes >= storedChunkBytes) {
      // oxlint-disable-next-line no-await-in-loop -- chunks are stored in order
      if (!(await store(target, state, take(pending, storedChunkBytes)))) {
        return false;
      }
    }
  }
  return await (pending.bytes === 0 ||
    store(target, state, take(pending, pending.bytes)));
};

/**
 * Reads `stream` to its end into storage, verifies what storage holds, and
 * returns what the step's commit names; undefined when the attempt was
 * superseded while it read. A stream that can't be kept, or storage that
 * doesn't hold what was written, throws a StreamResultError; anything
 * else thrown is the engine's own failure. Whatever it doesn't return, it
 * deletes, if storage lets it.
 */
export const persistStream = async (
  stream: object,
  target: StreamTarget
): Promise<StreamResult | undefined> => {
  const { storage, ordinal, attempt } = target;
  const reader = open(stream);
  const state: Upload = { chunks: 0, length: 0, digests: [], hash: hashing() };
  let fullyRead = false;
  let result: StreamResult | undefined;
  try {
    if (!(await upload(reader, target, state))) {
      return undefined;
    }
    fullyRead = true;
    const kept: StreamResult = {
      attempt,
      chunks: state.chunks,
      length: state.length,
      sha256: await state.hash.hex(),
      chunkDigest: await listDigestOf(state.digests),
      encoding,
    };
    await verifyStored(storage.sql, ordinal, kept);
    result = kept;
    return result;
  } finally {
    letGo(reader, fullyRead);
    if (result === undefined) {
      await state.hash.abandon();
      try {
        // A failed or superseded upload leaves nothing behind.
        storage.transactionSync(() => {
          discardChunks(storage.sql, ordinal, attempt);
        });
      } catch {
        // Storage that can't delete now: the step's next claim deletes
        // them. The error that got here is the one to report.
      }
    }
  }
};
