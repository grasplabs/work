import type { Locale } from "../i18n.ts";
import { hearRecording } from "./api.ts";
import { openLiveLine } from "./live-line.ts";
import type { LiveLine } from "./live-line.ts";
import {
  micStream,
  onMicChange,
  overhear,
  reachMic,
  watchLevel,
} from "./mic.ts";
import { joined, resampler, transcriptionRate } from "./pcm.ts";

// Stephen's ears (prototype `data/ear.ts`, `listen`, and
// `data/scribe.ts`): the microphone, listened to in stretches. A stretch
// starts once someone speaks, more than a click or a cough, and ends once
// they have been quiet for a moment. While they speak, the sound goes over
// the live line (live-line.ts), through core, and their words come back as
// they talk; the last second before is sent with it, so the start of what
// they say is in it. Once they fall quiet the stretch is closed and its
// words are all there a moment later. When the live line can't be used,
// or its words don't come in time, the stretch's recording goes to core
// to be written down instead (`hearRecording`).
//
// Audio is never kept: the last second lives in memory until the next one
// takes its place, and a stretch's recording until it is written down.
//
// Turn-taking (GRA-383) builds on the events an ear gives (`EarEvent`).

/** What an ear is opened with. */
export interface EarOptions {
  /** The language spoken. */
  locale: Locale;
  /** The interview link it listens for: the live line and the recordings go by it. */
  link: { secret: string; key: string };
  /** How long a silence ends a stretch, in ms, asked every moment: it can change while they talk. `pauseMs` without it. */
  pause?: () => number;
}

/** What an ear hears, in the order it hears it: for each stretch `stretch-start`, `partial`s, `stretch-end`, then `final` or `unheard`. */
export type EarEvent =
  /** Someone speaks. `live`: its words come as they speak. */
  | { type: "stretch-start"; stretch: number; at: number; live: boolean }
  /** What is heard so far of the stretch, all of it: it takes the place of the last. */
  | { type: "partial"; stretch: number; text: string }
  /** They fell quiet: the stretch is closed, with how long there was a voice in it, in ms. */
  | { type: "stretch-end"; stretch: number; at: number; voicedMs: number }
  /** All words of a closed stretch: as they were said, or from its recording. Empty when there were none. */
  | {
      type: "final";
      stretch: number;
      text: string;
      via: "live" | "recording";
    }
  /** A closed stretch couldn't be written down: it failed, or the link heard all it may today. */
  | { type: "unheard"; stretch: number; reason: "failed" | "limited" }
  /** The live line came up or went down; meanwhile stretches are written down from their recordings. */
  | { type: "line"; live: boolean };

/** Listening, until closed. */
export interface Ear {
  /** Tells `listener` everything the ear hears; gives back how to stop telling it. */
  on: (listener: (event: EarEvent) => void) => () => void;
  /** Whether someone speaks right now, in a stretch. */
  readonly talking: boolean;
  /**
   * Deaf, nothing starts a stretch and nothing is sent, as while Stephen
   * speaks; a stretch underway counts for nothing. Not deaf, it listens.
   */
  setDeaf: (deaf: boolean) => void;
  /** Stops listening. A stretch underway counts for nothing. */
  close: () => void;
}

/** A silence this long ends a stretch, in ms, unless whoever listens says otherwise. */
export const pauseMs = 800;
/** The longest stretch, however long someone talks without a breath, in ms. */
const longestMs = 30_000;
/** How long a quiet room is recorded before the recording starts over, in ms. */
const silenceMs = 12_000;
/** How long there must be a voice before it is a stretch, in ms: less is a click or a cough. */
const voicedLeastMs = 200;
/** The shortest a stretch is from its first voice to its end, in ms. */
const stretchLeastMs = 400;
/** How much sound is kept while nobody speaks, in seconds: once someone is known to speak, the start of it is in there. */
const keptSeconds = 1;

