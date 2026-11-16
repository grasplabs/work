// Collapsible: one panel that opens and closes under its trigger, from shadcn's
// (registry/bases/base/ui/collapsible.tsx, on Base UI), converted from Tailwind to StyleX and
// rebuilt on UI SDK's Collapsible, with Palermo's look: a full-width trigger with a chevron at its
// end, and quiet words under it that open over 200ms.
//
//   <Collapsible title="Advanced settings">Only change these with the owner.</Collapsible>
//   <Collapsible title="Section 1" variant="raised" defaultOpen>…</Collapsible>
//
// The panel stays readable by the browser's find in page while closed. Every value is a token.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Collapsible as CollapsiblePrimitive,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@ui-sdk/react/collapsible";
import type { CollapsibleState } from "@ui-sdk/react/collapsible";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { ChevronDown, Icon } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

type Layout = string | number | null;

/** What a caller may style: where it sits and how wide it is. */
export type CollapsibleLayoutStyle = stylex.StyleXStyles<{
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

/** Every prop a Collapsible takes. */
export interface CollapsibleProps {
  /** The words on the trigger: what opens ("Advanced settings"). */
  title: ReactNode;
  /** What the panel holds. */
  children: ReactNode;
  /** Whether it is open. Pass it with `onOpenChange` to control it. */
  open?: boolean;
  /**
   * Whether it starts open, when you do not control it.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs with the new state when the trigger is pressed. */
  onOpenChange?: (open: boolean) => void;
  /**
   * `ghost` lies on the page; `raised` stands off it, as a quiet button.
   * @default "ghost"
   */
  variant?: "ghost" | "raised";
  /**
   * The trigger is only as wide as its words and its chevron, which then stands beside them: for
   * one quiet line among words. Without it the trigger runs the whole width, chevron at the end.
   * @default false
   */
  fit?: boolean;
  /**
   * The trigger does nothing; it stays focusable.
   * @default false
   */
  disabled?: boolean;
  /** Layout only: where it sits and how wide it is. */
  style?: CollapsibleLayoutStyle;
}

const HOVER = media.hover;
const COARSE = media.coarse;
const OFF = ":is([data-disabled])";
// Without script nothing opens a panel, so every panel shows open.
const NO_SCRIPT = media.noScript;

const styles = stylex.create({
  root: {
    display: "grid",
    width: "100%",
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  trigger: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    minHeight: grasp.collapsibleTrigger,
    // The trigger bleeds out by its own padding, so its words and the panel's share one left edge
    // and the chevron ends where the panel does; hover and focus still have room round them.
    marginBlock: 0,
    marginInline: `calc(-1 * ${grasp.collapsibleInset})`,
    paddingBlock: 0,
    paddingInline: grasp.collapsibleInset,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: `min(${grasp.corner}, calc(${grasp.collapsibleTrigger} / 2))`,
    cornerShape: grasp.cornerShape,
    fontFamily: "inherit",
    fontSize: grasp.textSm,
    lineHeight: "1.125rem",
    fontWeight: grasp.weightMedium,
    textAlign: "start",
    color: {
      default: grasp.ink,
      [OFF]: { default: grasp.quiet, [media.forced]: "GrayText" },
    },
    cursor: { default: "pointer", [OFF]: "not-allowed" },
    transform: {
      default: null,
      ":active": { default: `scale(${grasp.pressScale})`, [OFF]: "none" },
    },
    transitionProperty: "transform, background-color",
    // With reduced motion the press still shows, at once, without travelling.
    transitionDuration: `${simply.hover}, ${grasp.durationHover}`,
    transitionTimingFunction: grasp.ease,
    touchAction: "manipulation",
    WebkitTapHighlightColor: "transparent",
  },
  // A disabled trigger takes no hover and no press: its rest wins under the pointer. Said inside
  // :hover and :active, since a bare [data-disabled] sorts before them and lost (B-collapsible-01).
  ghost: {
    backgroundColor: {
      default: "transparent",
      ":hover": {
        default: null,
        [HOVER]: { default: grasp.ghostFillHover, [OFF]: "transparent" },
      },
      ":active": { default: grasp.ghostFillPress, [OFF]: "transparent" },
      [OFF]: "transparent",
    },
  },
  raised: {
    backgroundColor: {
      default: grasp.quietFill,
      ":hover": {
        default: null,
        [HOVER]: { default: grasp.quietFillHover, [OFF]: grasp.soft },
      },
      ":active": { default: grasp.quietFillPress, [OFF]: grasp.soft },
      [OFF]: grasp.soft,
    },
    boxShadow: { default: grasp.liftLow, [OFF]: "none" },
  },
  // A finger needs 44px: on a touch screen an invisible area makes up the difference.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.collapsibleTrigger} - ${grasp.tap}) / 2)`,
    },
  },
  words: {
    flexGrow: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  // Points down while closed and turns up as it opens.
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  chevronOpen: {
    transform: "rotate(0.5turn)",
  },
  // Only as wide as its words and chevron: at the start, the chevron a step after the words.
  fit: {
    justifySelf: "start",
    maxWidth: "100%",
    columnGap: grasp.space1,
  },
  fitWords: {
    flexGrow: 0,
  },
  panel: {
    // A base stylesheet that hides [hidden] with !important (the docs' own) still wins over this.
    display: { default: null, [NO_SCRIPT]: "block" },
    height: { default: "var(--collapsible-panel-height)", [NO_SCRIPT]: "auto" },
    overflow: "hidden",
    fontSize: grasp.textXs,
    lineHeight: "1.125rem",
    color: grasp.muted,
    transitionProperty: "height",
    transitionDuration: simply.open,
    transitionTimingFunction: "ease-out",
  },
  // The words in an open panel stand a step off the trigger above and the next thing below, as
  // Accordion's do, so they read with their own trigger, not stuck under it (B-collapsible-02). On
  // a part inside the panel: padding on the panel itself would show while it is closed.
  body: {
    paddingBlock: grasp.space2,
  },
  panelMoving: {
    height: {
      default: "var(--collapsible-panel-height)",
      ":is([data-starting-style], [data-ending-style])": 0,
      [NO_SCRIPT]: "auto",
    },
  },
  // The same motion in an accordion, which measures its panels under its own name.
  panelAccordion: {
    height: {
      default: "var(--accordion-panel-height)",
      ":is([data-starting-style], [data-ending-style])": 0,
      [NO_SCRIPT]: "auto",
    },
  },
});

