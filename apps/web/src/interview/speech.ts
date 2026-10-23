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

// The interviewer's voice on the link (prototype `data/voice.ts`): lines
// said through core's `POST /api/speech` with the link's secret and the
// device's key, in Stephen's voice or Claire's, their words lighting up as
// they are said. A line of the interview is said a sentence at a time,
// each its own clip (`sayInPieces`): a short clip is ready much sooner
// than a whole line, so he is heard sooner, and the rest is made while
// the first is said. It can begin before the whole line is written, and
// the line grows on screen as the rest comes. Where there is no sound (the
// browser holds it back before a first press, the voice isn't set up, or
// they chose to go without), the words light up at the pace of speech
// instead, so a line is never lost. The onboarding's voice store
// (`src/voice/`) does the same for the admin's pages; this follows its
// design until the two become one.

/** Where a line is said: `speechPath` in `@grasp-os/shared/voice`. */
const speechPath = "/api/speech";

/** How a line is said: one of the tones the voice takes. */
export type Tone = (typeof voiceTags)[number];

/** How a line is said, apart from its words: in whose voice, and in what tone. */
export interface Voicing {
  speaker: Interviewer;
  tone: Tone | null;
}

/** How long a line waits for the browser to allow sound, in ms, before it is read silently. */
const allowWaitMs = 400;

/** How long one line may take to come. */
const fetchTimeoutMs = 15_000;

/**
 * How many lines are fetched ahead at once: the voice refuses many more.
 * The line being said never waits behind them.
 */
const fetchesAtOnce = 2;

/** When each word of a line is reached, in ms from its start, and how far the line is said then. */
type Schedule = { after: number; reached: number }[];

