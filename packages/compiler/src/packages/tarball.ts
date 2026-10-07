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
 *   checked after every header that could set it, and refused.
 * - Links (symbolic or hard), devices, FIFOs, sparse files and entry
 *   types this doesn't know: refused, never followed or skipped.
 * - Two entries for one path, the later one hiding the first from whoever
 *   looked: refused.
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

/**
 * Reads exact amounts from the unpacked stream, counting every byte gzip
 * produces against the limit as it arrives.
 */
class Unpacked {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #limit: number;
  #buffer = new Uint8Array();
  #offset = 0;
  bytes = 0;

  constructor(stream: ReadableStream<Uint8Array>, limit: number) {
    this.#reader = stream.getReader();
    this.#limit = limit;
  }

  /** Reads one more chunk into the buffer; false at the end. */
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
      await this.#reader.cancel();
      throw new TarballRefusedError(
        `it unpacks to more than ${this.#limit} bytes`
      );
    }
    const left = this.#buffer.subarray(this.#offset);
    const next = new Uint8Array(left.byteLength + chunk.value.byteLength);
    next.set(left);
    next.set(chunk.value, left.byteLength);
    this.#buffer = next;
    this.#offset = 0;
    return true;
  }

  /** Exactly `length` bytes, or undefined if the stream ended first. */
  async take(length: number): Promise<Uint8Array | undefined> {
    while (this.#buffer.byteLength - this.#offset < length) {
      // Each chunk decides whether there is enough yet.
      // oxlint-disable-next-line no-await-in-loop
      if (!(await this.#fill())) {
        return undefined;
      }
    }
    const taken = this.#buffer.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return taken;
  }

  /** Reads past `length` bytes without holding them. */
  async skip(length: number): Promise<void> {
    let left = length;
    while (left > 0) {
      const available = this.#buffer.byteLength - this.#offset;
      if (available === 0) {
        // oxlint-disable-next-line no-await-in-loop
        if (!(await this.#fill())) {
          throw new TarballRefusedError("an entry ends before its size");
        }
        continue;
      }
      const step = Math.min(available, left);
      this.#offset += step;
      left -= step;
    }
  }

  async close(): Promise<void> {
    await this.#reader.cancel();
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

/** PAX extended header records: `<length> <key>=<value>\n` each. */
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
    const length = Number(utf8.decode(bytes.subarray(at, space)));
    if (space === -1 || !Number.isInteger(length) || length <= 0) {
      throw new TarballRefusedError("a PAX header can't be read");
    }
    const record = utf8.decode(bytes.subarray(space + 1, at + length));
    const equals = record.indexOf("=");
    if (equals === -1 || !record.endsWith("\n")) {
      throw new TarballRefusedError("a PAX header can't be read");
    }
    records.set(record.slice(0, equals), record.slice(equals + 1, -1));
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

/** Whether `text` has a control character (C0 or DEL), by UTF-16 unit. */
const hasControl = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
};

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
    throw new TarballRefusedError("an entry's path has control characters");
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
      if (seen.has(path)) {
        throw new TarballRefusedError(`it has two entries for ${path}`);
      }
      seen.add(path);
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
