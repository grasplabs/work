import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

import type { DitherKind, DitherTone } from "./dither.ts";
import { nothingDrawn } from "./drawing.ts";
import type { DrawOptions, Drawing } from "./drawing.ts";

// What stands behind Chat's start (chat-start.tsx), as #2503's Backdrop
// draws its first look, sand, and behind a page that failed
// (frame/page-states.tsx), its dusk dither in the aurora's greens: one
// canvas behind what stands in the box,
// on the page's own ground, faded out towards the box's foot and clear of
// it. Light on purpose: the sand (sand.ts) is loaded the first time the
// canvas comes into view, and drawn while it is in view and the tab is
// seen; otherwise it holds its last picture. With reduced motion it is one
// still picture. Damsko has no backdrop: it is the product's own (the
// rename map's "backdrop → apps/web/src/chat/backdrop/").

const styles = stylex.create({
  // The box, with what stands on it above the canvas, on the page's ground:
  // the page's whole area, a column what stands on it grows in.
  box: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    minHeight: "100%",
    backgroundColor: colors.background,
  },
  // The drawing, whole down to a band over the foot, faded out across it, then clear.
  foot: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    pointerEvents: "none",
    maskImage: `linear-gradient(to bottom, black calc(100% - ${space["20"]} - ${space["12"]}), transparent calc(100% - ${space["20"]}))`,
  },
  // Behind everything that stands in the box, in the sand's colours: its
  // grains (pine on a light ground, sea on a dark one), and its sparks,
  // the one grain in a few that is mint, as the outline.
  canvas: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    color: `light-dark(${colors.brandPine}, ${colors.brandSea})`,
    outlineStyle: "none",
    outlineColor: colors.mintDeep,
  },
  // A dither (#2503's, as New agent stands on it): each cell a crisp
  // square, in mint, faint, strongest in the far corners and thinning, in
  // strength, all the way in, so it has no edge to stop at.
  dithered: {
    color: `color-mix(in oklch, ${colors.brandMint} 28%, transparent)`,
    imageRendering: "pixelated",
    maskImage:
      "radial-gradient(150% 135% at 50% 110%, rgb(0 0 0 / 0.05) 0%, rgb(0 0 0 / 0.07) 40%, rgb(0 0 0 / 0.22) 62%, rgb(0 0 0 / 0.6) 80%, black 96%)",
  },
});

type Layout = string | number | null;

/**
 * What a caller may style: where the box sits, how big it is and how what
 * stands in it is laid out (#2503's BackdropLayoutStyle). Never its look.
 */
type BackdropLayout = stylex.StyleXStyles<{
  display?: Layout;
  boxSizing?: Layout;
  flexGrow?: Layout;
  width?: Layout;
  minWidth?: Layout;
  minHeight?: Layout;
  paddingInline?: Layout;
  paddingBlock?: Layout;
}>;

const REDUCED = "(prefers-reduced-motion: reduce)";

/** Starts the sand, or the dither, on `element`, loading it first; nothing, if it fails to load. */
const startQuietly = async (
  element: HTMLCanvasElement,
  options: DrawOptions,
  dither: DitherKind | undefined,
  tone: DitherTone
): Promise<Drawing> => {
  try {
    if (dither !== undefined) {
      const { startDither } = await import("./dither.ts");
      return startDither(element, dither, options, tone);
    }
    const { startSand } = await import("./sand.ts");
    return await startSand(element, options);
  } catch {
    return nothingDrawn;
  }
};

/**
 * Draws the sand on `element` while it is in view and the tab is seen,
 * loading it the first time it comes near the window. Returns what stops
 * it for good.
 */
const watch = (
  element: HTMLCanvasElement,
  clear: RefObject<HTMLElement | null>,
  dither: DitherKind | undefined,
  tone: DitherTone
): (() => void) => {
  const options: DrawOptions = {
    clear: () => clear.current?.getBoundingClientRect(),
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
    const started = await startQuietly(element, options, dither, tone);
    if (gone) {
      started.stop();
      return;
    }
    drawing = started;
    update();
  };
  const seen = new IntersectionObserver(
    (entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      if (inView && !loading) {
        // load() never rejects: sand that fails to start leaves the canvas clear.
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

/** The page's area, the sand drawn behind what stands in it, clear of `clear`. */
export const Backdrop = ({
  children,
  clear,
  dither,
  tone = "mint",
  style,
}: {
  children: ReactNode;
  /** The column of words on it: the sand fades out round it, so the words read. */
  clear: RefObject<HTMLElement | null>;
  /** A dither drawn in place of the sand (#2503's, in mint). */
  dither?: DitherKind;
  /** The dither's ink: faint mint, or the aurora's greens (a page that failed). */
  tone?: DitherTone;
  /** Layout only: under a page's bar, the room left (`minHeight: 0`) rather than the page's whole height. */
  style?: BackdropLayout;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    return element === null ? undefined : watch(element, clear, dither, tone);
  }, [clear, dither, tone]);
  return (
    <div data-slot="backdrop" {...stylex.props(styles.box, style)}>
      <div aria-hidden="true" {...stylex.props(styles.foot)}>
        <canvas
          ref={canvas}
          {...stylex.props(
            styles.canvas,
            dither !== undefined && styles.dithered
          )}
        />
      </div>
      {children}
    </div>
  );
};
