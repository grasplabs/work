import type { Interviewer } from "@grasp-os/shared/onboarding";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";

import { isStill, wait } from "../onboarding/pixel-cursor.tsx";
import { startLight } from "./guide-light.ts";
import { guideDone, guideHeld, guideSays, guideStarts } from "./guide-said.ts";
import { keepNow, linkNow, update, useInterviewer } from "./kept.ts";
import { loopFirstName } from "./loop.ts";
import { StephenOrb } from "./orb.tsx";
import { prepare, say, stopSpeaking, useSaying } from "./speech.ts";

// The guide before the first question: a quick walk round for whoever has
// never talked to an AI, once, after they agreed and before Stephen asks
// anything. Nothing to press: it plays by itself. Each real control in turn
// lights up where it is, with an even dotted outline (guide-light.ts),
// while he says what it is for: the answer box, "type instead", the
// language, the transcript and the pause. Nothing travels across the
// window (the owner's ask, 2026-11-27). On the stage stands his orb, as in
// the conversation, and his words come into the transcript. Each step
// lasts as long as he takes to say it; then the conversation starts. Every control stays live meanwhile: a
// language picked during it changes the guide's words, and he says the
// step he is on again in it. Seen once on this device for this link, and
// never once anything is said.

/** What the guide shows, in order: the control each step is about. */
const spots = ["answer", "language", "transcript", "pause", "ready"] as const;
type Spot = (typeof spots)[number];

/** Where each step points; the last goes back to where they start. */
const targetOf: Record<Spot, string> = {
  answer: '[data-guide="answer"] [data-slot="prompt-input"]',
  language: '[data-guide="language"]',
  transcript: "[data-transcript-button]",
  pause: '[data-guide="pause"]',
  ready: '[data-guide="answer"] [data-slot="prompt-input"]',
};

const styles = stylex.create({
  // The outline over the whole window: seen, never pressed, never read out.
  light: {
    position: "fixed",
    inset: 0,
    width: "100vw",
    height: "100svh",
    zIndex: 3,
    pointerEvents: "none",
    display: { default: "block", [media.forcedColors]: "none" },
  },
  // Where the outline's colour is read from: the system's mint, as it stands in light or dark.
  paint: { display: "none", color: colors.mint },
  guide: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["6"],
    textAlign: "center",
    textWrap: "balance",
  },
  // How far along: a square for each step, in the system's pixel, the one it is on lit.
  steps: { display: "flex", gap: "6px" },
  step: {
    width: "6px",
    height: "6px",
    backgroundColor: colors.border,
    transitionProperty: {
      default: "background-color",
      [media.reducedMotion]: "none",
    },
    transitionDuration: "300ms",
  },
  stepOn: { backgroundColor: colors.mint },
});

// ---- Once ----------------------------------------------------------------------------------

const listeners = new Set<() => void>();
const told = () => {
  for (const listener of listeners) {
    listener();
  }
};

/** The link, as a name it can be kept under without keeping the link itself. */
const keyOf = (secret: string): string => {
  let hash = 7;
  for (const letter of secret) {
    hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) % 4_294_967_291;
  }
  return `grasp.interview.guided.${hash.toString(36)}`;
};

let guidedThisVisit = false;
/** The step the guide reached on this visit: a language change opens the page again, and it goes on from there. */
let reachedThisVisit = 0;

const guidedNow = (): boolean => {
  const link = linkNow();
  if (link === null) {
    return true;
  }
  try {
    return localStorage.getItem(keyOf(link.secret)) !== null;
  } catch {
    // Nothing can be kept here: shown, and not again for as long as the page stays.
    return guidedThisVisit;
  }
};

const setGuided = (on: boolean, secret = linkNow()?.secret): void => {
  guidedThisVisit = on;
  reachedThisVisit = 0;
  if (secret !== undefined) {
    try {
      if (on) {
        localStorage.setItem(keyOf(secret), "1");
      } else {
        localStorage.removeItem(keyOf(secret));
      }
    } catch {
      // Kept for this visit only.
    }
  }
  told();
};

/** The guide shows again on this link (the dev jump's start and guide). */
export const forgetGuided = (secret?: string): void => {
  setGuided(false, secret);
};

