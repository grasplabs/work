// PaintedField: the brand's painted field (brand book, chapter 05), for the one or two things on a
// page that matter most, such as the band across the top of Integrations. Four layers, never fewer:
// the painting's base colour, the painting, a fine grain, and a pattern of white lines that fades out
// before the far edge. Upstreamed from the old kit (@grasp-os/ui) with only what the product uses:
// the mist painting, the horizon pattern and the band shape.
//
//   <PaintedField painting="mist" pattern="horizon" shape="band" layout={styles.band}>
//     …what stands on the field…
//   </PaintedField>
//
// In the dark each light painting gives way to its dark stand-in (mist to tide), through the colour
// scheme that the tokens' light-dark() reads, so it follows the theme the same way. Text on it is the
// ink, muted text the same ink a little lighter: never the page's grey, which a painting swallows.
// The paintings are artwork, kept in painting.stylex.ts; everything else is a token. Its layers are
// decoration: hidden from assistive tech, they take no pointer and never move. In forced colours
// they are not drawn. A caller sets layout only (the `layout` prop), never its look.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { painting } from "./painting.stylex";

/** The paintings the product uses. Each is drawn light, and as its dark stand-in in the dark. */
export type PaintedFieldPainting = "mist";

/** The patterns of white lines the product uses. */
export type PaintedFieldPattern = "horizon";

/** The field's corners: `band`, across the top of a page, as Integrations'. */
export type PaintedFieldShape = "band";

/** What a caller may style: where the field sits and how tall it is. Never its look. */
export type PaintedFieldLayoutStyle = LayoutStyle;

/** Every prop a PaintedField takes. */
export interface PaintedFieldProps {
  /** Which painting: `mist`, a cool grey blue, which gives way to `tide` in the dark. */
  painting: PaintedFieldPainting;
  /** Which white lines over the paint: `horizon`, three wide columns, the middle lit, and a horizon. */
  pattern: PaintedFieldPattern;
  /**
   * Its corners. `band`: a band across the top of a page.
   * @default "band"
   */
  shape?: PaintedFieldShape;
  /** What stands on the field: the page's own parts. */
  children?: ReactNode;
  /** Layout only: where it sits, its width and its height. */
  layout?: PaintedFieldLayoutStyle;
}

const styles = stylex.create({
  field: {
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
    color: grasp.ink,
    "--grasp-muted": `color-mix(in oklab, ${grasp.ink} 76%, transparent)`,
  },
  layer: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    borderRadius: "inherit",
    cornerShape: "inherit",
    pointerEvents: "none",
    // Forced colours: no painting and no lines.
    display: { default: "block", [media.forced]: "none" },
  },
  // Its edge: the ink at 7%, a hairline inside, over the paint.
  paint: {
    backgroundSize: "180px, cover",
    backgroundPosition: "0 0, center",
    backgroundRepeat: "repeat, no-repeat",
    backgroundBlendMode: "overlay, normal",
    boxShadow: `inset 0 0 0 0.5px color-mix(in oklab, ${grasp.ink} 7%, transparent)`,
  },
  // Each painting is drawn only in its own scheme: a mask that is whole in one and empty in the other.
  inLight: {
    maskImage:
      "linear-gradient(light-dark(black, transparent), light-dark(black, transparent))",
  },
  inDark: {
    maskImage:
      "linear-gradient(light-dark(transparent, black), light-dark(transparent, black))",
  },
  band: {
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
  },
});

// Each painting: its base colour in the light and the dark, and its image and its dark stand-in's.
// Add a painting here, with its colours and image in painting.stylex.ts.
const paintings = stylex.create({
  mist: {
    backgroundColor: `light-dark(${painting.mistBase}, ${painting.tideBase})`,
  },
  mistLight: {
    backgroundImage: `${painting.grain}, ${painting.mistImage}`,
  },
  mistDark: {
    backgroundImage: `${painting.grain}, ${painting.tideImage}`,
  },
});

const paintingStyles = {
  mist: {
    base: paintings.mist,
    light: paintings.mistLight,
    dark: paintings.mistDark,
  },
} satisfies Record<
  PaintedFieldPainting,
  {
    base: stylex.StyleXStyles;
    light: stylex.StyleXStyles;
    dark: stylex.StyleXStyles;
  }
>;

// Each pattern: its white lines, and the mask that fades them out before the far edge. Add a
// pattern here.
const patterns = stylex.create({
  // Three wide columns, the middle one lit, and a horizon at 38%.
  horizon: {
    backgroundImage: [
      `linear-gradient(180deg, transparent 38%, ${painting.line} 38% calc(38% + 1px), transparent calc(38% + 1px))`,
      `repeating-linear-gradient(90deg, transparent 0 calc(100% / 3 - 1px), ${painting.line} calc(100% / 3 - 1px) calc(100% / 3))`,
      `linear-gradient(90deg, transparent 0 33.33%, ${painting.lit} 33.33% 66.66%, transparent 66.66%)`,
    ].join(", "),
    maskImage: "linear-gradient(180deg, black 20%, transparent 95%)",
  },
});

const shapes = { band: styles.band } satisfies Record<
  PaintedFieldShape,
  stylex.StyleXStyles
>;

/** The brand's painted field: a painting, a grain and a pattern of white lines, with the page's parts on it. */
export const PaintedField = ({
  painting: which,
  pattern,
  shape = "band",
  children,
  layout,
}: PaintedFieldProps) => {
  const paint = paintingStyles[which];
  return (
    <div
      data-slot="painted-field"
      data-painting={which}
      data-pattern={pattern}
      data-shape={shape}
      {...stylex.props(styles.field, paint.base, shapes[shape], layout)}
    >
      <span
        aria-hidden
        data-slot="painted-field-paint"
        {...stylex.props(
          styles.layer,
          styles.paint,
          paint.light,
          styles.inLight
        )}
      />
      <span
        aria-hidden
        data-slot="painted-field-paint"
        {...stylex.props(styles.layer, styles.paint, paint.dark, styles.inDark)}
      />
      <span
        aria-hidden
        data-slot="painted-field-pattern"
        {...stylex.props(styles.layer, patterns[pattern])}
      />
      {children}
    </div>
  );
};
