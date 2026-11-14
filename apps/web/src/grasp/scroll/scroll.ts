// Scroll: every box in Grasp UI that scrolls with the browser (a list in a popup, a dialog's body,
// a table, a text area, a code view) scrolls with no visible bar, at rest or in motion, as the
// product does. Like src/focus/focus.ts, it goes last in a scroller's stylex.props():
//
//   stylex.props(styles.list, scroll.bar)
//
// The box still scrolls by wheel, touch, keys and focus; a hidden bar costs nothing else. Where it
// matters that there is more, the part says so calmly itself (a dialog's body draws a hairline
// once it has scrolled, a popup's list fades at the edge content goes under). Scroll area is the
// one part that draws bars of its own, on purpose.
//
// `scrollbar-width: none` hides the bar in Chromium, Firefox and Safari 18.2 and later. No
// `::-webkit-scrollbar` rule ships in a component file: the product's lint (grasp/no-scrollbars)
// forbids one, and Safari before 18.2 is out of support.
import * as stylex from "@stylexjs/stylex";

export const scroll = stylex.create({
  bar: {
    scrollbarWidth: "none",
  },
});
