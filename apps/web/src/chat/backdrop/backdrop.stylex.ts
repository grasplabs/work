import * as stylex from "@stylexjs/stylex";

// The backdrop's own colours and sizes, as #2503's library has them
// (its `backdrop-*` tokens): Damsko has no Backdrop, so they stand here,
// on Damsko's colours (their variables) where the reference reads its own.

export const backdrop = stylex.defineConsts({
  /** Sand's grains: pine on a light ground, sea on a dark one. */
  grain: "light-dark(var(--damsko-brand-pine), var(--damsko-brand-sea))",
  /** The one grain in a few that is mint. */
  spark: "var(--damsko-mint-deep)",
  /** A dither in Light: sea, half strength, so a full field reads as a tint. */
  toneLight: "oklch(0.882 0.094 160.99 / 0.5)",
  /** A dither in Deep: pine; on a dark ground a lifted pine, so it still shows. */
  toneDeep:
    "light-dark(oklch(0.4321 0.0778 175.187 / 0.3), oklch(0.72 0.12 168 / 0.3))",
  /** A dither in Mint. */
  toneMint: "oklch(0.8005 0.1625 165.25 / 0.28)",
  /** A dither in Lime. */
  toneLime: "oklch(0.851 0.182 131.04 / 0.34)",
  /** A dither in Ink: evergreen, faint; on a dark ground faint sea. */
  toneInk:
    "light-dark(oklch(0.267 0.048 169.88 / 0.16), oklch(0.882 0.094 160.99 / 0.13))",
  /** How a dither thins from the far corners in: strongest at the edge, a trace under the words. */
  ditherMask:
    "radial-gradient(150% 135% at 50% 110%, rgb(0 0 0 / 0.05) 0%, rgb(0 0 0 / 0.07) 40%, rgb(0 0 0 / 0.22) 62%, rgb(0 0 0 / 0.6) 80%, black 96%)",
  /** A backdrop's preview: a window on it, as wide as a screen. */
  previewRatio: "16 / 9",
  /** How wide the question and the box stand in a backdrop's preview. */
  previewWords: "62%",
  /** The preview's frame: the page's card's shadow and edge (#2503's shell card). */
  previewShadow:
    "0 4px 4px 0 oklch(0 0 0 / 0.02), 0 4px 80px 8px oklch(0 0 0 / 0.02), 0 0 0 1px light-dark(oklch(0 0 0 / 0.05), oklch(1 0 0 / 0.08))",
});
