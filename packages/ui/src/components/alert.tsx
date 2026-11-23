// Alert: a note set into the page, for something to know, something that went well, something to
// look at, or something that went wrong: a tinted ground with no border or shadow,
// an icon in the note's colour, a short title over a sentence.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Alert>
//     <AlertTitle>Exports are ready</AlertTitle>
//     <AlertDescription>The CSV has finished and is ready to download.</AlertDescription>
//   </Alert>
//   <Alert variant="warning">…</Alert>                 something to look at
//   <Alert variant="destructive" appearance="subtle">…</Alert>   no fill, inside a row or a rail
//   <Alert appearance="banner" variant="warning" onClose={remember}>
//     <AlertTitle>Scheduled maintenance</AlertTitle>
//     <AlertDescription>Sunday from 02:00 to 04:00.</AlertDescription>
//     <AlertAction><Button size="xs">Read more</Button></AlertAction>
//   </Alert>
//
// `appearance="banner"` is a message across the top of a page or the app, about the whole of it:
// full width, the system's soft edge, its actions after the words. The inline alert is about the
// part it sits in. Its actions stand beside the words when there is room, under them when not.
//
// An alert stays where it is; it is not a toast. A warning or a destructive alert is said to a
// screen reader when it appears (`role="alert"`); the others are read where they stand and said
// when their words change (`role="status"`). `live` sets it in a live region's words instead.
// Every value is a token. A caller may set layout and width only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, use, useState } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  Icon,
  InfoIcon,
  TriangleAlertIcon,
  XIcon,
} from "../lib/icons";
import type { IconData } from "../lib/icons";
import { hyphenate } from "../lib/styles";
import { colors, font, media, radius, size, space } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";
import { Button } from "./button";

/** What the note means: something to know, done, worth a look, gone wrong, or a plain note. */
export type AlertVariant =
  | "default"
  | "success"
  | "warning"
  | "destructive"
  | "info";

/**
 * Where it stands and how heavy it is: `inline` a tinted note in the part it is about, `subtle` the
 * same without fill or inset, `banner` across the top of a page or the app.
 */
export type AlertAppearance = "inline" | "subtle" | "banner";

