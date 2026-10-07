/**
 * Unpacks an npm tarball (a gzipped ustar archive) into a file tree held
 * in memory, refusing anything that isn't a plain tree of files under the
 * package's root. It runs in the package builder's isolate, which has no
 * network and no bindings, on bytes whose SHA-512 was checked first; it
 * never writes to a file system and never runs anything it reads.
 *
 * What a hostile tarball could try, and what stops it:
 *
 * - Climbing out of the package (`../`, an absolute path, a backslash or a
 *   drive letter, a PAX or GNU long name that says either): every path is
 *   checked after every header that could set it, and refused, as are
 *   control characters and bidirectional overrides that make a path read
 *   as another.
 * - Links (symbolic or hard), devices, FIFOs, sparse files (the `S` type
 *   and GNU's `GNU.sparse.*` PAX records) and entry types this doesn't
 *   know: refused, never followed or skipped.
 * - Two entries for one path, the later one hiding the first from whoever
 *   looked, compared as a case-insensitive, normalizing file system would
 *   (NFC, lower case): refused.
 * - An archive bomb: bytes are counted as gzip produces them, never taken
 *   from a header's size, and unpacking stops past the limit; entries are
 *   counted too, and PAX records are bounded.
 * - Headers that lie: a wrong checksum, a size in base-256, a truncated
 *   entry or a path that isn't UTF-8 is refused.
 *
 * Only the files `keep` names are held; the rest are read past.
 */
import { TarballRefusedError } from "./refused.ts";

/** How much one package may unpack to. */
export interface ExtractLimits {
  /** Bytes gzip may produce, the tar's own blocks included. */
  extractedBytes: number;
  /** Entries in the archive, of every type. */
  extractedEntries: number;
  /** Longest path, in bytes of UTF-8. */
  pathBytes: number;
  /** Most segments a path may have. */
  pathDepth: number;
}

/** A package's files, by path within it (`package/` taken off). */
export interface Extracted {
  files: Map<string, Uint8Array>;
  /** Every entry read, of every type. */
  entries: number;
  /** Bytes gzip produced. */
  bytes: number;
}

const block = 512;

/** An entry's size with the padding to the next block. */
const paddedSize = (size: number): number => Math.ceil(size / block) * block;

