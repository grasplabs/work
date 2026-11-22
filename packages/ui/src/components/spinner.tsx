// Spinner: says that something is working,
// in StyleX: Hugeicons' loader (through lib/icons), turning in the colour
// of the words around it, so it works as a Button's child. With reduced motion it stands still and
// breathes.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Spinner aria-label="Loading the report" />            alone: a status that says its label
//   <p role="status"><Spinner /> Loading the report</p>    beside words: they are the status
//   <Button disabled><Spinner /> Saving</Button>           in a button: the button's words say it
//
// A caller may set layout only (the `style` prop). A part round it may set `spinnerVars`.
import * as stylex from "@stylexjs/stylex";

import { Icon, LoaderIcon } from "../lib/icons";
import { visuallyHidden } from "../lib/styles";
import { duration, media, size } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";
import { spinnerVars } from "./spinner.stylex";

export type SpinnerSize = "default" | "lg" | "xl";

/** Every prop a Spinner takes. */
export interface SpinnerProps {
  /**
   * What is working, said once to a screen reader ("Loading the report"), never shown: the spinner
   * is then a status. Give it when no words beside it say so; leave it out when they do, and make
   * those words the status.
   */
  "aria-label"?: string;
  /**
   * `default` beside small text and in a button, `lg` beside body text, `xl` alone in a panel.
   * @default "default"
   */
  size?: SpinnerSize;
  /** Layout only: margins and alignment. The look belongs to the spinner. */
  style?: LayoutStyle;
}

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});
// The reduced form: it stands still and breathes.
const breathe = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: size.spinnerFaint },
});

const styles = stylex.create({
  spinner: {
    [iconVars.stroke]: spinnerVars.stroke,
    display: "inline-flex",
    flexShrink: 0,
    verticalAlign: "middle",
    color: "inherit",
    // The fade: each bar a step fainter than the one ahead of it, down to the floor, so the turn
    // reads as a chase. A mask over the icon: no bar is drawn by hand.
    maskImage: `conic-gradient(oklch(0 0 none / ${spinnerVars.floor}), oklch(0 0 none))`,
    animationName: { default: spin, [media.reducedMotion]: breathe },
    animationDuration: {
      default: duration.spin,
      [media.reducedMotion]: size.spinnerBreath,
    },
    animationTimingFunction: {
      default: "linear",
      [media.reducedMotion]: duration.spinnerEase,
    },
    animationIterationCount: "infinite",
  },
  default: { [iconVars.size]: size.iconSm },
  lg: { [iconVars.size]: size.iconDefault },
  xl: { [iconVars.size]: size.spinnerLg },
});

const sizes = { default: styles.default, lg: styles.lg, xl: styles.xl };

export const Spinner = ({
  "aria-label": label,
  size: sized = "default",
  style,
}: SpinnerProps) => {
  const spinner = (
    <span
      aria-hidden="true"
      data-slot="spinner"
      {...stylex.props(
        styles.spinner,
        sizes[sized],
        label === undefined && style
      )}
    >
      <Icon icon={LoaderIcon} />
    </span>
  );
  if (label === undefined) {
    return spinner;
  }
  // A live region reads its text, not a name: the label is hidden text inside the status. Not
  // every screen reader treats <output> as a live region; role="status" is.
  return (
    <span role="status" {...stylex.props(style)}>
      {spinner}
      <span {...stylex.props(visuallyHidden)}>{label}</span>
    </span>
  );
};
