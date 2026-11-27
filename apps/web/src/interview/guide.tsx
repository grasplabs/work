import type { Interviewer } from "@grasp-os/shared/onboarding";
import { Heading } from "@grasp-os/ui/components/heading";
import { fadeIn, visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";

import {
  Arrow,
  arrowCell,
  arrowCells,
  bezier,
  easeInOut,
  frames,
  isStill,
  wait,
} from "../onboarding/pixel-cursor.tsx";
import type { Point } from "../onboarding/pixel-cursor.tsx";
import { startLight } from "./guide-light.ts";
import { guideHeld, guideSays, guideStarts } from "./guide-said.ts";
import { keepNow, linkNow, update, useInterviewer } from "./kept.ts";
import { loopFirstName } from "./loop.ts";
import { prepare, say, stopSpeaking } from "./speech.ts";

// The guide before the first question: a quick walk round for whoever has
// never talked to an AI, once, after they agreed and before Stephen asks
// anything. Nothing to press: it plays by itself. Stephen's pixel cursor
// (the one he points with in the setup) moves over the window to each real
// control in turn while he says what it is for, and a fine dotted line of
// the system's dither settles round it (guide-light.ts): the answer box,
// "type instead", the language, the transcript and the pause. On the stage,
// where his questions will stand, a short line says the same in a few
// words. Each step lasts as long as he takes to say it; then the cursor
// goes and the conversation starts. Every control stays live meanwhile: a
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
  // His cursor: over everything, never in the way of a press, moved a frame at a time.
  cursor: {
    position: "fixed",
    insetBlockStart: 0,
    insetInlineStart: 0,
    zIndex: 4,
    pointerEvents: "none",
    opacity: 0,
    willChange: "transform",
    color: colors.primary,
    transitionProperty: { default: "opacity", [media.reducedMotion]: "none" },
    transitionDuration: "240ms",
    display: { default: "block", [media.forcedColors]: "none" },
  },
  cursorOn: { opacity: 1 },
  arrow: {
    display: "block",
    filter: "drop-shadow(1px 1px 0 rgb(0 0 0 / 0.12))",
  },
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

/** Where the cursor's tip rests on a control: a little into it, as a hand points. */
const pointOn = (element: Element): Point => {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + Math.min(rect.width * 0.5, 40 + rect.width * 0.12),
    y: rect.top + rect.height * 0.55,
  };
};

/** How long a step may last at most, however its line is said: it never hangs. */
const longestMs = (spoken: string): number =>
  4000 + spoken.split(/\s+/u).length * 520;

/** How long, at least, the cursor rests on a control once there. */
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

/** Moves `cursor` from where it is to `to`, on a hand's curve; at once under reduced motion. */
const moveTo = async (
  cursor: HTMLElement,
  from: Point,
  to: Point,
  signal: AbortSignal
): Promise<void> => {
  const place = (at: Point): void => {
    cursor.style.transform = `translate3d(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px, 0)`;
  };
  const far = Math.hypot(to.x - from.x, to.y - from.y);
  if (isStill() || far < 2) {
    place(to);
    return;
  }
  // A slight arc, as a wrist moves, never a straight rail.
  const bend = Math.min(80, far * 0.18);
  const c1 = {
    x: from.x + (to.x - from.x) * 0.3,
    y: from.y + (to.y - from.y) * 0.3 - bend,
  };
  const c2 = {
    x: from.x + (to.x - from.x) * 0.75,
    y: from.y + (to.y - from.y) * 0.75 - bend * 0.4,
  };
  const ms = Math.min(1100, 420 + far * 0.6);
  try {
    await frames(ms, signal, (t) => {
      place(bezier(from, c1, c2, to, easeInOut(t)));
    });
  } catch {
    // Stopped on the way: the walk goes no further.
  }
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
  cursor: RefObject<HTMLDivElement | null>;
  wordsNow: RefObject<Record<Spot, { shown: string; spoken: string }>>;
  /** Where the walk is, as far as it went before: read as it starts. */
  atNow: RefObject<number>;
  cursorAt: RefObject<Point | null>;
  /** Tells where it is now: the step, and where the cursor rests. */
  onMoved: (at: number, cursor: Point | null) => void;
  speaker: Interviewer;
  setAt: (at: number) => void;
  setShownCursor: (shown: boolean) => void;
}