/** PAX records past this are refused: real ones are a few hundred bytes. */
const maxMetaBytes = 64 * 1024;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Cancels a stream, whatever state it is in: an errored one rejects. */
const cancelQuietly = async (
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> => {
  try {
    await reader.cancel();
  } catch {
    // Already errored or closed: the reason the caller has stands.
  }
};

/**
 * Reads exact amounts from the unpacked stream, counting every byte gzip
 * produces against the limit as it arrives. The chunks are kept as they
 * came and copied out once, so reading is linear in the bytes read.
 */
class Unpacked {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #limit: number;
  /** Chunks not read yet; the first from `#offset`. */
  readonly #chunks: Uint8Array[] = [];
  #offset = 0;
  #available = 0;
  bytes = 0;

  constructor(stream: ReadableStream<Uint8Array>, limit: number) {
    this.#reader = stream.getReader();
    this.#limit = limit;
  }

  /** Reads one more chunk; false at the end. */
  async #fill(): Promise<boolean> {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await this.#reader.read();
    } catch {
      throw new TarballRefusedError("it isn't a gzipped tarball");
    }
    if (chunk.done) {
      return false;
    }
    this.bytes += chunk.value.byteLength;
    if (this.bytes > this.#limit) {
      await cancelQuietly(this.#reader);
      throw new TarballRefusedError(
        `it unpacks to more than ${this.#limit} bytes`
      );
    }
    this.#chunks.push(chunk.value);
    this.#available += chunk.value.byteLength;
    return true;
  }

  /** Has `length` bytes ready, or returns false if the stream ends first. */
  async #ready(length: number): Promise<boolean> {
    while (this.#available < length) {
      // Each chunk decides whether there is enough yet.
      // oxlint-disable-next-line no-await-in-loop
      if (!(await this.#fill())) {
        return false;
      }
    }
    return true;
  }

  /** Moves past `length` ready bytes, copying them into `into` if given. */
  #consume(length: number, into?: Uint8Array): void {
    let done = 0;
    while (done < length) {
      const [first] = this.#chunks;
      if (first === undefined) {
        return;
      }
      const step = Math.min(first.byteLength - this.#offset, length - done);
      into?.set(first.subarray(this.#offset, this.#offset + step), done);
      done += step;
      this.#offset += step;
      if (this.#offset === first.byteLength) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    this.#available -= length;
  }

  /** Exactly `length` bytes, or undefined if the stream ended first. */
  async take(length: number): Promise<Uint8Array | undefined> {
    if (!(await this.#ready(length))) {
      return undefined;
    }
    const taken = new Uint8Array(length);
    this.#consume(length, taken);
    return taken;
  }

  /** Reads past `length` bytes without holding them. */
  async skip(length: number): Promise<void> {
    let left = length;
    while (left > 0) {
      // oxlint-disable-next-line no-await-in-loop
      if (this.#available === 0 && !(await this.#fill())) {
        throw new TarballRefusedError("an entry ends before its size");
      }
      const step = Math.min(this.#available, left);
      this.#consume(step);
      left -= step;
    }
  }

  async close(): Promise<void> {
    await cancelQuietly(this.#reader);
  }
}

/** A NUL-terminated field as text, refused if it isn't UTF-8. */
const field = (bytes: Uint8Array, at: number, length: number): string => {
  const raw = bytes.subarray(at, at + length);
  const end = raw.indexOf(0);
  try {
    return utf8.decode(end === -1 ? raw : raw.subarray(0, end));
  } catch {
    throw new TarballRefusedError("an entry's name isn't UTF-8");
  }
};

/** An octal number field; base-256 and anything else is refused. */
const octal = (bytes: Uint8Array, at: number, length: number): number => {
  // A first byte with its high bit set marks base-256.
  if ((bytes[at] ?? 0) >= 0x80) {
    throw new TarballRefusedError("an entry's size is in base-256");
  }
  const text = field(bytes, at, length).trim();
  if (!/^[0-7]*$/u.test(text)) {
    throw new TarballRefusedError(
      "an entry's header has a number that isn't octal"
    );
  }
  return text === "" ? 0 : Number.parseInt(text, 8);
};

/** Whether a header block is all zeros: the archive's end. */
const isEnd = (header: Uint8Array): boolean =>
  header.every((byte) => byte === 0);

/** Checks the header's checksum, as tar computes it. */
const checkSum = (header: Uint8Array): void => {
  const stored = octal(header, 148, 8);
  let sum = 0;
  for (const [index, byte] of header.entries()) {
    sum += index >= 148 && index < 156 ? 0x20 : byte;
  }
  if (sum !== stored) {
    throw new TarballRefusedError("an entry's header checksum is wrong");
  }
};

interface Header {
  path: string;
  size: number;
  type: string;
  linkname: string;
}

const readHeader = (header: Uint8Array): Header => {
  checkSum(header);
  const name = field(header, 0, 100);
  const magic = field(header, 257, 6);
  const prefix = magic.startsWith("ustar") ? field(header, 345, 155) : "";
  return {
    path: prefix === "" ? name : `${prefix}/${name}`,
    size: octal(header, 124, 12),
    type: String.fromCodePoint(header[156] ?? 0),
    linkname: field(header, 157, 100),
  };
};

/** A PAX record's length: decimal digits only. */
const paxLength = /^\d+$/u;

/**
 * PAX extended header records: `<length> <key>=<value>\n` each. GNU's
 * sparse-file records (`GNU.sparse.*`) are refused: a sparse file's bytes
 * aren't the entry's.
 */
const paxRecords = (content: Uint8Array): Map<string, string> => {
  let text: string;
  try {
    text = utf8.decode(content);
  } catch {
    throw new TarballRefusedError("a PAX header isn't UTF-8");
  }
  const records = new Map<string, string>();
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  while (at < bytes.byteLength) {
    const space = bytes.indexOf(0x20, at);
    const digits = space === -1 ? "" : utf8.decode(bytes.subarray(at, space));
    const length = Number(digits);
    if (!paxLength.test(digits) || length <= space - at + 1) {
      throw new TarballRefusedError("a PAX header can't be read");
    }
    const record = utf8.decode(bytes.subarray(space + 1, at + length));
    const equals = record.indexOf("=");
    if (equals === -1 || !record.endsWith("\n")) {
      throw new TarballRefusedError("a PAX header can't be read");
    }
    const key = record.slice(0, equals);
    if (key.startsWith("GNU.sparse.")) {
      throw new TarballRefusedError("it has a sparse file");
    }
    records.set(key, record.slice(equals + 1, -1));
    at += length;
  }
  return records;
};

/** Entry types that are files, and those only directories. */
const fileTypes = new Set(["0", "\0", "7"]);
const refusedTypes: Readonly<Record<string, string>> = {
  "1": "a hard link",
  "2": "a symbolic link",
  "3": "a character device",
  "4": "a block device",
  "6": "a FIFO",
  K: "a GNU long link name",
  S: "a sparse file",
  V: "a volume header",
  M: "a multi-volume entry",
};

const driveLetter = /^[A-Za-z]:/u;

/**
 * Whether `text` has a character that can make a path read as another:
 * a control character (C0, DEL or C1), or a bidirectional override or
 * isolate (U+202A–202E, U+2066–2069).
 */
const hasControl = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x20_2a && code <= 0x20_2e) ||
      (code >= 0x20_66 && code <= 0x20_69)
    ) {
      return true;
    }
  }
  return false;
};

/**
 * What two paths are the same file as on a case-insensitive file system
 * that normalizes Unicode (macOS's): compared so, no two entries may be.
 */
const sameFileKey = (path: string): string =>
  path.normalize("NFC").toLowerCase();

/**
 * The path of an entry within the package: its archive path without the
 * first segment (`package/`), as npm strips it. Undefined for the root
 * itself. Refused if it would leave the package's root, or is too long.
 */
const packagePath = (
  raw: string,
  limits: ExtractLimits
): string | undefined => {
  if (raw.startsWith("/") || raw.includes("\\") || driveLetter.test(raw)) {
    throw new TarballRefusedError(`an entry's path leaves the package: ${raw}`);
  }
  if (hasControl(raw)) {
    throw new TarballRefusedError(
      "an entry's path has control or bidirectional characters"
    );
  }
  const segments = raw.replace(/\/+$/u, "").split("/");
  const [, ...inside] = segments;
  if (
    inside.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new TarballRefusedError(`an entry's path leaves the package: ${raw}`);
  }
  if (
    new TextEncoder().encode(raw).byteLength > limits.pathBytes ||
    inside.length > limits.pathDepth
  ) {
    throw new TarballRefusedError("an entry's path is too long");
  }
  return inside.length === 0 ? undefined : inside.join("/");
};

/** What PAX and GNU long-name entries say of the entry after them. */
interface Pending {
  path?: string;
  size?: number;
}

/**
 * Reads a metadata entry's content (`x`, `g` or `L`) into what it says of
 * the next entry. A global header that sets a path is refused: it would
 * name every entry after it.
 */
const readMeta = async (
  unpacked: Unpacked,
  read: Header,
  pending: Pending
): Promise<Pending> => {
  if (read.size > maxMetaBytes) {
    throw new TarballRefusedError("an extended header is too large");
  }
  const content = await unpacked.take(paddedSize(read.size));
  if (content === undefined) {
    throw new TarballRefusedError("an entry ends before its size");
  }
  const meta = content.subarray(0, read.size);
  if (read.type === "L") {
    return { ...pending, path: field(meta, 0, meta.byteLength) };
  }
  const records = paxRecords(meta);
  if (read.type === "g") {
    if (records.has("path") || records.has("linkpath")) {
      throw new TarballRefusedError("a global PAX header names a path");
    }
    return pending;
  }
  const size = records.get("size");
  if (size !== undefined && !/^\d+$/u.test(size)) {
    throw new TarballRefusedError("a PAX header's size isn't a number");
  }
  return {
    path: records.get("path") ?? pending.path,
    size: size === undefined ? pending.size : Number(size),
  };
};

const metaTypes = new Set(["x", "g", "L"]);

/** The header of the next entry, or undefined at the archive's end. */
const nextHeader = async (unpacked: Unpacked): Promise<Header | undefined> => {
  const header = await unpacked.take(block);
  if (header === undefined) {
    throw new TarballRefusedError("the archive ends without its end marker");
  }
  if (isEnd(header)) {
    return undefined;
  }
  const read = readHeader(header);
  const refused = refusedTypes[read.type];
  if (refused !== undefined) {
    throw new TarballRefusedError(`it has ${refused}: ${read.path}`);
  }
  if (
    !(fileTypes.has(read.type) || read.type === "5" || metaTypes.has(read.type))
  ) {
    throw new TarballRefusedError(
      `it has an entry of a type that isn't a file or a directory: ${read.path}`
    );
  }
  return read;
};

/**
 * Unpacks `tarball`, keeping the files `keep` names. Throws
 * `TarballRefusedError` with the first reason it can't be a package.
 */
export const extractTarball = async (
  tarball: Uint8Array,
  limits: ExtractLimits,
  keep: (path: string) => boolean
): Promise<Extracted> => {
  const stream = new Blob([tarball])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const unpacked = new Unpacked(stream, limits.extractedBytes);
  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let entries = 0;
  let pending: Pending = {};
  try {
    // One entry at a time: each header says how much to read next.
    // oxlint-disable no-await-in-loop
    for (
      let read = await nextHeader(unpacked);
      read !== undefined;
      read = await nextHeader(unpacked)
    ) {
      entries += 1;
      if (entries > limits.extractedEntries) {
        throw new TarballRefusedError(
          `it has more than ${limits.extractedEntries} entries`
        );
      }
      if (metaTypes.has(read.type)) {
        pending = await readMeta(unpacked, read, pending);
        continue;
      }
      const path = packagePath(pending.path ?? read.path, limits);
      const size = pending.size ?? read.size;
      pending = {};
      if (read.type === "5" || path === undefined) {
        await unpacked.skip(paddedSize(size));
        continue;
      }
      if (seen.has(sameFileKey(path))) {
        throw new TarballRefusedError(`it has two entries for ${path}`);
      }
      seen.add(sameFileKey(path));
      if (keep(path)) {
        const content = await unpacked.take(paddedSize(size));
        if (content === undefined) {
          throw new TarballRefusedError("an entry ends before its size");
        }
        files.set(path, content.slice(0, size));
      } else {
        await unpacked.skip(paddedSize(size));
      }
    }
    // oxlint-enable no-await-in-loop
  } finally {
    await unpacked.close();
  }
  return { files, entries, bytes: unpacked.bytes };
};
