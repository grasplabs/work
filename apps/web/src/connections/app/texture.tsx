// Texture: a very faint dither of the light, behind the head of the one app a page or a panel is
// about, in the app's own colour where it is known (useMarkTint), else the mint from the top
// corner. #2503's library Texture, as its app panel and page drew it. Damsko's own `texture`
// (lib/styles) is the mint alone, seen through 2px squares; an app's head takes the app's colour,
// seen through the library's composer grid, 0.75px dots every 3px, at the system's texture strength
// (registry gap of 24 Nov 2026).
//
// It is decoration: hidden from assistive tech, takes no pointer, never moves. It fills the nearest
// positioned box (place it with `style`). In right to left the light comes from the start there,
// the right. In forced colours it is not drawn.
import { colors, media, size as sizes } from "@grasp-os/ui/lib/tokens.stylex";
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import * as stylex from "@stylexjs/stylex";

/** The library's composer dither: a dot and the grid it repeats on. */
const DOT = "0.75px";
const PITCH = "3px";

const styles = stylex.create({
  texture: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    opacity: sizes.textureStrength,
    backgroundImage: {
      default: `radial-gradient(120% 90% at 0% 0%, ${colors.mint}, transparent 70%)`,
      ":dir(rtl)": `radial-gradient(120% 90% at 100% 0%, ${colors.mint}, transparent 70%)`,
    },
    maskImage: `radial-gradient(circle, black ${DOT}, transparent calc(${DOT} + ${sizes.hairline}))`,
    maskSize: `${PITCH} ${PITCH}`,
    maskRepeat: "repeat",
    display: { default: "block", [media.forcedColors]: "none" },
  },
  // In the app's own colour: from the top, down, the same in either direction. In the dark, the
  // colour's own hue and strength at a lightness that shows on a dark ground.
  tinted: (tint: string) => ({
    backgroundImage: `linear-gradient(to bottom, light-dark(${tint}, oklch(from ${tint} 0.72 c h)), transparent 85%)`,
  }),
});

/** The faint dither of light behind the head of the one app a page is about. */
export const Texture = ({
  tint,
  style,
}: {
  /** The light in the app's own colour, from `useMarkTint`: any CSS colour. */
  tint?: string | undefined;
  /** Layout only: where it sits over the positioned box it fills. */
  style?: LayoutStyle;
}) => (
  <span
    aria-hidden="true"
    data-slot="app-texture"
    data-tinted={tint === undefined ? undefined : ""}
    {...stylex.props(
      styles.texture,
      tint !== undefined && styles.tinted(tint),
      style
    )}
  />
);
