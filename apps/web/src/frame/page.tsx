import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { pageRoom } from "./page.styles.ts";

// A page's body, as the prototype has it (`components/page.tsx`).

const styles = stylex.create({
  // A column as wide as the card, in the page's room (page.styles.ts):
  // one width through the product, so every page's edges stand under the
  // bar's and a banner's.
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    width: "100%",
  },
});

/**
 * The page body. Its text is the body's: a smaller part says so itself.
 */
export const Page = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.page, pageRoom.room)}>{children}</div>
);
