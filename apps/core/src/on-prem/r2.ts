/**
 * The on-prem profile's R2: core's R2 buckets (`FILES`, `AUDIT_ARCHIVE`) on
 * plain workerd, which has R2's client but no R2 service behind it.
 *
 * Core never sees this module. On Cloudflare its R2 bindings are real R2.
 * On-prem, the workerd config binds each of them as an `r2Bucket` binding
 * whose service is this Worker, with the bucket's binding name as its props
 * (scripts/workerd-r2.ts). So the R2 binding is the adapter interface, and
 * this is the on-prem implementation of it, answering workerd's R2 client
 * the way Miniflare's bucket object does for Wrangler's local dev and the
 * tests: `GET /` carries a head, get or list as JSON in `cf-r2-request`;
 * `PUT /` carries a put or delete as a JSON prefix of the body, sized by
 * `cf-r2-metadata-size`. An answer is the object's metadata as JSON, then
 * its body; a failure is a status and `cf-r2-error`.
 *
 * Each bucket is one SQLite Durable Object, named by its binding, holding
 * the index: a row per object with its metadata, which a list reads in key
 * order. The bodies are files on the local disk, in workerd's disk service
 * (`DISK`), so a bucket grows with the disk, not within one SQLite
 * database. Every put streams to a file of its own, under a new version:
 * the disk service writes it to a temporary file and moves it into place
 * only once all of it is in, and the index points at it only after that,
 * so a put that fails midway never replaces the object. A version is noted
 * in `files` before its file is written and forgotten once the file is
 * gone, so whatever a crash leaves behind is removed when the bucket
 * starts again.
 *
 * Not here: multipart upload, which core doesn't use; it is refused.
 */
import { DurableObject } from "cloudflare:workers";

/** What the workerd config gives this Worker. */
interface R2Env {
  /** One object per bucket. */
  BUCKETS: DurableObjectNamespace<R2Store>;
  /** Where the bodies are kept: a writable directory, workerd's disk service. */
  DISK: Fetcher;
}

/** Which bucket an R2 binding's client is: its binding name. */
interface R2Props {
  bucket: string;
}

const requestHeader = "cf-r2-request";
const metadataSizeHeader = "cf-r2-metadata-size";
const errorHeader = "cf-r2-error";

const maxKeyBytes = 1024;
const maxCustomMetadataBytes = 2048;
const maxListKeys = 1000;
const maxListKeysWithMetadata = 100;
const maxDeleteKeys = 1000;

const schema = `
CREATE TABLE IF NOT EXISTS objects (
  key TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  uploaded INTEGER NOT NULL,
  checksums TEXT NOT NULL,
  http_metadata TEXT NOT NULL,
  custom_metadata TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  version TEXT PRIMARY KEY
);`;

/** The hashes R2 knows, by the index its client numbers them with. */
const algorithms = [
  { field: "md5", name: "MD5" },
  { field: "sha1", name: "SHA-1" },
  { field: "sha256", name: "SHA-256" },
  { field: "sha384", name: "SHA-384" },
  { field: "sha512", name: "SHA-512" },
] as const;

type Algorithm = (typeof algorithms)[number]["field"];

interface ObjectRow extends Record<string, SqlStorageValue> {
  key: string;
  version: string;
  size: number;
  etag: string;
  uploaded: number;
  checksums: string;
  http_metadata: string;
  custom_metadata: string;
}

interface Etag {
  type: string;
  value?: string;
}

interface Conditional {
  etagMatches?: Etag[];
  etagDoesNotMatch?: Etag[];
  uploadedBefore?: number;
  uploadedAfter?: number;
  secondsGranularity?: boolean;
}

interface Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

/** A request, as workerd's R2 client sends it, read by `requestOf`. */
interface R2Request {
  method: string;
  object?: string;
  objects?: string[];
  range?: Range;
  rangeHeader?: string;
  onlyIf?: Conditional;
  httpFields: Record<string, unknown>;
  customFields: Record<string, string>;
  checksums: Partial<Record<Algorithm, string>>;
  limit?: number;
  prefix?: string;
  cursor?: string;
  delimiter?: string;
  startAfter?: string;
  include: number[];
}

/** How R2 answers a failure: its status, its code, and maybe an object. */
interface Failure {
  status: number;
  code: number;
  /** The object a failed precondition was tested on, which `get` returns. */
  object?: ObjectRow;
}

const failures = new WeakMap<Error, Failure>();

