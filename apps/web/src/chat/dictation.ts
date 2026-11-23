import type { PromptInputSpeechButtonProps } from "@grasp-os/ui/components/prompt-input";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMatch } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { isLocale } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { openLiveLine } from "../interview/live-line.ts";
import type { LiveLine } from "../interview/live-line.ts";
import {
  hangUp,
  micLevel,
  micProblem,
  muteMic,
  overhear,
  reachMic,
} from "../interview/mic.ts";
import { resampler } from "../interview/pcm.ts";

// Dictation in the box to ask in, on Damsko's PromptInputSpeechButton: the
// microphone at the box's foot starts it, its bar shows what is heard,
// lighter, after what is typed, and Done writes it in after the text;
// Cancel keeps nothing. Every member may dictate (GRA-1998): the words come
// from core's own live transcription (`GET /api/transcription`, core's
// src/onboarding/transcription.ts), the interview's line and microphone
// reused (interview/live-line.ts, interview/mic.ts), so the sound reaches
// no one but core. Where it stops on its own (the microphone refused,
// core's daily limit, the line lost), what was heard goes in, and a line
// under the box says why.

/** Why dictating stopped, as the line under the box says it. */
type Problem = "blocked" | "missing" | "unavailable" | "limited" | "failed";

const problemWords: Record<Problem, MessageDescriptor> = {
  blocked: msg`Your browser doesn't let Grasp use the microphone. Allow it in the browser's settings to dictate.`,
  missing: msg`No microphone was found.`,
  unavailable: msg`Dictation isn't set up here yet.`,
  limited: msg`You've dictated as much as you can today.`,
  failed: msg`Dictation stopped. What was heard is kept.`,
};

/**
 * Core refused to listen in this visit because live transcription isn't
 * set up for this deployment: no box offers dictation again until the
 * page loads anew. In memory only, so a deployment set up later offers it
 * on the next visit.
 */
let notSetUp = false;
const notSetUpHeard = new Set<() => void>();

const hearNotSetUp = (changed: () => void): (() => void) => {
  notSetUpHeard.add(changed);
  return () => {
    notSetUpHeard.delete(changed);
  };
};

const noteNotSetUp = (): void => {
  notSetUp = true;
  for (const changed of notSetUpHeard) {
    changed();
  }
};

/** Whether this browser could dictate here: a microphone to ask for, and core not known to refuse. */
const useCanDictate = (): boolean =>
  useSyncExternalStore(
    hearNotSetUp,
    () => !notSetUp && navigator.mediaDevices !== undefined,
    () => false
  );

/** How long core's line may take to listen before it counts as failed, in ms. */
const lineReadyMs = 10_000;

/** What a dictation hears from core, as it goes. */
interface Listener {
  /** What is heard so far, all of it. */
  heard: (words: string) => void;
  /** What stopped it. */
  problem: (problem: Problem) => void;
}

/** One dictation: core's line, fed from the microphone. */
interface Dictation {
  /** Done: all it heard, settled. */
  finish: () => Promise<string>;
  /** Stops, keeping nothing. */
  cancel: () => void;
}

/** Listens through core's line in `locale`, telling `listener` what it hears. */
const dictate = (locale: Locale, listener: Listener): Dictation => {
  let line: LiveLine | undefined;
  let unhear: (() => void) | undefined;
  let waiting = 0;
  let partial = "";
  let cancelled = false;
  const stop = (): void => {
    window.clearTimeout(waiting);
    unhear?.();
    unhear = undefined;
    // Gone before it closes, so its own close isn't heard as a line lost.
    const was = line;
    line = undefined;
    was?.close();
    hangUp();
  };
  const begin = async (): Promise<void> => {
    const reached = await reachMic();
    // Cancelled while the browser asked for the microphone.
    if (cancelled) {
      hangUp();
      return;
    }
    if (!reached) {
      const why = micProblem();
      listener.problem(why === "blocked" || why === "missing" ? why : "failed");
      return;
    }
    let began = false;
    line = openLiveLine({
      locale,
      onPartial: (text) => {
        partial = text;
        listener.heard(text);
      },
      // Core won't listen: no use trying again.
      onRefused: (code) => {
        line?.drop();
        stop();
        if (code === "transcription.unavailable") {
          noteNotSetUp();
          listener.problem("unavailable");
        } else {
          listener.problem(
            code === "transcription.limited" ? "limited" : "failed"
          );
        }
      },
      onLive: (live) => {
        if (live && !began && line !== undefined) {
          window.clearTimeout(waiting);
          began = line.begin(new Int16Array(0));
        } else if (!live && line !== undefined) {
          // The line went down, before it listened or mid-way.
          window.clearTimeout(waiting);
          stop();
          listener.problem("failed");
        }
      },
    });
    waiting = window.setTimeout(() => {
      if (!began) {
        line?.drop();
        stop();
        listener.problem("failed");
      }
    }, lineReadyMs);
    let resample: ((sound: Float32Array) => Int16Array) | undefined;
    unhear = overhear((sound, rate) => {
      resample ??= resampler(rate);
      line?.send(resample(sound));
    });
  };
  void begin();
  return {
    finish: async () => {
      const words = (await line?.end()) ?? null;
      stop();
      return words ?? partial;
    },
    cancel: () => {
      cancelled = true;
      line?.drop();
      stop();
    },
  };
};

