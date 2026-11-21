import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";

const bodyBackground = async (page: Page): Promise<string> =>
  await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);

// Which theme the page paints is the browser's cascade, from the system's
// scheme. What the components do, the journeys that use them show; how a
// person's choice is kept, apps/web/src/frame/theme.test.ts.
test("paints the system's scheme, dark from the start and following a change without a reload", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/sign-in");
  await expect(page.getByRole("button").first()).toBeVisible();
  const dark = await bodyBackground(page);

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => await bodyBackground(page)).not.toBe(dark);
  const light = await bodyBackground(page);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => await bodyBackground(page)).not.toBe(light);
});
