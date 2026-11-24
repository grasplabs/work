import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// An App's data model, end to end, as a builder makes it in the App's
// workspace: a table and its fields in the Data view, each a change of the
// App's definition in the App's draft, then the draft as the workspace
// shows it elsewhere: unpublished, and the schema the Code view shows
// generated from it.

/** A read or a build on a loaded stack. */
const read = { timeout: 20_000 };

/**
 * Moves the item `name`, at `place`, up one place with its Move up
 * button, as a screen reader's user does: the step is said.
 */
const moveUp = async (page: Page, name: string, place: number) => {
  await page
    .getByRole("button", { name: `Move ${name} up`, exact: true })
    .click();
  await expect(
    page.getByText(`${name} is now at place ${place - 1}.`)
  ).toBeAttached();
};

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
  await page.goto(`/apps/${app}?view=data`);
  await expect(page.getByText("No tables yet")).toBeVisible(read);

  // A table, named as a person says it, saved as code names it.
  await page.getByRole("button", { name: "New table" }).click();
  const dialog = page.getByRole("dialog", { name: "New table" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Tasks");
  await dialog.getByRole("button", { name: "Create table" }).click();
  await expect(page.getByRole("table", { name: "tasks" })).toBeVisible(read);

  // Its fields, added in its Fields view, each from its kind: a required
  // text, then a choice whose options are put in order from the keyboard,
  // as the field itself is put before the first.
  await expect(dialog).toHaveCount(0);
  const fieldsView = page.getByRole("button", { name: "Fields", exact: true });
  await fieldsView.click();
  await expect(fieldsView).toHaveAttribute("aria-pressed", "true");
  const kinds = page.getByRole("list", { name: "Kinds of field" });
  // A kind is picked by its row: the row takes the press.
  const kindOf = (kind: string) =>
    kinds
      .getByRole("listitem")
      .filter({ has: page.getByRole("button", { name: kind, exact: true }) });
  const fields = page.getByRole("list", { name: "Fields" });
  await kindOf("Text").click();
  await page
    .getByRole("form", { name: "New field" })
    .getByRole("textbox", { name: "Name" })
    .fill("title");
  await page.getByRole("switch", { name: "Required" }).click();
  await page.getByRole("button", { name: "Add field" }).last().click();
  await expect(
    fields.getByRole("listitem").filter({ hasText: /^title/u })
  ).toBeVisible(read);
  await page.getByRole("button", { name: "Add field" }).first().click();
  await kindOf("Choice").click();
  await page
    .getByRole("form", { name: "New field" })
    .getByRole("textbox", { name: "Name" })
    .fill("status");
  await page.getByLabel("New option").fill("Open");
  await page.getByLabel("New option").press("Enter");
  await page.getByLabel("New option").fill("Done");
  await page.getByLabel("New option").press("Enter");
  await moveUp(page, "Done", 2);
  await expect(page.getByLabel("Option 1")).toHaveValue("Done");
  await page.getByRole("button", { name: "Add field" }).last().click();
  await expect(
    fields.getByRole("listitem").filter({ hasText: /^status/u })
  ).toBeVisible(read);
  await moveUp(page, "status", 2);
  await expect(fields.getByRole("listitem").first()).toContainText(
    "status",
    read
  );
  await page.getByRole("button", { name: "Records", exact: true }).click();
  const grid = page.getByRole("table", { name: "tasks" });
  await expect(
    grid.getByRole("columnheader", { name: /^status/u })
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Tables" }).getByText("tasks")
  ).toBeVisible();

  // The draft as the workspace shows it: ready to publish, previewed as
  // the App's own working version, and its schema generated from the
  // table just made.
  await expect(
    page.getByRole("button", { name: "Publish", exact: true })
  ).toBeEnabled(read);
  // The App itself, by its name over the workspace's rows.
  await page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("heading")
    .getByRole("link")
    .click();
  await expect(
    page.getByRole("region", { name: /, your version$/u })
  ).toBeVisible(read);
  await page.getByRole("link", { name: "Code" }).click();
  await page
    .getByRole("tree", { name: "Files" })
    .getByRole("treeitem", { name: "schema.ts" })
    .click();
  const code = page.getByRole("region", { name: "Code of server/schema.ts" });
  await expect(code).toContainText("tasks: defineTable", read);
  await expect(code).toContainText('v.enum(["Done", "Open"])');
  // In the order the fields were put in.
  await expect(code).toContainText(/status:[\s\S]*title:/u);
});