/** An error R2 answers as `failure`. */
const r2Error = (message: string, failure: Failure): Error => {
  const error = new Error(message);
  failures.set(error, failure);
  return error;
};

const noSuchKey = (): Error =>
  r2Error("The specified key does not exist.", { status: 404, code: 10_007 });
const preconditionFailed = (object?: ObjectRow): Error =>
  r2Error("At least one of the pre-conditions you specified did not hold.", {
    status: 412,
    code: 10_031,
    ...(object === undefined ? {} : { object }),
  });
const invalidArgument = (message: string): Error =>
  r2Error(message, { status: 400, code: 10_029 });
const invalidRange = (): Error =>
  r2Error("The requested range is not satisfiable", {
    status: 416,
    code: 10_039,
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const numberOf = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return value;
  }
  // Dates come as strings of milliseconds.
  return typeof value === "string" && value !== "" ? Number(value) : undefined;
};

const etagsOf = (value: unknown): Etag[] | undefined =>
  Array.isArray(value)
    ? value.filter(isRecord).map((etag) => ({
        type: stringOf(etag.type) ?? "strong",
        ...(typeof etag.value === "string" ? { value: etag.value } : {}),
      }))
    : undefined;

const stringRecordOf = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : {};

const conditionalOf = (value: unknown): Conditional | undefined =>
  isRecord(value)
    ? {
        etagMatches: etagsOf(value.etagMatches),
        etagDoesNotMatch: etagsOf(value.etagDoesNotMatch),
        uploadedBefore: numberOf(value.uploadedBefore),
        uploadedAfter: numberOf(value.uploadedAfter),
        secondsGranularity: value.secondsGranularity === true,
      }
    : undefined;

const rangeFieldsOf = (value: unknown): Range | undefined =>
  isRecord(value)
    ? {
        offset: numberOf(value.offset),
        length: numberOf(value.length),
        suffix: numberOf(value.suffix),
      }
    : undefined;

const base64Bytes = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0);

