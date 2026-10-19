import { platformLimits } from "./platform-limits.ts";

// The constants and message types of App files (app-files.ts), apart and
// with nothing but the platform's limits imported: the runtime in every
// screen's frame carries them, and can't bring Zod along.

/** Where core's file channel is: `<path>/<app>/<resource alias>/…`. */
export const appFilesPath = "/api/app-files";

/** The header a chunk carries its SHA-256 in, as lower-case hex. */
export const fileChunkHashHeader = "x-grasp-chunk-sha256";

/** The limits of App files (platform-limits.ts), by what they bound. */
export const fileLimits = {
  bytes: platformLimits.appFileBytes,
  chunkBytes: platformLimits.appFileChunkBytes,
  chunks: Math.ceil(
    platformLimits.appFileBytes / platformLimits.appFileChunkBytes
  ),
  previewBytes: platformLimits.appFilePreviewBytes,
  previewPixels: platformLimits.appFilePreviewPixels,
  openUploads: platformLimits.appFileOpenUploads,
  unattachedPerPerson: platformLimits.appFileUnattachedPerPerson,
  personBytes: platformLimits.appFilePersonBytes,
  storeBytes: platformLimits.appFileStoreBytes,
  chunkRequests: {
    burst: platformLimits.appFileChunkBurst,
    perMinute: platformLimits.appFileChunksPerMinute,
  },
  downloadMs: platformLimits.appFileDownloadMs,
  chunkSendMs: platformLimits.appFileChunkSendMs,
  uploadMs: platformLimits.appFileUploadMs,
  orphanMs: platformLimits.appFileOrphanMs,
  /** Longest file name, in characters. */
  nameLength: 200,
  /**
   * The most files resources one App declares: every mutation hands core
   * those that declare `attach` (`commitSchema`'s `attachable`), so an App
   * that registers can always mutate.
   */
  resources: 64,
  /**
   * Transfers the page runs for one frame at once: a screen that starts
   * more is refused, so one frame never floods the page.
   */
  frameTransfers: 4,
  /**
   * Calls of one frame that wait, in order, for one of its transfers to
   * end (a list of files each reading its own, say); past these a call is
   * refused (`file.busy`).
   */
  frameQueued: 64,
} as const;

/**
 * The types a file may be, and whether a screen may preview one in its
 * frame. Only types whose bytes show what they are (`typeOfBytes`), and
 * none a browser runs: no HTML, SVG or script, which would need an
 * isolated viewer the platform doesn't have. A preview is a raster image.
 */
export const fileTypes = {
  "image/png": { preview: true, extensions: ["png"] },
  "image/jpeg": { preview: true, extensions: ["jpg", "jpeg"] },
  "image/gif": { preview: true, extensions: ["gif"] },
  "image/webp": { preview: true, extensions: ["webp"] },
  "application/pdf": { preview: false, extensions: ["pdf"] },
  "text/plain": { preview: false, extensions: ["txt"] },
  "text/csv": { preview: false, extensions: ["csv"] },
} as const;

/**
 * Characters a file's name may not hold, as stored or as saved: controls
 * (C0 and C1), and Unicode format characters, which include the bidi
 * overrides and invisible characters that make `invoice<RLO>txt.exe` look
 * like a text file. Folders' separators too.
 */
// oxlint-disable-next-line no-control-regex -- control characters are what it finds
export const notInFileName = /[\u0000-\u001F\u007F-\u009F\p{Cf}/\\]/u;

const allNotInFileName = new RegExp(notInFileName.source, "gu");

/**
 * The name a file of `type` is saved under, from its stored `name`, the
 * one place both core's `Content-Disposition` and the page's download
 * take it from: without what `notInFileName` refuses, and ending in an
 * extension of the type its bytes were checked to be, appended when the
 * name's own isn't one, with half a surrogate pair replaced (U+FFFD) so
 * it always encodes. So a text file named `report.html` saves as
 * `report.html.txt` and opens as text, never as what its name claims.
 */
