import type { voiceTags } from "@grasp-os/shared/interview-links";
import { interviewLocaleSchema } from "@grasp-os/shared/onboarding";
import { speechPath } from "@grasp-os/shared/voice";
import type { Speaker, SpeechRequestBody } from "@grasp-os/shared/voice";
import { i18n } from "@lingui/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";

import { wait } from "../core.ts";
import { lengthOf, readingTiming, saidBy, timingOf } from "./timing.ts";
import type { Timing } from "./timing.ts";

// Stephen's voice on the onboarding's pages (prototype `data/voice.ts`):
// one line at a time, said through core's `POST /api/speech`, its words
// lighting up as they are said. With the sound off, nothing is said and
// the words light up at the pace of speech instead; so they do while the
// browser holds sound back, or the voice is not set up, or has said enough
// for today. Whether the sound is on, and how loud, is remembered in this
// browser. Paused, the voice holds mid-word, the words stop lighting up,
// and whatever waits on a line (`hold`) waits with it.

/** How Stephen says a line: one of the tones he may use, none of them sad. */
export type Tone = (typeof voiceTags)[number];

/** How a line is said, apart from its words: whose voice, in what tone, and `quick` for a line only known as it is said. */
export interface Voicing {
  speaker?: Speaker;
  tone?: Tone;
  quick?: boolean;
}

/** The line being said: its words, how, when each character is said, and whether it is heard. */
export interface SaidLine {
  id: number;
  text: string;
  voicing: Voicing;
  timing: Timing;
  audible: boolean;
}

export interface VoiceState {
  on: boolean;
  /** The browser has not allowed sound yet: one press on the sound button allows it. */
  blocked: boolean;
  paused: boolean;
  /** How loud, 0 to 1. */
  volume: number;
  line: SaidLine | null;
}

const onKey = "grasp.voice";
const volumeKey = "grasp.volume";
const defaultVolume = 0.8;
/** How long a line waits for the browser to allow sound before it is read silently, in ms. */
const allowWaitMs = 400;
/** How near the end of a sentence has to be for an answer to wait for it, in seconds; further, it waits for the end of the word. */
const soonSeconds = 1;
/** How many lines are fetched ahead at once: the voice refuses many more. The line about to be said never waits. */
const fetchesAtOnce = 2;
/** Refusals that hold for the rest of the visit: the words then light up silently, without asking again. */
const restingCodes = new Set(["speech.unavailable", "speech.limited"]);

const readOn = (): boolean => {
  try {
    return localStorage.getItem(onKey) !== "off";
  } catch {
    return true;
  }
};

const readVolume = (): number => {
  try {
    const stored = localStorage.getItem(volumeKey);
    const volume = Number(stored);
    return stored !== null && Number.isFinite(volume)
      ? Math.min(1, Math.max(0, volume))
      : defaultVolume;
  } catch {
    return defaultVolume;
  }
};

const store = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A private window can refuse storage: the choice lasts until reload.
  }
};

let state: VoiceState = {
  on: readOn(),
  blocked: false,
  paused: false,
  volume: readVolume(),
  line: null,
};
const listeners = new Set<() => void>();

