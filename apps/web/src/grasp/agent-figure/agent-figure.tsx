// AgentFigure: an agent's figure, AgentMark's big sibling. Damsko's Stephen, lit and dithered, in a
// shape and a palette of its own (look.ts, kept by the agent's id with `agentFigureOf`), in one of
// five poses: asleep, idle, listening, thinking, done. Taken over from the product (Ruben: "use
// Damsko's Stephen so each agent gets its own colours and shape").
// The main agent's look (`stephensLook`) has one eye in its orb's middle, alive (eye.ts): it follows
// the pointer on a spring, glances, blinks, and takes each state as a mood.
//
//   <AgentFigure look={agentFigureOf(agent.id)} size="md" state="idle" />
//   <AgentFigure look={look} size="xl" state="listening" follow aria-label="Stephen" />
//
// It paints cells on a small 2D canvas, scaled up crisp: no WebGL, so a page of any number holds no
// GPU context. Every figure on the page shares one frame loop, steps only while it is in view and
// the tab is shown, and repaints only when a cell changed. Nothing reacts to hover; only `follow`
// (on by default for the main agent) turns its attention to the pointer, a touch or a focused control. A new pose stands within 300ms. With reduced motion, or
// `still` (the default at list sizes), one picture of its pose. In forced colours: a plain ring.
// Decorative by default: the agent's name is its host's; `aria-label` makes it an image with a name.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import type { FigureState } from "./body";
import { mountAura, mountFigure } from "./live";
import type { LiveFigure } from "./live";
import { paletteColours, restingColours } from "./look";
import type { AgentFigureLook } from "./look";

/** xs 24 and sm 48 for a list, md 72, lg 128, xl 200 pixels. */
export type AgentFigureSize = "xs" | "sm" | "md" | "lg" | "xl";

/** What a caller may style: where it sits. Never its look or its size. */
export type AgentFigureLayoutStyle = LayoutStyle;

const pixels: Record<AgentFigureSize, number> = {
  xs: 24,
  sm: 48,
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
  xs: { width: "24px", height: "24px" },
  sm: { width: "48px", height: "48px" },
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
  // On the page's own ground: the canvas's fill before it draws is the page's paper, not the night.
  auraOnPage: {
    backgroundColor: grasp.paper,
  },
});

/** A steady small number for a look, so figures side by side breathe out of step. */
const seedOf = (look: AgentFigureLook): number =>
  (look.shape.length * 7 + look.palette.length * 3) % 11;

/** The list sizes, where a figure is still unless asked otherwise. */
const isListSize = (size: AgentFigureSize) => size === "xs" || size === "sm";

/** The colours a figure is drawn in: its palette, pulled toward moon's greys while it is asleep. */
const coloursOf = (look: AgentFigureLook, state: FigureState) =>
  state === "asleep"
    ? restingColours(look.palette)
    : paletteColours(look.palette);

/** How much quieter an aura is behind a sleeping figure. */
const RESTING_BRIGHT = 0.4;

/** The cleanup of an effect that started nothing. */
const keep = () => {
  // Nothing was mounted.
};

/** Every prop an AgentFigure takes. */
export interface AgentFigureProps {
  /** Its shape and palette: `agentFigureOf(agent.id)` keeps one by the agent's id. */
  look: AgentFigureLook;
  /**
   * xs 24 and sm 48 in a list, md 72 in a card, lg 128 and xl 200 for the one agent a screen is about.
   * @default "md"
   */
  size?: AgentFigureSize;
  /**
   * Its pose: `asleep` (paused), `idle`, `listening`, `thinking` or `done`. Say the state in words
   * beside it: the pose is decoration.
   * @default "idle"
   */
  state?: FigureState;
  /**
   * It turns its attention to the pointer, a touch, or the control the keyboard focuses: the main
   * agent's eye looks there on a spring, and the light leans after it. For the one figure a screen
   * is about. Off, nothing on the figure answers the pointer.
   * @default true for the main agent's look (`stephensLook`), false for every other
   */
  follow?: boolean;
  /**
   * One picture of its pose, never moving: a page of many figures in a list.
   * @default true at xs and sm, false above
   */
  still?: boolean;
  /** Its name, when nothing beside it says it: then an image with that name. Left out, it is decoration. */
  "aria-label"?: string;
  /** Where it sits. */
  layout?: AgentFigureLayoutStyle;
}

