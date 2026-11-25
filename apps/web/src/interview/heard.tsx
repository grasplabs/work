import {
  colors,
  font,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { flightMs, landsAt, startFlight } from "@grasp-os/ui/lib/word-flight";
import type { Flight, Place } from "@grasp-os/ui/lib/word-flight";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef } from "react";

import { transcriptId } from "./transcript.tsx";

// What they say, written over the composer as they say it. The composer
// stays one slim row; their words stand above it, the newest line at its
// foot, at most three lines, the oldest fading out at the top. Each word
// that is heard leaves the composer's field as a few small squares
// (word-flight.ts), and its letters fade in where they land: opacity and a
// breath of blur, nothing else moves. When a line fills, the lines above
// glide up by one; they never jump. With reduced motion nothing flies and a
// word fades in where it stands. A screen reader is not read the words one
// by one: what they said is theirs, and it is in the transcript once sent.
//
// When what they said is kept, it is a line of the transcript from then on,
// and it is seen going there: the words lift off the composer, shrink and
// fade on their way to their line in the open transcript, which fades in as
// they reach it; with the transcript closed they go into its button, which
// answers with one soft beat. Words that are dropped just fade where they
// stand. With reduced motion nothing travels: they fade, and the line is there.

/** How far apart words that come together leave, in ms. */
const apartMs = 80;
/** How long a word's letters take to come, in ms. */
const fadeMs = 460;
/** How long the lines take to glide up by one, in ms. */
const glideMs = 280;
/** How long the words take to reach the transcript, in ms. */
const leaveMs = 700;
/** How the words travel there: off gently, and gently in. */
const travel = "cubic-bezier(0.45, 0, 0.2, 1)";
/** How long words that are only dropped take to go, in ms. */
const goneMs = 260;
/** The house curve: quick to start, long to settle. */
const settle = "cubic-bezier(0.22, 1, 0.36, 1)";

const REDUCED = media.reducedMotion;

const styles = stylex.create({
  // Over the composer, as wide as it is; the words start where the composer's own would.
  room: {
    position: "absolute",
    insetInline: 0,
    bottom: "100%",
    marginBlockEnd: space["3"],
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    boxSizing: "border-box",
    width: "100%",
    maxWidth: size.promptInputWidth,
    marginInline: "auto",
    // Always three lines and a half tall, so only a fourth line reaches the fade at its top.
    height: `calc(3.5 * ${font.textBaseLine})`,
    overflow: "hidden",
    paddingInline: space["4"],
    pointerEvents: "none",
    maskImage: `linear-gradient(to bottom, transparent 0, black calc(0.5 * ${font.textBaseLine}))`,
  },
  words: {
    margin: 0,
    color: colors.foreground,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    overflowWrap: "anywhere",
  },
  // A word keeps to itself as it comes, so its neighbours never move.
  word: { display: "inline-block" },
  // The air the squares fly through: over the words and the composer, and it takes no press.
  air: {
    position: "absolute",
    insetInline: 0,
    bottom: 0,
    zIndex: 2,
    display: { default: "block", [REDUCED]: "none" },
    width: "100%",
    // The composer's row and the words' room over it.
    height: `calc(100% + 4.5 * ${font.textBaseLine} + ${space["4"]})`,
    pointerEvents: "none",
  },
});

const nothing = () => {
  // Nothing to undo.
};

/** The words in a text, in order. */
const wordsIn = (text: string): string[] =>
  text.split(/\s+/u).filter((word) => word !== "");

/** A place in `within`, in its own pixels. */
const placeIn = (element: Element, within: Element): Place => {
  const box = element.getBoundingClientRect();
  const frame = within.getBoundingClientRect();
  return {
    x: box.left - frame.left,
    y: box.top - frame.top,
    width: box.width,
    height: box.height,
  };
};

