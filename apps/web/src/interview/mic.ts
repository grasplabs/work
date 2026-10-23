// The microphone, for the check before the interview (prototype
// `data/ear.ts`): asked for once, listened to only while the check is on
// screen, and let go of after it. Its level says when someone speaks,
// clearly above the room's own noise; nothing is recorded or sent
// anywhere. The person's choice of microphone is kept in this browser.

/** A microphone as the browser knows it: its own id for it, and its name. */
export interface Microphone {
  id: string;
  name: string;
}

/** Why the microphone could not be reached: the person or the browser said no, there is none, or this browser can't listen. */
export type MicProblem = "blocked" | "missing" | "unsupported";

/** Where the person's own choice of microphone is kept in this browser. */
const chosenKey = "grasp.microphone";
/** How often the level is looked at, in ms. */
const tickMs = 40;
/** How far back the room's own noise is looked for, in ms. */
const roomMs = 1500;
/** How long there must be a voice before it counts as someone speaking, in ms. */
const voicedMs = 200;

const readChosen = (): string | null => {
  try {
    return localStorage.getItem(chosenKey);
  } catch {
    return null;
  }
};

let stream: MediaStream | null = null;
let ears: {
  context: AudioContext;
  analyser: AnalyserNode;
  samples: Uint8Array<ArrayBuffer>;
} | null = null;
let level = 0;
let problem: MicProblem | null = null;

/** Whether this browser can listen at all. */
const canHear = (): boolean =>
  typeof navigator.mediaDevices?.getUserMedia === "function";

/** Why a microphone couldn't be had, by what the browser said. */
const problemOf = (caught: unknown): MicProblem => {
  const name = caught instanceof DOMException ? caught.name : "";
  return name === "NotFoundError" || name === "OverconstrainedError"
    ? "missing"
    : "blocked";
};

/**
 * The microphone: the one the person chose, when they chose one and it is
 * still there, else the browser's own. False when it isn't given;
 * `micProblem` then says why.
 */
export const reachMic = async (): Promise<boolean> => {
  if (!canHear()) {
    problem = "unsupported";
    return false;
  }
  if (stream !== null && ears !== null) {
    return true;
  }
  const chosen = readChosen();
  try {
    const got = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(chosen === null ? {} : { deviceId: { ideal: chosen } }),
      },
    });
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(got).connect(analyser);
    await context.resume();
    stream = got;
    ears = { context, analyser, samples: new Uint8Array(analyser.fftSize) };
    problem = null;
    return true;
  } catch (error) {
    problem = problemOf(error);
    return false;
  }
};

/** Why the microphone wasn't given the last time it was asked for; nothing when it was. */
export const micProblem = (): MicProblem | null => problem;

/** The microphones to choose from. The browser names them only once listening is allowed, so ask after `reachMic`. */
export const microphones = async (): Promise<Microphone[]> => {
  if (!canHear()) {
    return [];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(
        (device) =>
          device.kind === "audioinput" &&
          device.deviceId !== "" &&
          device.label !== ""
      )
      .map((device) => ({ id: device.deviceId, name: device.label }));
  } catch {
    return [];
  }
};

/** The microphone listened through right now, by its id; none while nobody listens. */
export const microphone = (): string | null =>
  stream?.getAudioTracks()[0]?.getSettings().deviceId ?? null;

/** Lets go of the microphone: the browser's own sign that it is on goes out. */
export const hangUp = (): void => {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
  const context = ears?.context;
  stream = null;
  ears = null;
  level = 0;
  if (context !== undefined) {
    void (async () => {
      try {
        await context.close();
      } catch {
        // Already closed.
      }
    })();
  }
};

/** Listens through another microphone from now on, and remembers it in this browser. */
export const chooseMic = async (id: string): Promise<boolean> => {
  try {
    localStorage.setItem(chosenKey, id);
  } catch {
    // Without storage the choice lasts until the microphone is let go of.
  }
  hangUp();
  return await reachMic();
};

/** How loud the microphone is right now, 0 to 1, while someone listens; 0 otherwise. */
export const micLevel = (): number => level;

/** How loud the microphone is now, 0 to 1, as the root of the mean square of its samples. */
const loudnessNow = (heard: NonNullable<typeof ears>): number => {
  heard.analyser.getByteTimeDomainData(heard.samples);
  let sum = 0;
  for (const sample of heard.samples) {
    sum += ((sample - 128) / 128) ** 2;
  }
  return Math.sqrt(sum / heard.samples.length);
};

/**
 * Listens until stopped, and tells `onVoice` once someone speaks: more
 * than a click or a cough, clearly above the room. Call `reachMic` first.
 */
export const listenForVoice = (onVoice: () => void): (() => void) => {
  const heard = ears;
  if (heard === null) {
    return () => {
      // Nothing listens.
    };
  }
  // The room's own noise is the quietest of the last moment and a half: also between words.
  const lately: [number, number][] = [];
  let loud = 0;
  let voiced = 0;
  let told = false;
  let before = performance.now();
  const timer = window.setInterval(() => {
    const now = performance.now();
    const loudness = loudnessNow(heard);
    lately.push([now, loudness]);
    while (lately.length > 0 && now - (lately[0]?.[0] ?? now) > roomMs) {
      lately.shift();
    }
    let room = loudness;
    for (const [, was] of lately) {
      room = Math.min(room, was);
    }
    // Speaking is clearly above the room, however softly someone talks.
    const speaks = loudness > Math.max(0.015, Math.min(room * 2.5, 0.12));
    // A voice dips between syllables: three loud moments close together are enough.
    loud = speaks ? loud + 1 : Math.max(0, loud - 0.5);
    if (speaks && loud >= 3) {
      voiced += Math.min(now - before, 100);
    }
    before = now;
    level = Math.min(1, loudness * 9);
    if (voiced > voicedMs && !told) {
      told = true;
      onVoice();
    }
  }, tickMs);
  return () => {
    window.clearInterval(timer);
    level = 0;
  };
};
