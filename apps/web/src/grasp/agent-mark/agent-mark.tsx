// AgentMark: an agent's face in Grasp's own hand. A small tile, dithered in the brand's light (night,
// ink, pine, mint, sea, lime, paper), drawn from the agent's name: the same name always gives the
// same tile, on the server and in the browser. Four compositions and three grounds, which a name
// chooses unless they are pinned.
//
//   <AgentMark name="Invoice chaser" />                          beside its name: decorative
//   <AgentMark name="Invoice chaser" label="Invoice chaser" />   alone: an image with a name
//   <AgentMark name="Invoice chaser" size="xl" composition="orb" ground="mint" develop />
//
// The tile is one field of light over the unit square, cut into cells and set in the seven stops by
// the system's ordered dither (src/dither/dither.ts, the 4×4 Bayer matrix). A larger tile samples
// the same field in more cells: the same picture at every size. Every cell is a whole number of
// pixels (2px, 3px at xl), so it is sharp at 1x and 2x.
//
// `develop` brings it into being in the dither's own order, a pass per threshold, by CSS alone: the
// passes are drawn from the first paint, each fading in after the last, so nothing is measured and
// the tile never changes size. With reduced motion it is whole at once. In forced colours: a plain
// bordered tile with the name's first letter.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";

import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { compositionOf, groundOf, markCells } from "./field";
import type { AgentMarkComposition, AgentMarkGround } from "./field";

/** xs 24, sm 32, md 40, lg 64, xl 72 pixels. */
export type AgentMarkSize = "xs" | "sm" | "md" | "lg" | "xl";

/** What a caller may style: where the mark sits. Never its look. */
export type AgentMarkLayoutStyle = LayoutStyle;

/** Every prop an AgentMark takes. */
export interface AgentMarkProps {
  /** The agent's name: it seeds the picture, so the same name always gives the same mark. */
  name: string;
  /**
   * How large: xs 24, sm 32, md 40 (a list), lg 64, xl 72 pixels (an agent's own page).
   * @default "md"
   */
  size?: AgentMarkSize;
  /** The picture: `rise`, `orb`, `horizon` or `beam`. Left out, the name chooses one. */
  composition?: AgentMarkComposition | undefined;
  /** What it stands on: `night`, `dusk` or `mint`. Left out, the name chooses one. */
  variant?: AgentMarkGround | undefined;
  /** @deprecated Use `variant`. */
  ground?: AgentMarkGround | undefined;
  /**
   * `true` brings the mark into being as it first shows, in the dither's order (whole at once with
   * reduced motion). A number from 0 to 1 holds it part made, for a caller that drives it.
   * @default false
   */
  develop?: boolean | number | undefined;
  /** Its name for a screen reader when it stands alone; left out, it is decorative beside a name. */
  "aria-label"?: string | undefined;
  /** @deprecated Use `aria-label`. */
  label?: string | undefined;
  /** Layout only: margins and alignment. */
  layout?: AgentMarkLayoutStyle;
}

/** How many cells a side, per size: 2px cells up to lg, 3px at xl. */
const cellsOf: Record<AgentMarkSize, number> = {
  xs: 12,
  sm: 16,
  md: 20,
  lg: 32,
  xl: 24,
};

/** How many passes the dither has: one per threshold of the 4×4 matrix. */
const PASSES = 16;

