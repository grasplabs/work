// Focus: the one way Grasp UI shows where the keyboard is. Every component and every site block
// takes its focus look from here, last in its stylex.props(), and sets no outline of its own.
//
//   stylex.props(styles.button, focus.ring)        a control: button, checkbox, tab, segment, chip
//   stylex.props(styles.link, focus.words)         words: a link, a row's name
//   stylex.props(styles.scroller, focus.inside)    a box its parent clips: a code view, a nav row
//   stylex.props(styles.input, focus.field)        a field you type in (with its own focus edge)
//
// A control shows focus only for the keyboard (:focus-visible), so a click shows nothing extra.
// A field shows it whenever it has focus (a text field always matches :focus-visible), because
// typing needs to know where it goes. The ring sits on the control's edge and follows its shape:
// one mark, not a second frame. A field has no ring at all: its own edge takes the focus colour,
// with a halo (grasp.fieldFocus), and in forced colours, where shadows are dropped, a real outline.
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex.ts";

const line = `${grasp.ringWidth} solid ${grasp.ring}`;

export const focus = stylex.create({
  ring: {
    outline: { default: "none", ":focus-visible": line },
    outlineOffset: grasp.ringOffset,
  },
  words: {
    outline: { default: "none", ":focus-visible": line },
    outlineOffset: grasp.ringOffsetWords,
  },
  inside: {
    outline: { default: "none", ":focus-visible": line },
    outlineOffset: `calc(-1 * ${grasp.ringWidth})`,
  },
  field: {
    outline: {
      default: "none",
      [media.forced]: {
        default: "none",
        ":focus-visible": `${grasp.ringWidth} solid`,
      },
    },
    outlineOffset: grasp.ringOffset,
  },
});
