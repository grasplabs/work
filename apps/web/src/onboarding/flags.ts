import type { Locale } from "../i18n.ts";

// Five flags, drawn as pixels: each a function from a point on the flag
// (0 to 1 across, 0 to 1 down) to which of its colours stands there. Drawn
// by hand, no icon pack. English is the United Kingdom's flag: the clients
// are European, and in Europe a language picker shows English by the
// Union Jack far more often than by the Stars and Stripes.

/** A flag: its colours, and which of them stands at each point. */
export interface Flag {
  /** Its colours in their real values: a flag's own, not the product's palette. */
  real: readonly string[];
  at: (u: number, v: number) => number;
  /** How wide it stands at the card's far edge, as times its height. */
  aspect: number;
  /** What runs on under the fade, toward the name: its own edge, or its first colour alone. */
  under: "edge" | "field";
}

/** Three bands across, top to bottom, `split` where the middle one starts and ends. */
const across =
  (split: readonly [number, number]) =>
  (_u: number, v: number): number => {
    if (v < split[0]) {
      return 0;
    }
    return v < split[1] ? 1 : 2;
  };

/** The Union Jack: blue, the white saltire with its thin red one, the white cross with its red one. */
const unionJack = (u: number, v: number): number => {
  const x = (u - 0.5) * 2;
  const y = (v - 0.5) * 2;
  // The flag is twice as wide as high: its diagonals run corner to corner.
  const onDiagonal = (width: number) =>
    Math.abs(x - y) < width || Math.abs(x + y) < width;
  if (Math.abs(x) < 0.1 || Math.abs(y) < 0.2) {
    return 2;
  }
  if (Math.abs(x) < 0.17 || Math.abs(y) < 0.34) {
    return 1;
  }
  if (onDiagonal(0.06)) {
    return 2;
  }
  if (onDiagonal(0.2)) {
    return 1;
  }
  return 0;
};

export const flags: Record<Locale, Flag> = {
  en: {
    real: ["#012169", "#ffffff", "#c8102e"],
    at: unionJack,
    aspect: 2,
    under: "field",
  },
  de: {
    real: ["#000000", "#dd0000", "#ffce00"],
    at: across([1 / 3, 2 / 3]),
    aspect: 1.8,
    under: "edge",
  },
  nl: {
    real: ["#ae1c28", "#ffffff", "#21468b"],
    at: across([1 / 3, 2 / 3]),
    aspect: 1.8,
    under: "edge",
  },
  es: {
    real: ["#aa151b", "#f1bf00", "#aa151b"],
    at: across([1 / 4, 3 / 4]),
    aspect: 1.8,
    under: "edge",
  },
  fr: {
    real: ["#002654", "#ffffff", "#ce1126"],
    at: (u) => {
      if (u < 1 / 3) {
        return 0;
      }
      return u < 2 / 3 ? 1 : 2;
    },
    aspect: 1.8,
    under: "field",
  },
};
