import type { PromptInputSpeechButtonProps } from "@grasp-os/ui/components/prompt-input";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useLocation, useMatch } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { isLocale } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { openLiveLine } from "../interview/live-line.ts";
import type { LiveLine, LiveLineOptions } from "../interview/live-line.ts";
import { openDictationMic } from "./dictation-mic.ts";
import type { DictationMic } from "./dictation-mic.ts";

// Dictation in the box to ask in, on Damsko's PromptInputSpeechButton: the
// microphone by Send starts it, its bar shows what is heard, lighter,
// after what is typed, and Done writes it in after the text; Cancel keeps
// nothing. Every member may dictate (GRA-1998): the words come from core's
// own live transcription (`GET /api/transcription`, core's
// src/onboarding/transcription.ts) over the interview's line
// (interview/live-line.ts), so the sound reaches no one but core.
//
// One dictation is one small state machine (`dictate`) that alone holds
// its microphone (dictation-mic.ts) and its line: asking for the
// microphone, then the line opening, then listening, then, after Done,
// writing it down, then over. Every way out (Done, Cancel, Escape, a
// problem, the microphone lost, the box going away or out of sight,
// another page, the tab hidden or closed, another box dictating) ends it
// in one place, which lets go of the microphone and closes the line; a
// microphone the browser gives after that is let go of at once. Sound goes
// to core only while it listens, and it listens only while its bar is on
// screen: the box that dictates watches its bar itself, so a page that
// hides a box without saying so (`off`) still stops it. One dictation in
// the app at a time. Its mute is its own and ends with it. Where it stops
// on its own, what was heard goes in, and a line under the box says why:
// both are kept with the box's text (the draft its page keeps, `note`), so
// a box that goes away mid-word leaves them for the box that comes, in the
// chat's panel or its bar. Only Cancel keeps nothing.

/** Why dictating stopped, as the line under the box says it. */
export type Problem =
  | "blocked"
  | "missing"
  | "unavailable"
  | "limited"
  | "failed"
  | "lost"
  | "hidden"
  | "away"
  | "page";

const problemWords: Record<Problem, MessageDescriptor> = {
  blocked: msg`Your browser doesn't let Grasp use the microphone. Allow it in the browser's settings to dictate.`,
  missing: msg`No microphone was found.`,
  unavailable: msg`Dictation isn't set up here yet.`,
  limited: msg`You've dictated as much as you can today.`,
  failed: msg`Dictation stopped. What was heard is kept.`,
  lost: msg`Dictation stopped: the microphone was lost. What was heard is kept.`,
  hidden: msg`Dictation stopped as you left this tab. What was heard is kept.`,
  away: msg`Dictation stopped as its box went out of sight. What was heard is kept.`,
  page: msg`Dictation stopped as you went to another page. What was heard is kept.`,
};

/**
 * Why dictating stopped last, and the way to say it anew: kept beside the
 * box's text by the page that keeps that, so it outlives the box.
 */
export type StopNote = readonly [
  Problem | undefined,
  (why: Problem | undefined) => void,
];

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
export const lineReadyMs = 10_000;

/** Why the browser gave no microphone, by the name of its error. */
const micProblemOf = (caught: unknown): Problem => {
  const name = caught instanceof DOMException ? caught.name : "";
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "missing";
  }
  return name === "NotAllowedError" || name === "SecurityError"
    ? "blocked"
    : "failed";
};

/** Why core won't listen, by its `transcription.*` code. */
const refusalOf = (code: string): Problem => {
  if (code === "transcription.unavailable") {
    return "unavailable";
  }
  return code === "transcription.limited" ? "limited" : "failed";
};

/** What a dictation runs on: the browser's microphone and core's line, or a test's. */
export interface DictationParts {
  /**
   * Asks for the microphone, its sound to `onSound`, and `onLost` once it
   * stops giving any (unplugged, taken by the system); rejects with the
   * browser's reason.
   */
  microphone: (
    onSound: (sound: Int16Array) => void,
    onLost: () => void
  ) => Promise<DictationMic>;
  openLine: (options: LiveLineOptions) => LiveLine;
}

