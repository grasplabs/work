import { describe, expect, it } from "vite-plus/test";

import { downloadNameOf, imagePixels } from "../src/app-file-limits.ts";

// The name a file is saved under (core's `Content-Disposition` and the
// page's download both take it from here): its checked type's extension,
// nothing invisible.

/** A right-to-left override, a zero-width space and a C1 control. */
const rightToLeft = String.fromCodePoint(0x20_2e);
const zeroWidth = String.fromCodePoint(0x20_0b);
const nextLine = String.fromCodePoint(0x85);

describe("a file's download name", () => {
  it("ends in an extension of the type its bytes were checked to be", () => {
    expect([
      downloadNameOf("Q3-report.html", "text/plain"),
      downloadNameOf("run.bat", "text/csv"),
      downloadNameOf("photo.svg", "image/png"),
      downloadNameOf("scan.PDF", "application/pdf"),
      downloadNameOf("holiday.jpeg", "image/jpeg"),
      downloadNameOf("notes", "text/plain"),
    ]).toStrictEqual([
      "Q3-report.html.txt",
      "run.bat.csv",
      "photo.svg.png",
      "scan.PDF",
      "holiday.jpeg",
      "notes.txt",
    ]);
  });

  it("drops bidi overrides, invisible formatting and controls", () => {
    expect([
      downloadNameOf(`invoice${rightToLeft}txt.exe`, "text/plain"),
      downloadNameOf(`a${zeroWidth}b${nextLine}c.png`, "image/png"),
      downloadNameOf(rightToLeft, "image/png"),
    ]).toStrictEqual(["invoicetxt.exe.txt", "abc.png", "file.png"]);
  });

  it("is always a name a header can encode, half a surrogate pair replaced", () => {
    const saved = downloadNameOf(
      `photo${String.fromCodePoint(0xd8_00)}.png`,
      "image/png"
    );
    expect(saved).toBe("photo\uFFFD.png");
    expect(encodeURIComponent(saved)).toBe("photo%EF%BF%BD.png");
  });
});

/** `values` as bytes, after `at` zero bytes. */
const bytesOf = (length: number, parts: [number, number[]][]): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (const [at, values] of parts) {
    bytes.set(values, at);
  }
  return bytes;
};

const ascii = (text: string): number[] =>
  Array.from(text, (letter) => letter.codePointAt(0) ?? 0);

describe("the pixels an image declares", () => {
  it("are read from the header of each previewable type, and none from one without", () => {
    const riff = (kind: string, rest: [number, number[]][]) =>
      bytesOf(32, [
        [0, ascii("RIFF")],
        [8, ascii("WEBP")],
        [12, ascii(kind)],
        ...rest,
      ]);
    expect([
      imagePixels(
        "image/png",
        bytesOf(24, [
          [12, ascii("IHDR")],
          [16, [0, 0, 0x01, 0x00]],
          [20, [0, 0, 0x00, 0x80]],
        ])
      ),
      imagePixels("image/gif", bytesOf(13, [[6, [0x00, 0x02, 0x00, 0x01]]])),
      // A 1 by 1 screen, a control extension, then an image of 4096 by
      // 2048 at (16, 8): the canvas grows to hold it.
      imagePixels(
        "image/gif",
        bytesOf(36, [
          [6, [1, 0, 1, 0, 0]],
          [13, [0x21, 0xf9, 0x04, 0, 0, 0, 0, 0x00]],
          [21, [0x2c, 16, 0, 8, 0, 0x00, 0x10, 0x00, 0x08, 0x00]],
          [31, [0x02, 0x01, 0x00, 0x00, 0x3b]],
        ])
      ),
      imagePixels(
        "image/jpeg",
        bytesOf(32, [
          [0, [0xff, 0xd8]],
          // An APP0 segment of 4 bytes, then a baseline start of frame.
          [2, [0xff, 0xe0, 0x00, 0x04, 0, 0]],
          [8, [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20]],
        ])
      ),
      imagePixels("image/webp", riff("VP8X", [[24, [0x3f, 0, 0, 0x1f, 0, 0]]])),
      imagePixels("image/webp", riff("VP8 ", [[26, [0x40, 0, 0x20, 0]]])),
      imagePixels(
        "image/webp",
        riff("VP8L", [[20, [0x2f, 0x0f, 0xc0, 0x03, 0]]])
      ),
      imagePixels("image/png", bytesOf(24, [])),
      imagePixels("image/jpeg", bytesOf(32, [[0, [0xff, 0xd8, 0xff, 0xda]]])),
      // Animated: an APNG of 10 frames, a WebP of two, a GIF of two.
      imagePixels(
        "image/png",
        bytesOf(50, [
          [8, [0, 0, 0, 13]],
          [12, ascii("IHDR")],
          [16, [0, 0, 0, 16, 0, 0, 0, 16]],
          [33, [0, 0, 0, 8]],
          [37, ascii("acTL")],
          [41, [0, 0, 0, 10]],
        ])
      ),
      imagePixels(
        "image/webp",
        bytesOf(60, [
          [0, ascii("RIFF")],
          [8, ascii("WEBP")],
          [12, ascii("VP8X")],
          [20, [0x02]],
          [24, [0x3f, 0, 0, 0x1f, 0, 0]],
          [30, ascii("ANIM")],
          [34, [6, 0, 0, 0]],
          [44, ascii("ANMF")],
          [52, ascii("ANMF")],
        ])
      ),
      imagePixels(
        "image/gif",
        bytesOf(38, [
          [6, [2, 0, 2, 0, 0]],
          [13, [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 0x02, 0x00]],
          [25, [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 0x02, 0x00]],
          [37, [0x3b]],
        ])
      ),
    ]).toStrictEqual([
      256 * 128,
      512 * 256,
      (16 + 4096) * (8 + 2048),
      32 * 16,
      64 * 32,
      64 * 32,
      16 * 16,
      undefined,
      undefined,
      16 * 16 * 10,
      64 * 32 * 2,
      2 * 2 * 2,
    ]);
  });
});