/** The trigger's look and the panel's motion, shared with Accordion, which is a set of these. */
export const collapsibleStyles = styles;

export const Collapsible = ({
  title,
  children,
  open,
  defaultOpen,
  onOpenChange,
  variant = "ghost",
  fit = false,
  disabled,
  style,
}: CollapsibleProps) => (
  <CollapsiblePrimitive
    data-slot="collapsible"
    open={open}
    defaultOpen={defaultOpen}
    onOpenChange={
      onOpenChange
        ? (next: boolean) => {
            onOpenChange(next);
          }
        : undefined
    }
    disabled={disabled}
    {...stylex.props(styles.root, style)}
  >
    <CollapsibleTrigger
      {...stylex.props(
        styles.trigger,
        styles[variant],
        fit && styles.fit,
        focus.ring
      )}
    >
      {(state: CollapsibleState) => (
        <>
          <span aria-hidden="true" {...stylex.props(styles.target)} />
          <span {...stylex.props(styles.words, fit && styles.fitWords)}>
            {title}
          </span>
          <span
            aria-hidden="true"
            {...stylex.props(styles.chevron, state.open && styles.chevronOpen)}
          >
            <Icon icon={ChevronDown} />
          </span>
        </>
      )}
    </CollapsibleTrigger>
    {/* The class only: UI SDK writes the panel's measured height as its own inline style. */}
    <CollapsiblePanel
      hiddenUntilFound
      className={stylex.props(styles.panel, styles.panelMoving).className}
    >
      <div {...stylex.props(styles.body)}>{children}</div>
    </CollapsiblePanel>
  </CollapsiblePrimitive>
);
