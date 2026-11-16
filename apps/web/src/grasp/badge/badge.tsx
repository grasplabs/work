// Badge: a short status in a pill, from shadcn's (registry/bases/base/ui/badge.tsx), converted from
// Tailwind to StyleX and made Grasp's after Profound's Palermo: a soft tinted fill, the system's
// edge, and words in the tone's colour. It says how something stands; it does
// nothing when pressed.
//
//   <Badge>Draft</Badge>
//   <Badge tone="success" icon={Tick}>Ready</Badge>
//   <Badge tone="danger" size="sm">Failed</Badge>
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

export type BadgeTone = "neutral" | "success" | "attention" | "danger" | "info";
export type BadgeSize = "sm" | "md";

type Layout = string | number | null;

/** What a caller may style: where the badge sits. Never its look. */
export type BadgeLayoutStyle = stylex.StyleXStyles<{
  alignSelf?: Layout;
  justifySelf?: Layout;
  flexShrink?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  gridRow?: Layout;
  order?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginBlockStart?: Layout;
  marginBlockEnd?: Layout;
  marginInline?: Layout;
  marginInlineStart?: Layout;
  marginInlineEnd?: Layout;
}>;

/** Every prop a Badge takes. */
export interface BadgeProps {
  /** The status, in a word or two, in sentence case ("Needs review"). It says it, never the colour alone. */
  children: ReactNode;
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
  /** Layout only: margins and alignment. The look belongs to the badge. */
  style?: BadgeLayoutStyle;
}

const styles = stylex.create({
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

export const Badge = ({
  children,
  tone = "neutral",
  size = "md",
  icon,
  style,
}: BadgeProps) => (
  <span
    data-slot="badge"
    data-tone={tone}
    {...stylex.props(styles.badge, styles[size], styles[tone], style)}
  >
    {icon && <Icon icon={icon} />}
    <span {...stylex.props(styles.words)}>{children}</span>
  </span>
);
