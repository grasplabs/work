// An agent's figure on a page: its shape in its palette (look.ts), live on a canvas (live.ts).
// Decorative beside the agent's name; with `label`, an image with a name. Every figure on the page
// shares one frame loop and draws only while in view; with reduced motion it is one still. In
// forced colours: a plain ring.
//
//   <AgentFigure look={lookOf(agent)} size="md" />
//   <AgentFigure look={look} size="xl" state="listening" follow label={name} />
//
// BUILDER: Damsko's Stephen with `shape` and `palette` is what this should be; until the library
// ships it, it lives here (see body.ts).
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { grasp, media } from "../../grasp/tokens/tokens.stylex.ts";
import type { FigureState } from "./body.ts";
import { mountAura, mountFigure } from "./live.ts";
import type { LiveFigure } from "./live.ts";
import { paletteColours } from "./look.ts";
import type { FigureLook } from "./look.ts";

/** sm 40, md 72, lg 128, xl 200 pixels. */
export type AgentFigureSize = "sm" | "md" | "lg" | "xl";

const pixels: Record<AgentFigureSize, number> = {
  sm: 40,
  md: 72,
  lg: 128,
  xl: 200,
};

const styles = stylex.create({
  box: {
    position: "relative",
    display: "inline-grid",
    flexShrink: 0,
    placeItems: "center",
  },
  canvas: {
    display: { default: "block", [media.forced]: "none" },
    width: "100%",
    height: "100%",
    imageRendering: "pixelated",
  },
  plain: {
    display: { default: "none", [media.forced]: "block" },
    width: "100%",
    height: "100%",
  },
  sm: { width: "40px", height: "40px" },
  md: { width: "72px", height: "72px" },
  lg: { width: "128px", height: "128px" },
  xl: { width: "200px", height: "200px" },
  // The aura fills the positioned box it stands in.
  aura: {
    position: "absolute",
    inset: 0,
    display: { default: "block", [media.forced]: "none" },
    width: "100%",
    height: "100%",
    imageRendering: "pixelated",
    pointerEvents: "none",
    backgroundColor: grasp.lightNight,
  },
});

/** A steady small number for a look, so figures side by side breathe out of step. */
const seedOf = (look: FigureLook): number =>
  (look.shape.length * 7 + look.palette.length * 3) % 11;

/** The live figure in `look`. */
export const AgentFigure = ({
  look,
  size = "md",
  state = "idle",
  follow = false,
  label,
}: {
  look: FigureLook;
  size?: AgentFigureSize;
  state?: FigureState;
  /** The light leans toward the pointer: for the one figure a screen is about. */
  follow?: boolean;
  /** Its name, alone; left out beside the agent's name, where it is decoration. */
  label?: string | undefined;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState<LiveFigure | null>(null);
  // Mounted once per size; a new look or pose reaches the live figure without mounting it again.
  const firstSeen = useRef({ look, state });
  useEffect(() => {
    const element = canvas.current;
    const first = firstSeen.current;
    if (element === null || typeof IntersectionObserver === "undefined") {
      return () => {
        // Nothing was mounted.
      };
    }
    const made = mountFigure(element, {
      size: pixels[size],
      state: first.state,
      shape: first.look.shape,
      colours: paletteColours[first.look.palette],
      follow,
      seed: seedOf(first.look),
    });
    setLive(made);
    return () => {
      made.stop();
    };
  }, [size, follow]);
  useEffect(() => {
    live?.pose(state, look.shape);
  }, [live, state, look.shape]);
  useEffect(() => {
    live?.recolour(paletteColours[look.palette]);
  }, [live, look.palette]);
  return (
    <span
      {...(label === undefined
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": label })}
      {...stylex.props(styles.box, styles[size])}
    >
      <canvas ref={canvas} {...stylex.props(styles.canvas)} />
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        {...stylex.props(styles.plain)}
      >
        <circle
          cx="12"
          cy="12"
          fill="none"
          r="10"
          stroke="CanvasText"
          strokeWidth="2"
        />
      </svg>
    </span>
  );
};

/** The palette's own night with its light rising behind a figure: the ground of an agent's card. */
export const AgentAura = ({
  look,
  bright = 1,
}: {
  look: FigureLook;
  /** How strong its light is, 0 to 1: lower behind a paused agent. */
  bright?: number;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const firstSeen = useRef({ look, bright });
  const [live, setLive] = useState<ReturnType<typeof mountAura> | null>(null);
  useEffect(() => {
    const element = canvas.current;
    const first = firstSeen.current;
    if (
      element === null ||
      typeof IntersectionObserver === "undefined" ||
      typeof ResizeObserver === "undefined"
    ) {
      return () => {
        // Nothing was mounted.
      };
    }
    const made = mountAura(element, {
      colours: paletteColours[first.look.palette],
      seed: seedOf(first.look),
      bright: first.bright,
    });
    setLive(made);
    return () => {
      made.stop();
    };
  }, []);
  useEffect(() => {
    live?.recolour(paletteColours[look.palette]);
  }, [live, look.palette]);
  return (
    <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.aura)} />
  );
};
