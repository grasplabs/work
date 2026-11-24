import { colors, font } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  // A line of its own, in the destructive ink at the size of a control's words.
  error: {
    display: "block",
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    color: colors.destructive,
    overflowWrap: "anywhere",
  },
});

/**
 * Why something failed, announced to screen readers; nothing when it didn't.
 * A block `span`, so it is valid inside a line as much as in a block (an
 * Item's words are a `span`). Damsko's Text has no destructive colour and
 * its FieldError needs a Field, so this line is the product's own.
 */
export const ErrorText = ({ children }: { children?: string }) =>
  children === undefined ? null : (
    <span role="alert" {...stylex.props(styles.error)}>
      {children}
    </span>
  );
