// Alert: a note set into the page, for something to know, something that went well, something to
// look at, or something that went wrong, from shadcn's (registry/bases/base/ui/alert.tsx),
// converted from Tailwind to StyleX and made Grasp's on Palermo's Alert: a tinted ground with no
// border or shadow, an icon in the note's colour, a short title over a sentence.
//
//   <Alert title="Exports are ready">The CSV has finished and is ready to download.</Alert>
//   <Alert variant="attention" title="Almost at this month's limit">Two refreshes are left.</Alert>
//   <Alert tone="danger" title="The answers did not load">Try again in a moment.</Alert>
//   <Alert variant="banner" tone="attention" title="Scheduled maintenance" onDismiss={…}>…</Alert>
//
// `variant="banner"` (once Banner, the breaking release's step 3) is a message across the top of a
// page or the app, about the whole of it: full width, its actions after the words, and a dismiss
// button at the end (alert/banner.tsx). The inline Alert is about the part it sits in.
//
// An alert stays where it is; it is not a toast. Attention and danger are said to a screen reader
// when they appear; neutral and success are read where they stand, and said when their words
// change. Every value is a token.
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Done, Failed, Icon, Info, Alert as Warning } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { AlertBanner } from "./banner";

export type AlertVariant = "neutral" | "success" | "attention" | "danger";
/** Where it stands: `inline` in the part it is about, `banner` across the top of the page or the app. */
export type AlertLook = "inline" | "banner";

/** What a caller may style: where it sits and how wide it is. */
export type AlertLayoutStyle = LayoutStyle;

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
  tone?: AlertVariant;
  /**
   * `inline` a note set into the part it is about. `banner` a message across the top of a page or
   * the app, about the whole of it (once Banner): full width, `action` after the words, and
   * `onDismiss` for a dismiss button. A tone's name here (`variant="danger"`) is its old name for
   * `tone`, still read until the breaking release's step 9.
   * @default "inline"
   */
  variant?: AlertLook | AlertVariant;
  /**
   * With `variant="banner"`: what to do about it, one or two Buttons of size `xs`, the main one
   * first, after the message. They wrap under the words when the line is too narrow.
   */
  action?: ReactNode;
  /**
   * With `variant="banner"`: shows a dismiss button at the end. The banner goes at once, then this
   * runs: remember it, so the banner does not come back on the next page.
   */
  onDismiss?: () => void;
  /**
   * With `variant="banner"`: the dismiss button's name, in the page's language.
   * @default "Dismiss"
   */
  dismissLabel?: string;
  /**
   * The quiet weight: no fill and no inset, the icon in its tone beside the words. For an alert
   * inside a row or a rail, next to quiet rows, where a filled box is too heavy.
   * @default false
   */
  quiet?: boolean;
  /** Another icon from the icons entry (`@/components/grasp/icons`), or `false` for none. Each variant has its own. */
  icon?: IconData | false;
  /**
   * How a screen reader hears it, when the variant's own does not fit: `alert` says it when it
   * appears, `status` only when its words change, `none` gives it no live role.
   */
  role?: "alert" | "status" | "none";
  /**
   * How a screen reader hears it, by the live region's own words, for a host whose lint prefers
   * them to a role: `polite` is a status (said when the reader is free), `assertive` an alert (said
   * at once), `off` no live role. It wins over `role` when both are given.
   */
  live?: "polite" | "assertive" | "off";
  /** An id, so a field or a section can point at it with `aria-describedby`. */
  id?: string;
  /** @deprecated Use `layout`. */
  style?: AlertLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: AlertLayoutStyle;
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
  quiet: {
    paddingBlock: 0,
    paddingInline: 0,
    borderRadius: 0,
    borderWidth: 0,
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
// `live` in a live region's words, as the role it gives.
const byLive = { polite: "status", assertive: "alert", off: "none" } as const;

/** The role it is heard by: `live` wins over `role`, and the variant's own role is the default. */
const saidOf = (
  live: AlertProps["live"],
  role: AlertProps["role"],
  variant: AlertVariant
) => (live === undefined ? (role ?? roles[variant]) : byLive[live]);

/** The tone: `tone`, else a tone's name given as `variant` (its old name), else neutral. */
const toneOf = (
  tone: AlertVariant | undefined,
  variant: AlertProps["variant"]
): AlertVariant =>
  tone ??
  (variant === undefined || variant === "inline" || variant === "banner"
    ? "neutral"
    : variant);

export const Alert = ({
  children,
  title,
  variant: look,
  tone: toneGiven,
  quiet = false,
  icon,
  role,
  live,
  id,
  action,
  onDismiss,
  dismissLabel,
  style: styleProp,
  layout,
}: AlertProps) => {
  const variant = toneOf(toneGiven, look);
  const said = saidOf(live, role, variant);
  if (look === "banner") {
    return (
      <AlertBanner
        tone={variant}
        title={title}
        icon={icon}
        action={action}
        onDismiss={onDismiss}
        dismissLabel={dismissLabel}
        role={said}
        id={id}
        layout={layout ?? styleProp}
      >
        {children}
      </AlertBanner>
    );
  }
  const mark = icon === false ? undefined : (icon ?? icons[variant]);
  return (
    <div
      id={id}
      data-slot="alert"
      data-variant={variant}
      data-quiet={quiet || undefined}
      role={said === "none" ? undefined : said}
      {...stylex.props(
        styles.alert,
        !quiet && styles[variant],
        quiet && styles.quiet,
        !mark && styles.noIcon,
        layout ?? styleProp
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
