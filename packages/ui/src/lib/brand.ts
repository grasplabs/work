/**
 * The brand book's colours as values, for what is drawn outside the
 * stylesheet: a canvas, which reads the theme's tokens but needs a value
 * before the stylesheet has its say, and pages printed to PDF. Everything
 * else reads the theme's tokens. These are the same values as the
 * stylesheet's `--brand-*` (styles.css), and brand.test.ts keeps the two
 * equal.
 */
export const BRAND = {
  ink: "#062d22",
  text: "#34503f",
  muted: "#5f7769",
  quiet: "#8a9d92",
  unlit: "#c3cec8",
  canvas: "#fbfdff",
  soft: "#f3f6f4",
  line: "#e0e7e2",
  hairline: "#062d2212",
  white: "#ffffff",
  lime: "#d9f9ad",
  limePressed: "#cdf394",
  limeEdge: "#bfe58c",
  limeShade: "#6fae2e",
  forest: "#10402f",
  signal: "#3fae6a",
  passed: "#1f8a5b",
  passedText: "#1c7148",
  amber: "#82560f",
  amberSoft: "#f9efd9",
  red: "#b04a35",
  focus: "#3f7a57",
  logo: "#04251b",
  iconTile: "#e7f6d9",
  underline: "#b7e67a",
  voice: "#e0542c",
  glow: "#f6c35a",
  kept: "#269658",
  keptLight: "#aae870",
  dawn: "#b9c8c8",
  mist: "#b4c6cc",
  sand: "#cdc8b2",
  sage: "#b8ccb2",
  blush: "#d6c4c4",
  stone: "#c8c8c6",
  grove: "#173f2d",
  tide: "#12282e",
  night: "#0d1714",
} as const;

/** A colour of the brand by its name. */
export type BrandColor = keyof typeof BRAND;
