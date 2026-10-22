import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// The page panel: a new page opens at its top however far the last was
// scrolled, and what is wider than the page is cut at its edge instead of
// sliding the page and its header sideways.

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

/** Short enough that any page scrolls once it has this much below it. */
const short = { width: 1280, height: 400 };

test("a new page opens at its top, and what is too wide does not scroll the page sideways", async ({
  pageOf,
}) => {
  const { member } = peopleIn("pagePanel");
  const page = await pageOf(member);
  await page.setViewportSize(short);
  await page.goto("/brain");
  const nav = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(nav).toContainText("Brain", pageRead);

  const panel = page.locator('[data-slot="sidebar-inset"]');
  // Content taller and wider than the panel, in the panel itself so it
  // stays through the navigation below. It is set through the style
  // object, which the page's content security policy allows.
  await panel.evaluate((element) => {
    const filler = document.createElement("div");
    filler.style.height = "3000px";
    filler.style.width = "4000px";
    // The panel lays its page out in a column, which would shrink it.
    filler.style.flexShrink = "0";
    element.append(filler);
  });

  const barBefore = await nav.boundingBox();
  // A sideways swipe or wheel over it, then the way down.
  await panel.hover();
  await page.mouse.wheel(600, 0);
  await page.mouse.wheel(0, 1500);
  await expect
    .poll(async () => await panel.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await panel.evaluate((element) => element.scrollLeft)).toBe(0);
  expect(await nav.boundingBox()).toEqual(barBefore);

  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page).toHaveURL(/\/workflows$/u);
  await expect(nav).toContainText("Workflows", pageRead);
  await expect
    .poll(async () => await panel.evaluate((element) => element.scrollTop))
    .toBe(0);
});
