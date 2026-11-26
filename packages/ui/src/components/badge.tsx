// Badge: a word or two in a pill. Five variants are a status, how something stands (`default`,
// `success`, `warning`, `destructive`, `info`): a soft tinted fill, the system's edge, and words in
// the variant's colour. Two are a label, what sorts or names something ("Design", "Q3"):
// `secondary`, a soft fill, and `outline`, an edge alone, a step taller with the words in the
// text's colour. It does nothing when pressed, unless it is drawn as a link (`asChild`); with
// `onRemove` it carries a small button that takes it away, as a filter or a chosen value does.
//
//   <Badge>Draft</Badge>
//   <Badge variant="success" icon={CheckIcon}>Ready</Badge>
//   <Badge variant="secondary">Design</Badge>                a label
//   <Badge variant="outline" icon={LinkIcon}>Shared</Badge>
//   <Badge variant="secondary" onRemove={() => drop("design")}>Design</Badge>
//   <Badge variant="destructive" size="sm">Failed</Badge>
//   <Badge loading={sending} icon={CheckIcon}>{sending ? "Sending" : "Invited"}</Badge>
//   <Badge dot variant="destructive">3 errors</Badge>        how serious, as a dot
//   <Badge tooltip="Support can open this workspace until Friday.">Staff access</Badge>
//   <Badge asChild variant="info"><a href="/changelog">New</a></Badge>
//
// `dot` is how serious something is, as a small dot in the variant's colour beside words in the
// text's colour, for a page full of them: a page of errors is not painted red. Alone (no words),
// the dot is named for a screen reader by the I18nProvider (`badge.dot`). In forced colours each
// variant keeps its own shape: destructive and success a full dot, warning a ring, default and
// info a dash.
//
// Every value is a token. A caller may set layout only (the `style` prop). The remove button's name
// comes from the I18nProvider (`badge.remove`, `badge.removeNamed`).
"use client";

