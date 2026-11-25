// The backdrop itself: one canvas, behind what stands in the box it fills. Light on purpose: what
// draws (sand.ts, shader.ts) is loaded the first time the canvas comes into view, and the scene
// pictures only when a scene draws. It draws while it is in view and the tab is seen, and holds its
// last picture otherwise. With reduced motion it is one still picture. #2503's library's Backdrop
// field, as it is; Damsko has no Backdrop.
import { duration, media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import { backdrop as tokens } from "./backdrop.stylex.ts";
import { nothingDrawn } from "./drawing.ts";
import type { DrawOptions, Drawing } from "./drawing.ts";
import { isDither, isSand, isScene } from "./look.ts";
import type { BackdropLook } from "./look.ts";

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
    color: tokens.grain,
    outlineStyle: "none",
    outlineColor: tokens.spark,
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
    maskImage: tokens.ditherMask,
  },
  // What the first paint shows, before the page's script has run and the canvas has drawn: a still
  // of the look in the server's HTML, under the canvas, fading out once the canvas says it drew: a
  // dither's, a soft glow of its own tone under its own mask. A drawer that fails to start leaves the still.
  still: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    pointerEvents: "none",
    backgroundSize: "cover",
    backgroundPosition: "center",
    opacity: { default: 1, ":has(+ canvas[data-drawn])": 0 },
    transitionProperty: "opacity",
    transitionDuration: { default: duration.ui, [media.reducedMotion]: "0s" },
  },
  stillDither: {
    backgroundImage:
      "radial-gradient(130% 85% at 50% 0%, currentColor 0%, transparent 72%), radial-gradient(60% 60% at 92% 4%, currentColor 0%, transparent 70%)",
  },
});

// A dither's flat colour is the canvas's own colour, so the shader reads it as it resolves here,
// light or dark (backdrop-tone-*). The runs (rim, core, aurora) are drawn in the light's stops.
export const toneColours = stylex.create({
  light: { color: tokens.toneLight },
  deep: { color: tokens.toneDeep },
  mint: { color: tokens.toneMint },
  lime: { color: tokens.toneLime },
  ink: { color: tokens.toneInk },
  rim: { color: tokens.toneLight },
  core: { color: tokens.toneLight },
  aurora: { color: tokens.toneLight },
});

const REDUCED = "(prefers-reduced-motion: reduce)";

/** What the canvas of one look is given. */
interface CanvasProps {
  look: BackdropLook;
  clear: RefObject<HTMLElement | null> | undefined;
  /** A small window on the look (the preview): its scene from the small picture. */
  small?: boolean;
}

/** Where the scene pictures are served from (the web app's public/backdrops/). */
const scenes = "/backdrops/";

/** Starts the drawer for `look` on `element`, loading it first. */
const start = async (
  element: HTMLCanvasElement,
  { backdrop, pattern, tone }: BackdropLook,
  options: DrawOptions,
  small: boolean
): Promise<Drawing | undefined> => {
  if (isSand(backdrop)) {
    const { startSand } = await import("./sand.ts");
    return await startSand(element, backdrop, options);
  }
  if (isScene(backdrop) || isDither(backdrop)) {
    const { startShader } = await import("./shader.ts");
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
  small: boolean
): (() => void) => {
  const options: DrawOptions = {
    clear: () => clear?.current?.getBoundingClientRect(),
    still: matchMedia(REDUCED).matches,
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
    const started = await startQuietly(element, look, options, small);
    if (gone) {
      started?.stop();
      return;
    }
    drawing = started;
    update();
    // The still under the canvas fades out once the canvas has its first picture.
    if (started !== undefined && started !== nothingDrawn) {
      requestAnimationFrame(() => {
        element.dataset.drawn = "";
      });
    }
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
const Canvas = ({ look, clear, small = false }: CanvasProps) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { backdrop, pattern, tone } = look;
  useEffect(() => {
    const element = canvas.current;
    return element === null
      ? undefined
      : watch(element, { backdrop, pattern, tone }, clear, small);
  }, [backdrop, pattern, tone, clear, small]);
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
        isDither(backdrop) && toneColours[tone]
      )}
    />
  );
};

/** The look's still, in the first HTML: a dither's glow in its own tone; a scene and sand have none. */
// A scene has no still: its canvas is not opaque where it dims round its words, and a picture
// under it would show through there, below the words' 4.5:1 (measured 2.56:1 on Aurora).
export const Still = ({ look }: { look: BackdropLook }) => {
  if (isDither(look.backdrop)) {
    return (
      <span
        aria-hidden="true"
        data-slot="backdrop-still"
        {...stylex.props(
          styles.still,
          styles.stillDither,
          styles.dithered,
          toneColours[look.tone]
        )}
      />
    );
  }
  return null;
};

/** The look's canvas, or nothing for `"none"`; keyed by the look, so each look draws on a canvas of its own. */
export const BackdropField = ({ look, clear, small = false }: CanvasProps) => {
  if (look.backdrop === "none") {
    return null;
  }
  const key = isDither(look.backdrop)
    ? `${look.backdrop}:${look.pattern}:${look.tone}`
    : look.backdrop;
  return (
    <>
      <Still key={`still-${key}`} look={look} />
      <Canvas key={key} clear={clear} look={look} small={small} />
    </>
  );
};
