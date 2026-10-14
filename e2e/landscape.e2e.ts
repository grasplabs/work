import { expect } from "@playwright/test";

import { seededConnections } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// The Landscape and Policies, as ported from the prototype: the apps Grasp
// knows from its integrations, each with its page and tabs, and the policy
// manager, which has nothing to show until core keeps rules. The apps are
// the shared connections the global setup seeds (e2e/connections-seed.ts),
// which everyone sees.

test("an admin finds a connected app in the landscape, with the engine that uses it, and opens its page", async ({
  browser,
}) => {
  const { admin } = peopleIn("landscape");
  const { mailbox } = seededConnections();
  const appName = `Expense desk ${crypto.randomUUID()}`;
  const { core, api } = apiOf(admin);
  try {
    const { id: appId } = await api.apps.create({
      name: appName,
      description: "Reads receipts from the shared mailbox",
    });
    const { id } = await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "connection", connectionId: mailbox.id },
      actions: ["mail.read"],
      binding: "MAILBOX",
    });
    await api.permissions.grant(id, { version: null });
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(browser, admin);
  await page.goto("/landscape");
  await expect(
    page.getByRole("heading", { level: 1, name: "Landscape" })
  ).toBeVisible();
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Microsoft 365", exact: true }),
  });
  await expect(row).toContainText("Productivity");
  await expect(row).toContainText("Native");
  // Nothing in Grasp classifies its AI or its data yet.
  await expect(row).toContainText("Unknown");
  // It is used in the engine that holds a permission on its connection.
  // The first by name shows, the others behind "+N".
  await expect(
    row
      .getByRole("link", { name: appName })
      .or(row.getByRole("button", { name: /^\+\d+$/u }))
      .first()
  ).toBeVisible();

  // A search narrows the table, and one that matches nothing says so.
  const search = page.getByRole("textbox", { name: "Search apps" });
  await search.fill("no such app at all");
  await expect(page.getByText("No apps match these filters.")).toBeVisible();
  await search.fill("microsoft");
  await expect(row).toBeVisible();

  // The mosaic is in the address.
  await page.goto("/landscape?view=mosaic");
  await expect(
    page.getByRole("button", { name: /^Microsoft 365, /u }).first()
  ).toBeVisible();

  await page.goto("/landscape");
  await page.getByRole("link", { name: "Microsoft 365", exact: true }).click();
  await expect(page).toHaveURL(
    /\/landscape\/native(?::|%3A)microsoft\/overview$/u
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Microsoft 365" })
  ).toBeVisible();
  await expect(page.getByText("App profile")).toBeVisible();
  await expect(page.getByText("Needs assignment")).toBeVisible();
  await expect(page.getByText("No risk signals")).toBeVisible();

  // The tabs: each is the prototype's empty state where Grasp has nothing yet.
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(page.getByText("No residency disclosed")).toBeVisible();
  await page.getByRole("tab", { name: "Connections" }).click();
  await expect(page.getByText("No connection paths recorded")).toBeVisible();
  await page.getByRole("tab", { name: "Usage" }).click();
  await expect(page.getByText("No connected users")).toBeVisible();
  // An admin reads the app's audit trail: core's log on its connections.
  await page.getByRole("tab", { name: "Audit trail" }).click();
  await expect(page.getByText("Event timeline")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Search events" })
  ).toBeVisible();

  // An app nothing in Grasp knows isn't there.
  await page.goto("/landscape/native:nothing/overview");
  await expect(
    page.getByRole("heading", { level: 1, name: "App not found" })
  ).toBeVisible();
});

test("a member sees the landscape but not an app's audit trail, and the policy manager's empty states", async ({
  browser,
}) => {
  const { user } = peopleIn("landscape");
  const page = await pageOf(browser, user);
  await page.goto("/landscape/native:microsoft/audit");
  await expect(
    page.getByText("Only admins can read the audit trail")
  ).toBeVisible();

  await page.goto("/policies");
  await expect(
    page.getByRole("heading", { level: 1, name: "Policies" })
  ).toBeVisible();
  await expect(
    page.getByText("No rules yet. Upload a policy, or make a rule yourself.")
  ).toBeVisible();
  await page.getByRole("tab", { name: "Apps that break them" }).click();
  await expect(page).toHaveURL(/[?&]tab=apps/u);
  await expect(page.getByText("No app breaks an active rule.")).toBeVisible();
  await page.getByRole("tab", { name: "Your policies" }).click();
  await expect(
    page.getByText(
      "No policies yet. Upload one to have Grasp propose its rules."
    )
  ).toBeVisible();

  // A link to a rule or a policy Grasp doesn't keep finds nothing.
  await page.goto("/policies/rules/rule-1");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "This rule is not here any more",
    })
  ).toBeVisible();
  await page.goto("/policies/documents/policy-1");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "This policy is not here any more",
    })
  ).toBeVisible();
});