/**
 * The walk itself, a step at a time, from where it is: drawn nothing of its
 * own. Started afresh, from the step it is on, in another language.
 */
const Walk = ({
  canvas,
  paint,
  cursor,
  wordsNow,
  atNow,
  cursorAt,
  onMoved,
  speaker,
  setAt,
  setShownCursor,
}: Held) => {
  useEffect(() => {
    const drawn = canvas.current;
    const pointer = cursor.current;
    if (drawn === null || pointer === null) {
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
        onMoved(place, cursorAt.current);
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
        if (target !== null) {
          const to = pointOn(target);
          // It comes in from the stage, under the line on screen, the first time.
          const stage = drawn.parentElement?.getBoundingClientRect();
          const from = cursorAt.current ?? {
            x: stage === undefined ? to.x : stage.left + stage.width / 2,
            y: stage === undefined ? to.y : stage.bottom + 24,
          };
          setShownCursor(true);
          // oxlint-disable-next-line no-await-in-loop -- one step after the other, as he says them
          await moveTo(pointer, from, to, signal);
          onMoved(place, to);
          light.aim(target);
        }
        const ended = async (): Promise<void> => {
          await Promise.all([said, pause(restMs, signal)]);
          await pause(apartMs, signal);
        };
        // oxlint-disable-next-line no-await-in-loop -- one step after the other, as he says them
        await orGone(ended(), signal);
        if (signal.aborted) {
          return;
        }
      }
      light.aim(null);
      setShownCursor(false);
      // The cursor fades before the conversation starts.
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
  }, [
    canvas,
    paint,
    cursor,
    wordsNow,
    atNow,
    cursorAt,
    onMoved,
    speaker,
    setAt,
    setShownCursor,
  ]);
  return null;
};

/**
 * The guide, on the stage in the questions' place, with his cursor and the
 * outline over the window. It plays by itself and, once through, starts
 * the conversation.
 */
export const Guide = () => {
  const { t, i18n } = useLingui();
  const words = useGuideWords(loopFirstName());
  const speaker = useInterviewer();
  const [at, setAt] = useState(() => reachedThisVisit);
  const [shownCursor, setShownCursor] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const paint = useRef<HTMLSpanElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  // Read by the walk as it goes: the words as they stand now, where it is, where the cursor is.
  const wordsNow = useRef(words);
  useEffect(() => {
    wordsNow.current = words;
  });
  const atNow = useRef(reachedThisVisit);
  const cursorAt = useRef<Point | null>(null);

  const spot = spots[at] ?? "ready";
  const step = at + 1;
  const total = spots.length;
  return (
    // His own cursor is the guide's here: the field doesn't also come to what it points at.
    <div data-field="still" {...stylex.props(styles.guide)}>
      {/* Again from the step it is on when the language changes, so he says it in the new one. */}
      <Walk
        atNow={atNow}
        canvas={canvas}
        cursor={cursor}
        cursorAt={cursorAt}
        onMoved={(place, point) => {
          atNow.current = place;
          reachedThisVisit = place;
          cursorAt.current = point;
        }}
        key={i18n.locale}
        paint={paint}
        setAt={setAt}
        setShownCursor={setShownCursor}
        speaker={speaker}
        wordsNow={wordsNow}
      />
      <span ref={paint} {...stylex.props(styles.paint)} />
      <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.light)} />
      <div
        aria-hidden="true"
        ref={cursor}
        {...stylex.props(styles.cursor, shownCursor && styles.cursorOn)}
      >
        <svg
          height={arrowCells.length * arrowCell}
          shapeRendering="crispEdges"
          width={10 * arrowCell}
          {...stylex.props(styles.arrow)}
        >
          <Arrow />
        </svg>
      </div>
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
      <div aria-live="polite" key={spot} {...stylex.props(fadeIn)}>
        <Heading level={1} size="xl">
          {words[spot].shown}
        </Heading>
      </div>
    </div>
  );
};
