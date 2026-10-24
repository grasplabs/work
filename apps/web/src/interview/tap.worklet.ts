// A tap on the microphone (prototype `data/ear.ts`, `TAP`), run by the
// browser beside the page's own work: it hands the sound on as it comes, a
// tenth of a second at a time, as numbers from -1 to 1 at the device's own
// rate. Built as a file of its own (mic.ts loads it with `?worker&url`)
// and served from this origin's assets, as the page's policy lets scripts
// come from nowhere else.

// What the browser gives a worklet's scope, which TypeScript's DOM types
// leave out.
interface Processor {
  readonly port: MessagePort;
}
declare const AudioWorkletProcessor: new () => Processor;
declare const sampleRate: number;
declare const registerProcessor: (
  name: string,
  processor: new () => Processor & {
    process: (inputs: Float32Array[][]) => boolean;
  }
) => void;

/** How many batches of sound make a second. */
const batchesASecond = 10;

class Tap extends AudioWorkletProcessor {
  #kept = new Float32Array(Math.round(sampleRate / batchesASecond));
  #filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const sound = inputs[0]?.[0];
    if (sound === undefined) {
      return true;
    }
    for (const sample of sound) {
      this.#kept[this.#filled] = sample;
      this.#filled += 1;
      if (this.#filled === this.#kept.length) {
        // A copy: the batch being filled is the next one.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort takes no origin
        this.port.postMessage(Float32Array.from(this.#kept));
        this.#filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("tap", Tap);