const appear = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const styles = stylex.create({
  tile: {
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    overflow: "hidden",
    cornerShape: grasp.cornerShape,
    backgroundColor: { default: grasp.lightNight, [media.forced]: "Canvas" },
    verticalAlign: "middle",
    color: { default: null, [media.forced]: "CanvasText" },
    // Forced colours drop shadows: the tile's own border draws its edge there.
    boxSizing: "border-box",
    borderStyle: { default: "none", [media.forced]: "solid" },
    borderWidth: { default: 0, [media.forced]: 1 },
    borderColor: { default: null, [media.forced]: "CanvasText" },
    // A hair inside the edge, so a dark tile still has an edge on the night page.
    "::after": {
      content: '""',
      position: "absolute",
      inset: 0,
      borderRadius: "inherit",
      cornerShape: grasp.cornerShape,
      boxShadow: `inset 0 0 0 ${grasp.hairline} ${grasp.line}`,
      pointerEvents: "none",
    },
  },
  // The ground's own darkest stop under the cells, so a pass not yet arrived shows the ground.
  dusk: {
    backgroundColor: { default: grasp.lightInk, [media.forced]: "Canvas" },
  },
  mint: {
    backgroundColor: { default: grasp.lightPine, [media.forced]: "Canvas" },
  },
  svg: {
    gridArea: "1 / 1",
    display: { default: "block", [media.forced]: "none" },
    width: "100%",
    height: "100%",
  },
  // The name's first letter: only in forced colours, where the dither is not drawn.
  letter: {
    gridArea: "1 / 1",
    display: { default: "none", [media.forced]: "block" },
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    lineHeight: 1,
  },
  xs: {
    width: grasp.avatarXs,
    height: grasp.avatarXs,
    borderRadius: grasp.cornerMark,
    fontSize: grasp.textXs,
  },
  sm: {
    width: grasp.avatarSm,
    height: grasp.avatarSm,
    borderRadius: `calc(${grasp.avatarSm} / 4)`,
    fontSize: grasp.textSm,
  },
  md: {
    width: grasp.avatarMd,
    height: grasp.avatarMd,
    borderRadius: `calc(${grasp.avatarMd} / 4)`,
    fontSize: grasp.textMd,
  },
  lg: {
    width: grasp.avatarXl,
    height: grasp.avatarXl,
    borderRadius: `calc(${grasp.avatarXl} / 4)`,
    fontSize: grasp.titleMd,
  },
  xl: {
    width: `calc(${grasp.avatarLg} * 1.5)`,
    height: `calc(${grasp.avatarLg} * 1.5)`,
    borderRadius: `calc(${grasp.avatarLg} * 1.5 / 4)`,
    fontSize: grasp.titleMd,
  },
  // A pass of the dither arriving: in the dither's order, the whole within simply.appear (300ms),
  // at once with reduced motion.
  arriving: {
    opacity: { default: 0, [media.reduced]: 1 },
    animationName: { default: appear, [media.reduced]: "none" },
    animationDuration: `calc(${simply.appear} / ${PASSES})`,
    animationTimingFunction: "steps(1, end)",
    animationFillMode: "forwards",
  },
  pass: (index: number) => ({
    animationDelay: `calc(${simply.appear} * ${index} / ${PASSES})`,
  }),
});

// The seven stops of the light, darkest first.
const stops = stylex.create({
  s0: { fill: grasp.lightNight },
  s1: { fill: grasp.lightInk },
  s2: { fill: grasp.lightPine },
  s3: { fill: grasp.lightMint },
  s4: { fill: grasp.lightSea },
  s5: { fill: grasp.lightLime },
  s6: { fill: grasp.lightPaper },
});
const stopStyles = [
  stops.s0,
  stops.s1,
  stops.s2,
  stops.s3,
  stops.s4,
  stops.s5,
  stops.s6,
] as const;

const groundStyles = {
  night: null,
  dusk: styles.dusk,
  mint: styles.mint,
} as const;

/** How many passes show when held part made: all of them when whole. */
const passesShown = (develop: boolean | number | undefined) => {
  if (typeof develop !== "number") {
    return PASSES;
  }
  return Math.round(Math.min(1, Math.max(0, develop)) * PASSES);
};

/** An agent's mark: a dithered tile in the brand's light, drawn from its name. */
export const AgentMark = ({
  name,
  size = "md",
  composition,
  ground: groundDeprecated,
  variant: ground = groundDeprecated,
  develop = false,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  layout,
}: AgentMarkProps) => {
  const chosen = ground ?? groundOf(name);
  const passes = markCells(
    name,
    composition ?? compositionOf(name),
    chosen,
    cellsOf[size]
  );
  const cells = cellsOf[size];
  const shown = passesShown(develop);
  const named = label !== undefined && label !== "";
  const point = name.trim().codePointAt(0);
  const first =
    point === undefined ? "" : String.fromCodePoint(point).toUpperCase();
  return (
    <span
      data-slot="agent-mark"
      role={named ? "img" : undefined}
      aria-label={named ? label : undefined}
      aria-hidden={named ? undefined : true}
      {...stylex.props(styles.tile, groundStyles[chosen], styles[size], layout)}
    >
      <svg
        viewBox={`0 0 ${cells} ${cells}`}
        shapeRendering="crispEdges"
        aria-hidden="true"
        focusable="false"
        {...stylex.props(styles.svg)}
      >
        {passes.slice(0, shown).map((stopsOfPass, index) => (
          <g
            key={index}
            {...stylex.props(
              develop === true && styles.arriving,
              develop === true && styles.pass(index)
            )}
          >
            {stopsOfPass.map((d, stop) =>
              d === "" ? null : (
                <path key={stop} d={d} {...stylex.props(stopStyles[stop])} />
              )
            )}
          </g>
        ))}
      </svg>
      <span aria-hidden="true" {...stylex.props(styles.letter)}>
        {first}
      </span>
    </span>
  );
};
