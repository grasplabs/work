// Spinner: says that something is working, from shadcn's (registry/bases/base/ui/spinner.tsx),
// converted from Tailwind to StyleX and made Grasp's after Palermo: Hugeicons' loader (the one
// icon set, through the icons entry (`@/components/grasp/icons`)), turning in the colour of the words around it. With reduced motion
// it stands still and breathes.
//
//   <Spinner label="Loading the report" />                 alone: a status that says its label
//   <p role="status"><Spinner /> Loading the report</p>    beside words: they are the status
//
// Inside a button, use the button's own working state (useAction); this is for everything else.
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
import * as stylex from "@stylexjs/stylex";

import { visuallyHidden } from "../hidden/hidden";
import { Icon, Spinner as SpinnerIcon } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { spinnerVars } from "./spinner.stylex";

export type SpinnerSize = "sm" | "md" | "lg";

/** What a caller may style: where the spinner sits. Never its look. */
export type SpinnerLayoutStyle = LayoutStyle;

/** Every prop a Spinner takes. */
export interface SpinnerProps {
  /**
   * What is working, said once to a screen reader ("Loading the report"), never shown. Give it when
   * no words beside it say so; leave it out when they do, and make those words the status.
   */
  label?: string;
  /**
   * `sm` beside small text, `md` beside body text, `lg` alone in a panel.
   * @default "sm"
   */
  size?: SpinnerSize;
  /** Layout only: margins and alignment. The look belongs to the spinner. */
  style?: SpinnerLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: SpinnerLayoutStyle;
}

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});
// The reduced form: it stands still and breathes.
const breathe = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: grasp.spinnerFaint },
});

const styles = stylex.create({
  spinner: {
    [iconVars.stroke]: spinnerVars.stroke,
    display: "inline-flex",
    flexShrink: 0,
    verticalAlign: "middle",
    color: "inherit",
    // The fade: each bar a step fainter than the one ahead of it, down to spinner-fade, so the
    // turn reads as a chase. A mask over the icon: no bar is drawn by hand.
    maskImage: `conic-gradient(oklch(0 0 none / ${spinnerVars.floor}), oklch(0 0 none))`,
    animationName: { default: spin, [media.reduced]: breathe },
    animationDuration: {
      default: grasp.durationSpin,
      [media.reduced]: grasp.spinnerBreath,
    },
    animationTimingFunction: {
      default: "linear",
      [media.reduced]: grasp.spinnerEase,
    },
    animationIterationCount: "infinite",
  },
  sm: { [iconVars.size]: grasp.iconSm },
  md: { [iconVars.size]: grasp.iconMd },
  lg: { [iconVars.size]: grasp.spinnerLg },
});

export const Spinner = ({
  label,
  size = "sm",
  style: styleProp,
  layout,
}: SpinnerProps) => {
  const spinner = (
    <span
      aria-hidden="true"
      data-slot="spinner"
      {...stylex.props(styles.spinner, styles[size], layout ?? styleProp)}
    >
      <Icon icon={SpinnerIcon} />
    </span>
  );
  if (label === undefined) {
    return spinner;
  }
  // A live region reads its text, not a name: the label is hidden text inside the status.
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region; role="status" is
    <span role="status">
      {spinner}
      <span {...stylex.props(visuallyHidden)}>{label}</span>
    </span>
  );
};
