// What a dictation hears, written in the prompt input's text as it is heard. Each word leaves the
// voice's field in the bar as a few small squares (lib/word-flight.ts) and its letters fade in
// where it lands: after the words that were there, on their line, wrapping as they would.
//
// The editor is the product's text and takes no foreign node, so the words are drawn on a layer
// over it. The editor still holds them, unseen, after its text (its `data-interim`), which keeps
// its height and its wrapping right; the layer starts where the text ends and is set in the
// editor's own type, so each word stands exactly where the editor would put it, and where it
// stays once the product writes it in. With reduced motion nothing flies; a word fades in.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { colors, media } from "../lib/tokens.stylex";
import { flightMs, landsAt, startFlight } from "../lib/word-flight";
import type { Flight, Place } from "../lib/word-flight";

/** How far apart words that come together leave, in ms. */
const apartMs = 80;
/** How long a word's letters take to come, in ms. */
const fadeMs = 460;
/** The house curve: quick to start, long to settle. */
const settle = "cubic-bezier(0.22, 1, 0.36, 1)";

const styles = stylex.create({
  // Over the editor, clipped as it is; it takes no press, so the text under it is still typed in.
  layer: {
    position: "absolute",
    boxSizing: "border-box",
    overflow: "hidden",
    pointerEvents: "none",
    color: colors.foreground,
    textAlign: "start",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  words: { margin: 0 },
  // A word keeps to itself as it comes, so its neighbours never move.
  word: { display: "inline-block", textIndent: 0 },
  // The air the squares fly through: over the whole card, and it takes no press.
  air: {
    position: "fixed",
    zIndex: 50,
    display: { default: "block", [media.reducedMotion]: "none" },
    pointerEvents: "none",
  },
});

const nothing = () => {
  // Nothing to undo.
};

/** The words in a text, in order. */
const wordsIn = (text: string): string[] =>
  text.split(/\s+/u).filter((word) => word !== "");

/** A computed length in pixels, as a number; 0 for one that is none (`normal`). */
const px = (length: string): number => Number(length.replace("px", "")) || 0;

/** The last thing the editor holds: a piece of text with something in it, or an element. */
const lastIn = (editor: HTMLElement): Node | null => {
  let node: Node | null = editor.lastChild;
  while (
    node !== null &&
    node.nodeType === Node.TEXT_NODE &&
    node.nodeValue === ""
  ) {
    node = node.previousSibling;
  }
  return node;
};

/** Where the editor's text ends, in the window: the x after its last character, and that line's middle. */
const endOf = (
  editor: HTMLElement
): { x: number; middle: number; below: boolean } | null => {
  const last = lastIn(editor);
  if (last === null) {
    return null;
  }
  if (last instanceof HTMLElement) {
    const box = last.getBoundingClientRect();
    return { x: box.right, middle: box.top + box.height / 2, below: false };
  }
  const text = last.nodeValue ?? "";
  const range = document.createRange();
  range.setStart(last, text.length - 1);
  range.setEnd(last, text.length);
  const box = [...range.getClientRects()].at(-1);
  if (box === undefined) {
    return null;
  }
  // After a line's end the next word starts the line below.
  const below = text.endsWith("\n");
  return { x: box.right, middle: box.top + box.height / 2, below };
};

/** Sets the layer over the editor, in its type, starting where its text ends. */
const place = (editor: HTMLElement, layer: HTMLElement, words: HTMLElement) => {
  // The newest words are what is looked at.
  editor.scrollTop = editor.scrollHeight;
  const look = getComputedStyle(editor);
  const frame = editor.getBoundingClientRect();
  const line = px(look.lineHeight);
  const left = frame.left + px(look.paddingLeft);
  const top = frame.top + px(look.paddingTop);
  const end = endOf(editor);
  let indent = 0;
  let down = 0;
  if (end !== null) {
    indent = end.below ? 0 : Math.max(0, end.x - left);
    down = Math.max(
      0,
      Math.round(end.middle - line / 2 - top + (end.below ? line : 0))
    );
  }
  Object.assign(layer.style, {
    left: `${editor.offsetLeft}px`,
    top: `${editor.offsetTop}px`,
    width: `${editor.offsetWidth}px`,
    height: `${editor.offsetHeight}px`,
    padding: look.padding,
    font: look.font,
    letterSpacing: look.letterSpacing,
    lineHeight: look.lineHeight,
    direction: look.direction,
  });
  Object.assign(words.style, {
    paddingTop: `${down}px`,
    textIndent: `${indent}px`,
  });
};

/** A place in the window, as the air's own pixels. */
const placeIn = (element: Element, air: Element): Place => {
  const box = element.getBoundingClientRect();
  const frame = air.getBoundingClientRect();
  return {
    x: box.left - frame.left,
    y: box.top - frame.top,
    width: box.width,
    height: box.height,
  };
};

/** The air lies over the card the editor is in. */
const spread = (air: HTMLElement, card: Element) => {
  const box = card.getBoundingClientRect();
  Object.assign(air.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
};

/** Words `from` to `count` arrive: their squares leave the voice's field, and each fades in as they land. */
const arrive = (
  editor: HTMLElement,
  words: HTMLElement,
  air: HTMLCanvasElement | null,
  flight: Flight | null,
  [from, count]: [number, number]
) => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const card = editor.closest("form");
  const field =
    card?.querySelector('[data-slot="prompt-input-dictation"] canvas') ?? null;
  const flies = !still && air !== null && flight !== null && field !== null;
  if (flies && card !== null) {
    spread(air, card);
  }
  const arrived = words.querySelectorAll<HTMLElement>("[data-word]");
  for (let index = from; index < count; index += 1) {
    const word = arrived[index];
    if (word !== undefined) {
      const leaves = (index - from) * apartMs;
      if (flies) {
        flight.fly(placeIn(field, air), placeIn(word, air), leaves);
      }
      word.animate(
        still
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, filter: "blur(4px)" },
              { opacity: 1, filter: "blur(0)" },
            ],
        {
          duration: still ? 200 : fadeMs,
          delay: leaves + (flies ? flightMs * landsAt : 0),
          easing: settle,
          fill: "backwards",
        }
      );
    }
  }
};

