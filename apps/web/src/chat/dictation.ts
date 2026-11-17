import type { ComposerVoiceProblem } from "../grasp/composer/index.ts";
import type { Locale } from "../i18n.ts";
import { openLiveLine } from "../interview/live-line.ts";
import {
  hangUp,
  micProblem,
  muteMic,
  overhear,
  reachMic,
} from "../interview/mic.ts";
import { resampler } from "../interview/pcm.ts";

// Where a chat's dictation gets its words (use-dictation.ts draws it in
// the Composer). Two sources behind one shape, chosen by `sourceFor`:
//
// - core's own live transcription (`GET /api/transcription`, core's
//   src/onboarding/transcription.ts), the interview's line
//   (interview/live-line.ts) and microphone (interview/mic.ts) reused:
//   for an admin, the only one core lets listen outside an interview;
// - the browser's own speech recognition (SpeechRecognition, in Chrome and
//   Safari), for everyone else: it sends the sound to the browser's maker,
//   which the person is told the first time.
//
// When core lets every member listen, `sourceFor` returns core's for all
// and the browser's goes.

/** What has been heard so far: settled, and still being heard. */
export interface Heard {
  settled: string;
  interim: string;
}

/** What a source tells while it listens. */
export interface Listener {
  /** It listens now. */
  ready: () => void;
  /** What it has heard so far, all of it. */
  heard: (words: Heard) => void;
  /** What stops it, or (`unheard`) what it missed while it goes on. */
  problem: (problem: ComposerVoiceProblem) => void;
}

/** Where a dictation's words come from. */
export interface DictationSource {
  /** Whether it sends the sound to the browser's maker: the person is told the first time. */
  outside: boolean;
  /** Starts listening. */
  start: (listener: Listener) => void;
  /** Done: all it heard, settled. */
  finish: () => Promise<string>;
  /** Stops, keeping nothing. */
  cancel: () => void;
  /** Mutes the microphone, or unmutes it. */
  mute: (muted: boolean) => void;
}

/** How long core's line may take to listen before it counts as failed, in ms. */
const lineReadyMs = 10_000;

/** Two pieces of what was said, as one. */
const both = (first: string, then: string): string =>
  [first, then].filter((piece) => piece !== "").join(" ");

/** Core's own transcription: the interview's line and microphone, for an admin. */
const coreSource = (locale: Locale): DictationSource => {
  let line: ReturnType<typeof openLiveLine> | undefined;
  let unhear: (() => void) | undefined;
  let waiting = 0;
  let partial = "";
  const stop = (): void => {
    window.clearTimeout(waiting);
    unhear?.();
    line?.close();
    hangUp();
    unhear = undefined;
    line = undefined;
  };
  return {
    outside: false,
    start: (listener) => {
      void (async () => {
        if (!(await reachMic())) {
          listener.problem(micProblem() ?? "failed");
          return;
        }
        let began = false;
        line = openLiveLine({
          locale,
          onPartial: (text) => {
            partial = text;
            listener.heard({ settled: "", interim: text });
          },
          onLive: (live) => {
            if (live && !began && line !== undefined) {
              window.clearTimeout(waiting);
              began = line.begin(new Int16Array(0));
              listener.ready();
            } else if (!live && began) {
              // The line went down mid-way: what came is kept in the box.
              listener.problem("failed");
            }
          },
        });
        waiting = window.setTimeout(() => {
          if (!began) {
            listener.problem("failed");
          }
        }, lineReadyMs);
        let resample: ((sound: Float32Array) => Int16Array) | undefined;
        unhear = overhear((sound, rate) => {
          resample ??= resampler(rate);
          line?.send(resample(sound));
        });
      })();
    },
    finish: async () => {
      const words = (await line?.end()) ?? null;
      stop();
      return words ?? partial;
    },
    cancel: () => {
      line?.drop();
      stop();
    },
    mute: (muted) => {
      muteMic(muted);
    },
  };
};

