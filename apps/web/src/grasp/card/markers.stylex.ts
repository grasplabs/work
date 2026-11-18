import * as stylex from "@stylexjs/stylex";

/** A card that is one link: its media and title answer the link's hover and keyboard focus. */
export const cardLinkMarker = stylex.defineMarker();

/**
 * The card's own padding, set by its `padding`, so a CardMedia in it can sit concentric: its corner
 * is the card's corner less the padding, never under the smallest corner.
 */
export const cardVars = stylex.defineVars({ inset: "16px" });
