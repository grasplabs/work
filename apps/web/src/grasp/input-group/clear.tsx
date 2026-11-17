// InputGroupClear: a square at the end of an InputGroup (input-group.tsx) that empties its input
// and puts the caret back in it. On UI SDK's InputClear, so it is there only while there is text,
// and an agent can press it by its name.
"use client";

import * as stylex from "@stylexjs/stylex";
import { InputClear as ClearPrimitive } from "@ui-sdk/react/input";

import { focus } from "../focus/focus";
import { Cross, Icon } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useGroupSize } from "./context";

/** Every prop an InputGroupClear takes. */
export interface InputGroupClearProps {
  /** Its name, for a screen reader, a voice command and an agent: "Clear search". */
  label: string;
}

const HOVER = media.hover;
const COARSE = media.coarse;

const styles = stylex.create({
  // A square in the group's end square, set in from its edge by space-1 on every side, so its focus
  // ring stands inside the group and never steps over its edge (third look A3-text-02), as
  // PasswordInput's button. In muted, ink under a pointer.
  clear: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    flexShrink: 0,
    alignSelf: "stretch",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBlock: grasp.space1,
    marginInline: grasp.space1,
    padding: 0,
    borderWidth: 0,
    // Its corner nests inside the group's, space-1 in.
    borderRadius: `max(0px, calc(${grasp.corner} - ${grasp.space1}))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: "transparent",
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  md: { width: `calc(${grasp.controlMd} - 2 * ${grasp.space1})` },
  lg: { width: `calc(${grasp.controlLg} - 2 * ${grasp.space1})` },
  // A finger needs 44px round it too; at rest the press covers the whole end square.
  target: {
    position: "absolute",
    inset: {
      default: `calc(-1 * ${grasp.space1})`,
      [COARSE]: `calc((100% - ${grasp.tap}) / 2)`,
    },
  },
});

/** Empties the input in its group; shown only while there is text. */
export const InputGroupClear = ({ label }: InputGroupClearProps) => {
  const size = useGroupSize();
  return (
    <ClearPrimitive
      aria-label={label}
      {...stylex.props(styles.clear, styles[size], focus.ring)}
    >
      <span aria-hidden="true" {...stylex.props(styles.target)} />
      <Icon icon={Cross} />
    </ClearPrimitive>
  );
};
