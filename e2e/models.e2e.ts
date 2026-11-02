import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// The Models page: an admin reads the models the organization allows and
// the one limit every run has. AI spend, beside it, shows this month's
// spend, read-only. The spend itself, which only model calls add to, is
// core's test.

/** A section of the page, by its heading. */
const sectionOf = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("an admin reads the allowed models and the run limit, and nobody else does", async ({
  pageOf,
}) => {
  const { admin, builder } = peopleIn("models");
  const page = await pageOf(admin);
  await page.goto("/settings/models");

  // The models are the organization's own choice: its admin is pointed
  // to where they choose them.
  await expect(
    sectionOf(page, "Allowed models").getByRole("link", {
      name: "Settings › AI providers",
    })
  ).toHaveAttribute("href", "/settings/ai-providers");
  await expect(
    sectionOf(page, "Allowed models").getByRole("row", {
      name: /mistral-large-latest/u,
    })
  ).toBeVisible();
  await expect(sectionOf(page, "Limits")).toContainText(
    "at most 100 model requests"
  );
  // Nothing to change: the page's only button is the sidebar's trigger.
  await expect(page.getByRole("main").getByRole("button")).toHaveText([
    "Show or hide the sidebar",
  ]);

  const refused = await pageOf(builder);
  await refused.goto("/settings/models");
  await expect(refused.getByRole("alert")).toHaveText(
    "Your role doesn't allow that."
  );
});

test("an admin reads this month's AI spend, and nobody else does", async ({
  pageOf,
}) => {
  const { admin, builder } = peopleIn("models");
  const page = await pageOf(admin);
  await page.goto("/settings/models");
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "AI spend" })
    .click();
  await expect(page).toHaveURL(/\/settings\/spend$/u);

  const spend = sectionOf(page, "AI spend");
  await expect(spend).toContainText(/\d{4}-\d{2}, UTC/u);
  await expect(spend.getByText("This month so far")).toBeVisible();
  await expect(spend.getByText("By the end of the month")).toBeVisible();
  await expect(sectionOf(page, "Workflows this month")).toBeVisible();

  const refused = await pageOf(builder);
  await refused.goto("/settings/spend");
  await expect(refused.getByRole("alert")).toHaveText(
    "Your role doesn't allow that."
  );
  await expect(
    refused
      .getByRole("navigation", { name: "Settings" })
      .getByRole("link", { name: "AI spend" })
  ).toHaveCount(0);
});
