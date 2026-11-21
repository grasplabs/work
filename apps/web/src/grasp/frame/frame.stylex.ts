// The page's card as Grasp UI's frame drew it before App shell, in Grasp's
// colours: read only by the chat backdrop's preview in Settings
// (grasp/field/backdrop-preview.tsx), which draws a small page card. It
// goes when that preview reads App shell's tokens (shellCard,
// shellCardCorner, shellCardShadow) instead.
import * as stylex from "@stylexjs/stylex";

export const frame = stylex.defineConsts({
  // The page's card.
  card: "light-dark(oklch(1 0 0), oklch(0.215 0 0))",
  // A rule: what parts the card from what is around it.
  rule: "light-dark(oklch(0 0 0 / 0.08), oklch(1 0 0 / 0.1))",
  // The card lifts off the ground by a hair, with a faint ring round it.
  cardShadow:
    "0 4px 4px 0 oklch(0 0 0 / 0.02), 0 4px 80px 8px oklch(0 0 0 / 0.02), 0 0 0 1px light-dark(oklch(0 0 0 / 0.05), oklch(1 0 0 / 0.08))",
  cardCorner: "12px",
});
