import { createContext, useContext } from "react";

// Which frame the signed-in product shows, while Grasp UI's frame is tried
// beside today's: `?frame=kit` shows today's (the kit's sidebar and site
// header), anything else Grasp UI's. Read once as the frame mounts. Only
// for trying the design: it goes before this is merged, with the frame
// that isn't kept.

export interface FrameStyle {
  frame: "grasp" | "kit";
}

/** The frame the address asks for. */
export const readFrameStyle = (): FrameStyle => ({
  frame:
    new URLSearchParams(window.location.search).get("frame") === "kit"
      ? "kit"
      : "grasp",
});

const FrameStyleContext = createContext<FrameStyle>({ frame: "grasp" });

export const FrameStyleProvider = FrameStyleContext.Provider;

/** The frame the page is in, for the parts drawn in it (the site header). */
export const useFrameStyle = (): FrameStyle => useContext(FrameStyleContext);