/**
 * What a dictation hears so far (`interim`), drawn over `editor` after its text. A sibling of the
 * editor, in the same positioned box.
 */
export const PromptInputHeard = ({
  editor,
  interim,
}: {
  editor: HTMLElement | null;
  interim: string;
}) => {
  const heard = wordsIn(interim);
  const count = heard.length;
  const layer = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLParagraphElement>(null);
  const air = useRef<HTMLCanvasElement>(null);
  const flight = useRef<Flight | null>(null);
  // The words that stood there as it came: they never fly.
  const seen = useRef(count);
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
  // After every render: the text under it may have changed too.
  useLayoutEffect(() => {
    if (editor === null || layer.current === null || words.current === null) {
      return;
    }
    place(editor, layer.current, words.current);
    const from = Math.min(seen.current, count);
    seen.current = count;
    if (from < count) {
      arrive(editor, words.current, air.current, flight.current, [from, count]);
    }
  });
  return (
    <>
      <div
        ref={layer}
        aria-hidden="true"
        data-slot="prompt-input-heard"
        {...stylex.props(styles.layer)}
      >
        <p ref={words} {...stylex.props(styles.words)}>
          {heard.map((word, index) => (
            // A word is its place in what is heard: one heard again differently stays where it is.
            <span key={index}>
              {" "}
              <span data-word="" {...stylex.props(styles.word)}>
                {word}
              </span>
            </span>
          ))}
        </p>
      </div>
      {typeof document === "undefined"
        ? null
        : createPortal(
            <canvas
              ref={air}
              aria-hidden="true"
              {...stylex.props(styles.air)}
            />,
            document.body
          )}
    </>
  );
};
