// Alert: a note set into the page, for something to know, something that went well, something to
// look at, or something that went wrong, from shadcn's (registry/bases/base/ui/alert.tsx),
// converted from Tailwind to StyleX and made Grasp's on Palermo's Alert: a tinted ground with no
// border or shadow, an icon in the note's colour, a short title over a sentence.
//
//   <Alert title="Exports are ready">The CSV has finished and is ready to download.</Alert>
//   <Alert variant="attention" title="Almost at this month's limit">Two refreshes are left.</Alert>
//   <Alert variant="danger" title="The answers did not load">Try again in a moment.</Alert>
//
// An alert stays where it is; it is not a toast. Attention and danger are said to a screen reader
// when they appear; neutral and success are read where they stand, and said when their words
// change. Every value is a token.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Done, Failed, Icon, Info, Alert as Warning } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

export type AlertVariant = "neutral" | "success" | "attention" | "danger";

type Layout = string | number | null;

/** What a caller may style: where it sits and how wide it is. */
export type AlertLayoutStyle = stylex.StyleXStyles<{
  alignSelf?: Layout;
  justifySelf?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  width?: Layout;
  maxWidth?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginInline?: Layout;
}>;

/** Every prop an Alert takes. */
export interface AlertProps {
  /** One or two sentences: what it means and, when there is one, what to do. */
  children?: ReactNode;
  /** A short title: the news in a few words. Leave it out when one sentence says it all. */
  title?: string;
  /**
   * `neutral` for something to know, `success` when it went well, `attention` for something to look
   * at before it becomes a problem, `danger` when it went wrong.
   * @default "neutral"
   */
  variant?: AlertVariant;
  /** Another icon from the icons entry (`@/components/grasp/icons`), or `false` for none. Each variant has its own. */
  icon?: IconData | false;
  /**
   * How a screen reader hears it, when the variant's own does not fit: `alert` says it when it
   * appears, `status` only when its words change, `none` gives it no live role.
   */
  role?: "alert" | "status" | "none";
  /** An id, so a field or a section can point at it with `aria-describedby`. */
  id?: string;
  /** Layout only: where it sits and how wide it is. */
  style?: AlertLayoutStyle;
}

const styles = stylex.create({
  alert: {
    [iconVars.size]: grasp.iconMd,
    [iconVars.stroke]: grasp.iconStroke,
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: grasp.space3,
    alignItems: "start",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    // No border and no shadow: the tint is the edge. In forced colours a real border draws it.
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
    overflowWrap: "anywhere",
    hyphens: "auto",
  },
  noIcon: {
    gridTemplateColumns: "minmax(0, 1fr)",
  },
  neutral: { backgroundColor: grasp.alertFillNeutral },
  success: { backgroundColor: grasp.successSoft },
  attention: { backgroundColor: grasp.attentionSoft },
  danger: { backgroundColor: grasp.dangerSoft },
  // The icon sits on the first line, in the note's colour.
  icon: {
    display: "inline-flex",
    // Centred on the first line: the line's height less the icon's, halved.
    marginBlock: `calc((${grasp.textSmLine} - ${grasp.iconMd}) / 2)`,
  },
  iconNeutral: { color: grasp.muted },
  iconSuccess: { color: grasp.success },
  iconAttention: { color: grasp.attention },
  iconDanger: { color: grasp.danger },
  words: {
    display: "grid",
    rowGap: grasp.space1,
    minWidth: 0,
  },
  title: {
    // Its own tracking: a host page's heading rules never reach it.
    letterSpacing: grasp.trackingUi,
    margin: 0,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  sentence: {
    margin: 0,
  },
});

const icons: Record<AlertVariant, IconData> = {
  neutral: Info,
  success: Done,
  attention: Warning,
  danger: Failed,
};
const iconColours = {
  neutral: styles.iconNeutral,
  success: styles.iconSuccess,
  attention: styles.iconAttention,
  danger: styles.iconDanger,
} as const;
// Something to look at or something wrong is said at once; the rest when the reader is free.
const roles: Record<AlertVariant, "alert" | "status"> = {
  neutral: "status",
  success: "status",
  attention: "alert",
  danger: "alert",
};

export const Alert = ({
  children,
  title,
  variant = "neutral",
  icon,
  role,
  id,
  style,
}: AlertProps) => {
  const mark = icon === false ? undefined : (icon ?? icons[variant]);
  const said = role ?? roles[variant];
  return (
    <div
      id={id}
      data-slot="alert"
      data-variant={variant}
      role={said === "none" ? undefined : said}
      {...stylex.props(
        styles.alert,
        styles[variant],
        !mark && styles.noIcon,
        style
      )}
    >
      {mark && (
        <span
          aria-hidden="true"
          {...stylex.props(styles.icon, iconColours[variant])}
        >
          <Icon icon={mark} />
        </span>
      )}
      <div {...stylex.props(styles.words)}>
        {title !== undefined && title !== "" && (
          <p {...stylex.props(styles.title)}>{title}</p>
        )}
        {children !== undefined &&
          children !== null &&
          children !== false &&
          children !== "" && (
            <div {...stylex.props(styles.sentence)}>{children}</div>
          )}
      </div>
    </div>
  );
};