const browserParts: DictationParts = {
  microphone: openDictationMic,
  openLine: openLiveLine,
};

/** What a dictation tells as it goes. */
export interface Listener {
  /** What is heard so far, all of it. */
  heard: (words: string) => void;
  /** It stopped on its own, and why. */
  problem: (problem: Problem) => void;
}

/** One dictation, from its start to its end. */
export interface Dictation {
  /** Done: listens no more at once, and gives all it heard, settled. */
  finish: () => Promise<string>;
  /** Stops, keeping nothing. */
  cancel: () => void;
  /** Gives silence for a moment, or sound again. */
  mute: (on: boolean) => void;
  /** How loud the voice is now, 0 to 1. */
  level: () => number;
}

/** Where a dictation is. */
type Stage = "asking" | "opening" | "listening" | "settling" | "over";

/** Starts one dictation in `locale`: asks for the microphone, then opens core's line. */
export const dictate = (
  locale: Locale,
  listener: Listener,
  parts: DictationParts = browserParts
): Dictation => {
  let stage: Stage = "asking";
  let mic: DictationMic | undefined;
  let line: LiveLine | undefined;
  let waiting = 0;
  let partial = "";
  let muted = false;
  /** Every way out ends here, once: the microphone let go of, the line closed. */
  const end = (): void => {
    stage = "over";
    window.clearTimeout(waiting);
    mic?.stop();
    mic = undefined;
    const was = line;
    line = undefined;
    was?.close();
  };
  /** It stopped on its own: over, and why. */
  const stopped = (problem: Problem): void => {
    if (stage === "over") {
      return;
    }
    line?.drop();
    end();
    if (problem === "unavailable") {
      noteNotSetUp();
    }
    listener.problem(problem);
  };
  const onSound = (sound: Int16Array): void => {
    if (stage === "listening" && !muted) {
      line?.send(sound);
    }
  };
  const open = (got: DictationMic): void => {
    // Over while the browser asked: what it gives now is let go of at once.
    if (stage !== "asking") {
      got.stop();
      return;
    }
    mic = got;
    mic.mute(muted);
    stage = "opening";
    const opened = parts.openLine({
      locale,
      onPartial: (text) => {
        if (stage === "listening") {
          partial = text;
          listener.heard(text);
        }
      },
      // Core won't listen: no use trying again.
      onRefused: (code) => {
        stopped(refusalOf(code));
      },
      onLive: (live) => {
        if (!live) {
          // The line went down, before it listened or mid-way.
          stopped("failed");
        } else if (stage === "opening" && line !== undefined) {
          window.clearTimeout(waiting);
          if (line.begin(new Int16Array(0))) {
            stage = "listening";
          }
        }
      },
    });
    // Ended while the line opened (a refusal said at once).
    if (stage !== "opening") {
      opened.close();
      return;
    }
    line = opened;
    waiting = window.setTimeout(() => {
      if (stage === "opening") {
        stopped("failed");
      }
    }, lineReadyMs);
  };
  void (async () => {
    try {
      open(
        await parts.microphone(onSound, () => {
          // Silence would go on being sent, as if it listened.
          stopped("lost");
        })
      );
    } catch (error) {
      if (stage === "asking") {
        stopped(micProblemOf(error));
      }
    }
  })();
  return {
    finish: async () => {
      if (stage !== "listening") {
        // Nothing listened yet: nothing to write down.
        end();
        return partial;
      }
      stage = "settling";
      // Nothing more is heard: only what was sent is written down.
      mic?.stop();
      mic = undefined;
      const words = (await line?.end()) ?? null;
      end();
      return words ?? partial;
    },
    cancel: () => {
      if (stage !== "over") {
        line?.drop();
      }
      end();
    },
    mute: (on) => {
      muted = on;
      mic?.mute(on);
    },
    level: () => (muted || stage !== "listening" ? 0 : (mic?.level() ?? 0)),
  };
};

/** No cleanup to do. */
const nothing = (): void => {
  // Nothing was started.
};

/** The dictation running in the app, if one is: starting another stops it first, keeping what it heard. */
let runningInApp: { box: object; stop: () => void } | null = null;

