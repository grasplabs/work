import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// Settings › Interviews: where its Damsko parts stand.

export const interviewStyles = stylex.create({
  // The days' chart, across its card.
  chart: { width: "100%" },
  // A row's buttons, side by side at its end.
  ends: { display: "flex", alignItems: "center", gap: space["1"] },
  // The address to correct, under the row's words.
  form: { marginBlockStart: space["2"] },
});
