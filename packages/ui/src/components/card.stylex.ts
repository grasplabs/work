// What Card's parts read from what holds them.
import * as stylex from "@stylexjs/stylex";

import { font, space } from "../lib/tokens.stylex";

/** A card that is one link: its media and title answer the link's hover and keyboard focus. */
export const cardLinkMarker = stylex.defineMarker();

/**
 * What a card hands its parts. `inset` is the card's own padding, so a CardMedia in it can sit
 * concentric: its corner is the card's corner less the padding, never under the smallest corner.
 * The title's and the description's type are the card's, until a header over a CardContent sets
 * a section's (a larger line, the interface's tracking).
 */
export const cardVars = stylex.defineVars({
  inset: space[4],
  titleSize: font.headingXs,
  titleLine: font.headingXsLine,
  titleTracking: font.trackingUiTitle,
  descriptionSize: font.textBase,
  descriptionLine: font.textBaseTightLine,
});
