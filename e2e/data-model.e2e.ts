import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// An App's data model, end to end, as a builder makes it in the App's
// workspace: a table and its fields in the Data view, each a change of the
// App's definition in the workspace chat's draft, then the draft as the
// workspace shows it elsewhere: unpublished, and the schema the Code view
// shows generated from it.

/** A read or a build on a loaded stack. */
const read = { timeout: 20_000 };

test.use({ trace: "retain-on-failure", actionTimeout: read.timeout });

test("a builder creates a table and its fields in the Data view, and sees them in the App's draft", async ({
  pageOf,
}) => {
  test.setTimeout(120_000);
  const { builder } = peopleIn("dataModel");
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({
      name: `Desk ${crypto.randomUUID().slice(0, 8)}`,
    }));
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/edit?view=data`);
  await expect(page.getByText("No tables yet")).toBeVisible(read);

  // A table, named as a person says it, saved as code names it.
  await page.getByRole("button", { name: "New table" }).click();
  const dialog = page.getByRole("dialog", { name: "New table" });
  await dialog.getByLabel("Table name").fill("Tasks");
  await dialog.getByRole("button", { name: "Create table" }).click();
  await expect(page.getByRole("grid", { name: "tasks" })).toBeVisible(read);

  // Its fields, each a column added from the grid's last one: a required
  // text and a choice.
  const grid = page.getByRole("grid", { name: "tasks" });
  await grid.getByRole("button", { name: "Add a field" }).click();
  await page.getByLabel("Field name").fill("title");
  await page.getByText("Required", { exact: true }).last().click();
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(grid.getByRole("button", { name: "Change title" })).toBeVisible(
    read
  );
  await grid.getByRole("button", { name: "Add a field" }).click();
  await page.getByLabel("Field name").fill("status");
  await page.getByLabel("Type", { exact: true }).click();
  await page.getByRole("option", { name: /^Choice/u }).click();
  await page.getByLabel("Options, separated by commas").fill("Open, Done");
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(grid.getByRole("button", { name: "Change status" })).toBeVisible(
    read
  );
  await expect(
    page.getByRole("navigation", { name: "Tables" }).getByText("tasks")
  ).toBeVisible();

  // The draft as the workspace shows it: unpublished, previewed as the
  // chat's draft is, and its schema generated from the table just made.
  await expect(
    page.getByText("Unpublished changes", { exact: true })
  ).toBeVisible(read);
  await page.getByRole("link", { name: "Preview" }).click();
  await expect(page.getByRole("region", { name: /^Preview of /u })).toBeVisible(
    read
  );
  await page.getByRole("link", { name: "Code" }).click();
  await page
    .getByRole("navigation", { name: "Files" })
    .getByRole("button", { name: "schema.ts" })
    .click();
  const code = page.getByRole("region", { name: "Code of server/schema.ts" });
  await expect(code).toContainText("tasks: defineTable", read);
  await expect(code).toContainText('v.enum(["Open", "Done"])');
});