/** How often a dictating box looks whether its bar is still on screen, in ms. */
export const shownCheckMs = 250;

/**
 * Whether the person can see `element`: on the page, and not hidden by
 * its styles (none drawn, invisible, or faded out, as a closed chat is).
 * Not merely inert: a menu or dialog over the box makes it inert while
 * it still shows.
 */
const onScreen = (element: Element): boolean =>
  element.isConnected &&
  element.closest("[hidden]") === null &&
  (typeof element.checkVisibility !== "function" ||
    element.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
    }));

/**
 * Whether the bar of the dictation running is on screen: Damsko's, which
 * PromptInputSpeechButton draws while it listens. One dictation runs at a
 * time, so the bar on the page is this one's. None drawn (yet) counts as
 * shown: only a bar the person can't see stops it.
 */
const barShown = (): boolean => {
  const bars = [
    ...document.querySelectorAll('[data-slot="prompt-input-dictation"]'),
  ];
  return bars.length === 0 || bars.some(onScreen);
};

/** Whether the focus is on no control: fallen to the page. */
const lostFocus = (): boolean =>
  document.activeElement === null || document.activeElement === document.body;

/** `text` with `said` after it, a space between. */
const after = (text: string, said: string): string =>
  [text.trimEnd(), said].filter((part) => part !== "").join(" ");

/**
 * Dictation for the box: the speech button's props, none where nobody
 * can dictate (a guest's chat, outside the shell; a browser with no
 * microphone; core not set up for it; the box `off`, such as the idle bar
 * while the chat is open), and the line that says why it stopped
 * (`problem`), until `clearProblem`. `text` is what is typed; `onText`
 * takes it back with the dictated words after it, also as the box goes.
 * `note` keeps why it stopped where the text is kept; the box's own
 * without it.
 */
