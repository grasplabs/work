import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { pageOf, peopleIn } from "./people.ts";

// The Models page: an admin reads the models the deployment allows, its
// EU routing and data rules, and its budgets, as the stack's gateway config
// sets them (playwright.config.ts). AI spend, beside it, shows this month's
// spend against those budgets. The spend itself, which only model calls
// add to, is core's test.

/** A section of the page, by its heading. */
const sectionOf = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("an admin reads the allowed models, the rules and the budgets, and nobody else does", async ({
  browser,
}) => {
  const { admin, builder } = peopleIn("models");
  const page = await pageOf(browser, admin);
  // An old link leads to Settings → Models.
  await page.goto("/models");
  await expect(page).toHaveURL(/\/settings\/models$/u);

  await expect(page.getByText("To change them, contact Grasp.")).toBeVisible();
  const allowed = sectionOf(page, "Allowed models").getByRole("row", {
    name: /llama-3\.3-70b-instruct-fp8-fast/u,
  });
  await expect(allowed).toContainText("Hosted in the EU");
  await expect(allowed).not.toContainText("Takes sensitive data");
  await expect(sectionOf(page, "EU routing")).toContainText(
    "Every call stays in the EU: yes."
  );
  await expect(sectionOf(page, "Data rules")).toContainText(
    "There is no data rule"
  );
  const budgets = sectionOf(page, "Budgets");
  await expect(budgets.getByRole("heading", { level: 3 })).toHaveText([
    "All calls together",
    "Each person",
  ]);
  await expect(budgets).toContainText(
    "$250.00 a month, admins alerted at 80%."
  );
  await expect(budgets).toContainText("$20.00 a month, admins alerted at 80%.");
  await expect(budgets.getByRole("link", { name: "AI spend" })).toHaveAttribute(
    "href",
    "/settings/spend"
  );
  // Nothing to change: the page's only button is the sidebar's trigger.
  await expect(page.getByRole("main").getByRole("button")).toHaveText([
    "Show or hide the sidebar",
  ]);

  const refused = await pageOf(browser, builder);
  await refused.goto("/settings/models");
  await expect(refused.getByRole("alert")).toHaveText(
    "Your role doesn't allow that."
  );
});

test("an admin reads this month's AI spend against the budgets, and nobody else does", async ({
  browser,
}) => {
  const { admin, builder } = peopleIn("models");
  const page = await pageOf(browser, admin);
  await page.goto("/settings/models");
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "AI spend" })
    .click();
  await expect(page).toHaveURL(/\/settings\/spend$/u);

  const spend = sectionOf(page, "AI spend");
  await expect(spend).toContainText(/\d{4}-\d{2}, UTC/u);
  await expect(spend.getByText("This month so far")).toBeVisible();
  await expect(spend).toContainText(/ of the \$250\.00 budget/u);
  await expect(spend.getByText("By the end of the month")).toBeVisible();
  await expect(sectionOf(page, "By person")).toContainText(
    "$20.00 a month for each, admins alerted at 80%."
  );
  // The stack sets no budget for each workflow.
  await expect(sectionOf(page, "By workflow")).toHaveCount(0);

  const refused = await pageOf(browser, builder);
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