import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import { isValidElement } from "react";
import type { MouseEvent, ReactElement, ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { Icon, LoaderIcon, XIcon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import { focusRing, hyphenate, tapTarget } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { isBlank } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * A status, how it stands: a plain fact, done or fine, worth a look, failed or blocked, a note. Or
 * a label, what sorts or names it: `secondary` filled, `outline` an edge alone.
 */
export type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "destructive"
  | "info";
/** A status: `default` 22px, `sm` 18px for a dense table. A label: `default` 24px, `sm` 20px. */
export type BadgeSize = "sm" | "default";

/** A label's variants: what sorts or names something. */
type BadgeLabelVariant = "secondary" | "outline";

/** What every Badge takes, a status or a label. */
interface BadgeOwnProps {
  /**
   * The status, in a word or two, in sentence case ("Needs review"). It says it, never the colour
   * alone. With `dot`, what happened or how many ("3 errors"); leave it out for the dot alone. With
   * `asChild`, the one element to draw as the badge (`<a href>`), holding the words. A label's
   * words stay on one line: too long for the room, they end in an ellipsis, and text words carry
   * their whole text as a `title`, so what the ellipsis hides can still be read.
   */
  children?: ReactNode;
  /**
   * A status, how it stands: `default` for a plain fact, `success` when it is done or fine,
   * `warning` when someone should look, `destructive` when it failed or is blocked, `info` for a
   * note. A label, what sorts or names it: `secondary` filled, the usual label; `outline` an edge
   * alone, quieter, for labels beside chosen ones.
   * @default "default"
   */
  variant?: BadgeVariant;
  /**
   * Takes the badge away: shows a small button after the words that runs this. A label only
   * (`secondary`, `outline`): a chosen value or a filter is taken away, a status is not. Its name is
   * "Remove" and the words when they are text. Focus then moves to the next badge's remove button
   * in the same row, or the one before when it was the last. When none is left, move focus
   * yourself, to the field that adds them. Not drawn with `asChild` or `dot`.
   */
  onRemove?: () => void;
  /**
   * How serious something is: a dot in the variant's colour beside words in the text's colour,
   * for a page full of them (captured logs), in place of the tinted pill.
   * @default false
   */
  dot?: boolean;
  /**
   * The height. A status: `default` 22px, `sm` 18px for a dense table. A label (`secondary`,
   * `outline`): `default` 24px beside body text, `sm` 20px in a dense row or a table.
   * @default "default"
   */
  size?: BadgeSize;
  /**
   * An icon before the words, in their colour, from lib/icons. Not drawn with `asChild`: put an
   * `<Icon />` in the element before its words.
   */
  icon?: IconData;
  /**
   * Working on it ("Sending", "Being removed"): a turning mark in the icon's place, still with
   * reduced motion. A badge given `loading`, true or false, says its words politely as they
   * change (a status), once each. Give it an icon for when it settles, and its width stays put.
   * Not drawn with `asChild`.
   */
  loading?: boolean;
  /**
   * What the status means, for whoever wonders: the badge becomes a stop for the keyboard and shows
   * these words in a tooltip on hover and on focus, said as its description. It still looks like a
   * badge, not a button, and nothing happens when it is pressed. A pill only.
   */
  tooltip?: ReactNode;
  /**
   * Draw the one element given as the child (`<a href>`, a router's link) as the badge, with its
   * look: a link stays a link, with the keyboard's ring. Its words are its own; an icon goes in it
   * as an `<Icon />` before them, and `icon` and `loading` are not drawn.
   * @default false
   */
  asChild?: boolean;
  /**
   * The dot's name when it stands alone (`dot`, no words). With words it is not said.
   * @default "Note", "Done", "Warning", "Error" or "Info", by variant (`badge.dot`)
   */
  "aria-label"?: string;
  /** Layout only: margins and alignment. The look belongs to the badge. */
  style?: LayoutStyle;
}

/**
 * Every prop a Badge takes. `onRemove` is a label's alone, so a status given one does not compile:
 * shadcn's Badge has no remove at all, and what its kin take away (a Combobox's chips, a tag) is
 * always a neutral label, never how something stands.
 */
export type BadgeProps =
  | (BadgeOwnProps & {
      variant?: Exclude<BadgeVariant, BadgeLabelVariant>;
      onRemove?: never;
    })
  | (BadgeOwnProps & { variant: BadgeLabelVariant });

const FORCED = media.forcedColors;
const REDUCED = media.reducedMotion;

const turn = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});

