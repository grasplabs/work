"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode, RefObject } from "react";

import { grasp } from "../tokens/tokens.stylex";
import { BackdropField } from "./field";
import type { BackdropProgress } from "./field";
import { byNewName, schemeOf } from "./look";
import type { BackdropLook } from "./look";

type Layout = string | number | null;

/** What a caller may style: where the backdrop sits and how big it is. Never its look. */
export type BackdropLayoutStyle = stylex.StyleXStyles<{
  alignSelf?: Layout;
  justifySelf?: Layout;
  flexGrow?: Layout;
  flexShrink?: Layout;
  flexBasis?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  gridRow?: Layout;
  order?: Layout;
  width?: Layout;
  minWidth?: Layout;
  maxWidth?: Layout;
  height?: Layout;
  minHeight?: Layout;
  maxHeight?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginInline?: Layout;
  padding?: Layout;
  paddingBlock?: Layout;
  paddingInline?: Layout;
  display?: Layout;
  flexDirection?: Layout;
  alignItems?: Layout;
  justifyContent?: Layout;
  gap?: Layout;
  boxSizing?: Layout;
}>;

/** Where the scene pictures are served from, unless you say: `public/backdrops/` in Damsko. */
export const defaultScenes = "/backdrops/";

/** Every prop a Backdrop takes. */
export interface BackdropProps {
  /** What it draws: a backdrop and, for a dither, its pattern and colour. `"none"` draws nothing. */
  variant?: BackdropLook;
  /** @deprecated Use `variant`. */
  look?: BackdropLook;
  /** What stands on the backdrop. On a scene it takes the dark scheme. */
  children?: ReactNode;
  /**
   * What the backdrop keeps clear of: the column of words on it. Sand fades out round it, and a
   * scene stays dark under it, so the words read in any window.
   */
  clear?: RefObject<HTMLElement | null>;
  /**
   * Where the six scene pictures are served from: a folder URL ending in a slash, holding
   * `cliffs.jpg`, `wave.jpg`, `aurora.jpg`, `starry.jpg`, `fuji.jpg` and `wanderer.jpg`.
   * @default "/backdrops/"
   */
  scenes?: string;
  /** @deprecated Use `layout`. */
  style?: BackdropLayoutStyle;
  /** Layout only: where it sits, its size and how what stands in it is laid out. */
  layout?: BackdropLayoutStyle;
  /**
   * How far the page has gone, 0 to 1, or `"scroll"` to follow the share of the page scrolled: a
   * dither travels through its silk, its cells gather and its ink lays stronger; a scene's silk
   * turns. Left out, it draws as it always has. Read at each picture, so a changing value costs no
   * render. With reduced motion it is still, as ever.
   */
  progress?: BackdropProgress;
  /**
   * The drawing fades out towards the box's foot and stops short of it, as the product's Chat page
   * has it; a dither or sand stands on the page's own ground. Chat start turns it on.
   * @default false
   */
  fadeFoot?: boolean;
}

const styles = stylex.create({
  // The backdrop's box, with what stands on it above the canvas.
  box: {
    position: "relative",
    isolation: "isolate",
  },
  // On a scene, which is night, what stands on it turns light. The text colour is set again here:
  // inherited, it would stay the one worked out for the page's own scheme, and what is typed
  // would be dark on the night.
  onNight: {
    colorScheme: "dark",
    color: grasp.text,
  },
  // fadeFoot: the page's own ground under a dither or sand (a scene covers its box whole).
  ground: { backgroundColor: grasp.paper },
  // fadeFoot: the drawing, whole down to a band over the foot, faded out across it, then clear.
  foot: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    pointerEvents: "none",
    maskImage: `linear-gradient(to bottom, black calc(100% - ${grasp.space20} - ${grasp.space12}), transparent calc(100% - ${grasp.space20}))`,
  },
});

/** A box that draws `look` behind what stands in it. */
export const Backdrop = ({
  look: lookDeprecated,
  variant,
  children,
  clear,
  scenes = defaultScenes,
  style: styleProp,
  layout,
  progress,
  fadeFoot = false,
}: BackdropProps) => {
  const look = byNewName(variant, lookDeprecated, "Backdrop: pass `variant`.");
  const scheme = schemeOf(look);
  return (
    <div
      data-slot="backdrop"
      data-backdrop={look.backdrop}
      // On a scene the kit's parts turn dark too, for a kit that switches on data-theme.
      data-theme={scheme}
      {...stylex.props(
        styles.box,
        scheme === "dark" && styles.onNight,
        fadeFoot && scheme !== "dark" && styles.ground,
        layout ?? styleProp
      )}
    >
      {fadeFoot ? (
        <div aria-hidden="true" {...stylex.props(styles.foot)}>
          <BackdropField
            clear={clear}
            look={look}
            scenes={scenes}
            progress={progress}
          />
        </div>
      ) : (
        <BackdropField
          clear={clear}
          look={look}
          scenes={scenes}
          progress={progress}
        />
      )}
      {children}
    </div>
  );
};
