/**
 * The link a whole table row opens by (`TableRow interactive`, its link
 * marked `data-row-target`), as the web app's rows draw it: the row's
 * words, no line, and its press area stretched over the row. Damsko's row
 * draws the pointer and, while the link has the keyboard's focus, the ring
 * round the whole row. A router `Link` takes it directly: Damsko's `Link`
 * stands its own box (`position: relative`), which would hold the stretch
 * to the words.
 */
import * as stylex from "@stylexjs/stylex";

export const rowTarget = stylex.create({
  stretch: {
    color: "inherit",
    textDecoration: "none",
    outline: "none",
    "::after": { content: '""', position: "absolute", inset: 0 },
  },
}).stretch;
