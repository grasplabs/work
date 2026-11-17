import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { onThemeChange } from "../frame/theme.ts";
import {
  Backdrop,
  isDither,
  isSand,
  isScene,
} from "../grasp/backdrop/index.ts";
import type { BackdropLook as Look } from "../grasp/backdrop/index.ts";

// Still pictures of looks, for choosing one by sight (look-tiles.tsx). A
// browser allows only a handful of WebGL contexts, so no tile draws live:
// one hidden stage draws one look at a time with Grasp UI's Backdrop,
// at a tile's size, takes its picture (a data URL), lets the field go, and
// moves on to the next. Each picture is kept for this visit, by the look
// and, for what is drawn on the page's ground, the page's theme. Only the
// big preview stays live.

/** A tile's size in CSS pixels: what the stage draws at. */
export const pictureWidth = 160;
export const pictureHeight = 90;

/**
 * How long a look draws before its picture is taken: a scene waits for
 * its picture to load; a dither for its first frames; sand settles at once.
 */
const settleMs = { scene: 900, dither: 260, sand: 60 } as const;

const pictures = new Map<string, string>();
const queue: { key: string; look: Look }[] = [];
const listeners = new Set<() => void>();

const changed = (): void => {
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

/** The page's theme as theme.js set it: what a look on the page's ground is drawn in. */
const pageTheme = (): string => {
  const html = document.documentElement;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return `${html.className}|${html.dataset.theme ?? ""}|${html.dataset.graspTheme ?? ""}|${String(dark)}`;
};

const onPageTheme = (onChange: () => void): (() => void) => {
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", onChange);
  const stop = onThemeChange(onChange);
  return () => {
    scheme.removeEventListener("change", onChange);
    stop();
  };
};

/** Where a look's picture is kept: a scene is night in any theme. */
const keyOf = ({ backdrop, pattern, tone }: Look, theme: string): string => {
  if (isScene(backdrop)) {
    return backdrop;
  }
  // Only a dither is drawn in a pattern and a colour.
  return isDither(backdrop)
    ? `${backdrop}:${pattern}:${tone}:${theme}`
    : `${backdrop}:${theme}`;
};

const ask = (key: string, look: Look): void => {
  if (pictures.has(key) || queue.some((each) => each.key === key)) {
    return;
  }
  queue.push({ key, look });
  changed();
};

/** `look`'s still picture, once drawn; undefined until then, and for "none". */
export const useLookPicture = (look: Look): string | undefined => {
  const theme = useSyncExternalStore(onPageTheme, pageTheme);
  const key = keyOf(look, theme);
  const picture = useSyncExternalStore(subscribe, () => pictures.get(key));
  const { backdrop, pattern, tone } = look;
  useEffect(() => {
    if (backdrop !== "none") {
      ask(key, { backdrop, pattern, tone });
    }
  }, [key, backdrop, pattern, tone]);
  return picture;
};

const styles = stylex.create({
  // Drawn, never seen: out of the way of the pointer and of a screen reader.
  fill: { width: "100%", height: "100%" },
  stage: {
    position: "fixed",
    insetBlockStart: 0,
    insetInlineStart: 0,
    width: `${pictureWidth}px`,
    height: `${pictureHeight}px`,
    opacity: 0,
    pointerEvents: "none",
    isolation: "isolate",
    overflow: "hidden",
  },
});

/** How a look is drawn, for how long it draws before its picture. */
const familyOf = ({ backdrop }: Look): keyof typeof settleMs => {
  if (isScene(backdrop)) {
    return "scene";
  }
  return isSand(backdrop) ? "sand" : "dither";
};

/** The first look waiting for its picture. */
const first = () => queue.at(0);

/**
 * Draws the waiting looks one at a time and keeps their pictures. Mount
 * one wherever tiles ask for pictures.
 */
export const LookPictureStage = () => {
  const next = useSyncExternalStore(subscribe, first);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (next === undefined) {
      return () => {
        // Nothing drawing.
      };
    }
    const timer = setTimeout(() => {
      // Our own pictures, from this origin: a canvas that is always read.
      const canvas = stage.current?.querySelector("canvas");
      pictures.set(next.key, canvas?.toDataURL() ?? "");
      queue.shift();
      changed();
    }, settleMs[familyOf(next.look)]);
    return () => {
      clearTimeout(timer);
    };
  }, [next]);
  return (
    <div aria-hidden="true" ref={stage} {...stylex.props(styles.stage)}>
      {next === undefined ? null : (
        <Backdrop key={next.key} layout={styles.fill} variant={next.look} />
      )}
    </div>
  );
};