export const useDictation = (
  text: string,
  onText: (text: string) => void,
  {
    off = false,
    parts = browserParts,
    note,
  }: {
    off?: boolean;
    parts?: DictationParts;
    note?: StopNote | undefined;
  } = {}
): {
  speech: PromptInputSpeechButtonProps | undefined;
  problem: string | undefined;
  clearProblem: () => void;
} => {
  const { i18n } = useLingui();
  // A guest's chat is outside the shell: nobody to dictate for.
  const shell = useMatch({ from: "/_shell", shouldThrow: false });
  const pathname = useLocation({ select: (location) => location.pathname });
  const possible = useCanDictate();
  const can = shell !== undefined && possible && !off;
  const [listening, setListening] = useState(false);
  const [settling, setSettling] = useState(false);
  const [muted, setMuted] = useState(false);
  const [interim, setInterim] = useState("");
  const [ownProblem, setOwnProblem] = useState<Problem>();
  const [problem, setProblem] = note ?? [ownProblem, setOwnProblem];
  const running = useRef<Dictation | null>(null);
  // What was heard of the one running, for a stop that keeps it.
  const heard = useRef("");
  // What is in the box now: typing can change it while dictating.
  const typed = useRef(text);
  useEffect(() => {
    typed.current = text;
  });
  // This box, as the app's one dictation knows it.
  const box = useRef({});
  /** The bar goes: nothing of the one that ran stays on screen. */
  const reset = (): void => {
    running.current = null;
    if (runningInApp?.box === box.current) {
      runningInApp = null;
    }
    heard.current = "";
    setListening(false);
    setSettling(false);
    setMuted(false);
    setInterim("");
  };
  /** Ends the one running; what was heard goes in when `keep`, and `why` says why. */
  const stop = (keep: boolean, why?: Problem): void => {
    const mine = running.current;
    if (mine === null) {
      return;
    }
    mine.cancel();
    if (keep && heard.current !== "") {
      onText(after(typed.current, heard.current));
    }
    reset();
    if (why !== undefined) {
      setProblem(why);
    }
  };
  // The latest `stop`, for the listeners below, which are set once.
  const stopNow = useRef(stop);
  useEffect(() => {
    stopNow.current = stop;
  });
  // The box goes away (the agent's questions in its place, the chat
  // undocked), or can't dictate any more (the chat opened over its bar, or
  // closed over its box): its dictation goes too, what was heard kept in
  // the text, and why, for the box that shows next.
  useEffect(() => {
    if (!can) {
      stopNow.current(true, "away");
    }
  }, [can]);
  useEffect(
    () => () => {
      stopNow.current(true, "away");
    },
    []
  );
  // Another page: it goes, keeping what was heard.
  const page = useRef(pathname);
  useEffect(() => {
    if (page.current !== pathname) {
      page.current = pathname;
      stopNow.current(true, "page");
    }
  }, [pathname]);
  // Its bar out of sight (the chat closed over it, the box hidden by its
  // page): it stops, keeping what was heard, whatever the page said.
  useEffect(() => {
    const timer = listening
      ? window.setInterval(() => {
          if (!barShown()) {
            stopNow.current(true, "away");
          }
        }, shownCheckMs)
      : undefined;
    return () => {
      window.clearInterval(timer);
    };
  }, [listening]);
  // Started by a press of the pointer, Damsko's box leaves the focus on
  // the page as its microphone gives way to the bar, where Escape reaches
  // nothing: the focus goes to the bar's Done, as it does from the keys.
  // As the bar goes (Done written down, Cancel, Escape), the focus it took
  // comes back to the microphone, as Damsko does from the keys, not to
  // the page.
  const barUp = listening || settling;
  useEffect(() => {
    if (!barUp) {
      return nothing;
    }
    let gaveTo: Element | null = null;
    const frame = window.requestAnimationFrame(() => {
      if (lostFocus()) {
        const done = document.querySelector<HTMLElement>(
          '[data-slot="prompt-input-dictation-done"]'
        );
        done?.focus();
        gaveTo = done?.closest('[data-slot="prompt-input"]') ?? null;
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (gaveTo?.isConnected === true && lostFocus()) {
        gaveTo
          .querySelector<HTMLElement>(
            '[data-slot="prompt-input-speech-button"]'
          )
          ?.focus();
      }
    };
  }, [barUp]);
  // The tab hidden: it stops, and says so; the tab closed: it goes.
  useEffect(() => {
    const onHidden = (): void => {
      if (document.visibilityState === "hidden") {
        stopNow.current(true, "hidden");
      }
    };
    const onGone = (): void => {
      stopNow.current(false);
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onGone);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onGone);
    };
  }, []);
  const locale = isLocale(i18n.locale) ? i18n.locale : "en";
  const start = (): void => {
    stop(false);
    // Another box dictating: it stops first, keeping what it heard.
    if (runningInApp !== null && runningInApp.box !== box.current) {
      runningInApp.stop();
    }
    setProblem(undefined);
    const dictation = dictate(
      locale,
      {
        heard: (words) => {
          if (running.current === dictation) {
            heard.current = words;
            setInterim(words);
          }
        },
        problem: (why) => {
          if (running.current === dictation) {
            stop(true, why);
          }
        },
      },
      parts
    );
    running.current = dictation;
    runningInApp = {
      box: box.current,
      stop: () => {
        stopNow.current(true);
      },
    };
    setListening(true);
  };
  const done = async (): Promise<void> => {
    const mine = running.current;
    if (mine === null) {
      return;
    }
    setListening(false);
    setSettling(true);
    const said = await mine.finish();
    // Cancelled, stopped, or another begun, while it was written down.
    if (running.current !== mine) {
      return;
    }
    reset();
    if (said !== "") {
      onText(after(typed.current, said));
    }
  };
  const words =
    problem === undefined ? undefined : i18n._(problemWords[problem]);
  const clearProblem = (): void => {
    setProblem(undefined);
  };
  if (!can) {
    return { speech: undefined, problem: words, clearProblem };
  }
  return {
    speech: {
      listening,
      settling,
      muted,
      interim,
      sample: () => ({ level: running.current?.level() ?? 0 }),
      onListeningChange: (next: boolean) => {
        if (next) {
          start();
        } else {
          void done();
        }
      },
      onCancel: () => {
        stop(false);
      },
      onMutedChange: (next: boolean) => {
        running.current?.mute(next);
        setMuted(next);
      },
    },
    problem: words,
    clearProblem,
  };
};