/** The figure, live (or still) on its canvas. */
export const AgentFigure = ({
  look,
  size = "md",
  state = "idle",
  follow: followGiven,
  still: stillGiven,
  "aria-label": label,
  layout,
}: AgentFigureProps) => {
  const still = stillGiven ?? isListSize(size);
  const follow = followGiven ?? look.eye === true;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState<LiveFigure | null>(null);
  // Mounted once per size; a new look or pose reaches the live figure without mounting it again.
  const firstSeen = useRef({ look, state });
  useEffect(() => {
    const element = canvas.current;
    const first = firstSeen.current;
    if (element === null || typeof IntersectionObserver === "undefined") {
      return keep;
    }
    const made = mountFigure(element, {
      size: pixels[size],
      state: first.state,
      shape: first.look.shape,
      colours: coloursOf(first.look, first.state),
      follow,
      seed: seedOf(first.look),
      still,
      eye: first.look.eye === true,
    });
    setLive(made);
    return () => {
      made.stop();
    };
  }, [size, follow, still]);
  const eye = look.eye === true;
  useEffect(() => {
    live?.pose(state, look.shape, eye);
  }, [live, state, look.shape, eye]);
  const asleep = state === "asleep";
  useEffect(() => {
    live?.recolour(
      asleep ? restingColours(look.palette) : paletteColours(look.palette)
    );
  }, [live, look.palette, asleep]);
  return (
    <span
      data-slot="agent-figure"
      data-shape={look.shape}
      data-palette={look.palette}
      data-eye={eye ? "" : undefined}
      data-state={state}
      {...(label === undefined
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": label })}
      {...stylex.props(styles.box, styles[size], layout)}
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

/**
 * An aura's colours: its ground, then its lights, deep to bright. On the page its ground is the
 * page's paper (both themes), and its glow starts a step up the palette's lights: the deepest
 * read as near ink on paper, a dark speckle; one step up they read as the palette's own light.
 */
const auraColours = (
  look: AgentFigureLook,
  state: FigureState,
  onPage: boolean
) => {
  const colours = coloursOf(look, state);
  return onPage ? ["var(--grasp-paper)", ...colours.slice(2)] : colours;
};

/** Every prop an AgentFigureAura takes. */
export interface AgentFigureAuraProps {
  /** The figure's look: the aura is its palette's own night, its light rising behind it. */
  look: AgentFigureLook;
  /**
   * How strong its light is, 0 to 1.
   * @default 1
   */
  bright?: number;
  /**
   * The figure's state: behind an `asleep` figure the aura rests with it, greyed and dimmed.
   * @default "idle"
   */
  state?: FigureState;
  /**
   * What it stands on: `night`, the palette's own night (an agent's card); `page`, the page's own
   * ground in both themes (a figure in a page's flow), its glow in the palette's lights.
   * @default "night"
   */
  ground?: "night" | "page";
}

/**
 * The palette's own night with its light rising behind a figure: the ground of an agent's card. It
 * fills the positioned box it stands in. Its points of light drift slowly while in view; with
 * reduced motion it is still. Decorative.
 */
export const AgentFigureAura = ({
  look,
  bright = 1,
  state = "idle",
  ground = "night",
}: AgentFigureAuraProps) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const asleep = state === "asleep";
  const onPage = ground === "page";
  const firstSeen = useRef({
    look,
    state,
    onPage,
    bright: asleep ? bright * RESTING_BRIGHT : bright,
  });
  const [live, setLive] = useState<ReturnType<typeof mountAura> | null>(null);
  useEffect(() => {
    const element = canvas.current;
    const first = firstSeen.current;
    if (
      element === null ||
      typeof IntersectionObserver === "undefined" ||
      typeof ResizeObserver === "undefined"
    ) {
      return keep;
    }
    const made = mountAura(element, {
      colours: auraColours(first.look, first.state, first.onPage),
      seed: seedOf(first.look),
      bright: first.bright,
    });
    setLive(made);
    return () => {
      made.stop();
    };
  }, []);
  useEffect(() => {
    live?.recolour(auraColours(look, state, onPage));
  }, [live, look, state, onPage]);
  useEffect(() => {
    live?.brighten(asleep ? bright * RESTING_BRIGHT : bright);
  }, [live, bright, asleep]);
  return (
    <canvas
      aria-hidden="true"
      data-slot="agent-figure-aura"
      data-ground={ground}
      ref={canvas}
      {...stylex.props(styles.aura, onPage && styles.auraOnPage)}
    />
  );
};
