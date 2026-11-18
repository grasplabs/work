// PanelTexture: a very faint dither of the light, behind the head of the one object a page is about.
// Mint light from the top corner at the start, seen through the Composer's fine grid of dots, at
// the inspector's dither strength: one recipe, from tokens, in one place. Panel header draws it
// behind its head (`texture`); a page draws it behind its own head of the one object, as the
// organisation card's cover does.
//
// It is decoration: hidden from assistive tech, takes no pointer, never moves. It fills the nearest
// positioned box (place it with `layout`). In right to left the light comes from the start there,
// the right. In forced colours it is not drawn.
import * as stylex from "@stylexjs/stylex";

import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";

/** What a caller may style: where the texture sits over its box. Never its look. */
export type PanelTextureLayoutStyle = LayoutStyle;

/** Every prop a PanelTexture takes. */
export interface PanelTextureProps {
  /** Layout only: where it sits over the positioned box it fills. Fills it whole, unless given. */
  layout?: PanelTextureLayoutStyle;
}

const styles = stylex.create({
  texture: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    opacity: grasp.inspectorDitherStrength,
    backgroundImage: {
      default: `radial-gradient(120% 90% at 0% 0%, ${grasp.mint}, transparent 70%)`,
      ":dir(rtl)": `radial-gradient(120% 90% at 100% 0%, ${grasp.mint}, transparent 70%)`,
    },
    maskImage: `radial-gradient(circle, black ${grasp.composerDot}, transparent calc(${grasp.composerDot} + ${grasp.hairline}))`,
    maskSize: `${grasp.composerDither} ${grasp.composerDither}`,
    maskRepeat: "repeat",
    // Forced colours: no texture.
    display: { default: "block", [media.forced]: "none" },
  },
});

/** The faint dither of light behind the head of the one object a page is about. */
export const PanelTexture = ({ layout }: PanelTextureProps) => (
  <span
    aria-hidden
    data-slot="panel-texture"
    {...stylex.props(styles.texture, layout)}
  />
);
