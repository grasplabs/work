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
// `flat` draws it small and crisp, no wave, no shade. Drawn once; nothing
// moves.

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

export const FlagPicture = ({
  locale,
  tone,
  flat = false,
}: {
  locale: Locale;
  tone: "real" | "brand";
  flat?: boolean;
}) => {
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
          const u = (x + 0.5) / columns;
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
  }, [locale, tone, flat]);
  return (
    <span {...stylex.props(flat ? styles.small : styles.picture)}>
      <canvas
        aria-hidden="true"
        ref={canvas}
        {...stylex.props(styles.canvas)}
      />
    </span>
  );
};
