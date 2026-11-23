import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// The icon of a control moves in its own parts when the control is pointed
// at (apps/web/src/icon-moves.css): the chat bar's way into the chat, its
// panel sliding over and back. Only the kit's (lucide's) icons: Damsko's
// own controls, the frame's among them, keep their own look. At rest, and for whoever asked for less motion, nothing
// moves. That every icon has a move is the lint's (grasp/icon-has-move,
// scripts/lint/icon-has-move.test.ts).

/** The control whose icon is watched: the chat bar's way into the chat. */
const control = (page: Page) =>
  page.getByRole("button", { name: "Open the chat" });

/** The animation the control's moving part runs now. */
const movePart = async (page: Page): Promise<string> =>
  await control(page)
    .locator("svg.lucide-panel-right-open > :nth-child(2)")
    .evaluate((part) => getComputedStyle(part).animationName);

/** A transform that moves nothing, as the browser computes it. */
const atRest = "matrix(1, 0, 0, 1, 0, 0)";

/**
 * The control's moving part's transform at `share` of its move (1 for
 * its end), the move held there.
 */
const transformAt = async (page: Page, share: number): Promise<string> =>
  await control(page)
    .locator("svg.lucide-panel-right-open > :nth-child(2)")
    .evaluate((part, at) => {
      const [move] = part.getAnimations();
      if (move === undefined) {
        return "no move";
      }
      move.pause();
      const { duration } = move.effect?.getComputedTiming() ?? {};
      move.currentTime = typeof duration === "number" ? duration * at : 0;
      return getComputedStyle(part).transform;
    }, share);

test("a control's icon moves when pointed at, and never for less motion", async ({
  pageOf,
}) => {
  const { member } = peopleIn("iconMoves");
  const page = await pageOf(member);
  await page.goto("/apps");
  const trigger = control(page);
  await expect(trigger).toBeVisible();
  expect(await movePart(page)).toBe("none");

  await trigger.hover();
  expect(await movePart(page)).toBe("icon-there");
  // It goes somewhere: at the middle of its move the part stands aside,
  // and at its end it is back where Lucide draws it.
  const aside = await transformAt(page, 0.45);
  expect(aside).toMatch(/^matrix\(/u);
  expect(aside).not.toBe(atRest);
  expect([atRest, "none"]).toContain(await transformAt(page, 1));

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.mouse.move(0, 0);
  await trigger.hover();
  expect(await movePart(page)).toBe("none");
});
