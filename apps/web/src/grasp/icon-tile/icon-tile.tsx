// IconTile: the small square that holds an object's own icon at the head of its inspector (an
// agent, a report, a person), after the tile on Profound's agent panel, made Grasp's: the system's
// squircle, and the colour rationed. Three forms: `raised`, white on the medium lift with the icon
// in the one accent; `tint`, a quiet wash of mint; and `gradient`, the pane of light Approve stands
// in, with its inner light. One tile per view.
//
//   <IconTile icon={Agent} look="gradient" />
//   <IconTile icon={Chart} look="tint" />
//   <IconTile icon={Agent} look="gradient" running />
//
// The spark: while the object is running, the gradient's light leans down once and stays leaned
// until it stops (no loop), over duration-ui. With reduced motion it moves at once.
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";

import { Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

export type IconTileLook = "raised" | "tint" | "gradient";

/** What a caller may style: where the tile sits. Never its look or its size. */
export type IconTileLayoutStyle = LayoutStyle;

/** Every prop an IconTile takes. */
export interface IconTileProps {
  /** The object's own icon: what kind of thing it is (an agent, a report). From the icons entry (`@/components/grasp/icons`). */
  icon: IconData;
  /**
   * `raised` for a quiet head, white with the icon in the accent; `tint` a wash of mint; `gradient`
   * the pane of light, for the one object a view is about.
   * @default "raised"
   */
  variant?: IconTileLook;
  /** @deprecated Use `variant`. */
  look?: IconTileLook;
  /**
   * The object is working now (an agent mid-run): the gradient's light leans down, once, and stays
   * until it stops. Say it in words too; the tile is decoration.
   * @default false
   */
  running?: boolean;
  /**
   * What the icon means, when no words beside it say so. Leave it out under a title (the usual
   * case): the tile is then hidden from screen readers.
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** @deprecated Use `layout`. */
  style?: IconTileLayoutStyle;
  /** Layout only: margins and alignment. */
  layout?: IconTileLayoutStyle;
}

const styles = stylex.create({
  tile: {
    [iconVars.size]: grasp.inspectorTileIcon,
    [iconVars.stroke]: grasp.iconStroke,
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: grasp.inspectorTile,
    height: grasp.inspectorTile,
    borderRadius: grasp.inspectorTileCorner,
    cornerShape: grasp.cornerShape,
    // Forced colours drop fills and shadows: an outline keeps the tile's square.
    outline: { default: "none", [media.forced]: "1px solid CanvasText" },
    outlineOffset: "-1px",
  },
  raised: {
    color: grasp.inspectorKind,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftMedium,
  },
  tint: {
    color: grasp.inspectorKind,
    backgroundColor: grasp.inspectorTileTint,
  },
  // The pane of light Approve stands in, with its inner light (the bevel). The light is taller than
  // the tile, so it can lean.
  gradient: {
    color: grasp.approveText,
    backgroundColor: grasp.approveFill,
    backgroundImage: grasp.approveLight,
    backgroundSize: grasp.approveLightSize,
    backgroundPosition: grasp.approveLightRest,
    boxShadow: grasp.bevelApprove,
    transitionProperty: "background-position",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  running: {
    backgroundPosition: grasp.approveLightLean,
  },
});

/** The tile for an object's own icon. */
export const IconTile = ({
  icon,
  look: lookDeprecated,
  variant: look = lookDeprecated ?? "raised",
  running = false,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  style: styleProp,
  layout,
}: IconTileProps) => {
  const named = label !== undefined && label !== "";
  return (
    <span
      data-slot="icon-tile"
      data-look={look}
      data-running={running ? "" : undefined}
      role={named ? "img" : undefined}
      aria-label={named ? label : undefined}
      aria-hidden={named ? undefined : true}
      {...stylex.props(
        styles.tile,
        styles[look],
        look === "gradient" && running && styles.running,
        layout ?? styleProp
      )}
    >
      <Icon icon={icon} />
    </span>
  );
};
