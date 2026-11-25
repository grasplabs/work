import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode, RefObject } from "react";

import { BackdropField } from "./field.tsx";
import { isScene, schemeOf } from "./look.ts";
import type { BackdropLook } from "./look.ts";

// What stands behind Chat's start (chat-start.tsx: the person's look,
// chat/backdrop-look.ts), behind a page that failed
// (frame/page-states.tsx: the dusk dither in the aurora's greens) and
// behind New agent (agents/: the dots in mint), as #2503's library's
// Backdrop draws it with `fadeFoot`, as each of those pages has it: one
// canvas behind what stands in the box (field.tsx), on the page's own
// ground, faded out towards the box's foot and clear of it. A scene covers
// its box whole, never faded, and what stands on it takes the dark scheme,
// a scene being night. Damsko has no backdrop: it is the product's own
// (the rename map's "backdrop → apps/web/src/chat/backdrop/").

const styles = stylex.create({
  // The box, with what stands on it above the canvas: the page's whole
  // area, a column what stands on it grows in.
  box: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    minHeight: "100%",
  },
  // The page's own ground under a dither or sand (a scene covers its box whole).
  ground: { backgroundColor: colors.background },
  // On a scene, which is night, what stands on it turns light. The text
  // colour is set again here: inherited, it would stay the one worked out
  // for the page's own scheme. The night's own ground stands under the
  // drawing, so the light text reads before the drawing is there and
  // where it can't be drawn at all.
  onNight: {
    backgroundColor: colors.brandNight,
    color: colors.bodyForeground,
  },
  // The drawing, whole down to a band over the foot, faded out across it, then clear.
  foot: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    pointerEvents: "none",
    maskImage: `linear-gradient(to bottom, black calc(100% - ${space["20"]} - ${space["12"]}), transparent calc(100% - ${space["20"]}))`,
  },
});

type Layout = string | number | null;

/**
 * What a caller may style: where the box sits, how big it is and how what
 * stands in it is laid out (#2503's BackdropLayoutStyle). Never its look.
 */
type BackdropLayout = stylex.StyleXStyles<{
  display?: Layout;
  boxSizing?: Layout;
  flexGrow?: Layout;
  width?: Layout;
  minWidth?: Layout;
  minHeight?: Layout;
  paddingInline?: Layout;
  paddingBlock?: Layout;
}>;

/** The page's area, `variant` drawn behind what stands in it, clear of `clear`. */
export const Backdrop = ({
  children,
  clear,
  variant,
  style,
}: {
  children: ReactNode;
  /** The column of words on it: the drawing keeps clear round it, so the words read. */
  clear?: RefObject<HTMLElement | null>;
  /** What it draws: a backdrop and, for a dither, its pattern and colour. */
  variant: BackdropLook;
  /** Layout only: under a page's bar, the room left (`minHeight: 0`) rather than the page's whole height. */
  style?: BackdropLayout;
}) => {
  const scheme = schemeOf(variant);
  const scene = isScene(variant.backdrop);
  return (
    <div
      data-slot="backdrop"
      data-backdrop={variant.backdrop}
      data-mode={scheme}
      {...stylex.props(
        styles.box,
        scene ? styles.onNight : styles.ground,
        style
      )}
    >
      {scene ? (
        <BackdropField clear={clear} look={variant} />
      ) : (
        <div aria-hidden="true" {...stylex.props(styles.foot)}>
          <BackdropField clear={clear} look={variant} />
        </div>
      )}
      {children}
    </div>
  );
};
