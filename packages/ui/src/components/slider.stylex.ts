// The slider's markers: its control, so the track and the thumb can follow a pointer over the whole
// press area, the default slider's and the levels slider's.
import * as stylex from "@stylexjs/stylex";

/** On the default slider's control: the track darkens under a pointer anywhere on it. */
export const sliderMarker = stylex.defineMarker();

/** On the levels slider's row: the thumb grows and lifts under a pointer anywhere on it. */
export const sliderLevelsMarker = stylex.defineMarker();