const styles = stylex.create({
  badge: {
    [iconVars.size]: sizes.badgeIcon,
    [iconVars.stroke]: sizes.iconStroke,
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    boxSizing: "border-box",
    // Gives way in a row that is short of room, down to its words' ellipsis.
    minWidth: 0,
    maxWidth: "100%",
    margin: 0,
    paddingInline: sizes.badgePadding,
    fontFamily: font.sans,
    fontSize: font.textXs,
    fontWeight: font.weightMedium,
    letterSpacing: "normal",
    textDecoration: "none",
    // A long status wraps rather than being cut off, and the pill grows with it. It breaks a word
    // only when the word alone is wider than the column. In a table's cell it stays in one piece:
    // the table scrolls sideways instead.
    whiteSpace: {
      default: "normal",
      ":is([data-slot=table-cell] *)": "nowrap",
    },
    overflowWrap: "break-word",
    textWrap: "balance",
    verticalAlign: "middle",
    // In forced colours fills and shadows are dropped, so an outline draws the pill there, inside
    // it, so it adds no size.
    outline: { default: "none", [FORCED]: "1px solid currentColor" },
    outlineOffset: -1,
  },
  // One line of words fills the height, with round ends; more lines grow it, with rounded corners.
  // A pill by design, as every badge and tag is: round, never the squircle, which would square its
  // ends (scripts/check-corners.ts names it).
  default: {
    minHeight: sizes.badgeHeight,
    paddingBlock: `calc((${sizes.badgeHeight} - ${font.textXsLine}) / 2)`,
    lineHeight: font.textXsLine,
    borderRadius: `calc(${sizes.badgeHeight} / 2)`,
    cornerShape: "round",
  },
  sm: {
    minHeight: sizes.badgeHeightSm,
    paddingBlock: 0,
    lineHeight: sizes.badgeHeightSm,
    borderRadius: `calc(${sizes.badgeHeightSm} / 2)`,
    cornerShape: "round",
  },
  // Default: white on a light ground, a veil on a dark one. Every variant has the system's edge.
  variantDefault: {
    color: colors.foreground,
    backgroundColor: colors.control,
    boxShadow: sizes.borderStrong,
  },
  success: {
    color: colors.success,
    backgroundColor: colors.successSubtle,
    boxShadow: sizes.borderStrong,
  },
  warning: {
    color: colors.warning,
    backgroundColor: colors.warningSubtle,
    boxShadow: sizes.borderStrong,
  },
  destructive: {
    color: colors.destructive,
    backgroundColor: colors.destructiveSubtle,
    boxShadow: sizes.borderStrong,
  },
  info: {
    color: colors.info,
    backgroundColor: colors.infoSubtle,
    boxShadow: sizes.borderStrong,
  },
  // A label (secondary, outline): one line 24px tall with 8px at each end, the words in the text's
  // colour and a size up, cut with an ellipsis where a status would wrap.
  label: {
    [iconVars.size]: sizes.badgeIcon,
    [iconVars.stroke]: sizes.iconStroke,
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    boxSizing: "border-box",
    maxWidth: "100%",
    paddingInline: space.badgeLabelPadding,
    borderRadius: radius.full,
    fontFamily: font.sans,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    whiteSpace: "nowrap",
    verticalAlign: "middle",
    // Forced colours drop the fill and the edge: a line keeps the pill, inside it.
    outline: { default: "none", [FORCED]: "1px solid currentColor" },
    outlineOffset: -1,
  },
  labelDefault: {
    height: sizes.badgeLabelHeight,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  labelSm: {
    height: sizes.badgeLabelHeightSm,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
  secondary: {
    backgroundColor: colors.badgeSecondary,
  },
  outline: {
    boxShadow: sizes.borderStrong,
  },
  labelWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // A label drawn as the caller's element (a link): its words are the element's own text, which a
  // flex box cannot cut, so it is one line box as tall as the label, cut with the same ellipsis.
  labelLinked: {
    display: "inline-block",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  labelLinkedDefault: { lineHeight: sizes.badgeLabelHeight },
  labelLinkedSm: { lineHeight: sizes.badgeLabelHeightSm },
  // With a remove button, the end is the button's own room.
  removable: {
    paddingInlineEnd: space["1"],
  },
  remove: {
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: sizes.iconSm,
    height: sizes.iconSm,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [media.hover]: colors.foreground },
    },
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: colors.badgeSecondary },
    },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color, background-color",
    transitionDuration: motionVars.mark,
    transitionTimingFunction: duration.ease,
  },
  // A badge drawn as a link: the pointer's cursor, and its words underlined under it.
  link: {
    cursor: "pointer",
    textDecoration: {
      default: "none",
      ":hover": { default: null, [media.hover]: "underline" },
    },
  },
  // A badge with a tooltip: the help cursor under a pointer, and no look of a button.
  explained: { cursor: "help" },
  words: { minWidth: 0 },
  // The working mark: the icon's box, turning; standing still with reduced motion.
  turning: {
    display: "inline-flex",
    flexShrink: 0,
    animationName: { default: turn, [REDUCED]: "none" },
    animationDuration: duration.spin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
});

