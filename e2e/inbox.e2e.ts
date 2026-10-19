import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { seedDependencyRequest } from "./dependency-request.ts";
import { apiOf, peopleIn } from "./people.ts";

// The inbox, at its address: what waits on the person as a list, the item
// chosen beside it with its actions, and what was done. Someone with
// nothing waiting sees that said; someone given the permission approves
// packages proposed for an engine from it, and the item leaves the list;
// an admin also reads the latest of what Grasp and people did. It grants a
// package approver, so it runs with the other package approval tests.

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

test("someone with nothing waiting sees that nothing waits, and no activity", async ({
  pageOf,
}) => {
  const { user } = peopleIn("inbox");
  const page = await pageOf(user);
  await page.goto("/inbox");

  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Inbox")
  ).toBeVisible(pageRead);
  await expect(page.getByRole("tab", { name: /^To do/u })).toHaveText(
    /^To do\s*0$/u
  );
  await expect(
    page
      .getByRole("region", { name: "What waits on you" })
      .getByText("Nothing waits on you.")
  ).toBeVisible();
  await expect(
    page.getByText("Nothing waits on you", { exact: true })
  ).toBeVisible();
  // The audit trail is for admins.
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveCount(0);

  await page.getByRole("tab", { name: /^Done/u }).click();
  await expect(page.getByText(/^Nothing dealt with yet\./u)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("someone given the permission approves packages from the inbox, and the item leaves the list", async ({
  pageOf,
}) => {
  const { admin, builder, approver } = peopleIn("inbox");
  const asAdmin = apiOf(admin);
  const asBuilder = apiOf(builder);
  const engine = `Charts ${crypto.randomUUID().slice(0, 8)}`;
  const { id: app } = await asBuilder.api.apps.create({ name: engine });
  await asAdmin.api.dependencies.grantApprover({
    type: "person",
    userId: approver.userId,
  });
  const origin = "https://registry.npmjs.org";
  const request = await seedDependencyRequest({
    app,
    requestedBy: builder.userId,
    purpose: "Draw the quarter's totals as a chart.",
    targets: ["browser"],
    approved: false,
    graph: {
      direct: [{ name: "charts", version: "3.1.0" }],
      packages: [
        {
          name: "charts",
          version: "3.1.0",
          origin,
          integrity: `sha512-${"D".repeat(86)}==`,
          license: "MIT",
          dependencies: [],
          peers: [],
        },
      ],
      platformPeers: {},
    },
  });

  const page = await pageOf(approver);
  await page.goto("/inbox");
  const list = page.getByRole("region", { name: "What waits on you" });
  const row = list.getByRole("button", { name: new RegExp(engine, "u") });
  await expect(row).toBeVisible(pageRead);
  await expect(row).toContainText("Packages");

  // Filtered to workflows, it isn't there; to apps and connections, it is.
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("menuitemradio", { name: "Workflows" }).click();
  await expect(row).toHaveCount(0);
  // The menu stays open while a filter is picked.
  await page
    .getByRole("menuitemradio", { name: "Apps and connections" })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Apps and connections" })
  ).toBeVisible();
  await expect(row).toBeVisible();

  await row.click();
  await expect(row).toHaveAttribute("aria-current", "true");
  const item = page.getByRole("article", {
    name: `Approve the packages for ${engine}?`,
  });
  await expect(
    item.getByText("Draw the quarter's totals as a chart.")
  ).toBeVisible();
  await expect(
    item.getByRole("region", { name: "Context" }).getByText("1 package")
  ).toBeVisible();

  // Approving waits for the whole graph to be shown.
  const approve = item.getByRole("button", {
    name: `Approve the packages for ${engine}`,
  });
  await expect(approve.first()).toBeDisabled();
  await item
    .getByRole("button", { name: `Show the packages for ${engine}` })
    .click();
  await expect(
    item.getByRole("cell", { name: "charts@3.1.0", exact: true })
  ).toBeVisible();
  await approve.first().click();

  await expect(row).toHaveCount(0);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `Approved: Packages for ${engine}.` })
  ).toHaveCount(1);
  await expect
    .poll(async () => {
      const { approved } = await asBuilder.api.dependencies.status({ app });
      return approved?.id;
    })
    .toBe(request.id);
  await expect(page.getByRole("alert")).toHaveCount(0);
  asAdmin.core[Symbol.dispose]();
  asBuilder.core[Symbol.dispose]();
});

test("an admin reads what Grasp and people did, with the way to the audit trail", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("inbox");
  const page = await pageOf(admin);
  await page.goto("/inbox");

  await page.getByRole("tab", { name: "Activity" }).click();
  // The trail records the roles the setup gave the cast, at least.
  const activity = page.getByRole("list", { name: "Latest activity" });
  await expect(activity.getByRole("listitem").first()).toBeVisible(pageRead);
  await page.getByRole("button", { name: "People" }).click();
  await expect(activity.getByRole("listitem").first()).toBeVisible();
  await page.getByRole("link", { name: "The full audit trail" }).click();
  await expect(page).toHaveURL(/\/settings\/audit$/u);
});
