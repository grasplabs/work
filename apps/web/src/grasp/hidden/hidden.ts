// Visually hidden: words a screen reader says and the eye does not see (a live status, a table's
// caption, the name of an icon). The one way every component hides words, last in its
// stylex.props() like any look: the box is one pixel, clipped to nothing and kept out of the flow, so
// it takes no room, never wraps and is still read, found and announced.
//
//   <span {...stylex.props(visuallyHidden)}>Copied</span>
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  hidden: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    borderWidth: 0,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

/** Hides words from the eye and keeps them for a screen reader. */
export const visuallyHidden = styles.hidden;
