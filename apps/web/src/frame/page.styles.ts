import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

/**
 * A page's room in the card, as the reference's shell gives a page
 * (#2503's frame/page.tsx): 28px under its bar, 24px at the sides, and at
 * the foot the room for the chat's dock over it, 96px, so the last row of
 * a page is never under it. The page body (page.tsx) and a not-found
 * state in its place (page-states.tsx) stand in the same room.
 */
export const pageRoom = stylex.create({
  room: {
    paddingBlockStart: space["7"],
    paddingInline: space["6"],
    paddingBlockEnd: space["24"],
  },
});
