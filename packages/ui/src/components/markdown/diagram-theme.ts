// A Mermaid diagram in the design system's look (diagram.tsx draws it): Mermaid's `base` theme,
// its colours Damsko's tokens as they resolve where the diagram stands (light, dark, a band of its
// own colour scheme, or the system's colours under forced colours), and its words in the page's
// font. Mermaid works its colours out from real values, never CSS variables, so each token is
// resolved to an opaque sRGB colour, as it shows on the card, when the diagram is drawn.
"use client";

import { colors, font } from "../../lib/tokens.stylex";

/** What a diagram is drawn in: its colours and font, and a key that changes when any of them does. */
export interface DiagramTheme {
  key: string;
  background: string;
  variables: Record<string, string | boolean>;
}

// The parts of a diagram by token, and by system colour under forced colours.
const TOKENS = {
  background: [colors.background, "Canvas"],
  surface: [colors.muted, "Canvas"],
  ink: [colors.foreground, "CanvasText"],
  muted: [colors.mutedForeground, "CanvasText"],
  border: [colors.border, "CanvasText"],
  accent: [colors.mintDeep, "Highlight"],
} as const;

type Part = keyof typeof TOKENS;

/** `css`, a colour, as `#rrggbb` once laid on `ground`: read back from one pixel of a canvas. */
const opaque = (
  context: CanvasRenderingContext2D,
  css: string,
  ground: string
) => {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = ground;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = css;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

/** The tokens as they resolve inside `place`: its colour scheme, or the system's forced colours. */
export const themeAt = (place: HTMLElement): DiagramTheme => {
  const forced = matchMedia("(forced-colors: active)").matches;
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  // Read as the token is, never forced to the system's colours by the probe itself.
  probe.style.cssText =
    "position:absolute;visibility:hidden;forced-color-adjust:none";
  place.append(probe);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const style = getComputedStyle(probe);
  const resolved = (part: Part) => {
    probe.style.color = TOKENS[part][forced ? 1 : 0];
    return style.color;
  };
  probe.style.fontFamily = font.sans;
  const family = style.fontFamily;
  const ground = resolved("background");
  const of = (part: Part) =>
    context === null ? "#000000" : opaque(context, resolved(part), ground);
  const parts = {
    background: of("background"),
    surface: of("surface"),
    ink: of("ink"),
    muted: of("muted"),
    border: of("border"),
    accent: of("accent"),
  };
  probe.remove();
  // Dark when its ground is: the mean of its three channels under half.
  const channels = [1, 3, 5].map((at) =>
    Number.parseInt(parts.background.slice(at, at + 2), 16)
  );
  const dark =
    !forced &&
    channels.reduce((sum, value) => sum + value, 0) / channels.length < 128;
  const variables = {
    darkMode: dark,
    background: parts.background,
    fontFamily: family,
    // Nodes: the surface, the accent's edge, the ink's words.
    primaryColor: parts.surface,
    primaryBorderColor: parts.accent,
    primaryTextColor: parts.ink,
    secondaryColor: parts.surface,
    secondaryBorderColor: parts.border,
    secondaryTextColor: parts.ink,
    tertiaryColor: parts.background,
    tertiaryBorderColor: parts.border,
    tertiaryTextColor: parts.ink,
    mainBkg: parts.surface,
    nodeBorder: parts.accent,
    nodeTextColor: parts.ink,
    textColor: parts.ink,
    titleColor: parts.ink,
    // Edges, and the words on them.
    lineColor: parts.muted,
    edgeLabelBackground: parts.background,
    // Groups and notes.
    clusterBkg: parts.background,
    clusterBorder: parts.border,
    noteBkgColor: parts.surface,
    noteBorderColor: parts.border,
    noteTextColor: parts.ink,
    // A sequence diagram's actors and messages.
    actorBkg: parts.surface,
    actorBorder: parts.accent,
    actorTextColor: parts.ink,
    actorLineColor: parts.muted,
    signalColor: parts.ink,
    signalTextColor: parts.ink,
    labelBoxBkgColor: parts.surface,
    labelBoxBorderColor: parts.border,
    labelTextColor: parts.ink,
    loopTextColor: parts.ink,
  };
  return {
    key: JSON.stringify(variables),
    background: parts.background,
    variables,
  };
};

/**
 * Hears every change that could change a diagram's colours: the page's colour scheme, forced
 * colours, and a theme set on the page's root or body (a class, an attribute, a style).
 */
export const watchScheme = (changed: () => void) => {
  const queries = [
    matchMedia("(prefers-color-scheme: dark)"),
    matchMedia("(forced-colors: active)"),
  ];
  for (const query of queries) {
    query.addEventListener("change", changed);
  }
  const roots = new MutationObserver(changed);
  roots.observe(document.documentElement, { attributes: true });
  roots.observe(document.body, { attributes: true });
  return () => {
    for (const query of queries) {
      query.removeEventListener("change", changed);
    }
    roots.disconnect();
  };
};
