// Alert's banner look (`variant="banner"`, once Banner; the breaking release's step 3): a message
// across the top of a page or the app, a notice, a warning, an outage. It runs the full width of
// what holds it, in the same tints as the inline Alert, with its actions and, when the message can
// be put away, a dismiss button at the end. After Palermo's Banner: the corner, a soft edge, 12px
// all round and 8px between the parts. Its own file, as it holds state (dismissed) and reads the
// product's words: the inline Alert stays a server component. Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { Button } from "../button";
import { Alert as Warning, Cross, Done, Failed, Icon, Info } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import type { AlertLayoutStyle, AlertVariant } from "./alert";
import { alertWords } from "./words";

const styles = stylex.create({
  banner: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    // Three columns: the icon, the message with its actions, and the dismiss button in the corner,
    // which stays there however the message wraps.
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "start",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    padding: grasp.space3,
    // Across the top of App shell's card (its `banner` row) it is a band: no corners of its own, so it
    // takes the card's at its top (the card clips it) and meets the bar under it square, never a
    // rounder corner inside the card's (App shell FRESH.md F71).
    borderRadius: {
      default: grasp.corner,
      [stylex.when.ancestor('[data-slot="app-shell-banner"]')]: 0,
    },
    cornerShape: grasp.cornerShape,
    // The system's soft edge, as Palermo's 1px edge. In forced colours a real border draws it.
    boxShadow: grasp.edge,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
    overflowWrap: "anywhere",
  },
  // With `icon={false}`: the message and the dismiss button only.
  noIcon: { gridTemplateColumns: "minmax(0, 1fr) auto" },
  neutral: { backgroundColor: grasp.alertFillNeutral },
  success: { backgroundColor: grasp.successSoft },
  attention: { backgroundColor: grasp.attentionSoft },
  danger: { backgroundColor: grasp.dangerSoft },
  // Level with the title's line, however many lines the message takes.
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    alignSelf: "flex-start",
    // The room to the words is the icon's own, so a banner without a dismiss button keeps no gap at its end.
    marginInlineEnd: grasp.space2,
    marginBlockStart: `calc(${grasp.space1} + (${grasp.textSmLine} - ${grasp.iconSm}) / 2)`,
  },
  iconNeutral: { color: grasp.muted },
  iconSuccess: { color: grasp.success },
  iconAttention: { color: grasp.attention },
  iconDanger: { color: grasp.danger },
  // The title on the first line, the message under it, as Palermo's.
  // The words take the line and give way down to 12rem, so the buttons stay beside them on a wide
  // line; under that the buttons move to the next line instead of squeezing them.
  words: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "min(100%, 12rem)",
    display: "grid",
    rowGap: grasp.space1,
    minWidth: 0,
    margin: 0,
    paddingBlock: grasp.space1,
    textWrap: "pretty",
  },
  title: {
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  // The words and the actions on one line when they fit. When they do not, the buttons go to the
  // next line, so a title never breaks word by word on a phone, and start there on the words'
  // edge: a line holding one item stands at its start (space-between), a line holding both puts
  // the buttons at its end.
  body: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "start",
    columnGap: grasp.space2,
    rowGap: grasp.space2,
    minWidth: 0,
  },
  // The actions 8px apart. On a very narrow screen they wrap among themselves rather than push the
  // page wider.
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  // 16px between the actions and the dismiss button, as Palermo's.
  dismiss: { display: "flex", marginInlineStart: grasp.space4 },
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

/** What the banner look takes from Alert's props, its tone and role already settled. */
export interface AlertBannerProps {
  children?: ReactNode;
  title?: string;
  tone: AlertVariant;
  icon?: IconData | false;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  role: "alert" | "status" | "none";
  id?: string;
  layout?: AlertLayoutStyle;
}

export const AlertBanner = ({
  children,
  title,
  tone,
  icon,
  action,
  onDismiss,
  dismissLabel,
  role,
  id,
  layout,
}: AlertBannerProps) => {
  const words = useWords("alert", alertWords);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) {
    return null;
  }
  const dismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };
  const mark = icon === false ? undefined : (icon ?? icons[tone]);
  return (
    <div
      id={id}
      data-slot="banner"
      data-tone={tone}
      role={role === "none" ? undefined : role}
      {...stylex.props(
        styles.banner,
        styles[tone],
        !mark && styles.noIcon,
        layout
      )}
    >
      {mark && (
        <span
          aria-hidden="true"
          {...stylex.props(styles.icon, iconColours[tone])}
        >
          <Icon icon={mark} />
        </span>
      )}
      <div {...stylex.props(styles.body)}>
        <p {...stylex.props(styles.words)}>
          {title !== undefined && title !== "" && (
            <span {...stylex.props(styles.title)}>{title}</span>
          )}
          {children !== undefined && <span>{children}</span>}
        </p>
        {action !== undefined && (
          <span {...stylex.props(styles.actions)}>{action}</span>
        )}
      </div>
      {onDismiss && (
        <span {...stylex.props(styles.dismiss)}>
          <Button
            variant="ghost"
            size="xs"
            icon={Cross}
            aria-label={dismissLabel ?? words.dismiss}
            onClick={dismiss}
          />
        </span>
      )}
    </div>
  );
};
