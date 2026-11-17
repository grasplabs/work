// Grasp's own themes. A theme is a named set of colour values on top of a mode (light or dark),
// nothing else: it never changes spacing, type sizes or corners, and no component knows a theme's
// name. It says two things:
//
//   neutrals  where the system's neutral family goes: every literal colour in it (the grounds'
//             tints, the lines, the hovers and fills, the quiet inks, written as the evergreen ink
//             at some opacity) moves to this hue and keeps this share of its chroma, so a theme
//             changes the whole family without naming each token
//   set       exact values for the tokens that carry it: the grounds and the inks, light and dark
//
// Mint, lime and the light's stops, the status colours, and the product frame's own greys are
// never moved: the light is Grasp's in every theme.
//
// scripts/build-themes.ts turns these into src/theme/themes.css (a block per theme that restates
// every colour token, so references like `sidebar-fill: {soft}` follow the theme on any subtree)
// and checks every contrast pair in tokens/tokens.ts for each theme, light and dark.

/** A colour value for one token, light and dark, in oklch(). */
export interface ThemeValue {
  light?: string;
  dark?: string;
}

export interface Theme {
  /** Its name in code and in `data-grasp-theme`. */
  id: string;
  /** What a person sees. */
  name: string;
  /** One line: what it is like. */
  description: string;
  /** A few words, for a tile: what it is like, at a glance. */
  tagline: string;
  /** Where the neutral family moves. Leave it out to keep evergreen's. */
  neutrals?: { hue: number; chroma: number };
  /** Exact values, by token name. */
  set: Record<string, ThemeValue>;
}

export const themes: readonly Theme[] = [
  {
    id: "evergreen",
    name: "Evergreen",
    description: "Ink on paper, with one light. Grasp as it is.",
    tagline: "Grasp as it is",
    set: {},
  },
  {
    id: "pine",
    name: "Pine",
    description:
      "Deeper and richer: pine grounds, the light kept for what is alive. Night in the forest.",
    tagline: "Night in the forest",
    neutrals: { hue: 178, chroma: 2 },
    set: {
      paper: {
        light: "oklch(0.972 0.014 172)",
        dark: "oklch(0.215 0.058 178)",
      },
      soft: { light: "oklch(0.948 0.022 172)", dark: "oklch(0.25 0.066 178)" },
      raised: {
        light: "oklch(0.988 0.008 172)",
        dark: "oklch(0.29 0.072 178)",
      },
      "stage-ground": {
        light: "oklch(0.962 0.018 172)",
        dark: "oklch(0.29 0.072 178)",
      },
      ink: { light: "oklch(0.25 0.062 176)", dark: "oklch(0.965 0.022 165)" },
      text: { light: "oklch(0.33 0.058 176)", dark: "oklch(0.89 0.032 165)" },
      muted: { light: "oklch(0.45 0.052 176)", dark: "oklch(0.74 0.04 168)" },
      ring: { light: "oklch(0.42 0.06 176)", dark: "oklch(0.8 0.05 168)" },
      "action-fill": { light: "oklch(0.36 0.075 177)" },
      "action-fill-press": {
        light: "oklch(0.3 0.068 177)",
        dark: "oklch(0.88 0.03 165)",
      },
      "checkbox-fill-hover": { light: "oklch(0.42 0.08 177)" },
      "quiet-fill": { light: "oklch(0.99 0.006 172)" },
      "quiet-fill-press": { light: "oklch(0.93 0.026 172)" },
    },
  },
  {
    id: "paper",
    name: "Paper",
    description:
      "Warmer and quieter: ink on a paper ground, the light only where something is alive.",
    tagline: "Warm and quiet",
    neutrals: { hue: 75, chroma: 0.22 },
    set: {
      paper: { light: "oklch(0.982 0.007 85)", dark: "oklch(0.205 0.006 75)" },
      soft: { light: "oklch(0.958 0.01 85)", dark: "oklch(0.235 0.007 75)" },
      raised: { light: "oklch(0.995 0.004 85)", dark: "oklch(0.265 0.008 75)" },
      "stage-ground": {
        light: "oklch(0.972 0.009 85)",
        dark: "oklch(0.265 0.008 75)",
      },
      ink: { light: "oklch(0.23 0.008 70)", dark: "oklch(0.955 0.008 85)" },
      text: { light: "oklch(0.33 0.008 70)", dark: "oklch(0.87 0.008 85)" },
      muted: { light: "oklch(0.49 0.01 70)", dark: "oklch(0.72 0.01 80)" },
      ring: { light: "oklch(0.44 0.01 70)", dark: "oklch(0.78 0.01 80)" },
      "action-fill": { light: "oklch(0.27 0.01 70)" },
      "action-fill-press": {
        light: "oklch(0.22 0.01 70)",
        dark: "oklch(0.86 0.008 85)",
      },
      "checkbox-fill-hover": { light: "oklch(0.34 0.01 70)" },
      "quiet-fill-press": { light: "oklch(0.94 0.01 85)" },
    },
  },
];

/** Grasp's themes, by id. */
export const themeIds = ["evergreen", "pine", "paper"] as const;
export type ThemeId = (typeof themeIds)[number];

/** How a person chose to see it: light, dark, or whatever the system says. */
export const themeModes = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof themeModes)[number];

/** Whether a value read from somewhere (storage, an attribute) is a mode. */
export const isThemeMode = (value: unknown): value is ThemeMode =>
  themeModes.some((mode) => mode === value);

/** Whether a value read from somewhere is one of Grasp's themes. */
export const isThemeId = (value: unknown): value is ThemeId =>
  themeIds.some((id) => id === value);
