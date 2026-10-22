import type { voiceTags } from "@grasp-os/shared/interview-links";
import { interviewLocaleSchema } from "@grasp-os/shared/onboarding";
import type { Interviewer } from "@grasp-os/shared/onboarding";
import { i18n } from "@lingui/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";

import { wait } from "../core.ts";
import { readingSeconds } from "../onboarding/setup.ts";
import { linkNow } from "./kept.ts";
import { scheduleOf, wordsOf } from "./spoken.tsx";

// The interviewer's voice before the interview: one line at a time, said
// through core's `POST /api/speech` with the link's secret and the
// device's key, in Stephen's voice or Claire's, its words lighting up as
// they are said. Where there is no sound (the browser holds it back before
// a first press, the voice isn't set up, or they chose to go without), the
// words light up at the pace of speech instead, so a line is never lost.
// The onboarding's voice store (`src/voice/`) does the same for every page
// once it is in; this is the least the sound check needs until then.

/** Where a line is said: `speechPath` in `@grasp-os/shared/voice`. */
const speechPath = "/api/speech";

/** How a line is said: one of the tones the voice takes. */
export type Tone = (typeof voiceTags)[number];

/** How long a line waits for the browser to allow sound, in ms, before it is read silently. */
const allowWaitMs = 400;

/** How long one line may take to come. */
const fetchTimeoutMs = 15_000;

/** When each word of a line is reached, in ms from its start, and how far the line is said then. */
type Schedule = { after: number; reached: number }[];

/** The line being said: whose, its words, when each is reached, and whether it is heard. */
export interface SaidLine {
  id: number;
  text: string;
  speaker: Interviewer;
  schedule: Schedule;
  audible: boolean;
}

const answerSchema = z.object({
  audio: z.string().min(1),
  words: z.array(
    z.object({ text: z.string(), startMs: z.number(), endMs: z.number() })
  ),
});

/** A line as fetched: its sound, when there is any, and when each word is said. */
interface Clip {
  audio: AudioBuffer | null;
  schedule: Schedule;
  /** How long it lasts, in ms. */
  length: number;
}

let line: SaidLine | null = null;
const listeners = new Set<() => void>();

const setLine = (next: SaidLine | null): void => {
  line = next;
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

const lineNow = (): SaidLine | null => line;

/** Whether lines are said out loud: off once they chose to go on without sound. */
let soundOn = true;

/** Lines are said out loud, or only light up. */
export const setSound = (on: boolean): void => {
  soundOn = on;
};

let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let samples = new Uint8Array(0);

/** The page's audio, made once: the voice goes through a level meter, for the figure and the wave. */
const audio = (): AudioContext | null => {
  if (context !== null) {
    return context;
  }
  try {
    const made = new AudioContext();
    analyser = made.createAnalyser();
    analyser.fftSize = 1024;
    samples = new Uint8Array(analyser.fftSize);
    analyser.connect(made.destination);
    context = made;
  } catch {
    context = null;
  }
  return context;
};

/** The page's language, as the voice takes it. */
const languageNow = () => {
  const parsed = interviewLocaleSchema.safeParse(i18n.locale);
  return parsed.success ? parsed.data : "en";
};

const bytesOf = (base64: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0);

/** A line read at the pace of speech. */
const readingClip = (text: string): Clip => ({
  audio: null,
  schedule: scheduleOf(text, 0),
  length: readingSeconds(text) * 1000,
});

/** When each word of `text` is reached, by when the voice says it; at the pace of speech where the words don't match. */
const scheduleBy = (
  text: string,
  said: { startMs: number }[]
): Schedule | null => {
  const words = wordsOf(text);
  if (words.length !== said.length) {
    return null;
  }
  return said.map(({ startMs }, at) => ({
    after: startMs,
    reached: (words[at]?.start ?? text.length) + 1,
  }));
};

/** Has core say a line; without an answer to play, it is read at the pace of speech. */
const fetchClip = async (
  text: string,
  speaker: Interviewer,
  tone: Tone
): Promise<Clip> => {
  const reading = readingClip(text);
  const link = linkNow();
  const made = audio();
  if (!soundOn || link === null || made === null) {
    return reading;
  }
  try {
    const response = await fetch(speechPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        language: languageNow(),
        speaker,
        tone,
        link: { secret: link.secret, key: link.key },
      }),
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
    if (!response.ok) {
      return reading;
    }
    const answer = answerSchema.safeParse(await response.json());
    if (!answer.success) {
      return reading;
    }
    const sound = await made.decodeAudioData(bytesOf(answer.data.audio).buffer);
    return {
      audio: sound,
      schedule: scheduleBy(text, answer.data.words) ?? reading.schedule,
      length: sound.duration * 1000,
    };
  } catch {
    // No connection, or audio the browser can't play: the words still light up.
    return reading;
  }
};

