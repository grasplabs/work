import {
  colors,
  font,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

import { flightMs, landsAt, startFlight } from "./word-flight.ts";
import type { Flight, Place } from "./word-flight.ts";

// What they say, written over the composer as they say it. The composer
// stays one slim row; their words stand above it, the newest line at its
// foot, at most three lines, the oldest fading out at the top. Each word
// that is heard leaves the composer's field as a few small squares
// (word-flight.ts), and its letters fade in where they land: opacity and a
// breath of blur, nothing else moves. When a line fills, the lines above
// glide up by one; they never jump. With reduced motion nothing flies and a
// word fades in where it stands. A screen reader is not read the words one
// by one: what they said is theirs, and it is in the transcript once sent.

/** How far apart words that come together leave, in ms. */
const apartMs = 80;
/** How long a word's letters take to come, in ms. */
const fadeMs = 460;
/** How long the lines take to glide up by one, in ms. */
const glideMs = 280;
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

/**
 * What they say, over the composer: `text` word by word as it is heard, or
 * `children` in its place once there is more to show in it than words.
 * Placed as the composer's sibling inside a box of its own position: the
 * words stand over that box, and the air covers both.
 */
export const Heard = ({
  text,
  children,
}: {
  text: string;
  children?: ReactNode;
}) => {
  const words = wordsIn(text);
  const own = children !== undefined && children !== null;
  const count = own ? 0 : words.length;
  const room = useRef<HTMLParagraphElement>(null);
  const air = useRef<HTMLCanvasElement>(null);
  const flight = useRef<Flight | null>(null);
  // The words that stood there as it came: they never fly.
  const seen = useRef(count);
  const tall = useRef(0);
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
    const grew = tall.current === 0 ? 0 : height - tall.current;
    tall.current = height;
    if (from < count) {
      arrive(paragraph, air.current, flight.current, from, count);
    }
    glide(paragraph, grew);
  });
  return (
    <>
      <div
        aria-hidden={own ? undefined : "true"}
        {...stylex.props(styles.room)}
      >
        <p ref={room} {...stylex.props(styles.words)}>
          {own
            ? children
            : words.map((word, index) => (
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