/** One result of the browser's recognition: its words, and whether they are settled. */
interface RecognitionResult {
  isFinal: boolean;
  text: string;
}

/** The browser's recognition, as far as it is used here. */
interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

/** What a recognition's `result` event carries, read with care: it is the browser's. */
const resultsOf = (event: Event): RecognitionResult[] => {
  const results: unknown = Reflect.get(event, "results");
  if (typeof results !== "object" || results === null) {
    return [];
  }
  const length: unknown = Reflect.get(results, "length");
  const read: RecognitionResult[] = [];
  for (let at = 0; at < (typeof length === "number" ? length : 0); at += 1) {
    const result: unknown = Reflect.get(results, at);
    if (typeof result === "object" && result !== null) {
      const best: unknown = Reflect.get(result, 0);
      const text: unknown =
        typeof best === "object" && best !== null
          ? Reflect.get(best, "transcript")
          : "";
      read.push({
        isFinal: Reflect.get(result, "isFinal") === true,
        text: typeof text === "string" ? text.trim() : "",
      });
    }
  }
  return read;
};

// The browser's speech recognition, under its two names: TypeScript's DOM
// types don't have it yet.
declare global {
  interface Window {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  }
}

/** The browser's speech recognition, where it has one. */
const recognitionOf = (): (new () => Recognition) | undefined =>
  window.SpeechRecognition ?? window.webkitSpeechRecognition;

/** What the browser's recognition reports as an error, as the Composer says it. */
const problemOf = (error: string): ComposerVoiceProblem => {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return "blocked";
  }
  if (error === "audio-capture") {
    return "missing";
  }
  if (error === "no-speech") {
    return "unheard";
  }
  return "failed";
};

/** The browser's own speech recognition, for everyone but an admin. */
const browserSource = (
  locale: Locale,
  Made: new () => Recognition
): DictationSource => {
  const recognition = new Made();
  recognition.lang = locale;
  recognition.continuous = true;
  recognition.interimResults = true;
  let heard: Heard = { settled: "", interim: "" };
  let listening = false;
  let ended: (() => void) | undefined;
  return {
    outside: true,
    start: (listener) => {
      listening = true;
      recognition.addEventListener("start", () => {
        listener.ready();
      });
      recognition.addEventListener("result", (event) => {
        let settled = "";
        let interim = "";
        for (const result of resultsOf(event)) {
          if (result.isFinal) {
            settled = both(settled, result.text);
          } else {
            interim = both(interim, result.text);
          }
        }
        heard = { settled, interim };
        listener.heard(heard);
      });
      recognition.addEventListener("error", (event) => {
        const error: unknown = Reflect.get(event, "error");
        const problem = problemOf(typeof error === "string" ? error : "");
        if (problem !== "unheard") {
          listening = false;
        }
        listener.problem(problem);
      });
      recognition.addEventListener("end", () => {
        // The browser stops by itself after a silence: listening goes on
        // until Done or Cancel.
        if (listening) {
          recognition.start();
          return;
        }
        ended?.();
      });
      recognition.start();
    },
    finish: async () => {
      listening = false;
      const done = Promise.withResolvers<boolean>();
      ended = () => {
        done.resolve(true);
      };
      recognition.stop();
      await done.promise;
      return both(heard.settled, heard.interim);
    },
    cancel: () => {
      listening = false;
      recognition.abort();
    },
    mute: (muted) => {
      // The browser's recognition can't be muted: it stops and starts again.
      if (muted) {
        listening = false;
        recognition.stop();
      } else {
        listening = true;
        recognition.start();
      }
    },
  };
};

/**
 * Where `locale`'s dictation comes from for this person: core's own for an
 * admin, the browser's for everyone else, none where neither can be had.
 * When core lets every member listen, this returns core's for all.
 */
export const sourceFor = (
  admin: boolean,
  locale: Locale
): DictationSource | undefined => {
  if (admin) {
    return coreSource(locale);
  }
  const Made = recognitionOf();
  return Made === undefined ? undefined : browserSource(locale, Made);
};