/** Whether they went through the guide on this link here. */
export const useGuided = (): boolean =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    guidedNow,
    () => true
  );

// ---- Words -------------------------------------------------------------------------------

/** Each step: the short line on screen, and what Stephen says round it, greeting them by name. */
const useGuideWords = (
  name: string
): Record<Spot, { shown: string; spoken: string }> => {
  const { t } = useLingui();
  return {
    answer: {
      shown: t`Talk or type—whatever feels easiest.`,
      spoken:
        name === ""
          ? t`Hey, great to have you here. Before we start, let me quickly show you how everything works. You can just talk to me like you would to a colleague. Oh, and you can type too—whatever feels easiest, both work just as well.`
          : t`Hey ${name}, great to have you here. Before we start, let me quickly show you how everything works. You can just talk to me like you would to a colleague. Oh, and you can type too—whatever feels easiest, both work just as well.`,
    },
    language: {
      shown: t`Switch languages anytime.`,
      spoken: t`Up here you’ll see a few buttons. With this one, you can switch languages anytime, even right in the middle of our conversation. Whatever’s easiest for you to speak in.`,
    },
    transcript: {
      shown: t`Everything we say, right here to read back.`,
      spoken: t`And over here on the right, you’ll find the transcript. You can read everything back, tweak a word, or remove anything you’d rather leave out.`,
    },
    pause: {
      shown: t`Need a break? Click here.`,
      spoken: t`Need a quick break? Just hit this button—and we’ll pick up right where we left off.`,
    },
    ready: {
      shown: t`That’s it. No wrong answers.`,
      spoken: t`So, that’s pretty much it in a nutshell. There really are no wrong answers—we’re just having a quick chat about what your day-to-day looks like, to see where things could be smarter or easier. Just let me know when you’re ready.`,
    },
  };
};

// ---- The walk ----------------------------------------------------------------------------

/** The control a step is about, when this window shows it: a phone, or typing, may not show every one. */
const targetOn = (spot: Spot): Element | null => {
  const element = document.querySelector(targetOf[spot]);
  if (element === null) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? element : null;
};

/** How long a step may last at most, however its line is said: it never hangs. */
const longestMs = (spoken: string): number =>
  4000 + spoken.split(/\s+/u).length * 520;

/** How long, at least, a control stays lit once he has told about it. */
const restMs = 900;
/** The breath between two steps. */
const apartMs = 380;

/** Waits `ms`, or less when the walk stops; never throws. */
const pause = async (ms: number, signal: AbortSignal): Promise<void> => {
  try {
    await wait(ms, signal);
  } catch {
    // Stopped: the walk goes no further.
  }
};

/** Resolves when `promise` does, or when `signal` aborts, whichever comes first. */
const orGone = async (
  promise: Promise<unknown>,
  signal: AbortSignal
): Promise<void> => {
  const gone = Promise.withResolvers<null>();
  signal.addEventListener(
    "abort",
    () => {
      gone.resolve(null);
    },
    { once: true }
  );
  await Promise.race([promise, gone.promise]);
};

/** Done with the guide: the minutes count from here, not from the yes. */
const guidedNowOn = (): void => {
  setGuided(true);
  const at = Date.now();
  update((was) =>
    was.lines.length === 0 ? { ...was, startedAt: at, seenAt: at } : was
  );
  keepNow();
};

interface Held {
  canvas: RefObject<HTMLCanvasElement | null>;
  paint: RefObject<HTMLSpanElement | null>;
  wordsNow: RefObject<Record<Spot, { shown: string; spoken: string }>>;
  /** Where the walk is, as far as it went before: read as it starts. */
  atNow: RefObject<number>;
  /** Tells which step it is on now. */
  onMoved: (at: number) => void;
  speaker: Interviewer;
  setAt: (at: number) => void;
}

/**
 * The walk itself, a step at a time, from where it is: drawn nothing of its
 * own. Started afresh, from the step it is on, in another language.
 */
