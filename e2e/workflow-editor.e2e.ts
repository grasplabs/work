import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// A builder writes an independent workflow's definition in the editor:
// core checks each save against the profile and says what to fix at its
// task and JSON Pointer, only a revision that passes publishes, and of two
// people saving the same revision, the second is told and keeps their text.

/** A definition of workflow `name`, its one task given `extra` keys. */
const definition = (
  name: string,
  status: string,
  extra: Record<string, unknown> = {}
): string =>
  JSON.stringify(
    {
      document: {
        dsl: "1.0.3",
        namespace: "workspace",
        name,
        version: "1.0.0",
        title: name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {},
            bindings: {},
          },
        },
      },
      input: {
        schema: {
          format: "json",
          document: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
      output: {
        schema: {
          format: "json",
          document: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
            additionalProperties: false,
          },
        },
      },
      do: [{ finish: { set: { status }, ...extra } }],
    },
    null,
    2
  );

/** Saves `text` as the draft on `page`. */
const save = async (page: Page, text: string): Promise<void> => {
  await page.getByLabel("workflow.json").fill(text);
  await page.getByRole("button", { name: "Check and save" }).click();
};

test("a builder writes a workflow's definition, fixes what core finds, publishes it, and keeps their text when someone saved first", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowEditor");
  const page = await pageOf(builder);
  const name = `edited-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/workflows");
  await page.getByLabel("Name of a new workflow").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText("Not published")).toBeVisible();

  // A key the profile doesn't know: refused at its task and pointer.
  await save(page, definition(name, "done", { unknown: true }));
  const problems = page.getByRole("region", { name: "What to fix" });
  await expect(problems.getByText("/do/0/finish/unknown")).toBeVisible();
  await expect(problems.getByText("finish", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Revision 1 doesn't pass yet, and no revision has.")
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish revision 1" })
  ).toBeDisabled();

  await save(page, definition(name, "done"));
  await expect(
    page.getByText("Revision 2 passes the profile and can be published.")
  ).toBeVisible();
  await expect(problems).toHaveCount(0);
  await page.getByRole("button", { name: "Publish revision 2" }).click();
  await expect(page.getByText("Version 1", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.getByRole("cell", { name: "1.0.0" })).toBeVisible();
  await page.getByRole("tab", { name: "Definition" }).click();

  // Another tab of theirs saves first: this one is told, keeps its text,
  // and can take the other instead.
  const other = await pageOf(builder);
  await other.goto(page.url());
  await save(other, definition(name, "theirs"));
  await expect(
    other.getByText("Revision 3 passes the profile and can be published.")
  ).toBeVisible();
  const mine = definition(name, "mine");
  await save(page, mine);
  await expect(
    page.getByText("Someone changed this draft since you read it.", {
      exact: false,
    })
  ).toBeVisible();
  await expect(page.getByLabel("workflow.json")).toHaveValue(mine);
  await page.getByRole("button", { name: "Take theirs" }).click();
  await expect(page.getByLabel("workflow.json")).toHaveValue(
    definition(name, "theirs")
  );
});
