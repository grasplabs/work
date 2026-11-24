// What an image is, told by its header alone, never by a name or a type
// anyone gives: a PNG, JPEG, WebP or GIF, and its size in pixels, as each
// format's specification puts them. Anything else (an SVG, HTML with an
// image's name) is none. Only the header is read: an image is served only
// as the type found here, with `nosniff` (security-headers.ts), so a
// polyglot (an image's header with HTML after it) runs nowhere.

/** What an image's header says it is: its type and size, in pixels. */
export interface ImageHeader {
  type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
}

/** Whether `bytes` hold `prefix` at `at`. */
const holds = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  bytes.length >= at + prefix.length &&
  prefix.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];

/** The low 14 bits of `value`, where WebP keeps a size. */
const low14 = (value: number): number => value % 0x40_00;

/** `bytes` as a view to read numbers from. */
const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** A 24-bit little-endian number at `at`. */
const u24le = (view: DataView, at: number): number =>
  view.getUint16(at, true) + view.getUint8(at + 2) * 0x1_00_00;

/**
 * A PNG's size, from its IHDR chunk, which the specification puts first,
 * right after the signature (PNG §5.6, §11.2.2): width, then height, each
 * a four-byte big-endian number.
 */
const pngHeader = (bytes: Uint8Array): ImageHeader | undefined => {
  if (
    !(
      holds(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
      holds(bytes, [0, 0, 0, 13, ...ascii("IHDR")], 8) &&
      bytes.length >= 24
    )
  ) {
    return undefined;
  }
  const view = viewOf(bytes);
  return {
    type: "image/png",
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
};

/**
 * A WebP's size (RFC 9649): "RIFF", its size, "WEBP", then its first
 * chunk, its FourCC and size, all within the RIFF size, and that within
 * the file. A simple lossy file's "VP8 " chunk starts with a key frame
 * (RFC 6386 §9.1: its frame tag's lowest bit clear, then the start code)
 * holding 14-bit sizes; a lossless one's "VP8L" holds each size less one
 * in 14 bits after its signature byte; an extended one's "VP8X" holds the
 * canvas's sizes less one in 24 bits.
 */
const webpHeader = (bytes: Uint8Array): ImageHeader | undefined => {
  if (
    !(
      holds(bytes, ascii("RIFF")) &&
      holds(bytes, ascii("WEBP"), 8) &&
      bytes.length >= 30
    )
  ) {
    return undefined;
  }
  const view = viewOf(bytes);
  const riffEnd = 8 + view.getUint32(4, true);
  const chunkEnd = 20 + view.getUint32(16, true);
  if (riffEnd > bytes.length || chunkEnd > riffEnd) {
    return undefined;
  }
  // Each header must lie within its chunk: VP8's sizes end at byte 30,
  // VP8L's at 25, and VP8X's chunk is ten bytes long.
  if (
    holds(bytes, ascii("VP8 "), 12) &&
    chunkEnd >= 30 &&
    view.getUint8(20) % 2 === 0 &&
    holds(bytes, [0x9d, 0x01, 0x2a], 23)
  ) {
    return {
      type: "image/webp",
      width: low14(view.getUint16(26, true)),
      height: low14(view.getUint16(28, true)),
    };
  }
  if (
    holds(bytes, ascii("VP8L"), 12) &&
    chunkEnd >= 25 &&
    holds(bytes, [0x2f], 20)
  ) {
    const sizes = view.getUint32(21, true);
    return {
      type: "image/webp",
      width: low14(sizes) + 1,
      height: low14(Math.floor(sizes / 0x40_00)) + 1,
    };
  }
  if (holds(bytes, ascii("VP8X"), 12) && chunkEnd === 30) {
    return {
      type: "image/webp",
      width: u24le(view, 24) + 1,
      height: u24le(view, 27) + 1,
    };
  }
  return undefined;
};

/**
 * JPEG's markers no segment before the first frame header may be (T.81
 * B.1.1.3, Table B.1): `FF 00`, which only stuffs entropy-coded data;
 * the reserved 0x02 to 0xBF; RST0 to RST7, which only sit in a scan; a
 * second SOI; and EOI and SOS, which end the file or start a scan before
 * any frame was declared. TEM (0x01) stands alone and is stepped over.
 */
const isRefusedBeforeFrame = (marker: number): boolean =>
  marker === 0x00 ||
  (marker >= 0x02 && marker <= 0xbf) ||
  (marker >= 0xd0 && marker <= 0xda);

/** JPEG's start-of-frame markers, SOF0 to SOF15 but DHT, JPG and DAC. */
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

/**
 * A JPEG's frame header at `at` (T.81 B.2.2): its length, which is 8 and
 * three bytes a component and fits in the file, the precision, then the
 * height and width as two-byte big-endian numbers, then the count of
 * components.
 */
const jpegFrame = (
  bytes: Uint8Array,
  view: DataView,
  at: number
): ImageHeader | undefined => {
  if (at + 10 > bytes.length) {
    return undefined;
  }
  const length = view.getUint16(at + 2);
  const components = view.getUint8(at + 9);
  return length === 8 + 3 * components && at + 2 + length <= bytes.length
    ? {
        type: "image/jpeg",
        height: view.getUint16(at + 5),
        width: view.getUint16(at + 7),
      }
    : undefined;
};

/**
 * A JPEG's size, from its frame header (ITU T.81 B.1.1, B.2.2): the
 * segments after SOI are walked by their lengths, each at least 2 and
 * within the file, to the first SOF. None when a marker that can't come
 * before it, or the end, comes first.
 */
const jpegHeader = (bytes: Uint8Array): ImageHeader | undefined => {
  if (!holds(bytes, [0xff, 0xd8])) {
    return undefined;
  }
  const view = viewOf(bytes);
  let at = 2;
  while (at + 2 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      return undefined;
    }
    const marker = view.getUint8(at + 1);
    if (marker === 0xff) {
      // A fill byte before the marker.
      at += 1;
    } else if (marker === 0x01) {
      at += 2;
    } else if (isRefusedBeforeFrame(marker)) {
      return undefined;
    } else if (isStartOfFrame(marker)) {
      return jpegFrame(bytes, view, at);
    } else {
      const length = at + 4 <= bytes.length ? view.getUint16(at + 2) : 0;
      if (length < 2 || at + 2 + length > bytes.length) {
        return undefined;
      }
      at += 2 + length;
    }
  }
  return undefined;
};

/**
 * A GIF's size, from its header and logical screen descriptor (GIF89a
 * §17, §18): "GIF87a" or "GIF89a", then the width and height as two-byte
 * little-endian numbers.
 */
const gifHeader = (bytes: Uint8Array): ImageHeader | undefined => {
  if (
    !(
      (holds(bytes, ascii("GIF87a")) || holds(bytes, ascii("GIF89a"))) &&
      bytes.length >= 13
    )
  ) {
    return undefined;
  }
  const view = viewOf(bytes);
  return {
    type: "image/gif",
    width: view.getUint16(6, true),
    height: view.getUint16(8, true),
  };
};

/** What `bytes` say they are, by their header; none for anything else. */
export const imageHeaderOf = (bytes: Uint8Array): ImageHeader | undefined =>
  pngHeader(bytes) ??
  jpegHeader(bytes) ??
  webpHeader(bytes) ??
  gifHeader(bytes);

/** The IEND chunk a PNG ends with: no data, then its CRC (PNG §11.2.5). */
const pngEnd = [0, 0, 0, 0, ...ascii("IEND"), 0xae, 0x42, 0x60, 0x82];

const endsOf: Record<ImageHeader["type"], (bytes: Uint8Array) => boolean> = {
  "image/png": (bytes) => holds(bytes, pngEnd, bytes.length - pngEnd.length),
  "image/gif": (bytes) => bytes.at(-1) === 0x3b,
  // Some cameras write bytes after the end marker: the last one counts.
  "image/jpeg": (bytes) => {
    for (let at = bytes.length - 2; at > 2; at -= 1) {
      if (bytes[at] === 0xff && bytes[at + 1] === 0xd9) {
        return true;
      }
    }
    return false;
  },
  // RIFF's length counts what follows its first eight bytes.
  "image/webp": (bytes) => viewOf(bytes).getUint32(4, true) + 8 <= bytes.length,
};

/**
 * Whether an image of `type` runs to its end in `bytes`, by its format's
 * end marker: a PNG's IEND chunk, a GIF's trailer (0x3B), a JPEG's end
 * of image (FF D9), a WebP's RIFF length. A header alone, or an upload
 * cut short, has none, and a model can't read it: kept, it would fail
 * every later turn that shows it. Nothing is decoded.
 */
export const imageEnded = (
  bytes: Uint8Array,
  type: ImageHeader["type"]
): boolean => endsOf[type](bytes);
