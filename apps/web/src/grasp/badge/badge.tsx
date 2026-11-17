// Badge: a short status in a pill, from shadcn's (registry/bases/base/ui/badge.tsx), converted from
// Tailwind to StyleX and made Grasp's after Profound's Palermo: a soft tinted fill, the system's
// edge, and words in the tone's colour. It says how something stands; it does
// nothing when pressed.
//
//   <Badge>Draft</Badge>
//   <Badge tone="success" icon={Tick}>Ready</Badge>
//   <Badge tone="danger" size="sm">Failed</Badge>
//   <Badge pending={sending} icon={Tick}>{sending ? "Sending" : "Invited"}</Badge>   working on it
//   <Badge variant="dot" tone="danger">3 errors</Badge>         how serious, as a dot (once Severity)
//
// `variant="dot"` is how serious something is, as a small dot in the tone's colour beside neutral
// words, as the Grasp product marks captured logs: a page full of errors is not painted red. Alone
// (no words), the dot is named for a screen reader. In forced colours each tone keeps its own shape:
// danger and success a full dot, attention a ring, neutral and info a dash.
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Icon, Spinner as Turning } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { Dot } from "./dot";

export type BadgeTone = "neutral" | "success" | "attention" | "danger" | "info";
export type BadgeSize = "sm" | "md";
/** `pill` the status in a tinted pill; `dot` how serious, as a dot beside neutral words (once Severity). */
export type BadgeVariant = "pill" | "dot";

/** What a caller may style: where the badge sits. Never its look. */
export type BadgeLayoutStyle = LayoutStyle;

/** Every prop a Badge takes. */
export interface BadgeProps {
  /**
   * The status, in a word or two, in sentence case ("Needs review"). It says it, never the colour
   * alone. With `variant="dot"`, what happened or how many ("3 errors"); leave it out for the dot alone.
   */
  children?: ReactNode;
  /**
   * `pill` a status in a tinted pill. `dot` how serious something is: a dot in the tone's colour
   * beside words in the text's colour, for a page full of them (captured logs).
   * @default "pill"
   */
  variant?: BadgeVariant;
  /**
   * The dot's name when it stands alone (`variant="dot"`, no words), in the page's language. With
   * words it is not said.
   * @default "Error", "Warning", "Info", "Done" or "Note", by tone
   */
  "aria-label"?: string;
  /**
   * How it stands: `neutral` for a plain fact, `success` when it is done or fine, `attention` when
   * someone should look, `danger` when it failed or is blocked, `info` for a note.
   * @default "neutral"
   */
  tone?: BadgeTone;
  /**
   * The height: `md` 22px, `sm` 18px for a dense table.
   * @default "md"
   */
  size?: BadgeSize;
  /** An icon before the words, in their colour. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * Working on it ("Sending", "Being removed"): a turning mark in the icon's place, still with
   * reduced motion. A badge given `pending`, true or false, says its words politely as they
   * change (a status), once each. Give it an icon for when it settles, and its width stays put.
   */
  loading?: boolean;
  /** @deprecated Use `loading`. */
  pending?: boolean;
  /** @deprecated Use `layout`. */
  style?: BadgeLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the badge. */
  layout?: BadgeLayoutStyle;
}

const turn = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});

const styles = stylex.create({
  // The working mark: the icon's box, turning; standing still with reduced motion.
  turning: {
    display: "inline-flex",
    flexShrink: 0,
    animationName: { default: turn, [media.reduced]: "none" },
    animationDuration: grasp.durationSpin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  badge: {
    [iconVars.size]: grasp.badgeIcon,
    [iconVars.stroke]: grasp.iconStroke,
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    maxWidth: "100%",
    margin: 0,
    paddingInline: grasp.badgeInset,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    fontWeight: grasp.weightMedium,
    letterSpacing: "normal",
    // A long status wraps rather than being cut off, and the pill grows with it. It breaks a word
    // only when the word alone is wider than the column, so in a row it keeps its width. In a
    // table's cell it stays in one piece: the table scrolls sideways instead ("Needs review" stood
    // as a tall blob in a narrow column).
    whiteSpace: {
      default: "normal",
      ":is([data-slot=table-cell] *)": "nowrap",
    },
    overflowWrap: "break-word",
    hyphens: "auto",
    textWrap: "balance",
    verticalAlign: "middle",
    // In forced colours fills and shadows are dropped, so an outline draws the pill there, inside
    // it, so it adds no size.
    outline: { default: "none", [media.forced]: "1px solid currentColor" },
    outlineOffset: -1,
  },
  // One line of words fills the height, with round ends; more lines grow it, with rounded corners.
  md: {
    minHeight: grasp.badgeHeight,
    paddingBlock: `calc((${grasp.badgeHeight} - ${grasp.textXsLine}) / 2)`,
    lineHeight: grasp.textXsLine,
    borderRadius: `calc(${grasp.badgeHeight} / 2)`,
  },
  sm: {
    minHeight: grasp.badgeHeightSm,
    paddingBlock: 0,
    lineHeight: grasp.badgeHeightSm,
    borderRadius: `calc(${grasp.badgeHeightSm} / 2)`,
  },
  // Neutral: white on a light ground, a veil on a dark one. Every tone has the system's edge.
  neutral: {
    color: grasp.ink,
    backgroundColor: grasp.quietFill,
    boxShadow: grasp.edge,
  },
  success: {
    color: grasp.success,
    backgroundColor: grasp.successSoft,
    boxShadow: grasp.edge,
  },
  attention: {
    color: grasp.attention,
    backgroundColor: grasp.attentionSoft,
    boxShadow: grasp.edge,
  },
  danger: {
    color: grasp.danger,
    backgroundColor: grasp.dangerSoft,
    boxShadow: grasp.edge,
  },
  info: {
    color: grasp.info,
    backgroundColor: grasp.infoSoft,
    boxShadow: grasp.edge,
  },
  words: {
    minWidth: 0,
  },
});

/** Before the words: the working mark while pending, else the icon. */
const Mark = ({ icon, pending }: { icon?: IconData; pending: boolean }) => {
  if (pending) {
    return (
      <span
        aria-hidden="true"
        data-slot="badge-pending"
        {...stylex.props(styles.turning)}
      >
        <Icon icon={Turning} />
      </span>
    );
  }
  return icon ? <Icon icon={icon} /> : null;
};

export const Badge = ({
  children,
  tone = "neutral",
  size = "md",
  icon,
  variant = "pill",
  "aria-label": named,
  pending: pendingDeprecated,
  loading: pending = pendingDeprecated,
  style: styleProp,
  layout,
}: BadgeProps) =>
  variant === "dot" ? (
    <Dot tone={tone} named={named} layout={layout ?? styleProp}>
      {children}
    </Dot>
  ) : (
    <span
      data-slot="badge"
      data-tone={tone}
      data-pending={pending === true ? "" : undefined}
      {...stylex.props(
        styles.badge,
        styles[size],
        styles[tone],
        layout ?? styleProp
      )}
    >
      <Mark icon={icon} pending={pending === true} />
      {/* A badge that may be pending is a polite status: its words are said as they change. */}
      <span
        role={pending === undefined ? undefined : "status"}
        {...stylex.props(styles.words)}
      >
        {children}
      </span>
    </span>
  );
