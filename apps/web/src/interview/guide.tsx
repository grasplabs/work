import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { fadeIn, visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { startLight } from "./guide-light.ts";
import { keepNow, linkNow, update, useInterviewer } from "./kept.ts";
import { prepare, say, stopSpeaking } from "./speech.ts";

// The guide before the first question: a quick look round for whoever has
// never talked to an AI, once, after they agreed and before Stephen asks
// anything. One thing at a time, on the stage where his questions will
// stand: a short line on screen, Stephen saying it more warmly out loud
// (as he talks round his questions), and his light, the system's dither,
// pooling round the real control it is about (guide-light.ts), gliding to
// the next. They can talk or type (the card at the foot), change the
// language (the header), read everything back (the transcript) and pause;
// then it gets out of the way. Every control stays live while it is
// lit: the language picked here changes the guide's words at once. Skip
// is always there. Seen once on this device for this link, and never once
// anything is said.

/** What the guide shows, in order: the control each step lights, by the mark it carries. */
const spots = ["answer", "language", "transcript", "pause", "ready"] as const;
type Spot = (typeof spots)[number];

/** Where each step's light goes; the last goes back to where they start. */
const targetOf: Record<Spot, string> = {
  answer: '[data-guide="answer"] [data-slot="prompt-input"]',
  language: '[data-guide="language"]',
  transcript: "[data-transcript-button]",
  pause: '[data-guide="pause"]',
  ready: '[data-guide="answer"] [data-slot="prompt-input"]',
};

const styles = stylex.create({
  // The light over the whole window: seen, never pressed, never read out.
  light: {
    position: "fixed",
    inset: 0,
    width: "100vw",
    height: "100svh",
    zIndex: 3,
    pointerEvents: "none",
    display: { default: "block", [media.forcedColors]: "none" },
  },
  // Where the light's colour is read from: the system's mint, as it stands in light or dark.
  paint: { display: "none", color: colors.mint },
  guide: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["6"],
    textAlign: "center",
    textWrap: "balance",
  },
  // How far along: a square for each step, in the system's pixel, the one they are on lit.
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
  ways: {
    display: "flex",
    gap: space["2"],
    justifyContent: "center",
    flexWrap: "wrap",
  },
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

/** Whether they went through the guide, or skipped it, on this link here. */
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

/** Done with the guide: the minutes count from here, not from the yes. */
const guidedNowOn = (): void => {
  setGuided(true);
  const at = Date.now();
  update((was) =>
    was.lines.length === 0 ? { ...was, startedAt: at, seenAt: at } : was
  );
  keepNow();
};

// ---- Words -------------------------------------------------------------------------------

/** Each step: the short line on screen, and what Stephen says round it. */
const useGuideWords = (): Record<Spot, { shown: string; spoken: string }> => {
  const { t } = useLingui();
  return {
    answer: {
      shown: t`Talk to me, or type. Whichever feels easiest.`,
      spoken: t`Before we start, a quick look around. You can just talk to me like you would to a colleague. Prefer to type? That works just as well.`,
    },
    language: {
      shown: t`Your language, whenever you like.`,
      spoken: t`Up here you can switch languages anytime—even halfway through. I’ll switch right along with you.`,
    },
    transcript: {
      shown: t`Everything we say, written down.`,
      spoken: t`Here you’ll find everything we say, written out. You can read it back, fix a word, or remove anything you want.`,
    },
    pause: {
      shown: t`Need a moment? Pause.`,
      spoken: t`If you need a break, just hit Pause—we’ll pick up right where we left off.`,
    },
    ready: {
      shown: t`That’s all. There are no wrong answers.`,
      spoken: t`That’s all there is to it. There are no wrong answers here—I just want to hear how your day-to-day really works. Ready when you are.`,
    },
  };
};

// ---- The guide ---------------------------------------------------------------------------

const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Whether the control `spot` is about is on screen here: a window may not show every one. */
const onScreen = (spot: Spot | undefined): boolean => {
  const element =
    spot === undefined ? null : document.querySelector(targetOf[spot]);
  if (element === null) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

/** His light round the control `spot` is about. */
const useLight = (spot: Spot) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const paint = useRef<HTMLSpanElement>(null);
  const light = useRef<ReturnType<typeof startLight> | null>(null);
  useEffect(() => {
    const drawn = canvas.current;
    if (drawn === null) {
      return () => {
        light.current = null;
      };
    }
    const started = startLight(
      drawn,
      () =>
        paint.current === null ? "" : getComputedStyle(paint.current).color,
      reducedMotion()
    );
    light.current = started;
    return () => {
      started.stop();
      light.current = null;
    };
  }, []);
  useEffect(() => {
    light.current?.aim(document.querySelector(targetOf[spot]));
  }, [spot]);
  return { canvas, paint };
};

/**
 * The guide, on the stage in the questions' place, with his light over the
 * window; `onDone` once they went through it or skipped it.
 */
export const Guide = ({ onDone }: { onDone?: () => void }) => {
  const { t } = useLingui();
  const words = useGuideWords();
  const speaker = useInterviewer();
  const [at, setAt] = useState(0);
  const spot = spots[at] ?? "ready";
  const { shown, spoken } = words[spot];
  // On, past a control this window doesn't show.
  const nextAt = (): number => {
    let place = at + 1;
    while (place < spots.length - 1 && !onScreen(spots[place])) {
      place += 1;
    }
    return place;
  };
  const next = spots[at + 1];
  const { canvas, paint } = useLight(spot);

  // Said as each step comes, and again in another language; the next fetched meanwhile.
  const nextSpoken = next === undefined ? null : words[next].spoken;
  useEffect(() => {
    const voicing = { speaker, tone: "warm, relaxed" } as const;
    void say(spoken, voicing);
    if (nextSpoken !== null) {
      prepare(nextSpoken, voicing);
    }
    return () => {
      stopSpeaking();
    };
  }, [spoken, nextSpoken, speaker]);

  const done = (): void => {
    stopSpeaking();
    guidedNowOn();
    onDone?.();
  };
  const last = at >= spots.length - 1;
  const step = at + 1;
  const total = spots.length;
  return (
    // His own light is the guide's here: the field doesn't also come to the buttons pressed.
    <div data-field="still" {...stylex.props(styles.guide)}>
      <span ref={paint} {...stylex.props(styles.paint)} />
      <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.light)} />
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
          {shown}
        </Heading>
      </div>
      <div {...stylex.props(styles.ways)}>
        {last ? null : (
          <Button onClick={done} size="lg" variant="ghost">
            {t`Skip`}
          </Button>
        )}
        <Button
          key={spot}
          onClick={() => {
            if (last) {
              done();
            } else {
              setAt(nextAt());
            }
          }}
          size="lg"
        >
          {t`Continue`}
        </Button>
      </div>
    </div>
  );
};