const Walk = ({
  canvas,
  paint,
  wordsNow,
  atNow,
  onMoved,
  speaker,
  setAt,
}: Held) => {
  useEffect(() => {
    const drawn = canvas.current;
    if (drawn === null) {
      return () => {
        stopSpeaking();
      };
    }
    const stopper = new AbortController();
    const { signal } = stopper;
    const light = startLight(
      drawn,
      () =>
        paint.current === null ? "" : getComputedStyle(paint.current).color,
      isStill()
    );
    const voicing = { speaker, tone: "warm, relaxed" } as const;
    // Through to its end: all he said stands as said.
    let through = false;
    const walk = async (): Promise<void> => {
      // What he said of other words goes; what he said of these stays, back from a pause.
      guideStarts(spots.map((spot) => wordsNow.current[spot].spoken));
      for (let place = atNow.current; place < spots.length; place += 1) {
        const spot = spots[place] ?? "ready";
        const target = targetOn(spot);
        if (target === null && spot !== "ready") {
          continue;
        }
        onMoved(place);
        setAt(place);
        const { spoken } = wordsNow.current[spot];
        const next = spots[place + 1];
        if (next !== undefined) {
          prepare(wordsNow.current[next].spoken, voicing);
        }
        // Into the transcript as he says it.
        guideSays(place, spoken);
        // Said, or as long as it may take at most: a voice that never ends never holds the walk.
        const said = Promise.race([
          say(spoken, voicing),
          pause(longestMs(spoken), signal),
        ]);
        // The control he tells about lights up where it is: nothing travels to it.
        light.aim(target);
        const ended = async (): Promise<void> => {
          await Promise.all([said, pause(restMs, signal)]);
          await pause(apartMs, signal);
        };
        // oxlint-disable-next-line no-await-in-loop -- one step after the other, as he says them
        await orGone(ended(), signal);
        if (signal.aborted) {
          return;
        }
        guideDone(place);
      }
      light.aim(null);
      // The outline fades before the conversation starts.
      await pause(260, signal);
      if (!signal.aborted) {
        through = true;
        guidedNowOn();
      }
    };
    void walk();
    return () => {
      stopper.abort();
      light.stop();
      stopSpeaking();
      // Stopped part way (paused, or another language): his words stand where his voice stopped.
      if (!through) {
        guideHeld();
      }
    };
  }, [canvas, paint, wordsNow, atNow, onMoved, speaker, setAt]);
  return null;
};

/**
 * The guide, on the stage in the questions' place, with his orb and the
 * outline over the window. It plays by itself and, once through, starts
 * the conversation.
 */
export const Guide = () => {
  const { t, i18n } = useLingui();
  const words = useGuideWords(loopFirstName());
  const speaker = useInterviewer();
  const [at, setAt] = useState(() => reachedThisVisit);
  const canvas = useRef<HTMLCanvasElement>(null);
  const paint = useRef<HTMLSpanElement>(null);
  // Read by the walk as it goes: the words as they stand now, and where it is.
  const wordsNow = useRef(words);
  useEffect(() => {
    wordsNow.current = words;
  });
  const atNow = useRef(reachedThisVisit);

  const saying = useSaying();
  const spot = spots[at] ?? "ready";
  const step = at + 1;
  const total = spots.length;
  return (
    // The guide shows the way here: the field doesn't also come to the controls it lights.
    <div data-field="still" {...stylex.props(styles.guide)}>
      {/* Again from the step it is on when the language changes, so he says it in the new one. */}
      <Walk
        atNow={atNow}
        canvas={canvas}
        onMoved={(place) => {
          atNow.current = place;
          reachedThisVisit = place;
        }}
        key={i18n.locale}
        paint={paint}
        setAt={setAt}
        speaker={speaker}
        wordsNow={wordsNow}
      />
      <span ref={paint} {...stylex.props(styles.paint)} />
      <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.light)} />
      {/* His orb in the middle, as in the conversation after it: what he says is in the transcript. */}
      <StephenOrb doing={saying === null ? "idle" : "speaking"} />
      <span {...stylex.props(visuallyHidden)}>
        {t`Step ${step} of ${total}`}
      </span>
      <div aria-hidden="true" {...stylex.props(styles.steps)}>
        {spots.map((each, place) => (
          <span
            key={each}
            {...stylex.props(styles.step, place === at && styles.stepOn)}
          />
        ))}
      </div>
      <h1 aria-live="polite" key={spot} {...stylex.props(visuallyHidden)}>
        {words[spot].shown}
      </h1>
    </div>
  );
};