// The dot: how serious, beside words that stay in the text's colour.
const dotStyles = stylex.create({
  mark: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  dot: {
    flexShrink: 0,
    boxSizing: "border-box",
    width: sizes.severityDot,
    height: sizes.severityDot,
    borderRadius: radius.circle,
    forcedColorAdjust: "none",
  },
  destructive: {
    backgroundColor: { default: colors.destructive, [FORCED]: "CanvasText" },
  },
  success: {
    backgroundColor: { default: colors.success, [FORCED]: "CanvasText" },
  },
  // In forced colours a ring, so warning and destructive never rest on colour alone.
  warning: {
    backgroundColor: { default: colors.warning, [FORCED]: "Canvas" },
    boxShadow: { default: null, [FORCED]: "inset 0 0 0 1.5px CanvasText" },
  },
  // Info and default are quiet: the text's own faint colour, a dash in forced colours.
  quiet: {
    backgroundColor: {
      default: colors.subtleForeground,
      [FORCED]: "CanvasText",
    },
    height: { default: sizes.severityDot, [FORCED]: "2px" },
    borderRadius: { default: radius.circle, [FORCED]: 0 },
  },
  words: { minWidth: 0, overflowWrap: "anywhere" },
});

const pillLooks = {
  default: styles.variantDefault,
  secondary: styles.secondary,
  outline: styles.outline,
  success: styles.success,
  warning: styles.warning,
  destructive: styles.destructive,
  info: styles.info,
} as const;

// A label has no severity: its dot is the quiet one, named as a note.
const dotLooks = {
  default: dotStyles.quiet,
  secondary: dotStyles.quiet,
  outline: dotStyles.quiet,
  success: dotStyles.success,
  warning: dotStyles.warning,
  destructive: dotStyles.destructive,
  info: dotStyles.quiet,
} as const;

/** Whether the variant is a label (what sorts or names something), not a status. */
const isLabel = (variant: BadgeVariant): variant is BadgeLabelVariant =>
  variant === "secondary" || variant === "outline";

