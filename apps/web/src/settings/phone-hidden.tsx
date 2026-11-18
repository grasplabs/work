import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { media } from "../grasp/tokens/tokens.stylex.ts";

// A list row's face, from the phone's width up: below it the row's room
// goes to the name and the controls, so each person stays one row. Above
// it the wrapper takes no box (`contents`), so what it holds is the row's
// own part, as if it weren't there.

const styles = stylex.create({
  shown: { display: { default: "contents", [media.belowPhone]: "none" } },
});

/** Holds a row's part (an Item's media) and leaves it out below the phone's width. */
export const PhoneHidden = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.shown)}>{children}</span>
);