/** Where the squares leave from: the composer's field of sound, or the middle of the air's foot. */
const fieldIn = (air: HTMLCanvasElement): Place => {
  const field = air.parentElement?.querySelector(
    '[data-slot="prompt-input-voice"] canvas'
  );
  if (field !== null && field !== undefined) {
    return placeIn(field, air);
  }
  const { width, height } = air.getBoundingClientRect();
  return { x: width * 0.25, y: height - 28, width: width * 0.5, height: 12 };
};

/** A word's letters come: out of nothing and a breath of blur, once its squares land. */
const fadeIn = (word: HTMLElement, delay: number, still: boolean) => {
  word.animate(
    still
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, filter: "blur(4px)" },
          { opacity: 1, filter: "blur(0)" },
        ],
    { duration: still ? 200 : fadeMs, delay, easing: settle, fill: "backwards" }
  );
};

/** Words `from` to `count` of `room` arrive: their squares leave the field, and each fades in as they land. */
const arrive = (
  room: HTMLElement,
  air: HTMLCanvasElement | null,
  flight: Flight | null,
  from: number,
  count: number
) => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const flies = !still && air !== null && flight !== null;
  const field = flies ? fieldIn(air) : null;
  const arrived = room.querySelectorAll<HTMLElement>("[data-word]");
  for (let index = from; index < count; index += 1) {
    const word = arrived[index];
    if (word !== undefined) {
      const leaves = (index - from) * apartMs;
      if (flies && field !== null) {
        flight.fly(field, placeIn(word, air), leaves);
      }
      fadeIn(word, leaves + (flies ? flightMs * landsAt : 0), still);
    }
  }
};

/** The lines glide up by `by` pixels to where they now stand. */
const glide = (room: HTMLElement, by: number) => {
  if (by > 0 && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    room.animate(
      [{ transform: `translateY(${by}px)` }, { transform: "none" }],
      { duration: glideMs, easing: settle }
    );
  }
};

/** What stood over the composer last: a copy of its room, and where it stood in the window. */
interface Stood {
  copy: HTMLElement;
  box: DOMRect;
}

/** The room as it stands now, copied: what leaves once its words are gone from the page. */
const stoodIn = (paragraph: HTMLElement): Stood | null => {
  const room = paragraph.parentElement;
  if (room === null) {
    return null;
  }
  const copy = room.cloneNode(true);
  if (!(copy instanceof HTMLElement)) {
    return null;
  }
  return { copy, box: room.getBoundingClientRect() };
};

/** Where their line goes: their newest line in the open transcript, else the transcript's button. */
const lineTaken = (): { to: HTMLElement; line: boolean } | null => {
  const lines = document.querySelectorAll<HTMLElement>(
    `#${transcriptId} [data-line-from="person"]`
  );
  const line = [...lines].at(-1);
  if (line !== undefined) {
    return { to: line, line: true };
  }
  const button = document.querySelector<HTMLElement>(
    `[data-transcript-button]`
  );
  return button === null ? null : { to: button, line: false };
};

/** The copy stands in the window where the room stood, over everything, and takes no press. */
const standing = ({ copy, box }: Stood): HTMLElement => {
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  Object.assign(holder.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    zIndex: "50",
    pointerEvents: "none",
    transformOrigin: "0 100%",
    willChange: "transform, opacity, filter",
  });
  Object.assign(copy.style, {
    position: "static",
    width: "100%",
    maxWidth: "none",
    margin: "0",
  });
  holder.append(copy);
  document.body.append(holder);
  return holder;
};

