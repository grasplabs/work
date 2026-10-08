import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { pageOf, peopleIn } from "./people.ts";

// The icon of a control moves in its own parts when the control is pointed
// at (apps/web/src/icon-moves.css): the sidebar trigger's panel slides
// over and back. At rest, and for whoever asked for less motion, nothing
// moves. That every icon has a move is a unit test (icon-moves.test.ts).

/** The animation the sidebar trigger's moving part runs now. */
const movePart = async (page: Page): Promise<string> =>
  await page
    .getByRole("button", { name: "Show or hide the sidebar" })
    .locator("svg.lucide-panel-left > :nth-child(2)")
    .evaluate((part) => getComputedStyle(part).animationName);

test("a control's icon moves when pointed at, and never for less motion", async ({
  browser,
}) => {
  const { member } = peopleIn("iconMoves");
  const page = await pageOf(browser, member);
  await page.goto("/");
  const trigger = page.getByRole("button", {
    name: "Show or hide the sidebar",
  });
  await expect(trigger).toBeVisible();
  expect(await movePart(page)).toBe("none");

  await trigger.hover();
  expect(await movePart(page)).toBe("icon-there");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.mouse.move(0, 0);
  await trigger.hover();
  expect(await movePart(page)).toBe("none");
});
