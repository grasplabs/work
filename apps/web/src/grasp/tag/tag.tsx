// Tag: a short label that sorts or names something ("Design", "Q3"), from Palermo's Pill / Tag,
// made Grasp's: a pill 24px tall with 8px at each end, the words in small type. A soft fill, or an
// outline beside other tags that are chosen. With `onRemove` it carries a small button that takes
// it away, as a filter or a chosen value does.
//
//   <Tag>Design</Tag>
//   <Tag variant="outline" icon={Link}>Shared</Tag>
//   <Tag onRemove={() => drop("design")}>Design</Tag>
//
// For how something stands (ready, failed), use a Badge. Every value is a token (src/tokens). A
// caller may set layout only (the `style` prop).
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { MouseEvent, ReactNode } from "react";

import { focus } from "../focus/focus";
import { Cross, Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { tagWords } from "./words";

/** What a caller may style: where the tag sits. Never its look. */
export type TagLayoutStyle = LayoutStyle;

/** Every prop a Tag takes. */
export interface TagProps {
  /**
   * Its words: one or two, in sentence case. Too long for the room, they end in an ellipsis, and
   * text words carry their whole text as a `title`, so what the ellipsis hides can still be read.
   */
  children: ReactNode;
  /**
   * `soft` filled, the usual tag. `outline` an edge alone, quieter, for tags beside chosen ones.
   * @default "soft"
   */
  variant?: "soft" | "outline";
  /**
   * `md` 24px beside body text, `sm` 20px in a dense row or a table.
   * @default "md"
   */
  size?: "md" | "sm";
  /** An icon before the words, from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * Takes the tag away: shows a small button after the words that runs this. Focus then moves to
   * the next tag's remove button in the same row, or the one before when it was the last. When no
   * tag is left, move focus yourself, to the field that adds them.
   */
  onRemove?: () => void;
  /** What the remove button says to a screen reader. When the words are text, "Remove" and them. */
  removeLabel?: string;
  /** @deprecated Use `layout`. */
  style?: TagLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the tag. */
  layout?: TagLayoutStyle;
}

const styles = stylex.create({
  tag: {
    [iconVars.size]: grasp.tagIcon,
    [iconVars.stroke]: grasp.iconStroke,
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    maxWidth: "100%",
    paddingInline: grasp.tagInset,
    borderRadius: grasp.cornerPill,
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
    whiteSpace: "nowrap",
    verticalAlign: "middle",
    // Forced colours drop the fill and the edge: a line keeps the pill, inside it.
    outline: { default: "none", [media.forced]: "1px solid currentColor" },
    outlineOffset: -1,
  },
  md: {
    height: grasp.tagHeight,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  sm: {
    height: grasp.tagHeightSm,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  soft: {
    backgroundColor: grasp.tagFill,
  },
  outline: {
    boxShadow: grasp.edge,
  },
  // With a remove button, the end is the button's own room.
  removable: {
    paddingInlineEnd: grasp.space1,
  },
  words: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  remove: {
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.iconSm,
    height: grasp.iconSm,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerPill,
    color: {
      default: grasp.muted,
      ":hover": { default: null, [media.hover]: grasp.ink },
    },
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.tagFill },
    },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color, background-color",
    transitionDuration: simply.mark,
    transitionTimingFunction: grasp.ease,
  },
  // A finger needs 44px: an invisible area round the small button, on touch.
  target: {
    position: "absolute",
    inset: {
      default: 0,
      [media.coarse]: `calc((${grasp.iconSm} - ${grasp.tap}) / 2)`,
    },
  },
});

// After a remove, the keyboard lands on a neighbour's remove button instead of the page: the next
// in the row, or the one before. Found before the tag goes, focused once it has.
const keepFocus = (event: MouseEvent<HTMLButtonElement>) => {
  const all = [
    ...(event.currentTarget
      .closest("[data-slot=tag]")
      ?.parentElement?.querySelectorAll<HTMLButtonElement>(
        "[data-tag-remove]"
      ) ?? []),
  ];
  const at = all.indexOf(event.currentTarget);
  const next = all[at + 1] ?? all[at - 1];
  if (!next) {
    return;
  }
  requestAnimationFrame(() => {
    if (next.isConnected) {
      next.focus();
    }
  });
};

export const Tag = ({
  children,
  variant = "soft",
  size = "md",
  icon,
  onRemove,
  removeLabel,
  style: styleProp,
  layout,
}: TagProps) => {
  const removable = onRemove !== undefined;
  const words = useWords("tag", tagWords);
  const label =
    removeLabel ??
    (typeof children === "string" ? words.removeNamed(children) : words.remove);
  return (
    <span
      data-slot="tag"
      {...stylex.props(
        styles.tag,
        styles[size],
        styles[variant],
        removable && styles.removable,
        layout ?? styleProp
      )}
    >
      {icon && <Icon icon={icon} />}
      {/* The whole text, for a cut tag: no measuring, as Code block's and Composer's names do. */}
      <span
        title={typeof children === "string" ? children : undefined}
        {...stylex.props(styles.words)}
      >
        {children}
      </span>
      {removable && (
        <button
          type="button"
          aria-label={label}
          data-tag-remove=""
          onClick={(event) => {
            keepFocus(event);
            onRemove();
          }}
          {...stylex.props(styles.remove, focus.ring)}
        >
          <span aria-hidden="true" {...stylex.props(styles.target)} />
          <Icon icon={Cross} />
        </button>
      )}
    </span>
  );
};