const set = (next: Partial<VoiceState>): void => {
  state = { ...state, ...next };
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const current = (): VoiceState => state;

/** The voice as it is now: on, held back, paused, how loud, and the line being said. */
export const useVoice = (): VoiceState =>
  useSyncExternalStore(subscribe, current, current);

// The page's clock in seconds, standing still while paused: a line read
// silently, and everything that waits on one, is timed on it.
let pausedAt: number | null = null;
let pausedFor = 0;
const clock = (): number =>
  ((pausedAt ?? performance.now()) - pausedFor) / 1000;

/** Waits `ms` on the voice's clock, so a pause holds the wait too. */
export const hold = async (ms: number): Promise<void> => {
  const until = clock() + ms / 1000;
  // oxlint-disable-next-line promise/avoid-new -- a timer that stands still while paused has no promise form
  await new Promise<void>((resolve) => {
    const check = () => {
      const left = until - clock();
      if (left <= 0 && pausedAt === null) {
        resolve();
      } else {
        window.setTimeout(check, pausedAt === null ? left * 1000 : 100);
      }
    };
    check();
  });
};

let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let gain: GainNode | null = null;
/** Sound has played before, so a context held back is only paused, not waiting for a press. */
let allowed = false;

/** The page's audio, made once: the voice goes through a level meter, for the brain, and then the volume. */
const audio = (): AudioContext | null => {
  if (context !== null) {
    return context;
  }
  try {
    const made = new AudioContext();
    analyser = made.createAnalyser();
    analyser.fftSize = 1024;
    gain = made.createGain();
    gain.gain.value = state.volume;
    analyser.connect(gain).connect(made.destination);
    context = made;
  } catch {
    context = null;
  }
  return context;
};

/** A line as fetched: its sound, when there is any, and when each character is said. */
interface Clip {
  audio: AudioBuffer | null;
  timing: Timing;
}

/** Set once the voice refused for the rest of the visit. */
let resting = false;

const answerSchema = z.object({
  audio: z.string().min(1),
  words: z.array(
    z.object({ text: z.string(), startMs: z.number(), endMs: z.number() })
  ),
});
const refusalSchema = z.object({ code: z.string() });

/** The page's language, as the voice takes it. */
const languageNow = () => {
  const parsed = interviewLocaleSchema.safeParse(i18n.locale);
  return parsed.success ? parsed.data : "en";
};

const bytesOf = (base64: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0);

/** Has core say a line; without an answer to play, the line is timed at the pace of speech. */
const fetchLine = async (
  text: string,
  language: SpeechRequestBody["language"],
  { speaker, tone, quick }: Voicing
): Promise<Clip> => {
  const reading: Clip = { audio: null, timing: readingTiming(text) };
  if (resting) {
    return reading;
  }
  try {
    const body: SpeechRequestBody = { text, language, speaker, tone, quick };
    const response = await fetch(speechPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const refusal = refusalSchema.safeParse(payload);
      resting = refusal.success && restingCodes.has(refusal.data.code);
      return reading;
    }
    const answer = answerSchema.safeParse(payload);
    const made = audio();
    if (!answer.success || made === null) {
      return reading;
    }
    return {
      audio: await made.decodeAudioData(bytesOf(answer.data.audio).buffer),
      timing: timingOf(text, answer.data.words),
    };
  } catch {
    // No connection, or audio the browser can't play: the words still light up.
    return reading;
  }
};

/** Lines fetched ahead, waiting their turn. */
const queued: { key: string; start: () => void }[] = [];
let fetching = 0;

const nextFetch = (): void => {
  for (const turn of queued.splice(0, Math.max(fetchesAtOnce - fetching, 0))) {
    turn.start();
  }
};

/** Runs `task` in its turn, or at once when `now`. */
const inTurn = async (
  key: string,
  task: () => Promise<Clip>,
  now: boolean
): Promise<Clip> => {
  const { promise, resolve } = Promise.withResolvers<Clip>();
  const start = async () => {
    fetching += 1;
    try {
      resolve(await task());
    } finally {
      fetching -= 1;
      nextFetch();
    }
  };
  if (now || fetching < fetchesAtOnce) {
    void start();
  } else {
    queued.push({
      key,
      start: () => {
        void start();
      },
    });
  }
  return await promise;
};

/** A line waiting its turn to be fetched goes now: it is about to be said. */
const hurry = (key: string): void => {
  const at = queued.findIndex((each) => each.key === key);
  const [turn] = at === -1 ? [] : queued.splice(at, 1);
  turn?.start();
};

const clips = new Map<string, Promise<Clip>>();

/** A line fetched once per language, voice and way of saying it; one that could not be heard is asked for again next time. */
const clip = async (
  text: string,
  voicing: Voicing,
  now: boolean
): Promise<Clip> => {
  const language = languageNow();
  const key = [
    language,
    voicing.speaker ?? "stephen",
    voicing.tone ?? "",
    voicing.quick === true ? "quick" : "",
    text,
  ].join("|");
  const found = clips.get(key);
  if (found !== undefined) {
    if (now) {
      hurry(key);
    }
    return await found;
  }
  const fetched = inTurn(
    key,
    async () => await fetchLine(text, language, voicing),
    now
  );
  clips.set(key, fetched);
  const got = await fetched;
  if (got.audio === null) {
    clips.delete(key);
  }
  return got;
};

/** A line planned to be said; with `still`, only if that still holds when its turn comes. */
interface Planned {
  text: string;
  voicing: Voicing;
  still?: () => boolean;
}

let lineId = 0;
/** The line being fetched before it is said, so a line asked to wait its turn waits for it too. */
let loading = 0;
/** The line read silently, which ends on its own once its time is up. */
let silent = 0;
let source: AudioBufferSourceNode | null = null;
/** When the line started: on the audio clock when heard, else on the page's clock. */
let startedAt = 0;
/** Who waits for a line to be over, by line: told when it ends or is cut. */
const ends = new Map<number, () => void>();
/** Lines planned to follow the one being said, in turn. */
const waiting: Planned[] = [];
/** An answer waiting for the line being said to reach a break: a later line makes it count for nothing. */
let answering = 0;

const over = (id: number): void => {
  ends.get(id)?.();
  ends.delete(id);
};

const stopSound = (): void => {
  silent = 0;
  const playing = source;
  source = null;
  try {
    playing?.stop();
  } catch {
    // Already stopped.
  }
};

const finish = (id: number): void => {
  over(id);
  if (id !== lineId) {
    return;
  }
  let next = waiting.shift();
  while (next?.still !== undefined && !next.still()) {
    next = waiting.shift();
  }
  set({ line: null });
  if (next !== undefined) {
    // oxlint-disable-next-line no-use-before-define -- a line ends, and the next begins
    begin(next);
  }
};

/** Resumes the audio, but no longer than the browser takes when it allows it. */
const allowSoon = async (made: AudioContext): Promise<void> => {
  try {
    await Promise.race([made.resume(), wait(allowWaitMs)]);
  } catch {
    // Held back: read silently.
  }
};

/** Reads a line silently at the pace it has, and ends it once its time is up. */
const readSilently = async (
  id: number,
  planned: Planned,
  found: Clip
): Promise<void> => {
  startedAt = clock();
  silent = id;
  set({
    line: { id, ...planned, timing: found.timing, audible: false },
    blocked: found.audio !== null,
  });
  await hold(lengthOf(found.timing) * 1000 + 250);
  if (silent === id) {
    finish(id);
  }
};

const sayLine = async (id: number, planned: Planned): Promise<void> => {
  const found = await clip(planned.text, planned.voicing, true);
  if (loading === id) {
    loading = 0;
  }
  if (id !== lineId || !state.on) {
    over(id);
    return;
  }
  const made = found.audio === null ? null : audio();
  if (made !== null && made.state !== "running" && !state.paused) {
    await allowSoon(made);
    if (id !== lineId || !state.on) {
      over(id);
      return;
    }
  }
  if (made?.state === "running") {
    allowed = true;
  }
  const out = analyser;
  const heard =
    made !== null &&
    out !== null &&
    found.audio !== null &&
    (made.state === "running" || (state.paused && allowed));
  if (!heard) {
    await readSilently(id, planned, found);
    return;
  }
  const playing = made.createBufferSource();
  playing.buffer = found.audio;
  playing.connect(out);
  playing.addEventListener(
    "ended",
    () => {
      if (source === playing) {
        source = null;
        finish(id);
      }
    },
    { once: true }
  );
  source = playing;
  startedAt = made.currentTime;
  set({
    line: { id, ...planned, timing: found.timing, audible: true },
    blocked: false,
  });
  playing.start();
};

/** Says a line now, cutting the one before: whoever waited for that one goes on. */
const begin = (planned: Planned): number => {
  lineId += 1;
  const id = lineId;
  for (const [older] of ends) {
    over(older);
  }
  stopSound();
  loading = id;
  void sayLine(id, planned);
  return id;
};

/** Seconds into the line being said. */
const lineTime = (): number => {
  const { line } = state;
  if (line === null) {
    return 0;
  }
  return line.audible && context !== null
    ? context.currentTime - startedAt
    : clock() - startedAt;
};

const fullStop = /[.?!…]/u;

/**
 * How long until the line being heard reaches a natural break, in
 * seconds: the end of its sentence when that is near, else the end of the
 * word it is on. None when nothing is heard.
 */
const untilBreak = (): number => {
  const { line } = state;
  if (line === null || !line.audible || state.paused) {
    return 0;
  }
  const now = lineTime();
  const { text, timing } = line;
  const at = saidBy(timing, now);
  for (let index = Math.max(0, at - 1); index < text.length; index += 1) {
    if (fullStop.test(text.charAt(index))) {
      const stop = timing.ends[index] ?? now;
      if (stop - now <= soonSeconds) {
        // A breath after the full stop, as a person leaves before going on.
        return Math.max(0, stop - now + 0.08);
      }
      break;
    }
  }
  for (let index = at; index < text.length; index += 1) {
    if (text.charAt(index) === " ") {
      return Math.max(0, (timing.starts[index] ?? now) - now);
    }
  }
  return 0;
};

const answerSoon = async (planned: Planned): Promise<void> => {
  answering += 1;
  const mine = answering;
  await hold(untilBreak() * 1000);
  if (answering === mine && state.on) {
    begin(planned);
  }
};

/** Fetches a line ahead, so it starts at once when it is said. */
export const prepare = (text: string, voicing: Voicing = {}): void => {
  if (state.on && text.trim() !== "") {
    void clip(text, voicing, false);
  }
};

/** What `speak` is told besides the line and its voicing. */
export interface SpeakOptions extends Voicing {
  /** Waits for the line being said, rather than cutting it. */
  after?: boolean;
  /** Answers what was just done: the line being said stops at its next natural break, not mid-word. */
  soon?: boolean;
  /** With `after`, said only if this still holds when its turn comes. */
  still?: () => boolean;
}

/**
 * Says a line, cutting the one being said, unless `after` (it waits its
 * turn, fetched meanwhile) or `soon` (it waits for a natural break). With
 * the sound off, nothing is said.
 */
export const speak = (
  text: string,
  { after = false, soon = false, still, ...voicing }: SpeakOptions = {}
): void => {
  if (!state.on || text.trim() === "") {
    return;
  }
  const planned: Planned =
    still === undefined ? { text, voicing } : { text, voicing, still };
  if (after && (state.line !== null || loading !== 0)) {
    waiting.push(planned);
    prepare(text, voicing);
    return;
  }
  waiting.length = 0;
  if (soon) {
    void answerSoon(planned);
    return;
  }
  answering += 1;
  begin(planned);
};

/**
 * Says a line and resolves once it is over, or cut; with the sound off,
 * after the time it takes to say. For what tells a story a line at a time.
 */
export const say = async (
  text: string,
  voicing: Voicing = {}
): Promise<void> => {
  if (!state.on || text.trim() === "") {
    await hold(lengthOf(readingTiming(text)) * 1000);
    return;
  }
  waiting.length = 0;
  answering += 1;
  // Told once the line is over, or cut.
  const { promise, resolve } = Promise.withResolvers<true>();
  ends.set(begin({ text, voicing }), () => {
    resolve(true);
  });
  await promise;
};

/** Stops the voice, and what was waiting to be said. */
export const stopSpeaking = (): void => {
  lineId += 1;
  answering += 1;
  waiting.length = 0;
  loading = 0;
  stopSound();
  for (const [id] of ends) {
    over(id);
  }
  if (state.line !== null) {
    set({ line: null });
  }
};

export const setVoiceOn = (on: boolean): void => {
  if (!on) {
    stopSpeaking();
  }
  set({ on, blocked: false });
  store(onKey, on ? "on" : "off");
};

/** How loud, 0 to 1; remembered in this browser. */
export const setVolume = (volume: number): void => {
  const loud = Math.min(1, Math.max(0, volume));
  if (gain !== null && context !== null) {
    gain.gain.setTargetAtTime(loud, context.currentTime, 0.05);
  }
  set({ volume: loud });
  store(volumeKey, String(loud));
};

/** Holds the voice where it is, and everything that waits on it, until `resumeVoice`. */
export const pauseVoice = (): void => {
  if (state.paused) {
    return;
  }
  pausedAt = performance.now();
  void context?.suspend();
  set({ paused: true });
};

/** Goes on from where the pause held it. */
export const resumeVoice = (): void => {
  if (!state.paused || pausedAt === null) {
    return;
  }
  pausedFor += performance.now() - pausedAt;
  pausedAt = null;
  void context?.resume();
  set({ paused: false });
};

/** Allows sound after the browser held it back, and says the line being read again, so it is heard. */
export const allowSound = async (): Promise<void> => {
  try {
    await audio()?.resume();
  } catch {
    return;
  }
  const { line } = state;
  set({ blocked: false });
  if (line !== null) {
    speak(line.text, line.voicing);
  }
};

const samples = new Uint8Array(1024);
let level = 0;

/** How loud the voice is right now, 0 to 1, eased so the brain breathes with it rather than flickers. */
export const voiceLevel = (): number => {
  const { line, paused } = state;
  let target = 0;
  if (paused || line === null) {
    target = 0;
  } else if (line.audible && analyser !== null) {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      sum += ((sample - 128) / 128) ** 2;
    }
    target = Math.min(1, Math.sqrt(sum / samples.length) * 4.5);
  } else {
    // Read silently, the brain follows the words at a speaking rhythm.
    const now = clock();
    target =
      0.35 + 0.35 * Math.abs(Math.sin(now * 6.1) * Math.sin(now * 2.3 + 0.7));
  }
  level += (target - level) * (target > level ? 0.45 : 0.12);
  return level;
};