const toHex = (bytes: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The checksums a put came with, as hex: MD5 comes base64, the rest hex. */
const checksumsOf = (
  json: Record<string, unknown>
): Partial<Record<Algorithm, string>> => {
  const checksums: Partial<Record<Algorithm, string>> = {};
  for (const { field } of algorithms) {
    const value = stringOf(json[field]);
    if (value !== undefined) {
      checksums[field] =
        field === "md5" ? toHex(base64Bytes(value)) : value.toLowerCase();
    }
  }
  return checksums;
};

/** Reads a request of workerd's R2 client, keeping what this service uses. */
const requestOf = (json: unknown): R2Request => {
  if (!isRecord(json) || typeof json.method !== "string") {
    throw invalidArgument("Metadata missing or invalid");
  }
  const customFields = Array.isArray(json.customFields)
    ? json.customFields
        .filter(isRecord)
        .map(({ k, v }) => [stringOf(k), stringOf(v)] as const)
        .filter((entry): entry is readonly [string, string] =>
          entry.every((part) => part !== undefined)
        )
    : [];
  return {
    method: json.method,
    object: stringOf(json.object),
    objects: Array.isArray(json.objects)
      ? json.objects.filter((key) => typeof key === "string")
      : undefined,
    range: rangeFieldsOf(json.range),
    rangeHeader: stringOf(json.rangeHeader),
    onlyIf: conditionalOf(json.onlyIf),
    httpFields: isRecord(json.httpFields) ? json.httpFields : {},
    customFields: Object.fromEntries(customFields),
    checksums: checksumsOf(json),
    limit: numberOf(json.limit),
    prefix: stringOf(json.prefix),
    cursor: stringOf(json.cursor),
    delimiter: stringOf(json.delimiter),
    startAfter: stringOf(json.startAfter),
    include: Array.isArray(json.include)
      ? json.include.filter((field) => typeof field === "number")
      : [],
  };
};

const keyOf = (key: string | undefined): string => {
  if (key === undefined) {
    throw invalidArgument("Metadata missing or invalid");
  }
  if (new TextEncoder().encode(key).byteLength > maxKeyBytes) {
    throw r2Error("The specified object name is not valid.", {
      status: 400,
      code: 10_020,
    });
  }
  return key;
};

const includesEtag = (
  conditions: readonly Etag[],
  etag: string,
  comparison: "strong" | "weak"
): boolean =>
  conditions.some(
    (condition) =>
      condition.type === "wildcard" ||
      (condition.value === etag &&
        (condition.type === "strong" || comparison === "weak"))
  );

/** Whether `onlyIf` holds for the object as it is, or for none. */
const holds = (onlyIf: Conditional, row: ObjectRow | undefined): boolean => {
  if (row === undefined) {
    return (
      onlyIf.etagMatches === undefined && onlyIf.uploadedAfter === undefined
    );
  }
  const truncate = (ms: number): number =>
    onlyIf.secondsGranularity === true ? Math.floor(ms / 1000) * 1000 : ms;
  const uploaded = truncate(row.uploaded);
  const ifMatch =
    onlyIf.etagMatches === undefined ||
    includesEtag(onlyIf.etagMatches, row.etag, "strong");
  const ifNoneMatch =
    onlyIf.etagDoesNotMatch === undefined ||
    !includesEtag(onlyIf.etagDoesNotMatch, row.etag, "weak");
  const ifModifiedSince =
    onlyIf.uploadedAfter === undefined ||
    truncate(onlyIf.uploadedAfter) < uploaded ||
    (onlyIf.etagDoesNotMatch !== undefined && ifNoneMatch);
  const ifUnmodifiedSince =
    onlyIf.uploadedBefore === undefined ||
    uploaded < truncate(onlyIf.uploadedBefore) ||
    (onlyIf.etagMatches !== undefined && ifMatch);
  return ifMatch && ifNoneMatch && ifModifiedSince && ifUnmodifiedSince;
};

/** The first and last byte a get asks for. */
interface ByteRange {
  start: number;
  end: number;
}

const rangeHeaderPattern = /^bytes=(?<start>\d*)-(?<end>\d*)$/u;

/** A single-range `Range` header's bytes; none for any other header. */
const headerRange = (header: string, size: number): ByteRange | undefined => {
  const match = rangeHeaderPattern.exec(header.trim());
  const { start = "", end = "" } = match?.groups ?? {};
  if (match === null || (start === "" && end === "")) {
    return undefined;
  }
  if (start === "") {
    const suffix = Math.min(Number(end), size);
    if (suffix === 0) {
      throw invalidRange();
    }
    return { start: size - suffix, end: size - 1 };
  }
  const first = Number(start);
  const last = end === "" ? size - 1 : Math.min(Number(end), size - 1);
  if (first >= size || last < first) {
    throw invalidRange();
  }
  return { start: first, end: last };
};

/** An R2 range's bytes: an offset and length, or a suffix. */
const fieldsRange = (range: Range, size: number): ByteRange => {
  let { offset, length } = range;
  if (range.suffix !== undefined) {
    if (range.suffix <= 0) {
      throw invalidRange();
    }
    length = Math.min(range.suffix, size);
    offset = size - length;
  }
  offset ??= 0;
  length ??= size - offset;
  if (offset < 0 || offset > size || length <= 0) {
    throw invalidRange();
  }
  return { start: offset, end: Math.min(offset + length, size) - 1 };
};

/** The bytes of a `size`-byte object a get asks for. */
const rangeOf = (request: R2Request, size: number): ByteRange | undefined => {
  if (request.rangeHeader !== undefined) {
    return headerRange(request.rangeHeader, size);
  }
  return request.range === undefined
    ? undefined
    : fieldsRange(request.range, size);
};

/** An object's metadata, as workerd's R2 client reads it. */
const propertiesOf = (
  row: ObjectRow,
  range?: { offset: number; length: number }
) => {
  const checksums: unknown = JSON.parse(row.checksums);
  const httpFields: unknown = JSON.parse(row.http_metadata);
  const customMetadata: unknown = JSON.parse(row.custom_metadata);
  const stored = stringRecordOf(checksums);
  return {
    name: row.key,
    version: row.version,
    size: row.size,
    etag: row.etag,
    uploaded: row.uploaded,
    httpFields,
    customFields: Object.entries(stringRecordOf(customMetadata)).map(
      ([k, v]) => ({ k, v })
    ),
    range,
    checksums: Object.fromEntries(
      algorithms.map(({ field }, index) => [
        index,
        field === "md5" ? row.etag : stored[field],
      ])
    ),
  };
};

const metadataResponse = (metadata: unknown, status = 200): Response => {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  return new Response(bytes, {
    status,
    headers: {
      [metadataSizeHeader]: String(bytes.byteLength),
      "content-type": "application/json",
    },
  });
};

/** Answers what was thrown: as R2 would its failure, anything else as R2's internal error. */
const failureResponse = (error: unknown): Response => {
  const message = error instanceof Error ? error.message : String(error);
  const failure = (error instanceof Error
    ? failures.get(error)
    : undefined) ?? {
    status: 500,
    code: 10_001,
  };
  const headers = {
    [errorHeader]: JSON.stringify({
      message,
      version: 1,
      // The client reads it with a lowercase c.
      v4code: failure.code,
    }),
  };
  if (failure.object === undefined) {
    return new Response(null, { status: failure.status, headers });
  }
  const response = metadataResponse(
    propertiesOf(failure.object, { offset: 0, length: failure.object.size }),
    failure.status
  );
  response.headers.set(errorHeader, headers[errorHeader]);
  return response;
};

/**
 * Reads the first `size` bytes of `body`: the request's metadata. Resolves
 * with them and the rest of the body, the object's value.
 */
const readPrefix = async (
  body: ReadableStream<unknown>,
  size: number
): Promise<[Uint8Array, ReadableStream<Uint8Array>]> => {
  const reader = body.getReader();
  const read = async (): Promise<Uint8Array | undefined> => {
    const { done, value } = await reader.read();
    if (done) {
      return undefined;
    }
    if (!(value instanceof Uint8Array)) {
      throw invalidArgument("The body is not bytes");
    }
    return value;
  };
  const prefix = new Uint8Array(size);
  let filled = 0;
  let rest: Uint8Array | undefined;
  while (filled < size) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
    const value = await read();
    if (value === undefined) {
      throw invalidArgument("Metadata missing or invalid");
    }
    const taken = Math.min(size - filled, value.byteLength);
    prefix.set(value.subarray(0, taken), filled);
    filled += taken;
    if (taken < value.byteLength) {
      rest = value.subarray(taken);
    }
  }
  const value = new ReadableStream<Uint8Array>({
    start: (controller) => {
      if (rest !== undefined) {
        controller.enqueue(rest);
      }
    },
    pull: async (controller) => {
      const chunk = await read();
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
    cancel: async (reason) => {
      await reader.cancel(reason);
    },
  });
  return [prefix, value];
};

/**
 * `rest`, with `first` in front of it. `onEnd` is called once, when it
 * ends, fails or is cancelled.
 */
const prepended = (
  first: Uint8Array,
  rest: ReadableStream<Uint8Array> | null,
  onEnd: () => void
): ReadableStream<Uint8Array> => {
  const reader = rest?.getReader();
  let ended = false;
  const end = (): void => {
    if (!ended) {
      ended = true;
      onEnd();
    }
  };
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(first);
    },
    pull: async (controller) => {
      try {
        const next = await reader?.read();
        if (next === undefined || next.done) {
          end();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        end();
        controller.error(error);
      }
    },
    cancel: async (reason) => {
      end();
      await reader?.cancel(reason);
    },
  });
};

