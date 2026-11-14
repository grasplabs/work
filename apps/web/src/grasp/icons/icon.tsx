// The one way an icon is drawn in Grasp UI. The drawings come from Hugeicons (only from there);
// this draws them with the stroke and size of the tokens, so every icon in the product has the
// same weight. Import icons from "src/icons", never from @hugeicons directly.
//
// Size and stroke come from two variables (icon.stylex.ts) that the holder sets: a button sets
// them for the icons in it, and an icon on its own uses the defaults (16px, a 1.5 stroke).
import type { IconSvgElement } from "@hugeicons/react";
import * as stylex from "@stylexjs/stylex";
import { createElement } from "react";

import { iconVars } from "./icon.stylex";

/** An icon's drawing: one of the exports of src/icons. */
export type IconData = IconSvgElement;

// The drawings that point along the line (an arrow, a chevron, send, undo): in right-to-left text
// they turn round, so "next" still points the way the line runs. Every other icon stays as drawn.
const pointers = new WeakSet<object>();

/** Marks a drawing as one that points along the line, so it mirrors in right-to-left text. */
export const pointing = (icon: IconData): IconData => {
  pointers.add(icon);
  return icon;
};

const styles = stylex.create({
  icon: {
    display: "block",
    flexShrink: 0,
    width: iconVars.size,
    height: iconVars.size,
    // Inherited by every path, so the stroke is set once, here.
    stroke: "currentColor",
    strokeWidth: iconVars.stroke,
    // The drawing never catches a click meant for the control it is in.
    pointerEvents: "none",
  },
  mirror: {
    transform: { default: null, ":dir(rtl)": "scaleX(-1)" },
  },
});

export interface IconProps {
  icon: IconData;
  /**
   * What the icon means, when nothing else says it. Leave it out when the icon sits beside words
   * that say the same (the usual case): it is then hidden from screen readers.
   */
  label?: string;
  /** Layout only, from the holder (a margin, an alignment). */
  style?: stylex.StyleXStyles<{
    alignSelf?: string | number | null;
    marginBlock?: string | number | null;
    marginInline?: string | number | null;
    marginInlineStart?: string | number | null;
    marginInlineEnd?: string | number | null;
  }>;
}

/** The attributes Hugeicons writes on each part that the token's stroke (set on the svg) replaces. */
const replaced = new Set(["key", "stroke", "strokeWidth"]);

export const Icon = ({ icon, label, style }: IconProps) => {
  const named = label !== undefined && label !== "";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
      role={named ? "img" : undefined}
      aria-label={label}
      aria-hidden={named ? undefined : true}
      data-mirror={pointers.has(icon) ? "" : undefined}
      {...stylex.props(styles.icon, pointers.has(icon) && styles.mirror, style)}
    >
      {icon.map(([tag, attrs], index) =>
        // Hugeicons writes its stroke on each part; the token's stroke (set on the svg) replaces it.
        createElement(tag, {
          ...Object.fromEntries(
            Object.entries(attrs).filter(([name]) => !replaced.has(name))
          ),
          key: String(attrs.key ?? index),
        })
      )}
    </svg>
  );
};