export const downloadNameOf = (name: string, type: FileType): string => {
  // Well-formed first (core stores no other, but a name read back is
  // never trusted to be), so it always encodes.
  const cleaned = name.toWellFormed().replaceAll(allNotInFileName, "").trim();
  const { extensions } = fileTypes[type];
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 ? cleaned.slice(dot + 1).toLowerCase() : "";
  const fits = extensions.some((known) => known === extension);
  if (fits) {
    return cleaned;
  }
  return `${cleaned.length === 0 ? "file" : cleaned}.${extensions[0]}`;
};

export type FileType = keyof typeof fileTypes;

/** Whether `type` is one a file may be. */
export const isFileType = (type: unknown): type is FileType =>
  typeof type === "string" && Object.hasOwn(fileTypes, type);

/** Whether a file of `type` and `size` bytes may be previewed in a frame. */
export const isPreviewable = (type: FileType, size: number): boolean =>
  fileTypes[type].preview && size <= fileLimits.previewBytes;

/** An image's declared width, height and frames. */
type Declared = readonly [number, number, number];

/** One byte's worth of place value. */
const byteBase = 0x1_00;

/** The values a WebP's 14-bit width or height holds. */
const webpSpan = 0x40_00;

/** The big-endian 16-bit number at `at`. */
const u16be = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) * byteBase + (bytes[at + 1] ?? 0);

/** The little-endian 16-bit number at `at`. */
const u16le = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) + (bytes[at + 1] ?? 0) * byteBase;

/** The little-endian 24-bit number at `at`. */
const u24le = (bytes: Uint8Array, at: number): number =>
  u16le(bytes, at) + (bytes[at + 2] ?? 0) * 0x1_00_00;

/** The little-endian 32-bit number at `at`. */
const u32le = (bytes: Uint8Array, at: number): number =>
  u16le(bytes, at) + u16le(bytes, at + 2) * 0x1_00_00;

/** The big-endian 32-bit number at `at`. */
const u32be = (bytes: Uint8Array, at: number): number =>
  u16be(bytes, at) * 0x1_00_00 + u16be(bytes, at + 2);

/** The size a JPEG declares in its first start-of-frame marker. */
const jpegSize = (bytes: Uint8Array): Declared | undefined => {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      return undefined;
    }
    const marker = bytes[at + 1] ?? 0;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // A start of frame (SOF0 to SOF15, but DHT, JPG and DAC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return [u16be(bytes, at + 7), u16be(bytes, at + 5), 1];
    }
    // Markers without a length, then the image data: no frame before it.
    if (
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) {
      return undefined;
    }
    at += 2 + u16be(bytes, at + 2);
  }
  return undefined;
};

/** The bytes of a GIF colour table whose packed field is `packed`. */
const gifTableBytes = (packed: number): number =>
  // The top bit says a table follows; the lowest three, its size.
  packed >= 0x80 ? 3 * 2 ** ((packed % 8) + 1) : 0;

/** Where the data sub-blocks starting at `at` end, past their terminator. */
const gifSubBlocksEnd = (bytes: Uint8Array, start: number): number => {
  let at = start;
  while (at < bytes.length) {
    const length = bytes[at] ?? 0;
    at += 1 + length;
    if (length === 0) {
      return at;
    }
  }
  return at;
};

/**
 * The canvas a GIF needs: its logical screen, grown to hold every image
 * it describes, as a browser's decoder grows it for an image larger than
 * the screen; and how many images it describes. Undefined for a block it
 * doesn't know.
 */
const gifSize = (bytes: Uint8Array): Declared | undefined => {
  if (bytes.length < 13) {
    return undefined;
  }
  let width = u16le(bytes, 6);
  let height = u16le(bytes, 8);
  let frames = 0;
  let at = 13 + gifTableBytes(bytes[10] ?? 0);
  while (at < bytes.length) {
    const block = bytes[at];
    // The trailer: every image seen.
    if (block === 0x3b) {
      break;
    }
    if (block === 0x21) {
      at = gifSubBlocksEnd(bytes, at + 2);
      continue;
    }
    if (block !== 0x2c) {
      return undefined;
    }
    frames += 1;
    width = Math.max(width, u16le(bytes, at + 1) + u16le(bytes, at + 5));
    height = Math.max(height, u16le(bytes, at + 3) + u16le(bytes, at + 7));
    // Past its descriptor, local colour table and LZW code size: its data.
    at = gifSubBlocksEnd(bytes, at + 11 + gifTableBytes(bytes[at + 9] ?? 0));
  }
  return [width, height, Math.max(frames, 1)];
};

