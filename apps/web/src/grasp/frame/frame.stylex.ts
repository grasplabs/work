// The frame's own values: the sidebar and the page's card, measured from
// Profound's platform (13 November 2026) as the bar for how it feels, in
// Grasp's colours. Each is written once here and read by the frame's parts
// (grasp-sidebar.tsx, nav.tsx, page-bar.tsx, grasp.css). They belong in
// Grasp UI's tokens (grasplabs/ui, tokens/tokens.ts) once the frame is
// agreed, and come from there after.
//
// The neutrals carry Grasp's green at a whisper, so the frame sits with the
// tokens around it; dark values follow the theme through light-dark(), as
// Grasp UI's tokens do.
import * as stylex from "@stylexjs/stylex";

export const frame = stylex.defineConsts({
  // The frame is neutral, as Capy's: greys with no hue, and ink laid over
  // the ground at a few percent for what is pointed at, chosen or ruled
  // off, so it reads the same on the sidebar and the card. Grasp's green
  // is kept for what means something (the person's initials, a count).
  // The window's ground, which the sidebar stands on.
  ground: "light-dark(oklch(0.957 0 0), oklch(0.18 0 0))",
  // The page's card on it.
  card: "light-dark(oklch(1 0 0), oklch(0.215 0 0))",
  // Where the person is.
  selected: "light-dark(oklch(0 0 0 / 0.05), oklch(1 0 0 / 0.07))",
  // A row or button under the pointer.
  hover: "light-dark(oklch(0 0 0 / 0.035), oklch(1 0 0 / 0.05))",
  // Rules: under nothing but what parts the sidebar, and a badge's edge.
  rule: "light-dark(oklch(0 0 0 / 0.08), oklch(1 0 0 / 0.1))",
  // Words: what is read first, then the rows' and the icons', then labels.
  textPrimary: "light-dark(oklch(0.269 0 0), oklch(0.96 0 0))",
  textSecondary: "light-dark(oklch(0.54 0 0), oklch(0.72 0 0))",
  textTertiary: "light-dark(oklch(0.64 0 0), oklch(0.6 0 0))",
  // The card lifts off the ground by a hair, with a faint ring round it.
  cardShadow:
    "0 4px 4px 0 oklch(0 0 0 / 0.02), 0 4px 80px 8px oklch(0 0 0 / 0.02), 0 0 0 1px light-dark(oklch(0 0 0 / 0.05), oklch(1 0 0 / 0.08))",
  // Sizes: Capy's edge (8 in from the sidebar's side), with rows of 32,
  // two apart, and 16px icons, a step roomier than Capy's.
  sidebar: "240px",
  gutter: "8px",
  inset: "6px",
  head: "16px",
  row: "32px",
  rowGap: "2px",
  rowBlock: "6px",
  rowInline: "8px",
  iconGap: "10px",
  icon: "16px",
  iconButton: "28px",
  corner: "6px",
  cardCorner: "12px",
  // Type: a hair tighter than set, as Capy's rows.
  tracking: "-0.01em",
  // How fast what is pointed at answers.
  answer: "100ms",
});
