// The one row's card (composer.tsx, compactCard) carries this marker, so a control in it can answer to
// what the row decides about its room: `data-fold`, the model's level folds to its maker's mark so the
// text keeps its least width (composer-field-least).
import * as stylex from "@stylexjs/stylex";

export const rowMarker = stylex.defineMarker();
