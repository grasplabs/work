import { expect } from "@playwright/test";

import { seededConnections } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// The Landscape and Policies, as ported from the prototype: the apps Grasp
// knows from its integrations, each with its page and tabs, and the policy
// manager, which shows the policies and rules core keeps. The apps are
// the shared connections the global setup seeds (e2e/connections-seed.ts),
// which everyone sees.

test("an admin finds a connected app in the landscape, with the engine that uses it, and opens its page", async ({
  pageOf,
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

  const page = await pageOf(admin);
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
  // Among them the permission the engine was granted on its connection,
  // which core records on the permission rather than the connection.
  await expect(page.getByText("Granted a permission").first()).toBeVisible();

  // Add app: an app the catalog doesn't have is asked for under its name,
  // and one it has opens where it is connected.
  await page.goto("/landscape");
  await page.getByRole("button", { name: "Add app" }).click();
  const adding = page.getByRole("dialog", { name: "Add an app" });
  await adding.getByRole("combobox").fill("Twinfield");
  await adding
    .getByRole("option", { name: "Ask Grasp to add “Twinfield”" })
    .click();
  const requesting = page.getByRole("dialog", { name: "Request an app" });
  await expect(requesting.getByLabel("App")).toHaveValue("Twinfield");
  await requesting.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Add app" }).click();
  await adding.getByRole("combobox").fill("google");
  await adding.getByRole("option", { name: /^Google Workspace/u }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Google Workspace" })
  ).toBeVisible();

  // An app nothing in Grasp knows isn't there.
  await page.goto("/landscape/native:nothing/overview");
  await expect(
    page.getByRole("heading", { level: 1, name: "App not found" })
  ).toBeVisible();
});

test("a member sees the landscape but not an app's audit trail, and the policy manager's empty states; an admin uploads a policy, makes a rule from it and grants an exception, which the member reads but can't change", async ({
  pageOf,
}) => {
  const { admin, user } = peopleIn("landscape");
  const page = await pageOf(user);
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

  // An admin uploads and publishes a policy, makes a rule from it, turns
  // it on and lets an app break it, all from the pages. One test keeps
  // the company's whole policy book, so the empty states above hold.
  const title = `Acceptable use of AI ${crypto.randomUUID()}`;
  const name = `Customer data stays in the EU ${crypto.randomUUID()}`;
  const reason = `Pilot with the sales team ${crypto.randomUUID()}`;
  const { core, api } = apiOf(admin);
  try {
    const adminPage = await pageOf(admin);
    await adminPage.goto("/policies");
    await adminPage.getByRole("button", { name: "Upload a policy" }).click();
    await adminPage.getByLabel("Title").fill(title);
    await adminPage
      .getByLabel("The policy's text")
      .fill(
        "Staff may not paste customer data into AI tools hosted outside the EU."
      );
    await adminPage.getByRole("button", { name: "Upload" }).click();
    await expect(
      adminPage.getByRole("heading", { level: 1, name: title })
    ).toBeVisible();
    const policyUrl = adminPage.url();
    await adminPage.getByRole("button", { name: "Publish" }).click();
    await expect(adminPage.getByText("Rules from this policy")).toBeVisible();

    await adminPage
      .getByRole("button", { name: "Make a rule from it" })
      .click();
    await adminPage.getByLabel("Name").fill(name);
    await adminPage.getByRole("checkbox", { name: "Customer data" }).click();
    await adminPage
      .getByLabel("The passage it says")
      .fill("Staff may not paste customer data into AI tools");
    await adminPage.getByRole("button", { name: "Save" }).click();
    await expect(
      adminPage.getByRole("heading", { level: 1, name })
    ).toBeVisible();
    await expect(
      adminPage.getByText("Watching", { exact: true })
    ).toBeVisible();
    await adminPage.getByRole("button", { name: "Edit" }).click();
    await adminPage.getByLabel("Status").selectOption("active");
    await adminPage.getByRole("button", { name: "Save" }).click();
    await expect(adminPage.getByText("Active", { exact: true })).toBeVisible();

    await adminPage.getByRole("button", { name: "Grant an exception" }).click();
    await adminPage.getByLabel("Why").fill(reason);
    await adminPage.getByLabel("Until").fill("2099-01-31");
    await adminPage.getByRole("button", { name: "Grant" }).click();
    await expect(adminPage.getByText(reason)).toBeVisible();
    const ruleUrl = adminPage.url();

    // The member reads all of it, and is offered none of the changes.
    await page.goto("/policies");
    await expect(page.getByText(name)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Upload a policy" })
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New rule" })).toHaveCount(0);
    await page.goto(ruleUrl);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByText(reason)).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /^(?:Edit|Delete|Grant an exception|Revoke.*)$/u,
      })
    ).toHaveCount(0);
    await page.goto(policyUrl);
    await expect(
      page.getByRole("heading", { level: 1, name: title })
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /^(?:Remove|Make a rule from it|Publish)$/u,
      })
    ).toHaveCount(0);

    // The admin ends the exception, deletes the rule, then removes the policy.
    await adminPage.getByRole("button", { name: /^Revoke/u }).click();
    await expect(
      adminPage.getByText("No app is allowed to break this rule.")
    ).toBeVisible();
    await adminPage.getByRole("button", { name: "Delete" }).click();
    await adminPage
      .getByRole("alertdialog")
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(adminPage).toHaveURL(/\/policies$/u);
    await expect(adminPage.getByText(name)).toHaveCount(0);
    await adminPage.goto(policyUrl);
    await adminPage.getByRole("button", { name: "Remove" }).click();
    await adminPage
      .getByRole("alertdialog")
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(adminPage).toHaveURL(/\/policies$/u);
  } finally {
    // Whatever the journey left, so the empty states hold on a retry.
    const book = await api.policies.book();
    await Promise.all(
      book.rules
        .filter((each) => each.name === name)
        .map(async ({ id }) => {
          await api.policies.removeRule(id);
        })
    );
    await Promise.all(
      book.policies
        .filter((each) => each.title === title)
        .map(async ({ id }) => {
          await api.policies.removePolicy(id);
        })
    );
    core[Symbol.dispose]();
  }
});
