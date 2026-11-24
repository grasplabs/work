import { loudnessOf, micWanted } from "../interview/mic.ts";
import { resampler } from "../interview/pcm.ts";
import tapUrl from "../interview/tap.worklet.ts?worker&url";

// The microphone of one dictation (dictation.ts), held by it alone: asked
// for as it starts and let go of as it ends, apart from the interview's
// shared one (interview/mic.ts), so neither a mute nor a hang-up of one
// reaches the other. Its sound is tapped as it comes (the interview's tap,
// interview/tap.worklet.ts) and handed on as core's line takes it, 16-bit
// at 16,000 a second (interview/pcm.ts).

/** A microphone held for one dictation. */
export interface DictationMic {
  /** How loud it is now, 0 to 1. */
  level: () => number;
  /** Gives silence, or sound again. */
  mute: (on: boolean) => void;
  /** Lets go of it: the browser's own sign that it is on goes out. */
  stop: () => void;
}

/**
 * Asks the browser for the microphone and taps it, handing each batch of
 * its sound to `onSound`, and says when it is lost (`onLost`: its track
 * ended, unplugged or taken by the system, after which only silence would
 * come). Rejects with the browser's reason; whatever it reached by then is
 * let go of first.
 */
export const openDictationMic = async (
  onSound: (sound: Int16Array) => void,
  onLost: () => void
): Promise<DictationMic> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: micWanted(),
  });
  let context: AudioContext | undefined;
  const lost = (): void => {
    onLost();
  };
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", lost);
  }
  const stop = (): void => {
    for (const track of stream.getTracks()) {
      // Let go of on purpose: not lost.
      track.removeEventListener("ended", lost);
      track.stop();
    }
    const was = context;
    context = undefined;
    void (async () => {
      try {
        await was?.close();
      } catch {
        // Already closed.
      }
    })();
  };
  try {
    context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    await context.audioWorklet.addModule(tapUrl);
    const tap = new AudioWorkletNode(context, "tap");
    const resample = resampler(context.sampleRate);
    tap.port.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.data instanceof Float32Array) {
        onSound(resample(event.data));
      }
    });
    // Listened to this way, the tap says nothing until it is told to start.
    tap.port.start();
    source.connect(tap);
    // The tap gives no sound itself, but some browsers only run what leads to the speakers.
    tap.connect(context.destination);
    await context.resume();
    return {
      level: () => {
        analyser.getByteTimeDomainData(samples);
        return Math.min(1, loudnessOf(samples) * 9);
      },
      mute: (on) => {
        for (const track of stream.getAudioTracks()) {
          track.enabled = !on;
        }
      },
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
};
