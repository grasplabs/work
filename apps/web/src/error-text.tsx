import * as stylex from "@stylexjs/stylex";

import { grasp } from "./grasp/tokens/tokens.stylex.ts";

const styles = stylex.create({
  // A line of its own, in the danger ink at the size of a control's words.
  error: {
    display: "block",
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightRegular,
    color: grasp.danger,
    overflowWrap: "anywhere",
  },
});

/**
 * Why something failed, announced to screen readers; nothing when it didn't.
 * A block `span`, so it is valid inside a line as much as in a block (an
 * Item's words are a `span`).
 */
export const ErrorText = ({ children }: { children?: string }) =>
  children === undefined ? null : (
    <span role="alert" {...stylex.props(styles.error)}>
      {children}
    </span>
  );
