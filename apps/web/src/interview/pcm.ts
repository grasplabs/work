// Sound as live transcription takes it (prototype `lib/pcm.ts`): numbers
// of 16 bits, 16,000 of them a second, low byte first. Pure, so it is
// tested; the ear (ear.ts) feeds it what the microphone's tap gives.

/** How many numbers a second live transcription listens at. */
export const transcriptionRate = 16_000;

/**
 * Makes sound as a device gives it, numbers from -1 to 1 at its own rate,
 * into 16-bit numbers at `to` a second. Each number out is the mean of the
 * ones it stands for, which also keeps out what is too high to be told
 * apart at the lower rate. What is left over of one batch counts with the
 * next, so nothing is lost or doubled at the seams. A device no faster
 * than `to` only has its numbers changed.
 */
export const resampler = (
  from: number,
  to: number = transcriptionRate
): ((sound: Float32Array) => Int16Array) => {
  const step = Math.max(1, from / to);
  let sum = 0;
  let count = 0;
  // How far into the sound it is, and where the number being made ends, both counted from its last number out.
  let seen = 0;
  let ends = step;
  return (sound) => {
    const out = new Int16Array(Math.ceil(sound.length / step) + 1);
    let made = 0;
    for (const sample of sound) {
      sum += sample;
      count += 1;
      seen += 1;
      if (seen >= ends) {
        out[made] = Math.round(Math.max(-1, Math.min(1, sum / count)) * 32_767);
        made += 1;
        sum = 0;
        count = 0;
        // Counted on from here, so the numbers stay small however long someone talks.
        ends += step - seen;
        seen = 0;
      }
    }
    return out.subarray(0, made);
  };
};

/** Several batches of sound as one. */
export const joined = (batches: readonly Int16Array[]): Int16Array => {
  const all = new Int16Array(
    batches.reduce((sum, batch) => sum + batch.length, 0)
  );
  let at = 0;
  for (const batch of batches) {
    all.set(batch, at);
    at += batch.length;
  }
  return all;
};

/** Sound as bytes, low byte first, whatever the device keeps them as. */
export const pcmBytes = (sound: Int16Array): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(sound.length * 2);
  const view = new DataView(bytes.buffer);
  for (const [at, sample] of sound.entries()) {
    view.setInt16(at * 2, sample, true);
  }
  return bytes;
};
