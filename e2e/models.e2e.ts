import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// Settings › AI and spend: an admin reads the models the organization's
// calls use (the default and its fallbacks) and this month's spend, read
// only here. The old Models and AI spend addresses lead there. The spend
// itself, which only model calls add to, is core's test.

test("an admin reads the default model and its fallbacks on AI and spend, and nobody else does", async ({
  pageOf,
}) => {
  const { admin, builder } = peopleIn("models");
  const page = await pageOf(admin);
  await page.goto("/settings/models");
  await expect(page).toHaveURL(/\/settings\/ai-providers$/u);

  // Other tests choose the models, so they aren't pinned here.
  await expect(
    page.getByRole("combobox", { name: "Default model" })
  ).not.toHaveValue("");
  await expect(page.getByRole("list", { name: "Fallbacks" })).toBeVisible();

  const refused = await pageOf(builder);
  await refused.goto("/settings/models");
  await expect(refused.getByRole("main").getByRole("alert")).toHaveText(
    "Your role doesn't allow that.",
    { timeout: 15_000 }
  );
});

test("an admin reads this month's AI spend on AI and spend, day by day and where it went, and nobody else does", async ({
  pageOf,
}) => {
  const { admin, builder } = peopleIn("models");
  const page = await pageOf(admin);
  await page.goto("/settings/spend");
  await expect(page).toHaveURL(/\/settings\/ai-providers$/u);

  // Other tests' calls count too, so the amounts aren't pinned.
  await expect(
    page.getByRole("region", { name: "Spent this month" })
  ).toContainText(/\$\d/u);
  await expect(
    page.getByRole("table", { name: "Spend so far this month, day by day" })
  ).toBeAttached();
  await expect(
    page.getByRole("table", { name: "Where it went this month" })
  ).toBeVisible();

  const refused = await pageOf(builder);
  await refused.goto("/settings/spend");
  await expect(refused.getByRole("main").getByRole("alert")).toHaveText(
    "Your role doesn't allow that.",
    { timeout: 15_000 }
  );
  await expect(
    refused
      .getByRole("navigation", { name: "Settings" })
      .getByRole("link", { name: "AI and spend" })
  ).toHaveCount(0);
});
