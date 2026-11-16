// The one value a part round a Spinner may set: how faint its last bars go. On a plain ground they
// fade to spinner-fade; on a filled control (a working ink, approve or danger button) the fill
// raises the floor to spinner-fade-on-fill, so the whole ring is seen turning, not the lead bar.
import * as stylex from "@stylexjs/stylex";

export const spinnerVars = stylex.defineVars({
  floor: "var(--grasp-spinner-fade)",
});
