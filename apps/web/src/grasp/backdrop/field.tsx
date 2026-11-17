// The backdrop itself: one canvas, behind what stands in the box it fills. Light on purpose: what
// draws (sand.ts, shader.ts) is loaded the first time the canvas comes into view, and the scene
// pictures only when a scene draws. It draws while it is in view and the tab is seen, and holds its
// last picture otherwise. With reduced motion, or `still` (a picker's tile at rest), it is one still picture.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import { grasp } from "../tokens/tokens.stylex";
import { nothingDrawn } from "./drawing";
import type { DrawOptions, Drawing } from "./drawing";
import { isDither, isSand, isScene } from "./look";
import type { BackdropLook } from "./look";

const styles = stylex.create({
  // Behind everything that stands in the box (which isolates it), whatever that is.
  canvas: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  },
  // Sand's colours are what it draws in (sand.ts): its grains, and its sparks as the outline.
  sand: {
    color: grasp.backdropGrain,
    outlineStyle: "none",
    outlineColor: grasp.backdropSpark,
  },
  // A scene: each of its cells a crisp square, over the whole field.
  crisp: {
    imageRendering: "pixelated",
  },
  // Dithered: each cell a crisp square, strongest in the far corners and thinning, in strength,
  // all the way in: a wide ellipse from under the foot, but never clear, so the dither has no edge
  // to stop at. A trace of it runs on under the page's words.
  dithered: {
    imageRendering: "pixelated",
    maskImage: grasp.backdropDitherMask,
  },
});

// A dither's flat colour is the canvas's own colour, so the shader reads it as it resolves here,
// light or dark (backdrop-tone-*). The runs (rim, core, aurora) are drawn in the light's stops.
const tones = stylex.create({
  light: { color: grasp.backdropToneLight },
  deep: { color: grasp.backdropToneDeep },
  mint: { color: grasp.backdropToneMint },
  lime: { color: grasp.backdropToneLime },
  ink: { color: grasp.backdropToneInk },
  rim: { color: grasp.backdropToneLight },
  core: { color: grasp.backdropToneLight },
  aurora: { color: grasp.backdropToneLight },
});

const REDUCED = "(prefers-reduced-motion: reduce)";

/** What the canvas of one look is given. */
interface CanvasProps {
  look: BackdropLook;
  clear: RefObject<HTMLElement | null> | undefined;
  scenes: string;
  /** A small window on the look (a preview tile): its scene from the small picture. */
  small?: boolean;
  /** One picture and no more, as with reduced motion: a picker's tile at rest. */
  still?: boolean;
  /** How far the page has gone (Backdrop's `progress`). */
  progress?: BackdropProgress;
}

/**
 * How far the page has gone, 0 to 1, or `"scroll"` to read it from the box that scrolls the
 * backdrop (the share of it scrolled). A dither travels through its silk, its cells gather and its
 * ink lays stronger as it rises; a scene's silk turns. Left out, the look draws as it always has.
 */
export type BackdropProgress = number | "scroll";

/** The box that scrolls `element`: its nearest scrolling ancestor, else the document. */
const scrollerOf = (element: Element): Element => {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    if (/(?:auto|scroll)/u.test(getComputedStyle(at).overflowY)) {
      return at;
    }
  }
  return document.scrollingElement ?? document.documentElement;
};

/** The share of `box` scrolled, 0 to 1. */
const scrolledShare = (box: Element): number => {
  const travel = box.scrollHeight - box.clientHeight;
  return travel > 0 ? box.scrollTop / travel : 0;
};

/** Starts the drawer for `look` on `element`, loading it first. */
const start = async (
  element: HTMLCanvasElement,
  { backdrop, pattern, tone }: BackdropLook,
  options: DrawOptions,
  scenes: string,
  small: boolean
): Promise<Drawing | undefined> => {
  if (isSand(backdrop)) {
    const { startSand } = await import("./sand");
    return startSand(element, backdrop, options);
  }
  if (isScene(backdrop) || isDither(backdrop)) {
    const { startShader } = await import("./shader");
    return startShader(
      element,
      backdrop,
      { pattern, tone },
      { ...options, scenes, small }
    );
  }
  return undefined;
};