/** `text` with `said` after it, a space between. */
const after = (text: string, said: string): string =>
  [text.trimEnd(), said].filter((part) => part !== "").join(" ");

/** How loud the voice is now, for the bar's field. */
const sample = () => ({ level: micLevel() });

/**
 * Dictation for the box: the speech button's props,
 * none where nobody can dictate (a guest's chat, outside the shell; a
 * browser with no microphone; core not set up for it), and the line that
 * says why it stopped (`problem`). `text` is what is typed; `onText` takes
 * it back with the dictated words after it.
 */
export const useDictation = (
  text: string,
  onText: (text: string) => void
): {
  speech: PromptInputSpeechButtonProps | undefined;
  problem: string | undefined;
} => {
  const { i18n } = useLingui();
  // A guest's chat is outside the shell: nobody to dictate for.
  const shell = useMatch({ from: "/_shell", shouldThrow: false });
  const possible = useCanDictate();
  const [listening, setListening] = useState(false);
  const [settling, setSettling] = useState(false);
  const [muted, setMuted] = useState(false);
  const [interim, setInterim] = useState("");
  const [problem, setProblem] = useState<Problem>();
  const running = useRef<Dictation | null>(null);
  // What is in the box now: typing can change it while dictating.
  const typed = useRef(text);
  useEffect(() => {
    typed.current = text;
  });
  // A box that goes away mid-dictation lets its line go.
  useEffect(
    () => () => {
      running.current?.cancel();
      running.current = null;
    },
    []
  );
  const locale = isLocale(i18n.locale) ? i18n.locale : "en";
  const start = (): void => {
    setProblem(undefined);
    setInterim("");
    setMuted(false);
    let heard = "";
    const mine = dictate(locale, {
      heard: (words) => {
        if (running.current === mine) {
          heard = words;
          setInterim(words);
        }
      },
      problem: (stopped) => {
        if (running.current !== mine) {
          return;
        }
        // What was heard before it stopped goes in, as Done would put it.
        mine.cancel();
        running.current = null;
        if (heard !== "") {
          onText(after(typed.current, heard));
        }
        setInterim("");
        setListening(false);
        setProblem(stopped);
      },
    });
    running.current = mine;
  };
  const done = async (): Promise<void> => {
    const mine = running.current;
    if (mine === null) {
      return;
    }
    setSettling(true);
    const said = await mine.finish();
    setSettling(false);
    setInterim("");
    // Cancelled, or another begun, while it was written down.
    if (running.current !== mine) {
      return;
    }
    running.current = null;
    if (said !== "") {
      onText(after(typed.current, said));
    }
  };
  const words =
    problem === undefined ? undefined : i18n._(problemWords[problem]);
  if (shell === undefined || !possible) {
    return { speech: undefined, problem: words };
  }
  return {
    speech: {
      listening,
      settling,
      muted,
      interim,
      sample,
      onListeningChange: (next: boolean) => {
        setListening(next);
        if (next) {
          start();
        } else {
          void done();
        }
      },
      onCancel: () => {
        running.current?.cancel();
        running.current = null;
        setInterim("");
      },
      onMutedChange: (next: boolean) => {
        muteMic(next);
        setMuted(next);
      },
    },
    problem: words,
  };
};