const clips = new Map<string, Promise<Clip>>();

/** A line fetched once per language, voice and tone; one that could not be heard is asked for again next time. */
const clipOf = async (
  text: string,
  speaker: Interviewer,
  tone: Tone
): Promise<Clip> => {
  const key = [languageNow(), speaker, tone, text].join("|");
  const found = clips.get(key);
  if (found !== undefined) {
    return await found;
  }
  const fetched = fetchClip(text, speaker, tone);
  clips.set(key, fetched);
  const got = await fetched;
  if (got.audio === null) {
    clips.delete(key);
  }
  return got;
};

/** Fetches a line ahead, so it follows the one being said without a gap. */
export const prepare = (
  text: string,
  { speaker, tone }: { speaker: Interviewer; tone: Tone }
): void => {
  void clipOf(text, speaker, tone);
};

let lineId = 0;
let source: AudioBufferSourceNode | null = null;
/** Who waits for the line being said to be over. */
let ending: (() => void) | null = null;

/** The line ends, or is cut: its sound stops and whoever waits for it goes on. */
const end = (): void => {
  const playing = source;
  source = null;
  try {
    playing?.stop();
  } catch {
    // Already stopped.
  }
  const done = ending;
  ending = null;
  setLine(null);
  done?.();
};

/** Whatever is being said stops. */
export const stopSpeaking = (): void => {
  lineId += 1;
  end();
};

/** Resumes the audio, but no longer than the browser takes when it allows it. */
const allowSoon = async (made: AudioContext): Promise<void> => {
  try {
    await Promise.race([made.resume(), wait(allowWaitMs)]);
  } catch {
    // Held back: read silently.
  }
};

/** Plays `sound` for line `id`; false when the browser holds sound back. */
const played = async (id: number, sound: AudioBuffer): Promise<boolean> => {
  const made = audio();
  if (made === null || analyser === null) {
    return false;
  }
  if (made.state !== "running") {
    await allowSoon(made);
  }
  if (made.state !== "running" || id !== lineId) {
    return false;
  }
  const node = made.createBufferSource();
  node.buffer = sound;
  node.connect(analyser);
  node.addEventListener("ended", () => {
    if (source === node) {
      end();
    }
  });
  source = node;
  node.start();
  return true;
};

/**
 * Says a line in `speaker`'s voice, its words lighting up as it is said,
 * and comes back once it is over or cut by another. Without sound, it is
 * read at the pace of speech.
 */
export const say = async (
  text: string,
  { speaker, tone }: { speaker: Interviewer; tone: Tone }
): Promise<void> => {
  stopSpeaking();
  const id = lineId;
  const clip = await clipOf(text, speaker, tone);
  if (id !== lineId) {
    return;
  }
  const heard = clip.audio !== null && (await played(id, clip.audio));
  if (id !== lineId) {
    return;
  }
  const { promise, resolve } = Promise.withResolvers<null>();
  ending = () => {
    resolve(null);
  };
  setLine({
    id,
    text,
    speaker,
    schedule: heard ? clip.schedule : readingClip(text).schedule,
    audible: heard,
  });
  if (!heard) {
    window.setTimeout(
      () => {
        if (id === lineId) {
          end();
        }
      },
      readingSeconds(text) * 1000 + 250
    );
  }
  await promise;
};

/** How loud the voice is right now, 0 to 1: nothing while no line is heard. */
export const voiceLevel = (): number => {
  if (source === null || analyser === null) {
    return 0;
  }
  analyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) {
    sum += ((sample - 128) / 128) ** 2;
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 6);
};

/** The line being said, if any. */
export const useSaying = (): SaidLine | null =>
  useSyncExternalStore(subscribe, lineNow, lineNow);

/** Tells `onReached` how far `being` is said, word by word, until stopped. */
const lightUp = (
  being: SaidLine,
  onReached: (reached: { id: number; at: number }) => void
): (() => void) => {
  const timers = being.schedule.map(({ after, reached }) =>
    window.setTimeout(() => {
      onReached({ id: being.id, at: reached });
    }, after)
  );
  return () => {
    for (const timer of timers) {
      window.clearTimeout(timer);
    }
  };
};

/**
 * How many characters of `text` are said by now, while it is the line
 * being said: one past the first letter of the word being said. -1 when
 * it is not being said, and its words rest.
 */
export const useSaidOf = (text: string): number => {
  const saying = useSaying();
  const being = saying !== null && saying.text === text ? saying : null;
  const [reached, setReached] = useState({ id: 0, at: 1 });
  useEffect(
    () => (being === null ? undefined : lightUp(being, setReached)),
    [being]
  );
  if (being === null) {
    return -1;
  }
  return reached.id === being.id ? reached.at : 1;
};