/** One stretch's recording: its pieces, and whether it is wanted when it stops. */
interface Recording {
  recorder: MediaRecorder;
  from: MediaStream;
  pieces: Blob[];
  done: Promise<Blob>;
}

/** Starts recording `from`; the promise gives the recording once it stops. */
const record = (from: MediaStream): Recording => {
  const recorder = new MediaRecorder(from);
  const pieces: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      pieces.push(event.data);
    }
  });
  // oxlint-disable-next-line promise/avoid-new -- MediaRecorder says it stopped by an event
  const done = new Promise<Blob>((resolve) => {
    recorder.addEventListener("stop", () => {
      resolve(new Blob(pieces, { type: recorder.mimeType || "audio/webm" }));
    });
  });
  recorder.start();
  return { recorder, from, pieces, done };
};

/** Stops a recording, if it still runs. */
const stopRecording = (recording: Recording | null): void => {
  if (recording?.recorder.state === "recording") {
    recording.recorder.stop();
  }
};

/** A stretch while it lasts. */
interface Stretch {
  number: number;
  began: number;
  /** When a voice was first heard in it, steadily; 0 before. */
  spokeAt: number;
  lastLoud: number;
  voiced: number;
  loud: number;
  talking: boolean;
  live: boolean;
  /** When the microphone was last looked at. */
  before: number;
  /** When it ended; 0 while it lasts. */
  ended: number;
}

const fresh = (number: number): Stretch => ({
  number,
  began: performance.now(),
  spokeAt: 0,
  lastLoud: 0,
  voiced: 0,
  loud: 0,
  talking: false,
  live: false,
  before: performance.now(),
  ended: 0,
});

/**
 * Listens until closed: the microphone is asked for first. Nothing when it
 * isn't given; `micProblem` then says why.
 */
