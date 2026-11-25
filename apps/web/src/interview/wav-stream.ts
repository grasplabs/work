// A line's audio as it arrives (speech.ts): a WAV file of plain samples,
// in pieces cut anywhere, read into samples the page can play at once.
// The file's own header says how its samples are written (the RIFF/WAVE
// format: a `fmt ` chunk, then the `data` chunk the samples are in), so
// nothing here assumes what the voice sends. Pure, so it is tested without
// a browser.

/** Samples ready to play: one channel, each between -1 and 1. */
export interface Samples {
  samples: Float32Array<ArrayBuffer>;
  /** Samples a second. */
  rate: number;
}

/** How a file's samples are written, from its `fmt ` chunk. */
interface Format {
  rate: number;
  channels: number;
  /** Bytes of one sample of one channel. */
  width: number;
  read: (view: DataView, at: number) => number;
}

/** WAV's format tags for whole numbers and for floating point. */
const pcmTag = 1;
const floatTag = 3;

/** A `fmt ` chunk has at least this much: tag, channels, rate, bytes a second, block size, bits. */
const formatBytes = 16;
/** A chunk's name and size. */
const chunkHead = 8;
/** `RIFF`, the file's size, `WAVE`. */
const fileHead = 12;

const tagAt = (bytes: Uint8Array, at: number): string =>
  String.fromCodePoint(...bytes.subarray(at, at + 4));

/** How samples of `bits` bits are read, or none for a way of writing them this doesn't play. */
const readerOf = (tag: number, bits: number): Format["read"] | undefined => {
  if (tag === pcmTag && bits === 16) {
    return (view, at) => view.getInt16(at, true) / 32_768;
  }
  if (tag === pcmTag && bits === 32) {
    return (view, at) => view.getInt32(at, true) / 2_147_483_648;
  }
  if (tag === floatTag && bits === 32) {
    return (view, at) => view.getFloat32(at, true);
  }
  return undefined;
};

const formatOf = (view: DataView, at: number): Format | undefined => {
  const channels = view.getUint16(at + 2, true);
  const rate = view.getUint32(at + 4, true);
  const bits = view.getUint16(at + 14, true);
  const read = readerOf(view.getUint16(at, true), bits);
  return read === undefined || channels === 0 || rate === 0
    ? undefined
    : { rate, channels, width: bits / 8, read };
};

/**
 * Where a file's samples start, and how they are written, as far as
 * `bytes` tells: `wait` while its header isn't all there yet, `unknown`
 * for bytes that are no such file or samples this doesn't play.
 */
const headOf = (
  bytes: Uint8Array
): { format: Format; from: number } | "wait" | "unknown" => {
  if (bytes.byteLength < fileHead) {
    return "wait";
  }
  if (tagAt(bytes, 0) !== "RIFF" || tagAt(bytes, 8) !== "WAVE") {
    return "unknown";
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: Format | undefined = undefined;
  for (let at = fileHead; ;) {
    if (at + chunkHead > bytes.byteLength) {
      return "wait";
    }
    const tag = tagAt(bytes, at);
    const size = view.getUint32(at + 4, true);
    if (tag === "data") {
      return format === undefined
        ? "unknown"
        : { format, from: at + chunkHead };
    }
    if (tag === "fmt ") {
      if (size < formatBytes) {
        return "unknown";
      }
      if (at + chunkHead + formatBytes > bytes.byteLength) {
        return "wait";
      }
      format = formatOf(view, at + chunkHead);
      if (format === undefined) {
        return "unknown";
      }
    }
    // A chunk of an odd size is followed by one byte of padding.
    at += chunkHead + size + (size % 2);
  }
};

const joined = (
  before: Uint8Array,
  more: Uint8Array
): Uint8Array<ArrayBuffer> => {
  const whole = new Uint8Array(before.byteLength + more.byteLength);
  whole.set(before, 0);
  whole.set(more, before.byteLength);
  return whole;
};

/** The first channel of whole frames in `bytes`, and the bytes of a frame cut short after them. */
const framesOf = (
  bytes: Uint8Array<ArrayBuffer>,
  { channels, width, read, rate }: Format
): { heard: Samples | null; rest: Uint8Array<ArrayBuffer> } => {
  const frame = channels * width;
  const count = Math.floor(bytes.byteLength / frame);
  if (count === 0) {
    return { heard: null, rest: bytes };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(count);
  for (let at = 0; at < count; at += 1) {
    samples[at] = read(view, at * frame);
  }
  return { heard: { samples, rate }, rest: bytes.slice(count * frame) };
};

/**
 * Reads a WAV file as its pieces come, in order: each call gives the
 * samples that piece completes, none while the header or a sample is
 * still cut short, and `unknown` once the bytes turn out to be no file of
 * plain samples (whoever plays it then needs the whole file).
 */
export const wavReader = (): ((
  piece: Uint8Array
) => Samples | null | "unknown") => {
  let format: Format | "unknown" | null = null;
  let unread: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  const read = (piece: Uint8Array): Samples | null | "unknown" => {
    if (format === "unknown") {
      return "unknown";
    }
    unread = joined(unread, piece);
    if (format === null) {
      const head = headOf(unread);
      if (head === "wait") {
        return null;
      }
      if (head === "unknown") {
        format = "unknown";
        return "unknown";
      }
      ({ format } = head);
      unread = unread.slice(head.from);
    }
    const { heard, rest } = framesOf(unread, format);
    unread = rest;
    return heard;
  };
  return read;
};
