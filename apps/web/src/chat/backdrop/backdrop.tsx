import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

import { nothingDrawn } from "./drawing.ts";
import type { DrawOptions, Drawing } from "./drawing.ts";

// What stands behind Chat's start (chat-start.tsx), as #2503's Backdrop
// draws its first look, sand: one canvas behind what stands in the box,
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
});

const REDUCED = "(prefers-reduced-motion: reduce)";

/** Starts the sand on `element`, loading it first; nothing, if it fails to load. */
const startQuietly = async (
  element: HTMLCanvasElement,
  options: DrawOptions
): Promise<Drawing> => {
  try {
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
  clear: RefObject<HTMLElement | null>
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
    const started = await startQuietly(element, options);
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
}: {
  children: ReactNode;
  /** The column of words on it: the sand fades out round it, so the words read. */
  clear: RefObject<HTMLElement | null>;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    return element === null ? undefined : watch(element, clear);
  }, [clear]);
  return (
    <div data-slot="backdrop" {...stylex.props(styles.box)}>
      <div aria-hidden="true" {...stylex.props(styles.foot)}>
        <canvas ref={canvas} {...stylex.props(styles.canvas)} />
      </div>
      {children}
    </div>
  );
};
