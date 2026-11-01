// The live transcription's audio, from the rate the page records at to the
// one the provider's realtime session takes (transcription.ts).

/**
 * 16-bit mono PCM at one rate as PCM at another, by linear interpolation
 * between neighbouring samples, carried across chunks: a chunk may end
 * between two output samples, or halfway through a sample's two bytes.
 * The output after the last sample waits for the next chunk's first.
 */
export class Resampler {
  readonly #step: number;
  /** Where the next output sample falls, in input samples from `#last`. */
  #at = 0;
  #last: number | undefined = undefined;
  #odd: number | undefined = undefined;

  constructor(from: number, to: number) {
    this.#step = from / to;
  }

  /** The output for the next chunk of input. */
  push(chunk: Uint8Array): Uint8Array {
    let bytes = chunk;
    if (this.#odd !== undefined) {
      bytes = new Uint8Array(chunk.byteLength + 1);
      bytes[0] = this.#odd;
      bytes.set(chunk, 1);
    }
    const whole = bytes.byteLength - (bytes.byteLength % 2);
    this.#odd = whole < bytes.byteLength ? bytes[whole] : undefined;
    const input = new DataView(bytes.buffer, bytes.byteOffset, whole);
    const samples: number[] = [];
    for (let index = 0; index < whole / 2; index += 1) {
      const next = input.getInt16(index * 2, true);
      const last = this.#last;
      this.#last = next;
      if (last !== undefined) {
        // Every output sample from the last input sample up to this one.
        while (this.#at < 1) {
          samples.push(Math.round(last + (next - last) * this.#at));
          this.#at += this.#step;
        }
        this.#at -= 1;
      }
    }
    const output = new Uint8Array(samples.length * 2);
    const view = new DataView(output.buffer);
    for (const [index, sample] of samples.entries()) {
      view.setInt16(index * 2, sample, true);
    }
    return output;
  }
}
