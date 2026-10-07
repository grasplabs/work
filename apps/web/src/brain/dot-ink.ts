/**
 * The ink the dot brain prints with, shared with the buddy on Home: how its dots look and move,
 * and every colour a dot can have, by warmth and ink, from the brain tokens in styles.css. Ported
 * from the prototype (grasplabs/prototype, packages/grasp: components/onboarding/dot-ink.ts).
 */

/**
 * How the brain looks: dots of mixed sizes, many small and a few large, sized against the spacing
 * so they never merge (radius as a share of it, lightest to darkest); patches of faintness that
 * drift over it and now and then recede, so the whole shows; and a pointer that finds what they
 * hide, swelling and warming the dots it passes. Grasp's voice lifts the patches a little.
 */
export const LOOK = {
  air: 1.06,
  lightDot: 0.13,
  darkDot: 0.34,
  variety: 0.95,
  tide: 0.96,
  tideSize: 1.1,
  tideSpeed: 0.16,
  voice: 0.6,
  reach: 1.7,
  reveal: 1,
  grow: 1.1,
  warm: 0.5,
};

/** How long dots take to fly into a new figure, and how much later the last one leaves. */
export const MORPH_S = 1.3;

export const SPREAD_S = 0.5;

/** The size the brain's figures are drawn for, in pixels: how far from the pointer dots swell and glow, and how a warm wave runs, are given at this size. */
export const CANVAS = 380;

/** How far from the pointer dots swell and glow, in pixels at that size. */
export const REACH = 64;

/**
 * How one dot prints and lives, for everything printed in this ink: the brain, and the small signs
 * beside Stephen in an interview, which are the same print and so go through the same rules.
 */

/** A swollen dot grows to this share of the spacing at most, so that it still stands apart from its neighbours. */
export const DOT_MOST = 0.44;

/**
 * A dot's size as a share of the spacing: by its ink, 0 to 1; smaller while it is still grey; and
 * by its own grain, 0 to 1, so that many print small and a few large.
 */
export const dotShare = (
  printed: number,
  inked: boolean,
  grain: number
): number => {
  const span = LOOK.darkDot - LOOK.lightDot;
  const own = 1 - 0.55 * LOOK.variety + 1.3 * LOOK.variety * grain;
  return Math.min(
    0.4,
    (inked
      ? LOOK.lightDot + span * printed
      : 0.85 * LOOK.lightDot + 0.5 * span * printed) * own
  );
};

/** How dark a dot prints, 0 to 1: inked, by its ink and a little by how lit it is; still grey, faint. */
export const dotAlpha = (
  printed: number,
  lit: number,
  inked: boolean
): number =>
  inked ? 0.58 + 0.32 * printed + 0.08 * lit : 0.16 + 0.22 * printed;

/** Each dot breathes a little in its own time: what its darkness is multiplied by, at a time in seconds. */
export const shimmerAt = (seed: number, now: number): number =>
  0.92 + 0.08 * Math.sin(now * 1.4 + seed * 60);

/**
 * How far a dot sways sideways, in figure units: faintly, through the rows, so that neighbouring
 * dots move together, and a little on its own.
 */
export const swayAt = (y: number, seed: number, now: number): number =>
  0.004 * (Math.sin(now * 1.3 + y * 4) + 0.4 * Math.sin(now * 2.2 + y * 11)) +
  0.0015 * Math.sin(now * 2.1 + seed * Math.PI * 2);

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** How far the patches of faintness are out at a time, in seconds: 0 when they have receded and everything shows, up to `LOOK.tide`. */
export const tideOut = (now: number): number =>
  LOOK.tide * smoothstep(0.12, 0.6, 0.5 - 0.5 * Math.cos(now * 0.21));

/**
 * How much of a dot shows where it stands on the figure: 0 in the middle of a patch of faintness,
 * 1 outside them. The patches drift, and `lifted` raises them, as Grasp's voice does.
 */
export const patchAt = (
  x: number,
  y: number,
  now: number,
  lifted = 0
): number => {
  const at = now * LOOK.tideSpeed;
  const tx = x * LOOK.tideSize;
  const ty = y * LOOK.tideSize;
  const swell =
    Math.sin(tx * 2.3 + at + 1.7 * Math.sin(ty * 1.6 - at * 0.7)) *
    Math.cos(ty * 2.1 - at * 0.9 + 1.3 * Math.sin(tx * 1.2 + at * 0.5));
  return smoothstep(0.2, 0.8, 0.5 + 0.5 * swell + 0.5 * lifted);
};

/** Steps of ink and of warmth a dot is printed in: one colour each, so a frame is a few fills. */
export const ALPHAS = 12;

export const HEATS = 6;

let probe: CanvasRenderingContext2D | null | undefined;

const seen = new Map<string, [number, number, number, number]>();

/** Any CSS colour as red, green, blue and alpha, by letting a canvas paint it; remembered, as pages repeat their colours. */
export const rgba = (color: string): [number, number, number, number] => {
  const known = seen.get(color);
  if (known) {
    return known;
  }
  if (probe === undefined) {
    probe = document
      .createElement("canvas")
      .getContext("2d", { willReadFrequently: true });
  }
  if (!probe) {
    return [26, 26, 25, 1];
  }
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 255] = probe.getImageData(0, 0, 1, 1).data;
  const found: [number, number, number, number] = [r, g, b, a / 255];
  seen.set(color, found);
  return found;
};

/** Any CSS colour as red, green and blue. */
export const rgb = (color: string): [number, number, number] => {
  const [r, g, b] = rgba(color);
  return [r, g, b];
};

const mix = (
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** Every colour a dot can have, in bucket order: warmth × ALPHAS + ink. */
export const palette = (element: HTMLElement): string[] => {
  const read = (name: string, fallback: string) =>
    rgb(getComputedStyle(element).getPropertyValue(name).trim() || fallback);
  const ink = read("--brain-ink", "#1a1a19");
  const heat = read("--brain-heat", "#e5572b");
  const glow = read("--brain-glow", "#f6c35a");
  const styles: string[] = [];
  for (let h = 0; h < HEATS; h += 1) {
    const w = h / (HEATS - 1);
    const color =
      w < 0.6 ? mix(ink, heat, w / 0.6) : mix(heat, glow, (w - 0.6) / 0.4);
    for (let a = 0; a < ALPHAS; a += 1) {
      styles.push(
        `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${(a / (ALPHAS - 1)).toFixed(3)})`
      );
    }
  }
  return styles;
};

/** The colour bucket a dot prints in: its warmth times the steps of ink, plus its ink. */
export const bucketOf = (alpha: number, heat: number): number => {
  const a = Math.min(ALPHAS - 1, Math.max(0, Math.round(alpha * (ALPHAS - 1))));
  const h = Math.min(HEATS - 1, Math.round(heat * (HEATS - 1)));
  return h * ALPHAS + a;
};
