// A product's own accent: one OKLCH colour, from which a small ramp is made for the main action
// (its fill, its pressed fill, a checked box under the pointer) and the words on it, light and
// dark. The ramp is checked against the system's grounds, so a product learns at once when its
// colour fails: `checkAccent` gives every pair with its contrast and whether it holds.
//
// The provider sets the ramp on the element that carries the theme, so every token that names the
// main action (a progress bar's fill, a calendar's chosen day) follows it.
import { contrastOf as contrast } from "./contrast";

/** The ramp made from an accent, as CSS values: each token's light and dark colour. */
export interface AccentRamp {
  /** CSS custom property to its value, `light-dark(…, …)`. */
  properties: Record<string, string>;
}

interface Oklch {
  l: number;
  c: number;
  h: number;
}

const parse = (colour: string): Oklch | undefined => {
  const groups =
    /^oklch\(\s*(?<l>[\d.]+)(?<percent>%?)\s+(?<c>[\d.]+)\s+(?<h>[\d.]+)\s*\)$/u.exec(
      colour.trim()
    )?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const l = Number(groups.l) / (groups.percent === "%" ? 100 : 1);
  return { l, c: Number(groups.c), h: Number(groups.h) };
};

const print = ({ l, c, h }: Oklch) =>
  `oklch(${Math.round(l * 1000) / 1000} ${Math.round(c * 1000) / 1000} ${Math.round(h * 100) / 100})`;

/** The words on a fill: near white or the light's ink, whichever reads better. */
const wordsOn = (fill: string) => {
  const white = "oklch(0.99 0.004 160)";
  const ink = "oklch(0.267 0.048 169.88)";
  return contrast(white, fill) >= contrast(ink, fill) ? white : ink;
};

/** The colours of the ramp, light and dark, from one accent. */
const colours = (accent: Oklch) => {
  // In dark the fill comes up to stand on the night: the same hue, lighter, a little less chroma.
  const dark: Oklch = {
    l: Math.max(accent.l, 0.78),
    c: accent.c * 0.85,
    h: accent.h,
  };
  const fill = { light: print(accent), dark: print(dark) };
  const press = {
    light: print({ ...accent, l: Math.max(0, accent.l - 0.05) }),
    dark: print({ ...dark, l: Math.max(0, dark.l - 0.06) }),
  };
  const hover = {
    light: print({ ...accent, l: Math.min(1, accent.l + 0.05) }),
    dark: print({ ...dark, l: Math.min(1, dark.l + 0.04) }),
  };
  const text = { light: wordsOn(fill.light), dark: wordsOn(fill.dark) };
  return { fill, press, hover, text };
};

const both = (pair: { light: string; dark: string }) =>
  `light-dark(${pair.light}, ${pair.dark})`;

/** The ramp from an `oklch()` colour, or undefined when it is not one. */
export const accentRamp = (accent: string): AccentRamp | undefined => {
  const parsed = parse(accent);
  if (parsed === undefined) {
    return undefined;
  }
  const ramp = colours(parsed);
  return {
    properties: {
      "--grasp-action-fill": both(ramp.fill),
      "--grasp-action-fill-press": both(ramp.press),
      "--grasp-checkbox-fill-hover": both(ramp.hover),
      "--grasp-action-text": both(ramp.text),
    },
  };
};

/** One pair the accent must hold, measured. */
export interface AccentPair {
  /** What is measured, in words: "words on the fill", "the fill on paper". */
  pair: string;
  mode: "light" | "dark";
  value: number;
  floor: number;
  holds: boolean;
}

/** The grounds a fill stands on, light and dark: Evergreen's paper, soft and raised. */
const grounds: Record<"light" | "dark", Record<string, string>> = {
  light: {
    paper: "oklch(0.992 0.002 165.08)",
    soft: "oklch(0.973 0.006 137.77)",
    raised: "oklch(1 0 0)",
  },
  dark: {
    paper: "oklch(0.173 0.028 169.36)",
    soft: "oklch(0.205 0.03 168)",
    raised: "oklch(0.235 0.032 168)",
  },
};

/**
 * Every pair an accent must hold, light and dark: its words on its fill (4.5:1), and its fill on
 * each ground (3:1, as a control's edge must). Empty when the colour is not an `oklch()` value.
 */
export const checkAccent = (accent: string): AccentPair[] => {
  const parsed = parse(accent);
  if (parsed === undefined) {
    return [];
  }
  const ramp = colours(parsed);
  return (["light", "dark"] as const).flatMap((mode) => {
    const fill = ramp.fill[mode];
    const words = contrast(ramp.text[mode], fill);
    const pairs: AccentPair[] = [
      {
        pair: "words on the fill",
        mode,
        value: words,
        floor: 4.5,
        holds: words >= 4.5,
      },
    ];
    for (const [name, ground] of Object.entries(grounds[mode])) {
      const value = contrast(fill, ground);
      pairs.push({
        pair: `the fill on ${name}`,
        mode,
        value,
        floor: 3,
        holds: value >= 3,
      });
    }
    return pairs;
  });
};