/** The four letters at `at`. */
const fourcc = (bytes: Uint8Array, at: number): string =>
  String.fromCodePoint(...bytes.subarray(at, at + 4));

/** The frames an animated WebP holds: its `ANMF` chunks, one or more. */
const webpFrames = (bytes: Uint8Array): number => {
  let frames = 0;
  // The chunks after VP8X's: each its kind, its size, its data, padded.
  let at = 30;
  while (at + 8 <= bytes.length) {
    if (fourcc(bytes, at) === "ANMF") {
      frames += 1;
    }
    const size = u32le(bytes, at + 4);
    at += 8 + size + (size % 2);
  }
  return Math.max(frames, 1);
};

/** The canvas a WebP declares, by its first chunk's kind, and its frames. */
const webpSize = (bytes: Uint8Array): Declared | undefined => {
  const kind = fourcc(bytes, 12);
  if (kind === "VP8X" && bytes.length >= 30) {
    // Its flags' second bit: animated, each frame decoded in turn.
    const animated = (bytes[20] ?? 0) % 4 >= 2;
    return [
      u24le(bytes, 24) + 1,
      u24le(bytes, 27) + 1,
      animated ? webpFrames(bytes) : 1,
    ];
  }
  if (kind === "VP8 " && bytes.length >= 30) {
    // 14 bits each, the top two a scale the canvas doesn't count.
    return [u16le(bytes, 26) % webpSpan, u16le(bytes, 28) % webpSpan, 1];
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    // Width and height less one, 14 bits each, from the 32 bits at 21.
    const bits = u16le(bytes, 21) + u16le(bytes, 23) * byteBase * byteBase;
    return [
      (bits % webpSpan) + 1,
      (Math.floor(bits / webpSpan) % webpSpan) + 1,
      1,
    ];
  }
  return undefined;
};

/**
 * The size a PNG declares in its header, and its frames: those an
 * animated PNG's `acTL` chunk, before its image data, says it holds.
 */
const pngSize = (bytes: Uint8Array): Declared | undefined => {
  if (bytes.length < 24 || fourcc(bytes, 12) !== "IHDR") {
    return undefined;
  }
  let frames = 1;
  // The chunks: each its length, its kind, its data and a checksum.
  let at = 8;
  while (at + 8 <= bytes.length) {
    const kind = fourcc(bytes, at + 4);
    if (kind === "IDAT") {
      break;
    }
    if (kind === "acTL") {
      frames = Math.max(u32be(bytes, at + 8), 1);
      break;
    }
    at += 12 + u32be(bytes, at);
  }
  return [u32be(bytes, 16), u32be(bytes, 20), frames];
};

/**
 * The pixels decoding an image of `type` would take, as its file
 * (`bytes`) declares them: its canvas, once for each frame an animated
 * one holds. Undefined when it declares none that can be read. Whatever
 * its size in bytes.
 */
export const imagePixels = (
  type: FileType,
  bytes: Uint8Array
): number | undefined => {
  let size: Declared | undefined;
  switch (type) {
    case "image/png": {
      size = pngSize(bytes);
      break;
    }
    case "image/gif": {
      size = gifSize(bytes);
      break;
    }
    case "image/jpeg": {
      size = jpegSize(bytes);
      break;
    }
    case "image/webp": {
      size = webpSize(bytes);
      break;
    }
    case "application/pdf":
    case "text/csv":
    case "text/plain": {
      size = undefined;
      break;
    }
    default: {
      size = undefined;
    }
  }
  return size === undefined ? undefined : size[0] * size[1] * size[2];
};

/**
 * Whether an image of `type`, whose file starts with `bytes`, declares
 * few enough pixels to be previewed: one that declares none readable has
 * no preview.
 */
export const fitsPreview = (type: FileType, bytes: Uint8Array): boolean => {
  const pixels = imagePixels(type, bytes);
  return (
    pixels !== undefined && pixels > 0 && pixels <= fileLimits.previewPixels
  );
};

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((byte, at) => bytes[at] === byte);

const ascii = (text: string): number[] =>
  Array.from(text, (character) => character.codePointAt(0) ?? 0);

