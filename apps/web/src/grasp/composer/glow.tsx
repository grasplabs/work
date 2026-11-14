// ComposerGlow: the life of a composer (composer.tsx), drawn behind its card so only the part
// outside the card shows. Working: three soft beams of Grasp's light travel along the top edge, at
// Palermo's three speeds, so it reads as light moving, never a spinner. Success: one halo of mint
// gathers and fades. Only `transform` and `opacity` move, so nothing is laid out per frame. With
// reduced motion the beams stand still as a soft edge, the light comes and goes without a fade,
// and there is no halo.
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";
import { useStill } from "./still-context";

/** The colour of the light: Grasp's light by default, or one token colour. */
export type ComposerAccent =
  | "light"
  | "mint"
  | "lavender"
  | "info"
  | "attention"
  | "danger";

/** How the light's edge is drawn: a smooth glow, or a fine dither of dots that thins outwards. */
export type ComposerEdge = "smooth" | "dither";

const REDUCED = media.reduced;

// Right to left the strip stands at the other end, so it slides the other way (--grasp-line-sign),
// and the light follows the reading direction.
const travel = stylex.keyframes({
  from: { transform: "translateX(0)" },
  to: { transform: "translateX(calc(-50% * var(--grasp-line-sign, 1)))" },
});

const halo = stylex.keyframes({
  "0%": { opacity: 0 },
  "20%": { opacity: 1 },
  "100%": { opacity: 0 },
});

const styles = stylex.create({
  // The light's layer reaches past the card's top and foot, so a mask on it (the dithered edge)
  // covers the glow too: a mask only paints inside its own box. Not past its sides, so it never
  // widens the page.
  layer: {
    position: "absolute",
    insetBlock: `calc(-1 * ${grasp.space8})`,
    insetInline: 0,
    zIndex: 0,
    pointerEvents: "none",
    opacity: 0,
    transitionProperty: "opacity",
    // With reduced motion the light is there or not: no fade.
    transitionDuration: { default: grasp.composerLightIn, [REDUCED]: "0s" },
    transitionTimingFunction: grasp.ease,
    // In forced colours there is no light: the state is said in words.
    display: { default: "block", [media.forced]: "none" },
  },
  // The card's own box, inside the layer: the beams are placed against it.
  frame: {
    position: "absolute",
    insetBlock: grasp.space8,
    insetInline: 0,
  },
  on: {
    opacity: grasp.composerLightStrength,
  },
  // The dithered edge: the same light seen through a fine grid of dots, so its glow reads as
  // points of light that thin out where the glow fades, after the website's ordered dither.
  // A second mask fades its ends, so the dots never stop on a hard line at the card's sides.
  dither: {
    maskImage: `radial-gradient(circle, black ${grasp.composerDot}, transparent calc(${grasp.composerDot} + ${grasp.hairline})), linear-gradient(90deg, transparent, black ${grasp.space8}, black calc(100% - ${grasp.space8}), transparent)`,
    maskSize: `${grasp.composerDither} ${grasp.composerDither}, 100% 100%`,
    maskRepeat: "repeat, no-repeat",
    maskComposite: "intersect",
  },
  ditherOn: {
    opacity: 1,
  },
  // A beam's room along the top edge. It clips its moving strip, then blurs, so its glow spreads
  // past the room and past the card, softly.
  beam: {
    position: "absolute",
    // Centred just inside the top edge, so about half of each beam's glow shows above the card.
    top: grasp.space1,
    overflow: "hidden",
    borderRadius: grasp.cornerPill,
    transform: "translateY(-50%)",
  },
  wide: {
    insetInline: grasp.space1,
    height: grasp.space3,
    filter: `blur(${grasp.space3})`,
  },
  mid: {
    insetInlineStart: "8%",
    insetInlineEnd: "12%",
    height: grasp.space4,
    filter: `blur(calc(${grasp.space3} - ${grasp.space1} / 2))`,
  },
  tight: {
    insetInlineStart: "38%",
    insetInlineEnd: "7%",
    height: grasp.space2,
    filter: `blur(${grasp.space2})`,
  },
  // The strip: twice the room, its light repeating once across it, sliding by half and starting
  // over, so the loop has no seam.
  strip: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    width: "200%",
    backgroundSize: "50% 100%",
    backgroundRepeat: "repeat-x",
    "--grasp-line-sign": { default: "1", ":dir(rtl)": "-1" },
    animationName: { default: travel, [REDUCED]: "none" },
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationPlayState: "paused",
  },
  running: {
    animationPlayState: "running",
    willChange: "transform",
  },
  stripWide: {
    animationDuration: grasp.composerBeam,
  },
  stripMid: {
    animationDuration: grasp.composerBeamFast,
    animationDelay: `calc(-1 * ${grasp.composerBeamFast} / 3)`,
  },
  stripTight: {
    animationDuration: grasp.composerBeamSlow,
    animationDelay: `calc(-1 * ${grasp.composerBeamSlow} / 2)`,
  },
  light: {
    backgroundImage: grasp.composerLight,
  },
  tint: {
    backgroundImage: grasp.composerTint,
  },
  held: {
    animationName: "none",
    opacity: 1,
  },
  halo: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    pointerEvents: "none",
    boxShadow: grasp.composerHalo,
    opacity: 0,
    // With reduced motion there is no halo: the status says it is done.
    animationName: { default: halo, [REDUCED]: "none" },
    animationDuration: grasp.composerHaloTime,
    animationTimingFunction: grasp.easeInOut,
    animationFillMode: "forwards",
    display: { default: "block", [media.forced]: "none" },
  },
  mint: { color: grasp.lightMint },
  lavender: { color: grasp.lavender },
  info: { color: grasp.info },
  attention: { color: grasp.attention },
  danger: { color: grasp.danger },
});

const colour = (accent: ComposerAccent) =>
  accent === "light" ? styles.mint : styles[accent];

interface GlowProps {
  edge: ComposerEdge;
  working: boolean;
  /** Changes each time the composer succeeds, so the halo plays again. */
  success: number;
  accent: ComposerAccent;
}

/** The working light and the success halo, behind the card. */
export const ComposerGlow = ({ edge, working, success, accent }: GlowProps) => {
  const still = useStill();
  const paint = accent === "light" ? styles.light : styles.tint;
  const strip = (size: stylex.StyleXStyles) => (
    <span
      aria-hidden="true"
      {...stylex.props(
        styles.strip,
        size,
        paint,
        working && !still && styles.running
      )}
    />
  );
  const dither = edge === "dither";
  return (
    <>
      <span
        aria-hidden="true"
        data-slot="composer-light"
        data-edge={edge}
        {...stylex.props(
          styles.layer,
          colour(accent),
          working && styles.on,
          dither && styles.dither,
          dither && working && styles.ditherOn
        )}
      >
        <span {...stylex.props(styles.frame)}>
          <span {...stylex.props(styles.beam, styles.wide)}>
            {strip(styles.stripWide)}
          </span>
          <span {...stylex.props(styles.beam, styles.mid)}>
            {strip(styles.stripMid)}
          </span>
          <span {...stylex.props(styles.beam, styles.tight)}>
            {strip(styles.stripTight)}
          </span>
        </span>
      </span>
      {success > 0 && (
        <span
          key={success}
          aria-hidden="true"
          data-slot="composer-halo"
          {...stylex.props(styles.halo, colour(accent), still && styles.held)}
        />
      )}
    </>
  );
};