/** The words go: to their line in the transcript when `kept`, else out where they stand. */
const leave = (stood: Stood, kept: boolean) => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const taken = kept ? lineTaken() : null;
  const holder = standing(stood);
  const over = () => {
    holder.remove();
  };
  if (taken === null || still) {
    const going = holder.animate(
      still
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { opacity: 1, transform: "none", filter: "blur(0)" },
            {
              opacity: 0,
              transform: "translateY(-6px)",
              filter: "blur(3px)",
            },
          ],
      { duration: goneMs, easing: "ease-out", fill: "forwards" }
    );
    going.addEventListener("finish", over);
    going.addEventListener("cancel", over);
    return;
  }
  const { to, line } = taken;
  // Their line comes as the words reach it, never before.
  if (line) {
    to.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: fadeMs,
        delay: leaveMs * 0.5,
        easing: settle,
        fill: "backwards",
      }
    );
  } else {
    to.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(1.16)" },
        { transform: "scale(1)" },
      ],
      { duration: 420, delay: leaveMs * 0.72, easing: "ease-in-out" }
    );
  }
  // Measured a frame on: the transcript has made room for the line and followed it by then.
  requestAnimationFrame(() => {
    const goal = to.getBoundingClientRect();
    const { box } = stood;
    const scale = line
      ? Math.min(1, Math.max(0.55, goal.width / box.width))
      : 0.3;
    // The words' foot, where the newest stand, lands on the line's own foot, or in the button's middle.
    const x = line
      ? goal.left + (goal.width - box.width * scale) / 2
      : goal.left + goal.width / 2 - (box.width * scale) / 2;
    const y = line ? goal.bottom - 10 : goal.top + goal.height / 2;
    const dx = x - box.left;
    const dy = y - box.bottom;
    const going = holder.animate(
      [
        { opacity: 1, transform: "none", filter: "blur(0)" },
        { opacity: 0.85, filter: "blur(0)", offset: 0.4 },
        {
          opacity: 0,
          transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
          filter: "blur(2px)",
        },
      ],
      { duration: leaveMs, easing: travel, fill: "forwards" }
    );
    going.addEventListener("finish", over);
    going.addEventListener("cancel", over);
  });
};

/**
 * What they say, over the composer: `text` word by word as it is heard.
 * Once it is empty again the words leave: to the transcript when one more
 * of their lines was kept meanwhile (`sent` counts them), else they fade.
 * Placed as the composer's sibling inside a box of its own position: the
 * words stand over that box, and the air covers both.
 */
export const Heard = ({ text, sent }: { text: string; sent: number }) => {
  const words = wordsIn(text);
  const count = words.length;
  const room = useRef<HTMLParagraphElement>(null);
  const air = useRef<HTMLCanvasElement>(null);
  const flight = useRef<Flight | null>(null);
  // The words that stood there as it came: they never fly.
  const seen = useRef(count);
  const tall = useRef(0);
  // What stood there at the last draw with words in it, and how many lines of theirs were kept then.
  const stood = useRef<{ was: Stood; sent: number } | null>(null);
  useEffect(() => {
    const canvas = air.current;
    if (canvas === null) {
      return nothing;
    }
    const started = startFlight(canvas);
    flight.current = started;
    return () => {
      started.stop();
      flight.current = null;
    };
  }, []);
  // After every render: a word heard again differently can fill a line too.
  useLayoutEffect(() => {
    const paragraph = room.current;
    if (paragraph === null) {
      return;
    }
    const from = Math.min(seen.current, count);
    seen.current = count;
    const height = paragraph.offsetHeight;
    const grew = tall.current === 0 || count === 0 ? 0 : height - tall.current;
    tall.current = count === 0 ? 0 : height;
    if (count === 0) {
      const last = stood.current;
      stood.current = null;
      if (last !== null) {
        leave(last.was, sent > last.sent);
      }
      return;
    }
    if (from < count) {
      arrive(paragraph, air.current, flight.current, from, count);
    }
    glide(paragraph, grew);
    const was = stoodIn(paragraph);
    stood.current = was === null ? null : { was, sent };
  });
  return (
    <>
      <div aria-hidden="true" {...stylex.props(styles.room)}>
        <p ref={room} {...stylex.props(styles.words)}>
          {words.map((word, index) => (
            // A word is its place in the turn: one heard again differently stays where it is.
            <span key={index}>
              <span data-word="" {...stylex.props(styles.word)}>
                {word}
              </span>{" "}
            </span>
          ))}
        </p>
      </div>
      <canvas ref={air} aria-hidden="true" {...stylex.props(styles.air)} />
    </>
  );
};
