import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";

// Damsko's components (packages/ui) in the product's own build, before any
// page uses them: the local gallery (apps/web/src/routes/kit_.damsko.tsx)
// draws one small use of each, group by group, under the page's Content
// Security Policy. What each component does is tested in Damsko; here,
// that it compiles, loads and draws beside the kit.

/** A group's demos: each drew something with a size, and none failed. */
const drew = async (page: Page, group: string, count: number) => {
  await page.goto("/kit/damsko");
  const demos = page
    .getByRole("region", { name: group, exact: true })
    .locator("[data-demo]");
  await expect(demos).toHaveCount(count);
  await expect(page.getByText("This part failed to draw.")).toHaveCount(0);
  const empty = await demos.evaluateAll((items) =>
    items
      .filter((item) => {
        const content = item.querySelector("[data-demo-content]");
        const box = content?.getBoundingClientRect();
        return !box || box.width === 0 || box.height === 0;
      })
      .map((item) => item.dataset.demo)
  );
  expect(empty).toStrictEqual([]);
};

test("Damsko's form and basic controls draw in the product's build", async ({
  page,
}) => {
  await drew(page, "Form and basic controls", 52);
});
