import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// Settings › AI and spend: the organization's own AI providers, the
// models its calls run on, and what they cost this month, for its admins.
// The stack connects its providers and chooses its models before any test
// (`signInCast`, e2e/people.ts), so this test reads them and changes
// nothing other tests' chats run on. What a key or a model change does is
// core's test (apps/core/test/ai-providers.test.ts); the spend itself,
// which only model calls add to, is core's too.

/** A section of the page, by its title. */
const sectionOf = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("an admin finds the organization's providers, models and spend under AI and spend, and nobody else does", async ({
  pageOf,
}) => {
  const { admin, builder } = peopleIn("aiSpend");
  const page = await pageOf(admin);
  await page.goto("/settings");
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "AI and spend" })
    .click();
  await expect(page).toHaveURL(/\/settings\/ai-providers$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "AI and spend" })
  ).toBeVisible();

  // The stack's two providers, each the admin's to manage.
  const providers = sectionOf(page, "Providers");
  await expect(
    providers.getByRole("button", { name: /^Manage /u })
  ).toHaveCount(2);
  // The models every chat, agent and workflow runs on: the default first.
  const models = sectionOf(page, "Models");
  await expect(
    models.getByRole("combobox", { name: "Default model" })
  ).toHaveValue(/^Mistral Large/u);
  // What they cost this month, day by day.
  await expect(page.getByText("Spent this month")).toBeVisible();

  // Someone who isn't an admin has no such section.
  const theirs = await pageOf(builder);
  await theirs.goto("/settings");
  await expect(
    theirs.getByRole("navigation", { name: "Settings" }).getByRole("link")
  ).toHaveText(["Profile", "Appearance", "Instructions", "Security"]);
});
