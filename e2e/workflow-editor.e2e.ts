/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { callGate } from "./call-gate.ts";
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
  extra: Record<string, unknown> = {},
  version = "1.0.0"
): string =>
  JSON.stringify(
    {
      document: {
        dsl: "1.0.3",
        namespace: "workspace",
        name,
        version,
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
  const reads = await callGate(page, '["workflowResources","draft"]');
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
  // Typed while it publishes: still there once the page shows version 1.
  const typed = definition(name, "typed while publishing");
  await page.getByLabel("workflow.json").fill(typed);
  await expect(page.getByText("Version 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Published as version 1.")).toBeVisible();
  await expect(page.getByLabel("workflow.json")).toHaveValue(typed);
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
  // While theirs is on its way, the editor holds still: nothing typed then
  // is overwritten when it arrives.
  reads.hold();
  await page.getByRole("button", { name: "Take theirs" }).click();
  await expect.poll(reads.stalled).toBe(1);
  await expect(page.getByLabel("workflow.json")).not.toBeEditable();
  reads.release();
  await expect(page.getByLabel("workflow.json")).toHaveValue(
    definition(name, "theirs")
  );
  await expect(page.getByLabel("workflow.json")).toBeEditable();

  // A newer revision saved before this tab publishes is the same conflict.
  await save(other, definition(name, "again"));
  await expect(
    other.getByText("Revision 4 passes the profile and can be published.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish revision 3" }).click();
  await expect(
    page.getByText("Someone changed this draft since you read it.", {
      exact: false,
    })
  ).toBeVisible();
});

test("a builder whose workflow someone else published meanwhile is told, and publishes on the new version", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowEditor");
  const page = await pageOf(builder);
  const name = `racing-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/workflows");
  await page.getByLabel("Name of a new workflow").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  // The definition it starts from saves as it is.
  await page.getByRole("button", { name: "Check and save" }).click();
  await expect(
    page.getByText("Revision 1 passes the profile and can be published.")
  ).toBeVisible();

  // Another tab publishes it first.
  const other = await pageOf(builder);
  await other.goto(page.url());
  await other.getByRole("button", { name: "Publish revision 1" }).click();
  await expect(other.getByText("Version 1", { exact: true })).toBeVisible();

  const next = definition(name, "next", {}, "1.1.0");
  await page.getByLabel("workflow.json").fill(next);
  await page.getByRole("button", { name: "Check and save" }).click();
  await page.getByRole("button", { name: "Publish revision 2" }).click();
  await expect(
    page.getByText("Someone published another version since you started", {
      exact: false,
    })
  ).toBeVisible();
  await expect(page.getByText("Version 1", { exact: true })).toBeVisible();
  await expect(page.getByLabel("workflow.json")).toHaveValue(next);
  await page.getByRole("button", { name: "Publish revision 2" }).click();
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();
});

/** Spec 13.9's routing, by who, as workflow `name`: branches that join. */
const routing = (name: string): string =>
  JSON.stringify(
    {
      ...JSON.parse(definition(name, "unused")),
      input: {
        schema: {
          format: "json",
          document: {
            type: "object",
            properties: { who: { type: "string" } },
            required: ["who"],
            additionalProperties: false,
          },
        },
      },
      do: [
        {
          route: {
            switch: [
              {
                ada: {
                  when: '${ $workflow.input.who == "Ada" }',
                  then: "greet-ada",
                },
              },
              { anyone: { then: "greet-other" } },
            ],
          },
        },
        { "greet-ada": { set: { status: "ada" }, then: "finished" } },
        { "greet-other": { set: { status: "other" }, then: "finished" } },
        { finished: { set: "${ . }" } },
      ],
    },
    null,
    2
  );

test("a builder sees every declared branch of the checked definition, and a test run marks only the tasks it reached", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowDiagram");
  const page = await pageOf(builder);
  const name = `routed-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/workflows");
  await page.getByLabel("Name of a new workflow").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  await save(page, routing(name));
  await expect(
    page.getByText("Revision 1 passes the profile and can be published.")
  ).toBeVisible();
  const diagram = page.getByRole("region", { name: "Diagram", exact: true });
  const route = diagram.getByRole("listitem", { name: "route" });
  await expect(route.getByText("Case ada, when it holds")).toBeVisible();
  await expect(route.getByText("Then greet-ada")).toBeVisible();
  await expect(route.getByText("Otherwise: anyone")).toBeVisible();
  await expect(route.getByText("Then greet-other")).toBeVisible();
  for (const task of ["greet-ada", "greet-other", "finished"]) {
    // oxlint-disable-next-line no-await-in-loop -- one task at a time
    await expect(diagram.getByRole("listitem", { name: task })).toBeVisible();
  }

  // Text that doesn't pass leaves the diagram on the revision that did.
  await save(page, "{ not yet");
  await expect(
    page.getByRole("heading", { name: "Diagram of revision 1" })
  ).toBeVisible();
  await save(page, routing(name));
  await page.getByRole("button", { name: "Publish revision 3" }).click();
  await expect(page.getByText("Version 1", { exact: true })).toBeVisible();

  await page.getByLabel("Input").fill('{ "who": "Ada" }');
  await page.getByRole("button", { name: "Start a test run" }).click();
  await expect(page.getByText("The run completed.")).toBeVisible({
    timeout: 30_000,
  });
  const ran = page.getByRole("region", {
    name: "What the run of version 1 did",
  });
  for (const task of ["route", "greet-ada", "finished"]) {
    // oxlint-disable-next-line no-await-in-loop -- one task at a time
    await expect(
      ran.getByRole("listitem", { name: task }).getByText("Reached")
    ).toBeVisible();
  }
  await expect(
    ran.getByRole("listitem", { name: "greet-other" })
  ).toHaveAttribute("data-state", "none");
});
