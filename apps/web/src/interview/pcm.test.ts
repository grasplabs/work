import { describe, expect, it } from "vite-plus/test";

import { joined, pcmBytes, resampler, transcriptionRate } from "./pcm.ts";

// What the microphone gives, made into what live transcription takes:
// 16,000 numbers of 16 bits a second, whatever the device's own rate.

/** A tone as a device gives it: numbers from -1 to 1. */
const tone = (seconds: number, rate: number, pitch = 440): Float32Array =>
  Float32Array.from(
    { length: Math.round(seconds * rate) },
    (_, at) => 0.5 * Math.sin((2 * Math.PI * pitch * at) / rate)
  );

/** How often a sound goes up through zero. */
const risingsOf = (sound: Int16Array): number => {
  let risings = 0;
  for (let at = 1; at < sound.length; at += 1) {
    if ((sound[at - 1] ?? 0) < 0 && (sound[at] ?? 0) >= 0) {
      risings += 1;
    }
  }
  return risings;
};

describe(resampler, () => {
  it.each([48_000, 44_100, 96_000, 22_050, 16_000])(
    "makes a second at %i a second into 16,000 numbers",
    (rate) => {
      const made = resampler(rate)(tone(1, rate));
      expect(Math.abs(made.length - transcriptionRate)).toBeLessThanOrEqual(1);
    }
  );

  it("makes each number the mean of the ones it stands for", () => {
    const made = resampler(48_000)(
      Float32Array.from([0.3, 0.6, 0.9, -1, -1, -1, 0, 0, 0.3])
    );
    expect([...made]).toStrictEqual([
      Math.round(0.6 * 32_767),
      -32_767,
      Math.round(0.1 * 32_767),
    ]);
  });

  it("loses and doubles nothing at the seams between batches", () => {
    const sound = tone(0.5, 44_100);
    const whole = resampler(44_100)(sound);
    const inBatches = resampler(44_100);
    const parts: Int16Array[] = [];
    // Batches of a size that never falls on a number's end.
    for (let at = 0; at < sound.length; at += 1000) {
      parts.push(inBatches(sound.subarray(at, at + 1000)));
    }
    expect([...joined(parts)]).toStrictEqual([...whole]);
  });

  it("keeps a tone as loud and as high", () => {
    const made = resampler(48_000)(tone(1, 48_000));
    let loudest = 0;
    for (const sample of made) {
      loudest = Math.max(loudest, Math.abs(sample));
    }
    expect({
      loud: loudest / 32_767 > 0.45 && loudest / 32_767 <= 0.5,
      high: Math.abs(risingsOf(made) - 440) <= 1,
    }).toStrictEqual({ loud: true, high: true });
  });

  it("never goes over what 16 bits hold", () => {
    expect([
      ...resampler(16_000)(Float32Array.from([2, -3, 1, -1])),
    ]).toStrictEqual([32_767, -32_767, 32_767, -32_767]);
  });

  it("only changes the numbers of a device that is no faster", () => {
    expect(resampler(8000)(tone(1, 8000))).toHaveLength(8000);
  });
});

describe(pcmBytes, () => {
  it("writes each number low byte first", () => {
    expect([...pcmBytes(Int16Array.from([1, -2, 256]))]).toStrictEqual([
      1, 0, 254, 255, 0, 1,
    ]);
  });
});