/** The binary types, by the bytes they start with. */
const signatures: readonly (readonly [
  FileType,
  (bytes: Uint8Array) => boolean,
])[] = [
  [
    "image/png",
    (bytes) =>
      startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ],
  ["image/jpeg", (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff])],
  [
    "image/gif",
    (bytes) =>
      startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a")),
  ],
  [
    "image/webp",
    (bytes) =>
      startsWith(bytes, ascii("RIFF")) &&
      startsWith(bytes.subarray(8), ascii("WEBP")),
  ],
  ["application/pdf", (bytes) => startsWith(bytes, ascii("%PDF-"))],
];

/**
 * The type a file whose first bytes are `head` is, given the type it was
 * declared as: the declared one if the bytes show it, `undefined` if they
 * don't. A binary type is known by its signature; text has none, so text
 * is anything that starts with none of them (whether all of it is UTF-8
 * is `TextCheck`'s to say, as the rest arrives). The declared label alone
 * is never trusted (spec 10.7.5).
 */
export const typeOfBytes = (
  head: Uint8Array,
  declared: FileType
): FileType | undefined => {
  const signed = signatures.find(([, matches]) => matches(head))?.[0];
  if (declared === "text/plain" || declared === "text/csv") {
    return signed === undefined ? declared : undefined;
  }
  return signed === declared ? declared : undefined;
};

/**
 * Checks that a text file is UTF-8 with no NUL, chunk by chunk as its
 * bytes arrive in order: `add` each, then `end`. Either answers false
 * once the bytes aren't text.
 */
export class TextCheck {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #text = true;

  add(bytes: Uint8Array): boolean {
    if (!this.#text) {
      return false;
    }
    try {
      this.#text = !this.#decoder
        .decode(bytes, { stream: true })
        .includes("\0");
    } catch {
      this.#text = false;
    }
    return this.#text;
  }

  end(): boolean {
    if (!this.#text) {
      return false;
    }
    try {
      this.#decoder.decode();
    } catch {
      this.#text = false;
    }
    return this.#text;
  }
}

/** How many chunks a file of `size` bytes is sent in. */
export const chunksOf = (size: number): number =>
  Math.max(1, Math.ceil(size / fileLimits.chunkBytes));

/** A file as its reader sees it: never its bytes, nor where they are. */
export interface FileDescription {
  readonly id: string;
  readonly name: string;
  readonly mimeType: FileType;
  readonly size: number;
}

/** A failure, as the page answers it to the frame. */
export interface FileFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * What a frame sends over its file port: an upload of a file it picked
 * (its `Blob`, handed over, never read in the frame), its cancellation, a
 * caller that stopped waiting, and reads, downloads and deletions of
 * files by ID. Each names its call, so the page's answers find it.
 * Untrusted: the page reads each against `frameFileMessageSchema`
 * (app-files.ts) before anything else.
 */
export type FrameFileMessage =
  | {
      readonly type: "upload";
      readonly call: number;
      readonly resource: string;
      readonly file: Blob;
      readonly name: string;
    }
  | { readonly type: "cancel" | "stop"; readonly call: number }
  | {
      readonly type: "read" | "download";
      readonly call: number;
      readonly resource: string;
      readonly file: string;
    }
  | {
      readonly type: "delete";
      readonly call: number;
      readonly resource: string;
      readonly file: string;
      readonly idempotencyKey?: string;
    };

/**
 * What the page answers over the file port: an upload's progress, and
 * each call's outcome. A read's answer carries the file's preview, a
 * `Blob` the frame shows through a URL of its own, or none. Trusted by
 * the frame: the page is what the frame's whole session goes through.
 */
export type PageFileMessage =
  | {
      readonly type: "progress";
      readonly call: number;
      readonly phase: "uploading" | "verifying";
      readonly bytesUploaded: number;
      readonly bytesTotal: number;
    }
  | { readonly type: "uploaded"; readonly call: number; readonly file: string }
  | {
      readonly type: "read";
      readonly call: number;
      readonly description: FileDescription;
      readonly preview: Blob | null;
    }
  | { readonly type: "done"; readonly call: number }
  | {
      readonly type: "failed";
      readonly call: number;
      readonly error: FileFailure;
    };
