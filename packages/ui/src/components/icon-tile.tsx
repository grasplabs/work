// IconTile: the small square that holds an object's own icon at the head of its details (an
// agent, a report, a person), in the system's squircle with the colour rationed. Three variants:
// `default`, white on the medium lift with the icon in the one accent; `tinted`, a quiet wash of
// mint; and `gradient`, the pane of light the success colour stands in, with its inner light. One
// tile per view.
//
//   <IconTile icon={ChartColumnIcon} variant="tinted" />
//   <IconTile icon={WandSparklesIcon} variant="gradient" loading />
//
// While the object is working, the gradient's light leans down once and stays leaned until it
// stops (no loop), over duration-ui. With reduced motion it moves at once.
//
// Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";

import { Icon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import {
  colors,
  duration,
  media,
  radius,
  shadow,
  size as sizes,
} from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";

/** The tile's ground: white and raised, a tint, or the pane of light. */
export type IconTileVariant = "default" | "tinted" | "gradient";

/** Every prop an IconTile takes. */
export interface IconTileProps {
  /** The object's own icon: what kind of thing it is (an agent, a report). From lib/icons. */
  icon: IconData;
  /**
   * `default` for a quiet head, white with the icon in the accent; `tinted` a wash of mint;
   * `gradient` the pane of light, for the one object a view is about.
   * @default "default"
   */
  variant?: IconTileVariant;
  /**
   * `default`, the 40px tile at the head of a details panel; `sm`, a 24px tile for an object in a
   * table's row, which keeps the row at its dense height (give the column `control`).
   * @default "default"
   */
  size?: "sm" | "default";
  /**
   * The object is working now (an agent mid-run): the gradient's light leans down, once, and stays
   * until it stops. Say it in words too; the tile is decoration.
   * @default false
   */
  loading?: boolean;
  /**
   * What the icon means, when no words beside it say so. Leave it out under a title (the usual
   * case): the tile is then hidden from screen readers.
   */
  "aria-label"?: string;
  /** Layout only: margins and alignment. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  tile: {
    [iconVars.size]: sizes.iconTileIcon,
    [iconVars.stroke]: sizes.iconStroke,
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: sizes.iconTile,
    height: sizes.iconTile,
    // The tile's corner, as BrandIcon's at the same size: the one corner capped at half.
    borderRadius: `min(${radius.base}, calc(${sizes.iconTile} / 2))`,
    cornerShape: radius.shape,
    // Forced colours drop fills and shadows: an outline keeps the tile's square.
    outline: { default: "none", [media.forcedColors]: "1px solid CanvasText" },
    outlineOffset: "-1px",
  },
  default: {
    color: colors.iconTileForeground,
    backgroundColor: colors.card,
    boxShadow: shadow.md,
  },
  tinted: {
    color: colors.iconTileForeground,
    backgroundColor: colors.iconTileTint,
  },
  // The pane of light the success colour stands in, with its inner light (the bevel). The light is
  // taller than the tile, so it can lean.
  gradient: {
    color: colors.successFillForeground,
    backgroundColor: colors.successFill,
    backgroundImage: colors.successLight,
    backgroundSize: sizes.successLightSize,
    backgroundPosition: sizes.successLightRest,
    boxShadow: shadow.bevelSuccess,
    transitionProperty: "background-position",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  loading: {
    backgroundPosition: sizes.successLightLean,
  },
  // The small tile, for a dense row: its square, its icon and its corner a size down.
  sm: {
    [iconVars.size]: sizes.iconTileSmIcon,
    width: sizes.iconTileSm,
    height: sizes.iconTileSm,
    borderRadius: radius.mark,
    cornerShape: radius.shape,
  },
  // A lift for the small tile: the medium lift is drawn for a 40px square and stands too far out
  // of a row.
  smDefault: {
    boxShadow: shadow.sm,
  },
});

/** The tile for an object's own icon. */
export const IconTile = ({
  icon,
  variant = "default",
  size = "default",
  loading = false,
  "aria-label": label,
  style,
}: IconTileProps) => {
  const named = label !== undefined && label !== "";
  return (
    <span
      data-slot="icon-tile"
      data-variant={variant}
      data-loading={loading ? "" : undefined}
      role={named ? "img" : undefined}
      aria-label={named ? label : undefined}
      aria-hidden={named ? undefined : true}
      data-size={size}
      {...stylex.props(
        styles.tile,
        variant === "default" && styles.default,
        variant === "tinted" && styles.tinted,
        variant === "gradient" && styles.gradient,
        variant === "gradient" && loading && styles.loading,
        size === "sm" && styles.sm,
        size === "sm" && variant === "default" && styles.smDefault,
        style
      )}
    >
      <Icon icon={icon} />
    </span>
  );
};