/**
 * How many characters of `text` have been said, while it is the line
 * being said; -1 otherwise. It changes as the voice goes from word to
 * word, not every frame.
 */
export const useSaid = (text: string): number => {
  const { line } = useVoice();
  const saying = line?.text === text ? line : null;
  const [said, setSaid] = useState(-1);
  useEffect(() => {
    let frame = 0;
    let last = -1;
    const tick = (timing: Timing) => {
      const count = saidBy(timing, lineTime());
      if (count !== last) {
        last = count;
        setSaid(count);
      }
      frame = requestAnimationFrame(() => {
        tick(timing);
      });
    };
    if (saying !== null) {
      tick(saying.timing);
    }
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [saying]);
  return saying === null ? -1 : said;
};

/** Fetches a line ahead while it is on its way: on the step before, or as a step arrives. */
export const usePrepare = (
  text: string,
  { speaker, tone, quick }: Voicing = {}
): void => {
  useEffect(() => {
    prepare(text, { speaker, tone, quick });
  }, [text, speaker, tone, quick]);
};

/**
 * Says a line once it is shown: after `delay`, after the line being said
 * when `after`, or as an answer at its next natural break when `soon`.
 * Said again when its words change, as they do with the language.
 */
export const useSay = (
  text: string,
  {
    delay = 0,
    when = true,
    after = false,
    soon = false,
    speaker,
    tone,
    quick = false,
  }: SpeakOptions & { delay?: number; when?: boolean } = {}
): void => {
  useEffect(() => {
    const id = when
      ? window.setTimeout(() => {
          speak(text, { after, soon, speaker, tone, quick });
        }, delay)
      : undefined;
    return () => {
      window.clearTimeout(id);
    };
  }, [text, delay, when, after, soon, speaker, tone, quick]);
};