/** Starts the drawer, or nothing if it fails to load: the canvas then stays clear. */
const startQuietly = async (
  ...args: Parameters<typeof start>
): Promise<Drawing | undefined> => {
  try {
    return await start(...args);
  } catch {
    return nothingDrawn;
  }
};

/**
 * Draws `look` on `element` while it is in view and the tab is seen, loading its drawer the first
 * time it comes near the window. Returns what stops it for good.
 */
const watch = (
  element: HTMLCanvasElement,
  look: BackdropLook,
  clear: RefObject<HTMLElement | null> | undefined,
  scenes: string,
  small: boolean,
  progress: () => number,
  still: boolean
): (() => void) => {
  const options: DrawOptions = {
    clear: () => clear?.current?.getBoundingClientRect(),
    still: still || matchMedia(REDUCED).matches,
    progress,
  };
  let drawing: Drawing | undefined;
  let loading = false;
  let gone = false;
  let inView = false;
  const update = (): void => {
    drawing?.run(inView && document.visibilityState === "visible");
  };
  const load = async (): Promise<void> => {
    loading = true;
    const started = await startQuietly(element, look, options, scenes, small);
    if (gone) {
      started?.stop();
      return;
    }
    drawing = started;
    update();
  };
  // Loaded the first time it comes near the window; drawn only while it is in it.
  const seen = new IntersectionObserver(
    (entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      if (inView && !loading) {
        // load() never rejects: a drawer that fails to start leaves the canvas clear.
        void load();
      }
      update();
    },
    { rootMargin: "200px 0px" }
  );
  seen.observe(element);
  document.addEventListener("visibilitychange", update);
  return () => {
    gone = true;
    seen.disconnect();
    document.removeEventListener("visibilitychange", update);
    drawing?.stop();
  };
};

/** One look on its own canvas: a canvas holds one kind of drawing for good, so each look gets a new one. */
const Canvas = ({
  look,
  clear,
  scenes,
  small = false,
  still = false,
  progress,
}: CanvasProps) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The latest number given, read by the drawer at each picture, so a new value never restarts it.
  const given = useRef(0);
  const { backdrop, pattern, tone } = look;
  const follows = progress === "scroll";
  useEffect(() => {
    given.current = typeof progress === "number" ? progress : 0;
  }, [progress]);
  useEffect(() => {
    const element = canvas.current;
    const box = element !== null && follows ? scrollerOf(element) : null;
    const read = (): number =>
      box === null ? given.current : scrolledShare(box);
    return element === null
      ? undefined
      : watch(
          element,
          { backdrop, pattern, tone },
          clear,
          scenes,
          small,
          read,
          still
        );
  }, [backdrop, pattern, tone, clear, scenes, small, follows, still]);
  return (
    <canvas
      aria-hidden="true"
      data-slot="backdrop-canvas"
      data-backdrop={backdrop}
      ref={canvas}
      {...stylex.props(
        styles.canvas,
        isSand(backdrop) && styles.sand,
        isScene(backdrop) && styles.crisp,
        isDither(backdrop) && styles.dithered,
        isDither(backdrop) && tones[tone]
      )}
    />
  );
};

/** The look's canvas, or nothing for `"none"`; keyed by the look, so each look draws on a canvas of its own. */
export const BackdropField = ({
  look,
  clear,
  scenes,
  small = false,
  still = false,
  progress,
}: CanvasProps) => {
  if (look.backdrop === "none") {
    return null;
  }
  const key = isDither(look.backdrop)
    ? `${look.backdrop}:${look.pattern}:${look.tone}`
    : look.backdrop;
  return (
    <Canvas
      key={key}
      clear={clear}
      look={look}
      scenes={scenes}
      small={small}
      still={still}
      progress={progress}
    />
  );
};