export const openEar = async (options: EarOptions): Promise<Ear | null> => {
  if (!(await reachMic())) {
    return null;
  }
  const listeners = new Set<(event: EarEvent) => void>();
  const tell = (event: EarEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  let closed = false;
  let deaf = false;
  let count = 0;
  let stretch = fresh(count);
  let recording: Recording | null = null;
  /** The last second of sound, while nobody speaks. */
  let kept: Int16Array[] = [];
  let convert: {
    rate: number;
    make: (sound: Float32Array) => Int16Array;
  } | null = null;
  const line: LiveLine = openLiveLine({
    locale: options.locale,
    link: options.link,
    onPartial: (text) => {
      if (stretch.live && stretch.talking) {
        tell({ type: "partial", stretch: stretch.number, text });
      }
    },
    onLive: (live) => {
      tell({ type: "line", live });
    },
  });

  /** A new recording, through the microphone as it is now. */
  const restart = (): void => {
    stopRecording(recording);
    const from = micStream();
    recording = from === null ? null : record(from);
  };

  /** The microphone's sound as it comes: over the live line while a stretch goes out on it, else the last second of it kept. */
  const hear = (sound: Float32Array, rate: number): void => {
    // A device slower than live transcription listens at has nothing for it.
    if (closed || rate < transcriptionRate) {
      return;
    }
    if (convert?.rate !== rate) {
      convert = { rate, make: resampler(rate) };
    }
    const batch = convert.make(sound);
    if (deaf) {
      return;
    }
    if (stretch.live) {
      line.send(batch);
      return;
    }
    kept.push(batch);
    let length = kept.reduce((sum, each) => sum + each.length, 0);
    while (
      kept.length > 1 &&
      length - (kept[0]?.length ?? 0) >= keptSeconds * transcriptionRate
    ) {
      length -= kept.shift()?.length ?? 0;
    }
  };

  /** The words of a closed stretch: as they were said, else from its recording. */
  const writeDown = async (
    closing: Stretch,
    live: Promise<string | null> | null,
    recorded: Promise<Blob> | null
  ): Promise<void> => {
    const said = live === null ? null : await live;
    if (said !== null) {
      tell({ type: "final", stretch: closing.number, text: said, via: "live" });
      return;
    }
    const blob = recorded === null ? null : await recorded;
    if (blob === null || blob.size === 0) {
      tell({ type: "unheard", stretch: closing.number, reason: "failed" });
      return;
    }
    const heard = await hearRecording({
      ...options.link,
      locale: options.locale,
      audio: blob,
      seconds: (closing.ended - closing.began) / 1000,
    });
    if (closed) {
      return;
    }
    tell(
      "heard" in heard
        ? {
            type: "final",
            stretch: closing.number,
            text: heard.heard,
            via: "recording",
          }
        : { type: "unheard", stretch: closing.number, reason: heard.reason }
    );
  };

  /** The stretch is done: off it goes to be written down, and the next begins. */
  const finish = (now: number): void => {
    const closing = stretch;
    closing.ended = now;
    const wanted = recording;
    count += 1;
    stretch = fresh(count);
    restart();
    tell({
      type: "stretch-end",
      stretch: closing.number,
      at: now,
      voicedMs: Math.round(closing.voiced),
    });
    void writeDown(
      closing,
      closing.live ? line.end() : null,
      wanted === null ? null : wanted.done
    );
  };

  /** Someone speaks: the stretch begins, over the live line where there is one. */
  const begin = (now: number): void => {
    stretch.talking = true;
    stretch.live = line.begin(joined(kept));
    kept = [];
    tell({
      type: "stretch-start",
      stretch: stretch.number,
      at: now,
      live: stretch.live,
    });
  };

  /** One look at the microphone. */
  const tick = (speaks: boolean): void => {
    if (closed || deaf) {
      return;
    }
    const now = performance.now();
    // The microphone changed: a recording through the old one is no use.
    if (recording?.from !== micStream()) {
      restart();
    }
    const at = stretch;
    // A voice dips between syllables: three loud moments close together are enough.
    at.loud = speaks ? at.loud + 1 : Math.max(0, at.loud - 0.5);
    if (at.loud >= 3 && at.spokeAt === 0) {
      at.spokeAt = now;
    }
    if (speaks) {
      at.voiced += Math.min(now - at.before, 100);
      at.lastLoud = now;
    }
    at.before = now;
    if (at.spokeAt !== 0 && at.voiced > voicedLeastMs && !at.talking) {
      begin(now);
    }
    const pause = options.pause?.() ?? pauseMs;
    const fellQuiet =
      now - at.lastLoud > pause && now - at.spokeAt > stretchLeastMs;
    if (at.talking && (fellQuiet || now - at.began > longestMs)) {
      finish(now);
    } else if (!at.talking && now - at.began > silenceMs) {
      // Nobody spoke: the recording of a quiet room is dropped, and listening goes on.
      count += 1;
      stretch = fresh(count);
      restart();
    }
  };

  count += 1;
  stretch = fresh(count);
  restart();
  const unhear = overhear(hear);
  const unwatch = watchLevel(({ speaks }) => {
    tick(speaks);
  });
  /** The stretch underway counts for nothing, and a new one begins. */
  const forget = (): void => {
    if (stretch.live) {
      line.drop();
    }
    count += 1;
    stretch = fresh(count);
    kept = [];
  };
  // A stretch through the microphone let go of counts for nothing.
  const unchange = onMicChange(forget);

  return {
    on: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get talking() {
      return stretch.talking;
    },
    setDeaf: (on) => {
      if (deaf === on) {
        return;
      }
      deaf = on;
      // Nothing is recorded while nobody listens; listening again starts afresh.
      forget();
      if (on) {
        stopRecording(recording);
        recording = null;
      } else {
        restart();
      }
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      unhear();
      unwatch();
      unchange();
      stopRecording(recording);
      recording = null;
      kept = [];
      line.close();
      listeners.clear();
    },
  };
};
