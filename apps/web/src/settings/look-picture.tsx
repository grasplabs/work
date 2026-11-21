import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { onThemeChange } from "../frame/theme.ts";
import { BackdropField } from "../grasp/backdrop/field.tsx";
import {
  defaultScenes,
  isDither,
  isSand,
  isScene,
} from "../grasp/backdrop/index.ts";
import type { BackdropLook as Look } from "../grasp/backdrop/index.ts";

// Still pictures of looks, for choosing one by sight (look-tiles.tsx). A
// browser allows only a handful of WebGL contexts, so no tile draws live:
// one hidden stage draws one look at a time with Grasp UI's backdrop field,
// still and small as its own picker's tiles are, at a tile's size, takes its
// picture (a data URL) as soon as it stands, lets the field go, and
// moves on to the next. Each picture is kept for this visit, by the look
// and, for what is drawn on the page's ground, the page's theme. Only the
// big preview stays live.

/** A tile's size in CSS pixels: what the stage draws at. */
const pictureWidth = 160;
const pictureHeight = 90;

/**
 * The longest a look draws before its picture is taken anyway. It is taken
 * as soon as it stands: a dither or sand once it has drawn, a scene once
 * its picture has come. Waiting these out for every look, the tiles took
 * nine seconds to fill.
 */
const settleMs = { scene: 900, dither: 260, sand: 60 } as const;

/** How long a scene waits, once its picture has come and its field has started, for the field to draw it. */
const sceneDrawMs = 150;

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
    const canvas = stage.current?.querySelector("canvas");
    let taken = false;
    const take = (): void => {
      if (taken) {
        return;
      }
      taken = true;
      // Our own pictures, from this origin: a canvas that is always read.
      pictures.set(next.key, canvas?.toDataURL() ?? "");
      queue.shift();
      changed();
    };
    const family = familyOf(next.look);
    const timers = [setTimeout(take, settleMs[family])];
    // A scene's picture, fetched here too: once it has come, the field's
    // own copy comes from the cache at once.
    let came = family !== "scene";
    const ready = (): void => {
      if (came && canvas?.dataset.drawn !== undefined) {
        timers.push(setTimeout(take, family === "scene" ? sceneDrawMs : 0));
      }
    };
    const watch = new MutationObserver(ready);
    if (canvas !== undefined && canvas !== null) {
      watch.observe(canvas, {
        attributes: true,
        attributeFilter: ["data-drawn"],
      });
    }
    if (isScene(next.look.backdrop)) {
      const picture = new Image();
      picture.addEventListener(
        "load",
        () => {
          came = true;
          ready();
        },
        { once: true }
      );
      picture.src = `${defaultScenes}${next.look.backdrop}.small.jpg`;
    }
    ready();
    return () => {
      watch.disconnect();
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [next]);
  return (
    <div aria-hidden="true" ref={stage} {...stylex.props(styles.stage)}>
      {next === undefined ? null : (
        <BackdropField
          key={next.key}
          look={next.look}
          clear={undefined}
          scenes={defaultScenes}
          small
          still
        />
      )}
    </div>
  );
};
