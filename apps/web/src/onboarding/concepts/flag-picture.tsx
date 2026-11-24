import { media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import type { Locale } from "../../i18n.ts";
import { bayerAt, readTones } from "../campaign/pixels.ts";
import { flags } from "./flags.ts";
import type { BrandStop } from "./flags.ts";

// A language's flag, drawn cell by cell on a canvas with the brand's one
// dither, the campaign builder's (onboarding/campaign/pixels.ts: Bayer's
// 4x4 threshold, the stops read from the tokens), between each colour and
// its shade, the
// light falling across a flag that waves once. `real` draws it in its own
// colours; `brand` in the brand's stops, night to paper, read from the
// tokens as the page resolves them, so light and dark follow the page.
// `flat` draws it small and crisp, no wave, no shade. `cover` lays it over
// the whole card it stands in: dense at the right edge, its cells thinning
// out by the same dither toward the left, so the language's name stands
// clear; the card's own corner, read from the page, clips it. Drawn once;
// nothing moves.

const styles = stylex.create({
  canvas: {
    display: "block",
    width: "100%",
    height: "100%",
    imageRendering: "pixelated",
  },
  // The picture as a card's media.
  picture: {
    display: "block",
    width: { default: "6rem", [media.maxSm]: "5rem" },
    height: { default: "4rem", [media.maxSm]: "3.25rem" },
  },
  // A small flag beside a name.
  small: { display: "block", width: "1.75rem", height: "1.25rem" },
  // Over the whole card, under its words, never in the way of its press.
  cover: {
    position: "absolute",
    inset: 0,
    display: "block",
    pointerEvents: "none",
  },
});

/** The brand's stops, darkest first: a stop's shade is the one before it. */
const stops: readonly BrandStop[] = [
  "night",
  "ink",
  "pine",
  "mint",
  "sea",
  "lime",
  "paper",
];

/** A colour of the flag's own, a third of the way to black: its shade. */
const shadeOf = (hex: string): string => {
  const part = (at: number) =>
    Math.round(Number.parseInt(hex.slice(at, at + 2), 16) * 0.68);
  return `rgb(${part(1)}, ${part(3)}, ${part(5)})`;
};

/** How big a cell is, in CSS pixels, by how the flag is drawn. */
const cellOf = (flat: boolean) => (flat ? 2 : 4);

/** How a flag stands: a card's media, small beside a name, or over the whole card. */
export type FlagFit = "media" | "small" | "cover";

/** Where the flag starts to show, in CSS pixels from the name's side: clear of the longest name. */
const clearOfName = 150;

/**
 * How much of the flag stands `at` pixels across a card `width` wide: none
 * beside the name, all of it near the far edge, eased between.
 */
const presence = (at: number, width: number): number => {
  const start = Math.min(width * 0.45, clearOfName);
  const end = width * 0.85;
  const t = Math.min(1, Math.max(0, (at - start) / (end - start)));
  return t * t * (3 - 2 * t);
};

/** Whether a cell lies inside the card's rounded corners, `radius` in cells. */
const inside = (
  x: number,
  y: number,
  columns: number,
  rows: number,
  radius: number
): boolean => {
  const dx = Math.max(radius - x - 0.5, x + 0.5 - (columns - radius), 0);
  const dy = Math.max(radius - y - 0.5, y + 0.5 - (rows - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
};

export const FlagPicture = ({
  locale,
  tone,
  fit = "media",
}: {
  locale: Locale;
  tone: "real" | "brand";
  fit?: FlagFit;
}) => {
  const flat = fit === "small";
  const cover = fit === "cover";
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element === null || context === null || context === undefined) {
      return () => {
        // Nothing drawn.
      };
    }
    const flag = flags[locale];
    const paint = () => {
      const { width, height } = element.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const size = cellOf(flat);
      const columns = Math.ceil(width / size);
      const rows = Math.ceil(height / size);
      const brand = readTones(element);
      // Over a card: the flag keeps its shape at the far edge, its first
      // band running on under the name, and the card's corner clips it.
      const card = element.closest('[data-slot="item"]');
      const corner =
        card === null
          ? 0
          : Number(
              getComputedStyle(card).borderTopRightRadius.replace("px", "")
            );
      const radius = cover && Number.isFinite(corner) ? corner / size : 0;
      const flagColumns = cover
        ? Math.min(columns, Math.round(rows * 1.8))
        : columns;
      const flagStart = columns - flagColumns;
      const colourOf = (band: number, shaded: boolean): string => {
        if (tone === "real") {
          const own = flag.real[band] ?? "#000000";
          return shaded ? shadeOf(own) : own;
        }
        const stop = flag.brand[band] ?? "night";
        const shade = stops[Math.max(0, stops.indexOf(stop) - 1)] ?? stop;
        return brand[shaded ? shade : stop];
      };
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < columns; x += 1) {
          if (
            cover &&
            (!inside(x, y, columns, rows, radius) ||
              bayerAt(x + 2, y + 1) >= presence((x + 0.5) * size, width))
          ) {
            continue;
          }
          const u = Math.max(0, (x - flagStart + 0.5) / flagColumns);
          // Waving: the flag rises and falls once across, its light with it.
          const phase = u * Math.PI * 2.4 + 0.5;
          const lift = flat ? 0 : Math.sin(phase) * 0.05;
          const v = Math.min(1, Math.max(0, (y + 0.5) / rows + lift));
          const light = flat
            ? 1
            : 0.55 +
              0.35 * Math.cos(phase) -
              0.15 * ((x + y) / (columns + rows));
          const shaded = bayerAt(x, y) > light;
          context.fillStyle = colourOf(flag.at(u, v), shaded);
          context.fillRect(x * size, y * size, size, size);
        }
      }
    };
    paint();
    // Light and dark change the brand's stops: drawn again.
    const modes = new MutationObserver(paint);
    modes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-mode"],
    });
    return () => {
      modes.disconnect();
    };
  }, [locale, tone, flat, cover]);
  return (
    <span {...stylex.props(styles[fit === "media" ? "picture" : fit])}>
      <canvas
        aria-hidden="true"
        ref={canvas}
        {...stylex.props(styles.canvas)}
      />
    </span>
  );
};