// After a remove, the keyboard lands on a neighbour's remove button instead of the page: the next
// in the row, or the one before. Found before the badge goes, focused once it has.
const keepFocus = (event: MouseEvent<HTMLButtonElement>) => {
  const all = [
    ...(event.currentTarget
      .closest("[data-slot=badge]")
      ?.parentElement?.querySelectorAll<HTMLButtonElement>(
        "[data-slot=badge] > [data-slot=badge-remove]"
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

/** `dot`: the dot in the variant's colour, and the words beside it, or the dot alone, named. */
const Dot = ({
  variant,
  children,
  named,
  style,
}: {
  variant: BadgeVariant;
  children: ReactNode;
  named: string | undefined;
  style: LayoutStyle | undefined;
}) => {
  const { badge: words } = useI18n();
  const alone = isBlank(children);
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      data-dot=""
      {...stylex.props(dotStyles.mark, style)}
    >
      <span
        // Alone, the dot is the thing said; beside words, the words say it.
        role={alone ? "img" : undefined}
        aria-label={
          alone
            ? (named ?? words.dot[isLabel(variant) ? "default" : variant])
            : undefined
        }
        aria-hidden={alone ? undefined : true}
        {...stylex.props(dotStyles.dot, dotLooks[variant])}
      />
      {alone ? null : (
        <span {...stylex.props(dotStyles.words)}>{children}</span>
      )}
    </span>
  );
};

/** Before the words: the working mark while loading, else the icon. */
const Mark = ({ icon, loading }: { icon?: IconData; loading: boolean }) => {
  if (loading) {
    return (
      <span
        aria-hidden="true"
        data-slot="badge-loading"
        {...stylex.props(styles.turning)}
      >
        <Icon icon={LoaderIcon} />
      </span>
    );
  }
  return icon ? <Icon icon={icon} /> : null;
};

/**
 * The words, the mark before them and the remove button after. A badge that may be loading is a
 * polite status. A label's words are cut, so text carries itself whole as a `title`: no measuring.
 */
const Inside = ({
  icon,
  loading,
  label,
  onRemove,
  children,
}: {
  icon: IconData | undefined;
  loading: boolean | undefined;
  label: boolean;
  onRemove: (() => void) | undefined;
  children: ReactNode;
}) => {
  const { badge: words } = useI18n();
  return (
    <>
      <Mark icon={icon} loading={loading === true} />
      <span
        role={loading === undefined ? undefined : "status"}
        title={label && typeof children === "string" ? children : undefined}
        {...stylex.props(label ? styles.labelWords : styles.words)}
      >
        {children}
      </span>
      {onRemove !== undefined && (
        <button
          type="button"
          aria-label={
            typeof children === "string"
              ? words.removeNamed(children)
              : words.remove
          }
          data-slot="badge-remove"
          onClick={(event) => {
            keepFocus(event);
            onRemove();
          }}
          {...stylex.props(styles.remove, focusRing)}
        >
          <span aria-hidden="true" {...stylex.props(tapTarget)} />
          <Icon icon={XIcon} />
        </button>
      )}
    </>
  );
};

/** The pill's shape at its size: a label's one cut line (a link's too), or a status that wraps. */
const shapeOf = (label: boolean, size: BadgeSize, linked: boolean) => {
  const small = size === "sm";
  if (!label) {
    return [styles.badge, hyphenate, small ? styles.sm : styles.default];
  }
  return [
    styles.label,
    small ? styles.labelSm : styles.labelDefault,
    linked && styles.labelLinked,
    linked && (small ? styles.labelLinkedSm : styles.labelLinkedDefault),
  ];
};

/** A linked label's whole text, for when it is cut: the plain label's words carry theirs. */
const titleOf = (
  label: boolean,
  element: ReactElement<{ children?: ReactNode }> | undefined
): string | undefined =>
  label && typeof element?.props.children === "string"
    ? element.props.children
    : undefined;

/** A short status or a label in a pill, or how serious something is as a dot. */
export const Badge = ({
  children,
  variant = "default",
  dot = false,
  size = "default",
  icon,
  loading,
  tooltip,
  asChild = false,
  onRemove,
  "aria-label": named,
  style,
}: BadgeProps) => {
  if (dot) {
    return (
      <Dot variant={variant} named={named} style={style}>
        {children}
      </Dot>
    );
  }
  const explained = !isBlank(tooltip);
  // With `asChild`, the caller's one element (a link) is drawn as the badge.
  const element =
    asChild && isValidElement<{ children?: ReactNode }>(children)
      ? children
      : undefined;
  const linked = element !== undefined;
  const label = isLabel(variant);
  // Only a label is taken away.
  const remove = label ? onRemove : undefined;
  const look = stylex.props(
    shapeOf(label, size, linked),
    pillLooks[variant],
    remove !== undefined && !linked && styles.removable,
    linked && styles.link,
    explained && styles.explained,
    (explained || linked) && focusRing,
    style
  );
  const own = {
    "data-slot": "badge",
    "data-variant": variant,
    "data-loading": loading === true ? "" : undefined,
    title: titleOf(label, element),
    ...look,
  };
  // Drawn as the caller's element (a link), the badge's look, mark and words go onto it.
  const pill =
    element === undefined ? (
      <span
        {...own}
        // An explained badge is a stop, so its tooltip (its description) reaches the keyboard too.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the tooltip describes it, as a Key-value icon's does
        tabIndex={explained ? 0 : undefined}
      >
        <Inside icon={icon} loading={loading} label={label} onRemove={remove}>
          {children}
        </Inside>
      </span>
    ) : (
      // Its own words stay its own: an icon goes inside it, as `<Icon />` before the words.
      renderElement("span", own, element)
    );
  if (!explained) {
    return pill;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
};
