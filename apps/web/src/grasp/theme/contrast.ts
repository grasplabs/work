// Contrast of two opaque oklch() colours, WCAG 2, for a product's accent (accent.ts). The same
// maths as tokens/contrast.ts, which the token build uses; this copy ships with the theme, so a
// product can check its own colour without the build.
interface Rgb {
  r: number;
  g: number;
  b: number;
}

const OKLCH =
  /^oklch\(\s*(?<l>[\d.]+)(?<percent>%?)\s+(?<c>[\d.]+)\s+(?<h>[\d.]+|none)\s*\)$/u;

/** Linear-light sRGB channel to its gamma-encoded value, clipped into gamut. */
const encode = (linear: number) => {
  const clipped = Math.min(1, Math.max(0, linear));
  return clipped <= 0.0031308
    ? 12.92 * clipped
    : 1.055 * clipped ** (1 / 2.4) - 0.055;
};

/** An opaque oklch() colour as gamma-encoded sRGB, or undefined when it is not one. */
const rgbOf = (colour: string): Rgb | undefined => {
  const groups = OKLCH.exec(colour.trim())?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const lightness = Number(groups.l) / (groups.percent === "%" ? 100 : 1);
  const chroma = Number(groups.c);
  const hue = groups.h === "none" ? 0 : (Number(groups.h) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
};

const channel = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const luminance = ({ r, g, b }: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG 2 contrast of two opaque oklch() colours, to two decimals; 0 when either is not one. */
export const contrastOf = (one: string, other: string): number => {
  const first = rgbOf(one);
  const second = rgbOf(other);
  if (first === undefined || second === undefined) {
    return 0;
  }
  const [light, dark] = [luminance(first), luminance(second)].toSorted(
    (x, y) => y - x
  );
  return Math.round((((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)) * 100) / 100;
};
