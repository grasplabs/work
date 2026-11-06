import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// An App's data model, end to end, as a builder makes it in the App's
// workspace: a table and its fields in the Data view, each a change of the
// App's definition in the workspace chat's draft, then the draft as the
// workspace shows it elsewhere: unpublished, and the schema the Code view
// shows generated from it.

/** A read or a build on a loaded stack. */
const read = { timeout: 20_000 };

/**
 * Moves the item `name`, at `place`, up one place from the keyboard, as a
 * screen reader's user does: each step once it's said.
 */
const moveUp = async (page: Page, name: string, place: number) => {
  await page.getByRole("button", { name: `Move ${name}`, exact: true }).focus();
  await page.keyboard.press("Space");
  // Picked up, and over its own place.
  await expect(
    page.getByText(`${name} is now at place ${place}.`)
  ).toBeAttached();
  // dnd-kit listens for the arrows a task after the pick-up, which a
  // person never beats but a test's next key can.
  await page.evaluate(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    requestAnimationFrame(() => {
      setTimeout(() => {
        resolve(true);
      }, 0);
    });
    await promise;
  });
  await page.keyboard.press("ArrowUp");
  await expect(
    page.getByText(`${name} is now at place ${place - 1}.`)
  ).toBeAttached();
  await page.keyboard.press("Space");
  await expect(
    page.getByText(`Put ${name} down at place ${place - 1}.`)
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
  await page.goto(`/apps/${app}/edit?view=data`);
  await expect(page.getByText("No tables yet")).toBeVisible(read);

  // A table, named as a person says it, saved as code names it.
  await page.getByRole("button", { name: "New table" }).click();
  const dialog = page.getByRole("dialog", { name: "New table" });
  await dialog.getByLabel("Table name").fill("Tasks");
  await dialog.getByRole("button", { name: "Create table" }).click();
  await expect(page.getByRole("table", { name: "tasks" })).toBeVisible(read);

  // Its fields, added in its Fields view, each from its kind: a required
  // text, then a choice whose options are put in order from the keyboard,
  // as the field itself is put before the first.
  await page.getByRole("button", { name: "Fields", exact: true }).click();
  const kinds = page.getByRole("list", { name: "Kinds of field" });
  const fields = page.getByRole("list", { name: "Fields" });
  await kinds.getByRole("button", { name: /^Text/u }).click();
  await page.getByLabel("Field name").fill("title");
  await page.getByRole("switch", { name: "Required" }).click();
  await page.getByRole("button", { name: "Add field" }).last().click();
  await expect(fields.getByRole("button", { name: /^title/u })).toBeVisible(
    read
  );
  await page.getByRole("button", { name: "Add field" }).first().click();
  await kinds.getByRole("button", { name: /^Choice/u }).click();
  await page.getByLabel("Field name").fill("status");
  await page.getByLabel("New option").fill("Open");
  await page.getByLabel("New option").press("Enter");
  await page.getByLabel("New option").fill("Done");
  await page.getByLabel("New option").press("Enter");
  await moveUp(page, "Done", 2);
  await expect(page.getByLabel("Option 1")).toHaveValue("Done");
  await page.getByRole("button", { name: "Add field" }).last().click();
  await expect(fields.getByRole("button", { name: /^status/u })).toBeVisible(
    read
  );
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
  await expect(code).toContainText('v.enum(["Done", "Open"])');
  // In the order the fields were put in.
  await expect(code).toContainText(/status:[\s\S]*title:/u);
});
