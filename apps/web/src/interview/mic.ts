import { useSyncExternalStore } from "react";

import tapUrl from "./tap.worklet.ts?worker&url";

// The microphone (prototype `data/ear.ts`), for the check before the
// interview and for Stephen's ears (ear.ts): asked for once, kept while
// someone listens, and let go of after. Its level says when someone
// speaks, clearly above the room's own noise. Beside that its sound itself
// can be overheard as it comes (`overhear`), through a tap that runs
// beside the page (tap.worklet.ts), served from this origin as the page's
// policy wants. Nothing is kept here. The person's choice of microphone is
// kept in this browser, and they can mute themselves for a moment.

/** A microphone as the browser knows it: its own id for it, and its name. */
export interface Microphone {
  id: string;
  name: string;
}

/** Why the microphone could not be reached: the person or the browser said no, there is none, or this browser can't listen. */
export type MicProblem = "blocked" | "missing" | "unsupported";

/** Whoever takes the microphone's sound itself: a batch of numbers from -1 to 1, and how many of them make a second. */
export type Overhearer = (sound: Float32Array, rate: number) => void;

/** Where the person's own choice of microphone is kept in this browser. */
const chosenKey = "grasp.microphone";
/** How often the level is looked at, in ms. */
export const tickMs = 40;
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

interface Ears {
  context: AudioContext;
  analyser: AnalyserNode;
  samples: Uint8Array<ArrayBuffer>;
}

let stream: MediaStream | null = null;
let ears: Ears | null = null;
let level = 0;
let heardAt = 0;
let problem: MicProblem | null = null;
/** The person muted themselves: the microphone gives silence until they are back. */
let muted = false;
const muteWatchers = new Set<() => void>();
const overhearers = new Set<Overhearer>();
/** Whoever wants to know that the microphone was let go of or changed. */
const changeWatchers = new Set<() => void>();

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
 * Puts the tap on the microphone. Where a browser can't, nobody overhears
 * anything, and what is said is written down from its recordings alone.
 */
const tapInto = async (
  context: AudioContext,
  source: MediaStreamAudioSourceNode
): Promise<void> => {
  try {
    await context.audioWorklet.addModule(tapUrl);
    // The microphone was let go of, or changed, while the tap was loading.
    if (ears?.context !== context) {
      return;
    }
    const tapped = new AudioWorkletNode(context, "tap");
    tapped.port.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!(event.data instanceof Float32Array) || muted) {
        return;
      }
      for (const overhearer of overhearers) {
        overhearer(event.data, context.sampleRate);
      }
    });
    // Listened to this way, the tap says nothing until it is told to start.
    tapped.port.start();
    source.connect(tapped);
    // The tap gives no sound itself, but some browsers only run what leads to the speakers.
    tapped.connect(context.destination);
  } catch {
    // No tap in this browser.
  }
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
    for (const track of got.getAudioTracks()) {
      track.enabled = !muted;
    }
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const source = context.createMediaStreamSource(got);
    source.connect(analyser);
    stream = got;
    ears = { context, analyser, samples: new Uint8Array(analyser.fftSize) };
    await context.resume();
    void tapInto(context, source);
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

/** The microphone's stream while it is held, for recording a stretch (ear.ts). */
export const micStream = (): MediaStream | null => stream;

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
  for (const watcher of changeWatchers) {
    watcher();
  }
};

/**
 * Listens through another microphone from now on, and remembers it in
 * this browser. An ear that was listening goes on through the new one by
 * itself (`onMicChange`).
 */
export const chooseMic = async (id: string): Promise<boolean> => {
  try {
    localStorage.setItem(chosenKey, id);
  } catch {
    // Without storage the choice lasts until the microphone is let go of.
  }
  hangUp();
  return await reachMic();
};

/** Tells `watcher` each time the microphone is let go of or changed; gives back how to stop telling it. */
export const onMicChange = (watcher: () => void): (() => void) => {
  changeWatchers.add(watcher);
  return () => {
    changeWatchers.delete(watcher);
  };
};

/**
 * Mutes the person, or brings them back: for a cough, a colleague at the
 * door, a call. Muted, the microphone is still held but gives silence, so
 * nothing of that moment is heard, recorded or written down.
 */
export const muteMic = (on: boolean): void => {
  if (muted === on) {
    return;
  }
  muted = on;
  for (const track of stream?.getAudioTracks() ?? []) {
    track.enabled = !on;
  }
  if (on) {
    level = 0;
  }
  for (const watcher of muteWatchers) {
    watcher();
  }
};

/** Whether the person muted themselves. */
export const micMuted = (): boolean => muted;

const watchMute = (watcher: () => void): (() => void) => {
  muteWatchers.add(watcher);
  return () => {
    muteWatchers.delete(watcher);
  };
};

/** Whether the person muted themselves, kept up to date. */
export const useMicMuted = (): boolean =>
  useSyncExternalStore(watchMute, micMuted);

/**
 * The microphone's sound itself, as it comes, while someone has the
 * microphone and isn't muted: a tenth of a second at a time, at the
 * device's own rate. The function it gives back stops it.
 */
export const overhear = (overhearer: Overhearer): (() => void) => {
  overhearers.add(overhearer);
  return () => {
    overhearers.delete(overhearer);
  };
};

/** How loud the microphone is right now, 0 to 1, while someone listens; 0 otherwise. */
export const micLevel = (): number => level;

/** When someone was last heard speaking, on the page's clock; 0 when never. */
export const lastHeard = (): number => heardAt;

/** How loud the microphone is now, 0 to 1, as the root of the mean square of its samples. */
const loudnessNow = (heard: Ears): number => {
  heard.analyser.getByteTimeDomainData(heard.samples);
  let sum = 0;
  for (const sample of heard.samples) {
    sum += ((sample - 128) / 128) ** 2;
  }
  return Math.sqrt(sum / heard.samples.length);
};

/** One look at the microphone: whether someone speaks now, clearly above the room. */
export interface Heard {
  speaks: boolean;
}

/**
 * Looks at the microphone every `tickMs` until stopped, and tells `onTick`
 * whether someone speaks at that moment: clearly above the room's own
 * noise, which is the quietest of the last moment and a half, also
 * between words, so talking straight away doesn't pass for a loud room.
 * Keeps the level up to date while it does. Nothing when there is no
 * microphone; muted, nobody speaks.
 */
export const watchLevel = (onTick: (heard: Heard) => void): (() => void) => {
  const lately: [number, number][] = [];
  const timer = window.setInterval(() => {
    const heard = ears;
    if (heard === null || muted) {
      level = 0;
      onTick({ speaks: false });
      return;
    }
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
    if (speaks) {
      heardAt = now;
    }
    level = Math.min(1, loudness * 9);
    onTick({ speaks });
  }, tickMs);
  return () => {
    window.clearInterval(timer);
    level = 0;
  };
};

/**
 * Listens until stopped, and tells `onVoice` once someone speaks: more
 * than a click or a cough, clearly above the room. Call `reachMic` first.
 */
export const listenForVoice = (onVoice: () => void): (() => void) => {
  let loud = 0;
  let voiced = 0;
  let told = false;
  let before = performance.now();
  return watchLevel(({ speaks }) => {
    const now = performance.now();
    // A voice dips between syllables: three loud moments close together are enough.
    loud = speaks ? loud + 1 : Math.max(0, loud - 0.5);
    if (speaks && loud >= 3) {
      voiced += Math.min(now - before, 100);
    }
    before = now;
    if (voiced > voicedMs && !told) {
      told = true;
      onVoice();
    }
  });
};