const newVersion = (): string =>
  toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);

const base64Encode = (text: string): string =>
  btoa(String.fromCodePoint(...new TextEncoder().encode(text)));

/**
 * A list cursor's key: what `base64Encode` made of it, or a 400. A byte
 * order mark it starts with is part of the key, so it's kept.
 */
const cursorKey = (cursor: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      base64Bytes(cursor)
    );
  } catch {
    throw invalidArgument("The cursor is not valid.");
  }
};

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Orders strings as SQLite does: by their UTF-8 bytes. */
const compareUtf8 = (a: string, b: string): number => {
  const [left, right] = [utf8(a), utf8(b)];
  const length = Math.min(left.byteLength, right.byteLength);
  for (let i = 0; i < length; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.byteLength - right.byteLength;
};

const maxCodePoint = 0x10_ff_ff;
const surrogates = { first: 0xd8_00, last: 0xdf_ff };

/**
 * The least string after every string that starts with `prefix`: its last
 * code point that can be, made one greater. UTF-8's byte order is code
 * point order, so keys from `prefix` up to it are exactly its keys. None
 * when no string comes after them all.
 */
const prefixEnd = (prefix: string): string | undefined => {
  const codePoints: number[] = [];
  for (const char of prefix) {
    codePoints.push(char.codePointAt(0) ?? 0);
  }
  while (codePoints.length > 0) {
    const last = (codePoints.pop() ?? 0) + 1;
    if (last <= maxCodePoint) {
      const next = last === surrogates.first ? surrogates.last + 1 : last;
      return String.fromCodePoint(...codePoints, next);
    }
  }
  return undefined;
};

/**
 * The keys a list reads, as a range of the primary key SQLite can search:
 * from the prefix, or after `startAfter` when that's later, up to the end
 * of the prefix.
 */
const keyRange = (
  prefix: string,
  startAfter: string | undefined
): { sql: string; bindings: string[] } => {
  const after =
    startAfter !== undefined && compareUtf8(startAfter, prefix) >= 0;
  const conditions = [after ? "key > ?" : "key >= ?"];
  const bindings = [after && startAfter !== undefined ? startAfter : prefix];
  const end = prefixEnd(prefix);
  if (end !== undefined) {
    conditions.push("key < ?");
    bindings.push(end);
  }
  return { sql: conditions.join(" AND "), bindings };
};

/** Where a list starts: after its cursor's key or `startAfter`, the later. */
const startAfterOf = (request: R2Request): string | undefined => {
  const { startAfter, cursor } = request;
  if (cursor === undefined) {
    return startAfter;
  }
  const after = cursorKey(cursor);
  return startAfter === undefined || compareUtf8(after, startAfter) > 0
    ? after
    : startAfter;
};

/** One entry of a list page: an object, or the keys under a delimited prefix. */
interface ListGroup {
  prefix?: string;
  row: ObjectRow;
  lastKey: string;
}

/** The delimited prefix `key` falls under, past the list's `prefix`. */
const delimitedPrefixOf = (
  key: string,
  prefix: string,
  delimiter: string | undefined
): string | undefined => {
  if (delimiter === undefined) {
    return undefined;
  }
  const at = key.indexOf(delimiter, prefix.length);
  return at === -1 ? undefined : key.slice(0, at + delimiter.length);
};

/**
 * What `answer` settles with: its response, or the error it failed with.
 * It never fails, so a request can be waited for after its body is sent.
 */
const settled = async (
  answer: Promise<Response>
): Promise<Response | Error> => {
  try {
    return await answer;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

/**
 * The error a put fails with when the disk service fails its file: with
 * the status it answered, or what its request threw.
 */
const diskFailed = (cause: unknown): Error => {
  let reason = String(cause);
  if (cause instanceof Response) {
    reason = `it answered ${cause.status}`;
  } else if (cause instanceof Error) {
    reason = cause.message;
  }
  return new Error(`The disk failed to store the object's body: ${reason}`);
};

/** One bucket: a SQLite Durable Object that answers R2's client. */
export class R2Store extends DurableObject<R2Env> {
  /** The versions being read now, with how many reads each. */
  readonly #reading = new Map<string, number>();
  /** Versions replaced or deleted while read: removed once no read is left. */
  readonly #released = new Set<string>();

  constructor(ctx: DurableObjectState, env: R2Env) {
    super(ctx, env);
    const { sql } = ctx.storage;
    sql.exec(schema);
    // The files of puts that stopped before they replaced their object, and
    // of objects replaced or deleted before their file was removed. Nothing
    // is being written or read yet, so every file no object names can go.
    void ctx.blockConcurrencyWhile(async () => {
      const left = sql
        .exec<{ version: string }>(
          "SELECT version FROM files WHERE version NOT IN (SELECT version FROM objects)"
        )
        .toArray();
      await Promise.all(
        left.map(async ({ version }) => {
          await this.#remove(version);
        })
      );
    });
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      if (request.method === "GET") {
        return await this.#read(
          requestOf(JSON.parse(request.headers.get(requestHeader) ?? "null"))
        );
      }
      if (request.method === "PUT") {
        return await this.#write(request);
      }
      return new Response(null, { status: 405 });
    } catch (error) {
      return failureResponse(error);
    }
  }

  #row(key: string): ObjectRow | undefined {
    return this.ctx.storage.sql
      .exec<ObjectRow>("SELECT * FROM objects WHERE key = ?", key)
      .toArray()[0];
  }

  /**
   * A version's directory in `DISK`, which holds its file. One directory a
   * version, so removing it also removes the temporary file a put cut off
   * by a crash left in it. The first two characters of the version spread
   * the directories over 256 others, so none grows too large to list.
   */
  #directory(version: string): string {
    return `https://disk/${this.ctx.id.toString()}/${version.slice(0, 2)}/${version}`;
  }

  async #read(request: R2Request): Promise<Response> {
    if (request.method === "list") {
      return metadataResponse(this.#list(request));
    }
    const key = keyOf(request.object);
    const row = this.#row(key);
    if (row === undefined) {
      throw noSuchKey();
    }
    if (request.method === "head") {
      return metadataResponse(
        propertiesOf(row, { offset: 0, length: row.size })
      );
    }
    if (request.method !== "get") {
      throw invalidArgument(`Unsupported method ${request.method}`);
    }
    if (request.onlyIf !== undefined && !holds(request.onlyIf, row)) {
      throw preconditionFailed(row);
    }
    const range = rangeOf(request, row.size) ?? {
      start: 0,
      end: row.size - 1,
    };
    const length = Math.max(range.end - range.start + 1, 0);
    const metadata = new TextEncoder().encode(
      JSON.stringify(propertiesOf(row, { offset: range.start, length }))
    );
    const { body, release } = await this.#open(
      row.version,
      range.start,
      length
    );
    // Its length known, so the client can read the metadata off its front.
    const framed = prepended(metadata, body, release).pipeThrough(
      new FixedLengthStream(metadata.byteLength + length)
    );
    return new Response(framed, {
      headers: {
        [metadataSizeHeader]: String(metadata.byteLength),
        "content-type": "application/json",
      },
    });
  }

  /**
   * A version's bytes from `start`, `length` of them, read from its file.
   * The file is kept until `release`, even if the object is replaced or
   * deleted meanwhile.
   */
  async #open(
    version: string,
    start: number,
    length: number
  ): Promise<{ body: ReadableStream<Uint8Array> | null; release: () => void }> {
    this.#reading.set(version, (this.#reading.get(version) ?? 0) + 1);
    const release = (): void => {
      const left = (this.#reading.get(version) ?? 1) - 1;
      if (left > 0) {
        this.#reading.set(version, left);
        return;
      }
      this.#reading.delete(version);
      if (this.#released.delete(version)) {
        this.ctx.waitUntil(this.#remove(version));
      }
    };
    // Nothing to read: no range of the file is empty.
    if (length === 0) {
      return { body: null, release };
    }
    try {
      const response = await this.env.DISK.fetch(
        `${this.#directory(version)}/body`,
        { headers: { range: `bytes=${start}-${start + length - 1}` } }
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("The object's body is missing.");
      }
      return { body: response.body, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Removes a version's file, or marks it to go once no read is left. */
  async #drop(version: string): Promise<void> {
    if (this.#reading.has(version)) {
      this.#released.add(version);
      return;
    }
    await this.#remove(version);
  }

  /**
   * Removes a version's directory, then forgets the version. It never
   * fails: one the disk service can't remove stays in `files`, for the
   * next start, so a put or delete that already committed is never
   * answered as failed.
   */
  async #remove(version: string): Promise<void> {
    const response = await settled(
      this.env.DISK.fetch(this.#directory(version), { method: "DELETE" })
    );
    if (
      response instanceof Response &&
      (response.ok || response.status === 404)
    ) {
      this.ctx.storage.sql.exec("DELETE FROM files WHERE version = ?", version);
    }
  }

  async #write(request: Request): Promise<Response> {
    const size = Number(request.headers.get(metadataSizeHeader) ?? Number.NaN);
    if (!Number.isInteger(size) || request.body === null) {
      throw invalidArgument("Metadata missing or invalid");
    }
    const [prefix, value] = await readPrefix(request.body, size);
    const metadata = requestOf(JSON.parse(new TextDecoder().decode(prefix)));
    if (metadata.method === "delete") {
      const keys = metadata.objects ?? [keyOf(metadata.object)];
      if (keys.length > maxDeleteKeys) {
        throw invalidArgument(
          `You can delete up to ${maxDeleteKeys} keys at once.`
        );
      }
      await this.#delete(keys.map(keyOf));
      return new Response();
    }
    if (metadata.method === "put") {
      // The client sends a body of known length: the metadata, then the value.
      const length =
        Number(request.headers.get("content-length") ?? Number.NaN) - size;
      return await this.#put(metadata, value, length);
    }
    throw r2Error(
      `${metadata.method} is not supported by the on-prem R2 service`,
      { status: 501, code: 10_001 }
    );
  }

  async #delete(keys: readonly string[]): Promise<void> {
    const { sql } = this.ctx.storage;
    const gone = this.ctx.storage.transactionSync(() =>
      keys.flatMap((key) =>
        sql
          .exec<{ version: string }>(
            "DELETE FROM objects WHERE key = ? RETURNING version",
            key
          )
          .toArray()
      )
    );
    await Promise.all(
      gone.map(async ({ version }) => {
        await this.#drop(version);
      })
    );
  }

  async #put(
    request: R2Request,
    value: ReadableStream<Uint8Array>,
    length: number
  ): Promise<Response> {
    const key = keyOf(request.object);
    const customMetadata = request.customFields;
    const metadataBytes = Object.entries(customMetadata).reduce(
      (total, [k, v]) => total + utf8(k).byteLength + utf8(v).byteLength,
      0
    );
    if (metadataBytes > maxCustomMetadataBytes) {
      throw r2Error(
        "Your metadata headers exceed the maximum allowed metadata size.",
        { status: 400, code: 10_012 }
      );
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      await value.cancel();
      throw invalidArgument("The value's length is not known.");
    }
    // Checked before the body is read, and again when it replaces the
    // object, as another put may have come in between.
    if (
      request.onlyIf !== undefined &&
      !holds(request.onlyIf, this.#row(key))
    ) {
      // Read to its end, unkept: workerd's client fails a put answered
      // before all of its body is read, where R2 answers with nothing.
      await value.pipeTo(new WritableStream());
      throw preconditionFailed();
    }
    const version = newVersion();
    const { sql } = this.ctx.storage;
    sql.exec("INSERT INTO files (version) VALUES (?)", version);
    let row: ObjectRow;
    let previous: ObjectRow | undefined;
    try {
      const { md5 = "", ...others } = await this.#store(
        request,
        version,
        value,
        length
      );
      row = {
        key,
        version,
        size: length,
        etag: md5,
        uploaded: Date.now(),
        checksums: JSON.stringify(others),
        http_metadata: JSON.stringify(request.httpFields),
        custom_metadata: JSON.stringify(customMetadata),
      };
      const stored = row;
      previous = this.ctx.storage.transactionSync(() => {
        const replaced = this.#row(key);
        if (request.onlyIf !== undefined && !holds(request.onlyIf, replaced)) {
          throw preconditionFailed();
        }
        sql.exec(
          `INSERT OR REPLACE INTO objects
            (key, version, size, etag, uploaded, checksums, http_metadata, custom_metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          stored.key,
          stored.version,
          stored.size,
          stored.etag,
          stored.uploaded,
          stored.checksums,
          stored.http_metadata,
          stored.custom_metadata
        );
        return replaced;
      });
    } catch (error) {
      // Read to its end, unkept, so the client gets the error rather than a
      // lost connection; settled either way, as the body may have failed.
      await Promise.allSettled([value.pipeTo(new WritableStream())]);
      await this.#remove(version);
      throw error;
    }
    if (previous !== undefined) {
      await this.#drop(previous.version);
    }
    return metadataResponse(propertiesOf(row));
  }

  /**
   * Streams a put's value into the file of `version`, `length` bytes of
   * it. Resolves with its checksums once the file is in place, having
   * checked them against those the put came with. A value that ends early
   * or fails aborts the file, which the disk service then never moves into
   * place.
   */
  async #store(
    request: R2Request,
    version: string,
    value: ReadableStream<Uint8Array>,
    length: number
  ): Promise<Partial<Record<Algorithm, string>>> {
    const wanted = algorithms.filter(
      ({ field }) => field === "md5" || request.checksums[field] !== undefined
    );
    const digests = wanted.map(({ field, name }) => ({
      field,
      stream: new crypto.DigestStream(name),
    }));
    const writers = digests.map(({ stream }) => stream.getWriter());
    // Of known length, so the disk service fails a file that ends early
    // rather than keep what came.
    const file = new FixedLengthStream(length);
    const stored = settled(
      this.env.DISK.fetch(`${this.#directory(version)}/body`, {
        method: "PUT",
        body: file.readable,
      })
    );
    const fileWriter = file.writable.getWriter();
    const all = [...writers, fileWriter];
    /**
     * Writes to the digests and the file. Only the file can fail, when the
     * disk service stops taking it: said as such, not as what it threw.
     */
    const toFile = async (
      step: (writer: (typeof all)[number]) => Promise<void>
    ): Promise<void> => {
      try {
        await Promise.all(all.map(step));
      } catch (error) {
        throw diskFailed(error);
      }
    };
    try {
      // Not cancelled on a failure: `#put` reads the rest before it answers.
      for await (const part of value.values({ preventCancel: true })) {
        await toFile(async (writer) => {
          await writer.write(part);
        });
      }
      await toFile(async (writer) => {
        await writer.close();
      });
      const answer = await stored;
      if (answer instanceof Error || !answer.ok) {
        throw diskFailed(answer);
      }
    } catch (error) {
      // Settled either way: the file may have failed already.
      await Promise.allSettled([fileWriter.abort(error)]);
      await stored;
      throw error;
    }
    const checksums: Partial<Record<Algorithm, string>> = {};
    for (const { field, stream } of digests) {
      // oxlint-disable-next-line no-await-in-loop -- each settled at close
      const computed = toHex(await stream.digest);
      const provided = request.checksums[field];
      if (provided !== undefined && provided !== computed) {
        throw r2Error(
          `The ${field} checksum you specified did not match what we received.`,
          { status: 400, code: 10_037 }
        );
      }
      checksums[field] = computed;
    }
    return checksums;
  }

  /**
   * A list page's entries in key order: up to `limit` of them, and whether
   * there are more. The prefix's keys are one range of the primary key,
   * read in order. A delimited prefix is one entry, so the read seeks past
   * all of its keys: a page reads about one row per entry, however many
   * objects each prefix holds.
   */
  #groups(
    prefix: string,
    startAfter: string | undefined,
    delimiter: string | undefined,
    limit: number
  ): { groups: ListGroup[]; truncated: boolean } {
    const { sql } = this.ctx.storage;
    const groups: ListGroup[] = [];
    let after = startAfter;
    for (;;) {
      const { sql: where, bindings } = keyRange(prefix, after);
      let seekTo: string | undefined;
      for (const row of sql.exec<ObjectRow>(
        `SELECT * FROM objects WHERE ${where} ORDER BY key`,
        ...bindings
      )) {
        if (groups.length === limit) {
          return { groups, truncated: true };
        }
        const delimited = delimitedPrefixOf(row.key, prefix, delimiter);
        if (delimited === undefined) {
          groups.push({ row, lastKey: row.key });
        } else {
          seekTo = this.#lastKeyUnder(delimited);
          groups.push({ prefix: delimited, row, lastKey: seekTo });
          break;
        }
      }
      if (seekTo === undefined) {
        return { groups, truncated: false };
      }
      after = seekTo;
    }
  }

  /** The last key starting with `prefix`: one seek of the primary key. */
  #lastKeyUnder(prefix: string): string {
    const end = prefixEnd(prefix);
    const [row] = this.ctx.storage.sql
      .exec<{ last: string }>(
        end === undefined
          ? "SELECT max(key) AS last FROM objects WHERE key >= ?"
          : "SELECT max(key) AS last FROM objects WHERE key >= ? AND key < ?",
        ...(end === undefined ? [prefix] : [prefix, end])
      )
      .toArray();
    return row?.last ?? prefix;
  }

  #list(request: R2Request) {
    const prefix = request.prefix ?? "";
    let limit = request.limit ?? maxListKeys;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxListKeys) {
      throw r2Error("MaxKeys params must be positive integer <= 1000.", {
        status: 400,
        code: 10_022,
      });
    }
    const { include } = request;
    if (include.length > 0) {
      limit = Math.min(limit, maxListKeysWithMetadata);
    }
    const startAfter = startAfterOf(request);
    const delimiter =
      request.delimiter === undefined || request.delimiter === ""
        ? undefined
        : request.delimiter;
    const { groups, truncated } = this.#groups(
      prefix,
      startAfter,
      delimiter,
      limit
    );
    const withHttp = include.includes(0);
    const withCustom = include.includes(1);
    const objects = groups
      .filter((group) => group.prefix === undefined)
      .map(({ row }) =>
        propertiesOf({
          ...row,
          http_metadata: withHttp ? row.http_metadata : "{}",
          custom_metadata: withCustom ? row.custom_metadata : "{}",
        })
      );
    const delimitedPrefixes = groups.flatMap((group) =>
      group.prefix === undefined ? [] : [group.prefix]
    );
    const last = groups.at(-1)?.lastKey;
    return {
      objects,
      truncated,
      ...(truncated && last !== undefined
        ? { cursor: base64Encode(last) }
        : {}),
      delimitedPrefixes,
    };
  }
}

/** Passes each R2 client's request to its bucket's object. */
export default {
  async fetch(request, env, ctx): Promise<Response> {
    return await env.BUCKETS.getByName(ctx.props.bucket).fetch(request);
  },
} satisfies ExportedHandler<R2Env, unknown, unknown, R2Props>;
