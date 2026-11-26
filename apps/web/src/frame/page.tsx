import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// A page's body, as the prototype has it (`components/page.tsx`).

const styles = stylex.create({
  // A column as wide as the card, its sides 24px in, as the reference's
  // (#2503's frame/page.tsx: one width through the product, so every
  // page's edges stand under the bar's and a banner's). Its foot leaves
  // room for the chat box, its dock's 96px, so the last row of a page is
  // never under it.
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    width: "100%",
    paddingBlockStart: space["7"],
    paddingInline: space["6"],
    paddingBlockEnd: space["24"],
  },
});

/**
 * The page body. Its text is the body's: a smaller part says so itself.
 */
export const Page = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.page)}>{children}</div>
);