/** Every prop an Alert takes. */
export interface AlertProps {
  /** Its parts: an AlertTitle, an AlertDescription and, when there is something to do, an AlertAction. */
  children: ReactNode;
  /**
   * What it means: `default` something to know, `success` it went well, `warning` something to
   * look at before it becomes a problem, `destructive` it went wrong, `info` a plain note.
   * @default "default"
   */
  variant?: AlertVariant;
  /**
   * `inline` a note set into the part it is about. `subtle` the same with no fill and no inset, the
   * icon in its colour beside the words, for an alert inside a row or a rail next to quiet rows.
   * `banner` a message across the top of a page or the app, about the whole of it: full width, with
   * the system's soft edge.
   * @default "inline"
   */
  appearance?: AlertAppearance;
  /** Another icon from lib/icons, or `false` for none. Each variant has its own. */
  icon?: IconData | false;
  /**
   * Shows a close button at the end, named by the I18nProvider (`alert.close`). The alert goes at
   * once, then this runs: remember it, so it does not come back on the next page.
   */
  onClose?: () => void;
  /**
   * How a screen reader hears it, when the variant's own does not fit: `polite` is a status (said
   * when its words change), `assertive` an alert (said when it appears), `off` no live role, for a
   * note that is part of the page.
   */
  live?: "polite" | "assertive" | "off";
  /** An id, so a field or a section can point at it with `aria-describedby`. */
  id?: string;
  /** Layout only: where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop an AlertTitle takes. */
export interface AlertTitleProps {
  /** The news in a few words. Leave the part out when one sentence says it all. */
  children: ReactNode;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop an AlertDescription takes. */
export interface AlertDescriptionProps {
  /** One or two sentences: what it means and, when there is one, what to do. */
  children: ReactNode;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop an AlertAction takes. */
export interface AlertActionProps {
  /** What to do about it: one or two Buttons of size `xs`, the main one first. */
  children: ReactNode;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

const FORCED = media.forcedColors;
// The actions stand beside the words once the words keep 12rem and the actions their own width.
const WIDE = "@container (width >= 24rem)";

const styles = stylex.create({
  alert: {
    [iconVars.size]: size.iconDefault,
    [iconVars.stroke]: size.iconStroke,
    display: "grid",
    columnGap: space["3"],
    alignItems: "start",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    paddingBlock: space["3"],
    paddingInline: space["4"],
    borderRadius: radius.base,
    cornerShape: radius.shape,
    // No border and no shadow: the tint is the edge. In forced colours a real border draws it.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.bodyForeground,
    // Hyphenated only when long; a word longer than the line still breaks.
    overflowWrap: "anywhere",
  },
  // The columns: the icon, the words, and the close button, each when it is there.
  iconWords: { gridTemplateColumns: "auto minmax(0, 1fr)" },
  iconWordsClose: { gridTemplateColumns: "auto minmax(0, 1fr) auto" },
  words: { gridTemplateColumns: "minmax(0, 1fr)" },
  wordsClose: { gridTemplateColumns: "minmax(0, 1fr) auto" },
  subtle: {
    paddingBlock: 0,
    paddingInline: 0,
    borderRadius: 0,
    borderWidth: 0,
  },
  // The banner: 12px all round, the system's soft edge, the smaller icon, 8px to the words.
  banner: {
    [iconVars.size]: size.iconSm,
    columnGap: 0,
    padding: space["3"],
    borderRadius: radius.base,
    boxShadow: size.borderStrong,
  },
  default: { backgroundColor: colors.alertBgDefault },
  success: { backgroundColor: colors.successSubtle },
  warning: { backgroundColor: colors.warningSubtle },
  destructive: { backgroundColor: colors.destructiveSubtle },
  info: { backgroundColor: colors.infoSubtle },
  // The icon sits on the first line, in the note's colour: centred on it.
  icon: {
    display: "inline-flex",
    marginBlock: `calc((${font.textSmLine} - ${size.iconDefault}) / 2)`,
  },
  iconBanner: {
    flexShrink: 0,
    marginBlock: 0,
    marginBlockStart: `calc(${space["1"]} + (${font.textSmLine} - ${size.iconSm}) / 2)`,
    marginInlineEnd: space["2"],
  },
  iconDefault: { color: colors.mutedForeground },
  iconSuccess: { color: colors.success },
  iconWarning: { color: colors.warning },
  iconDestructive: { color: colors.destructive },
  iconInfo: { color: colors.info },
  // The words and the actions: a container, so the actions move beside the words by its own width.
  body: { containerType: "inline-size", minWidth: 0 },
  content: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [WIDE]: "minmax(0, 1fr) auto",
    },
    columnGap: space["2"],
    rowGap: space["1"],
    minWidth: 0,
  },
  // In a banner the words stand level with a 28px button: 4px above and below them.
  contentBanner: { paddingBlock: space["1"], textWrap: "pretty" },
  title: {
    gridColumn: "1",
    // Its own tracking: a host page's heading rules never reach it.
    letterSpacing: font.trackingUi,
    margin: 0,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  description: { gridColumn: "1", margin: 0, minWidth: 0 },
  // Beside the words at their end when there is room, under them on their start edge when not.
  action: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
    gridColumn: { default: "1", [WIDE]: "2" },
    gridRow: { default: null, [WIDE]: "1 / span 2" },
    marginBlockStart: { default: space["1"], [WIDE]: 0 },
  },
  actionBanner: {
    marginBlockStart: {
      default: space["2"],
      [WIDE]: `calc(-1 * ${space["1"]})`,
    },
    marginBlockEnd: `calc(-1 * ${space["1"]})`,
  },
  close: { display: "flex", marginInlineStart: space["4"] },
});

const icons: Record<AlertVariant, IconData> = {
  default: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
  destructive: CircleAlertIcon,
  info: InfoIcon,
};
const iconColours = {
  default: styles.iconDefault,
  success: styles.iconSuccess,
  warning: styles.iconWarning,
  destructive: styles.iconDestructive,
  info: styles.iconInfo,
} as const;
// Something to look at or something wrong is said at once; the rest when the reader is free.
const roles: Record<AlertVariant, "alert" | "status"> = {
  default: "status",
  success: "status",
  warning: "alert",
  destructive: "alert",
  info: "status",
};
// `live` in a live region's words, as the role it gives.
const byLive = {
  polite: "status",
  assertive: "alert",
  off: undefined,
} as const;

/** The grid's columns: the icon, the words and the close button, each when it is there. */
const columnsOf = (hasIcon: boolean, closable: boolean) => {
  if (hasIcon) {
    return closable ? styles.iconWordsClose : styles.iconWords;
  }
  return closable ? styles.wordsClose : styles.words;
};

// Whether the alert is a banner, so its actions stand level with its words.
const InBanner = createContext(false);

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where focus goes as a closed alert leaves, so it never falls to the page: the control before it,
 * else the one after it, else the nearest box round it that takes focus. Within its dialog, if it
 * stands in one.
 */
const focusAround = (alert: HTMLElement) => {
  const scope =
    alert.parentElement?.closest<HTMLElement>(
      "dialog, [role=dialog], [role=alertdialog]"
    ) ?? alert.ownerDocument.body;
  const stops = [...scope.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (stop) => !alert.contains(stop) && stop.checkVisibility()
  );
  // Stops outside the alert stand wholly before or after it (a box round it is neither).
  const before = stops.findLast(
    (stop) =>
      alert.compareDocumentPosition(stop) === Node.DOCUMENT_POSITION_PRECEDING
  );
  const after = stops.find(
    (stop) =>
      alert.compareDocumentPosition(stop) === Node.DOCUMENT_POSITION_FOLLOWING
  );
  (
    before ??
    after ??
    alert.parentElement?.closest<HTMLElement>("[tabindex]")
  )?.focus();
};

/** A note set into the page: its icon, its title and sentence, its actions and a close button. */
export const Alert = ({
  children,
  variant = "default",
  appearance = "inline",
  icon,
  onClose,
  live,
  id,
  style,
}: AlertProps) => {
  const { alert: words } = useI18n();
  const [closed, setClosed] = useState(false);
  if (closed) {
    return null;
  }
  const mark = icon === false ? undefined : (icon ?? icons[variant]);
  const role = live === undefined ? roles[variant] : byLive[live];
  const banner = appearance === "banner";
  return (
    <div
      id={id}
      role={role}
      data-slot="alert"
      data-variant={variant}
      data-appearance={appearance}
      {...stylex.props(
        styles.alert,
        hyphenate,
        columnsOf(mark !== undefined, onClose !== undefined),
        appearance !== "subtle" && styles[variant],
        appearance === "subtle" && styles.subtle,
        banner && styles.banner,
        style
      )}
    >
      {mark && (
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.icon,
            banner && styles.iconBanner,
            iconColours[variant]
          )}
        >
          <Icon icon={mark} />
        </span>
      )}
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.content, banner && styles.contentBanner)}>
          <InBanner value={banner}>{children}</InBanner>
        </div>
      </div>
      {onClose && (
        <span data-slot="alert-close" {...stylex.props(styles.close)}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={words.close}
            onClick={(event) => {
              const alert =
                event.currentTarget.closest<HTMLElement>("[data-slot=alert]");
              if (alert?.contains(document.activeElement) === true) {
                focusAround(alert);
              }
              setClosed(true);
              onClose();
            }}
          >
            <Icon icon={XIcon} />
          </Button>
        </span>
      )}
    </div>
  );
};

/** The news in a few words, over the sentence. */
export const AlertTitle = ({ children, style }: AlertTitleProps) => (
  <p data-slot="alert-title" {...stylex.props(styles.title, style)}>
    {children}
  </p>
);

/** One or two sentences: what it means and what to do. */
export const AlertDescription = ({
  children,
  style,
}: AlertDescriptionProps) => (
  <div
    data-slot="alert-description"
    {...stylex.props(styles.description, style)}
  >
    {children}
  </div>
);

/** What to do about it: beside the words when there is room, under them when not. */
export const AlertAction = ({ children, style }: AlertActionProps) => (
  <div
    data-slot="alert-action"
    {...stylex.props(
      styles.action,
      use(InBanner) && styles.actionBanner,
      style
    )}
  >
    {children}
  </div>
);
