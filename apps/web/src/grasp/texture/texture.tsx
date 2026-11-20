// Texture: a very faint dither of the light, behind the head of the one object a page is about.
// Mint light from the top corner at the start, seen through the Composer's fine grid of dots, at
// the inspector's dither strength: one recipe, from tokens, in one place. Panel header draws it
// behind its head (`texture`, and Panel exports it as `PanelTexture`); Page header's band draws it
// behind the page's head; a page draws it behind its own head of the one object, as the
// organisation card's cover does. It is shared, so a part that draws it never reaches into Panel.
// It keeps the slot it had as Panel's, `panel-texture`, so what finds it still does.
//
// It is decoration: hidden from assistive tech, takes no pointer, never moves. It fills the nearest
// positioned box (place it with `layout`). In right to left the light comes from the start there,
// the right. In forced colours it is not drawn.
import * as stylex from "@stylexjs/stylex";

import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";

/** What a caller may style: where the texture sits over its box. Never its look. */
export type TextureLayoutStyle = LayoutStyle;

/** Every prop a Texture takes. */
export interface TextureProps {
  /**
   * The light in the object's own colour (an app's brand, from `useMarkTint`), fading down from the
   * top instead of the mint from the corner. Any CSS colour; it is drawn at the same faint strength,
   * so words on it keep their contrast.
   */
  tint?: string;
  /** Layout only: where it sits over the positioned box it fills. Fills it whole, unless given. */
  layout?: TextureLayoutStyle;
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
  // In the object's own colour: from the top, down, the same in either direction. In the dark the
  // colour is lifted toward white, so a deep brand (Slack's aubergine) still shows on a dark ground.
  tinted: (tint: string) => ({
    backgroundImage: `linear-gradient(to bottom, light-dark(${tint}, color-mix(in oklab, ${tint} 40%, white)), transparent 85%)`,
  }),
});

/** The faint dither of light behind the head of the one object a page is about. */
export const Texture = ({ tint, layout }: TextureProps) => (
  <span
    aria-hidden
    data-slot="panel-texture"
    data-tinted={tint === undefined ? undefined : ""}
    {...stylex.props(
      styles.texture,
      tint !== undefined && styles.tinted(tint),
      layout
    )}
  />
);