/** The line being said: whose, its words so far, when each is reached as far as that is known, and whether it is heard. */
export interface SaidLine {
  id: number;
  text: string;
  speaker: Interviewer;
  /** A piece not begun yet has no words in it: they wait. */
  schedule: Schedule;
  /** When it began, on the page's clock (`performance.now()`). */
  began: number;
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

let saidNow: SaidLine | null = null;
const listeners = new Set<() => void>();

const setLine = (next: SaidLine | null): void => {
  saidNow = next;
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

const lineNow = (): SaidLine | null => saidNow;

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

/** How long a text takes to read at the pace of speech, in ms. */
const readingMs = (text: string): number => readingSeconds(text) * 1000;

/** A line read at the pace of speech. */
const readingClip = (text: string): Clip => ({
  audio: null,
  schedule: scheduleOf(text, 0),
  length: readingMs(text),
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
const fetchClip = async (text: string, voicing: Voicing): Promise<Clip> => {
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
        speaker: voicing.speaker,
        ...(voicing.tone === null ? {} : { tone: voicing.tone }),
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
  const start = async (): Promise<void> => {
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

/**
 * A line fetched once per language, voice and tone; one that could not be
 * heard is asked for again next time. With `now`, it is about to be said,
 * and is fetched at once, not behind the lines fetched ahead.
 */
const clipOf = async (
  text: string,
  voicing: Voicing,
  now: boolean
): Promise<Clip> => {
  const key = [languageNow(), voicing.speaker, voicing.tone ?? "", text].join(
    "|"
  );
  const found = clips.get(key);
  if (found !== undefined) {
    if (now) {
      hurry(key);
    }
    return await found;
  }
  const fetched = inTurn(key, async () => await fetchClip(text, voicing), now);
  clips.set(key, fetched);
  const got = await fetched;
  if (got.audio === null) {
    clips.delete(key);
  }
  return got;
};

/** Fetches a line ahead, so it follows the one being said without a gap. */
export const prepare = (text: string, voicing: Voicing): void => {
  if (soundOn && text.trim() !== "") {
    void clipOf(text, voicing, false);
  }
};

/** A line's sentences, each with where it starts in the line. */
export const piecesOf = (text: string): { text: string; from: number }[] => {
  let at = 0;
  return text.split(/(?<=[.?!…])\s+/u).flatMap((each) => {
    const piece = each.trim();
    if (piece === "") {
      return [];
    }
    const from = text.indexOf(piece, at);
    at = from + piece.length;
    return [{ text: piece, from }];
  });
};

/** What a line's growing tells before it plays: nothing yet. */
const notYet = (): void => {
  // `play` gives it what to do.
};

/** A piece of a line, said as a clip of its own, and where it starts in the line. */
interface Piece {
  text: string;
  from: number;
}

/**
 * A line being said: its words so far, the pieces they are said in, and
 * whether more may still come. `grew` is told when more of it came, or
 * that no more will.
 */
interface Line {
  text: string;
  voicing: Voicing;
  pieces: Piece[];
  open: boolean;
  grew: () => void;
}

let lineId = 0;
let source: AudioBufferSourceNode | null = null;
/** Who waits for the line being said to be over. */
let ending: (() => void) | null = null;

const stopSound = (): void => {
  const playing = source;
  source = null;
  try {
    playing?.stop();
  } catch {
    // Already stopped.
  }
};

/** The line ends, or is cut: its sound stops and whoever waits for it goes on. */
const end = (): void => {
  stopSound();
  const done = ending;
  ending = null;
  setLine(null);
  done?.();
};

/** Line `id` is all said: it ends, unless another took its place. */
const finish = (id: number): void => {
  if (id === lineId) {
    end();
  }
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

/** Whether line `id` can be heard: false when the browser holds sound back. */
const heardNow = async (id: number): Promise<boolean> => {
  const made = audio();
  if (made === null || analyser === null) {
    return false;
  }
  if (made.state !== "running") {
    await allowSoon(made);
  }
  return made.state === "running" && id === lineId;
};

/** Reads line `id` at the pace of speech, all of it, and on as it grows. */
const readSilently = (id: number, said: Line, began: number): void => {
  let waitingForMore = false;
  const shown = (): void => {
    setLine({
      id,
      text: said.text,
      speaker: said.voicing.speaker,
      schedule: scheduleOf(said.text, 0),
      began,
      audible: false,
    });
  };
  const read = async (): Promise<void> => {
    await wait(
      Math.max(0, readingMs(said.text) - (performance.now() - began)) + 250
    );
    if (id !== lineId) {
      return;
    }
    if (said.open) {
      waitingForMore = true;
      return;
    }
    finish(id);
  };
  said.grew = () => {
    shown();
    if (waitingForMore) {
      waitingForMore = false;
      void read();
    }
  };
  shown();
  void read();
};

/** What plays a line heard, piece after piece. */
interface Playing {
  id: number;
  said: Line;
  coming: Promise<Clip>[];
  out: AudioNode;
  made: AudioContext;
}

/** Plays line `id` heard, piece after piece: each starts as the one before ends, its words lighting up from there. */
const playHeard = (
  { id, said, coming, out, made }: Playing,
  first: Clip
): void => {
  const began = performance.now();
  const schedule: Schedule = [];
  let waitingForMore: (() => void) | null = null;
  const shown = (): void => {
    setLine({
      id,
      text: said.text,
      speaker: said.voicing.speaker,
      schedule: [...schedule],
      began,
      audible: true,
    });
  };
  const begin = (at: number, own: Clip): void => {
    const piece = said.pieces[at];
    if (piece === undefined) {
      return;
    }
    const since = performance.now() - began;
    for (const { after, reached } of own.schedule) {
      schedule.push({ after: since + after, reached: piece.from + reached });
    }
    shown();
    if (own.audio === null) {
      // This piece could not be had: its words light up at the pace of speech, and the next follows.
      void (async () => {
        await wait(own.length + 150);
        if (id === lineId) {
          // oxlint-disable-next-line no-use-before-define -- a piece ends, and the next begins
          await onward(at + 1);
        }
      })();
      return;
    }
    // Played from its very start, never from where its first word is said: nothing is skipped.
    const node = made.createBufferSource();
    node.buffer = own.audio;
    node.connect(out);
    node.addEventListener(
      "ended",
      () => {
        if (source === node) {
          source = null;
          // oxlint-disable-next-line no-use-before-define -- a piece ends, and the next begins
          void onward(at + 1);
        }
      },
      { once: true }
    );
    source = node;
    node.start();
  };
  const onward = async (at: number): Promise<void> => {
    const next = coming[at];
    if (next === undefined) {
      // All that is known of it is said: it ends here, or goes on once more of it comes.
      if (said.open) {
        waitingForMore = () => {
          void onward(at);
        };
      } else {
        finish(id);
      }
      return;
    }
    const own = await next;
    if (id === lineId) {
      begin(at, own);
    }
  };
  const fetchAll = said.grew;
  said.grew = () => {
    fetchAll();
    shown();
    const goOn = waitingForMore;
    waitingForMore = null;
    goOn?.();
  };
  begin(0, first);
};

/** Says line `id`, as one clip or piece after piece, each fetched as soon as it is known. */
const play = async (id: number, said: Line): Promise<void> => {
  // Ahead of what is fetched ahead: the first piece is heard as soon as it is ready, and the rest is made while it is said.
  const coming: Promise<Clip>[] = [];
  said.grew = () => {
    for (const piece of said.pieces.slice(coming.length)) {
      coming.push(clipOf(piece.text, said.voicing, true));
    }
  };
  said.grew();
  const [next] = coming;
  if (next === undefined) {
    finish(id);
    return;
  }
  const first = await next;
  if (id !== lineId) {
    return;
  }
  const heard = first.audio !== null && (await heardNow(id));
  if (id !== lineId) {
    return;
  }
  const made = audio();
  if (!heard || made === null || analyser === null) {
    readSilently(id, said, performance.now());
    return;
  }
  playHeard({ id, said, coming, out: analyser, made }, first);
};

/** Says `said`, cutting whatever is being said; resolves once it is over, or cut by another. */
const start = async (said: Line): Promise<void> => {
  stopSpeaking();
  const id = lineId;
  const { promise, resolve } = Promise.withResolvers<null>();
  ending = () => {
    resolve(null);
  };
  void play(id, said);
  await promise;
};

/**
 * A line said a sentence at a time: `text` is the line as it is said by
 * now; `add` gives the whole line once it is there, and the sentences still
 * to come follow the ones said; `end` says no more comes. `over` resolves
 * once all of it is said, or it is cut.
 */
export interface Saying {
  readonly text: string;
  add: (all: string) => void;
  end: () => void;
  over: Promise<void>;
}

/**
 * Begins to say a line in pieces, a sentence each, cutting whatever is
 * being said: `first` is what is known of it, and with `done`, it is all
 * of it. On screen it is one line, growing, lighting up across its pieces.
 * Without sound, it takes the time it takes to read.
 */
export const sayInPieces = (
  first: string,
  voicing: Voicing,
  { done = false }: { done?: boolean } = {}
): Saying => {
  const said: Line = {
    text: first,
    voicing,
    pieces: piecesOf(first),
    open: !done,
    grew: notYet,
  };
  const over = start(said);
  return {
    get text() {
      return said.text;
    },
    add: (all) => {
      if (!said.open) {
        return;
      }
      // What is new is said after what was said already; a line that doesn't go on from there is said after it, all of it.
      const more = all.startsWith(said.text)
        ? all.slice(said.text.length)
        : ` ${all}`;
      if (more.trim() !== "") {
        const from = said.text.length;
        said.text += more;
        for (const piece of piecesOf(more)) {
          said.pieces.push({ text: piece.text, from: from + piece.from });
        }
      }
      said.grew();
    },
    end: () => {
      if (said.open) {
        said.open = false;
        said.grew();
      }
    },
    over,
  };
};

/**
 * Says a line in `speaker`'s voice as one clip, its words lighting up as
 * it is said, and comes back once it is over or cut by another. Without
 * sound, it is read at the pace of speech.
 */
export const say = async (text: string, voicing: Voicing): Promise<void> => {
  await start({
    text,
    voicing,
    pieces: text.trim() === "" ? [] : [{ text, from: 0 }],
    open: false,
    grew: notYet,
  });
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

/** Tells `onReached` how far `being` is said, word by word, from when it began, until stopped. */
const lightUp = (
  being: SaidLine,
  onReached: (reached: { id: number; at: number }) => void
): (() => void) => {
  const since = performance.now() - being.began;
  const timers = being.schedule.map(({ after, reached }) =>
    window.setTimeout(
      () => {
        onReached({ id: being.id, at: reached });
      },
      Math.max(0, after - since)
    )
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
  const [reached, setReached] = useState({ id: 0, at: 0 });
  useEffect(
    () => (being === null ? undefined : lightUp(being, setReached)),
    [being]
  );
  if (being === null) {
    return -1;
  }
  return reached.id === being.id ? reached.at : 0;
};

/** How many characters of `line` are said, while what follows `from` in it is being said; what comes before stands said. */
export const useSaidIn = (line: string, from: number): number => {
  const said = useSaidOf(line.slice(from));
  return said < 0 ? -1 : from + said;
};
