import { describe, expect, it } from "vite-plus/test";

import { wavReader } from "./wav-stream.ts";

// A line's audio comes as a WAV file in pieces, cut anywhere: what is
// played is the same samples however it was cut.

const name = (view: DataView, at: number, tag: string): void => {
  for (let letter = 0; letter < 4; letter += 1) {
    view.setUint8(at + letter, tag.codePointAt(letter) ?? 0);
  }
};

/** A WAV file of 16-bit samples at 24 kHz, with a chunk of another kind before its samples. */
const fileOf = (samples: number[], channels = 1): Uint8Array => {
  const extra = 6;
  const data = samples.length * 2;
  const file = new Uint8Array(12 + 24 + 8 + extra + 8 + data);
  const view = new DataView(file.buffer);
  name(view, 0, "RIFF");
  // As a file written while it was made names it: a size it didn't know.
  view.setUint32(4, 0xff_ff_ff_ff, true);
  name(view, 8, "WAVE");
  name(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000 * channels, true);
  view.setUint16(32, 2 * channels, true);
  view.setUint16(34, 16, true);
  name(view, 36, "LIST");
  view.setUint32(40, extra, true);
  name(view, 44 + extra, "data");
  view.setUint32(48 + extra, 0xff_ff_ff_ff, true);
  for (const [at, sample] of samples.entries()) {
    view.setInt16(52 + extra + at * 2, sample, true);
  }
  return file;
};

/** Every sample a file gives when it comes in pieces of `size` bytes. */
const heardIn = (file: Uint8Array, size: number) => {
  const read = wavReader();
  const heard: number[] = [];
  let rate = 0;
  for (let at = 0; at < file.byteLength; at += size) {
    const got = read(file.subarray(at, at + size));
    if (got === "unknown") {
      return "unknown";
    }
    if (got !== null) {
      heard.push(...got.samples);
      ({ rate } = got);
    }
  }
  return { heard, rate };
};

describe(wavReader, () => {
  const samples = [0, 16_384, -16_384, 32_767, -32_768, 8192, 1];
  const played = samples.map((sample) => sample / 32_768);

  it.each([1, 3, 7, 44, 1000])(
    "gives the same samples when the file comes %i bytes at a time",
    (size) => {
      expect(heardIn(fileOf(samples), size)).toStrictEqual({
        heard: played,
        rate: 24_000,
      });
    }
  );

  it("plays the first channel of a file with two", () => {
    expect(heardIn(fileOf([100, -100, 200, -200], 2), 5)).toStrictEqual({
      heard: [100 / 32_768, 200 / 32_768],
      rate: 24_000,
    });
  });

  it("says so when the bytes are no file of plain samples", () => {
    const mp3 = new Uint8Array(64).fill(0xff);
    expect(heardIn(mp3, 16)).toBe("unknown");
  });
});
