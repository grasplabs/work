import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";
import { toastSaying } from "./said.ts";
import { goTo } from "./tabs-nav.ts";

// A builder writes an independent workflow's definition in the editor:
// core checks each save against grasp-workflow/2 and says what to fix at
// its JSON Pointer, only a draft that passes is published to the team
// (Publish, in its bar, as an App's), and of two people saving the
// same draft, the second is told and keeps their text. The workflow opens
// on its page, whose Workshop opens its Steps: the Flow, drawn from the
// draft every builder shares; a step is changed there too, and the JSON is
// behind it, in its Settings' Definition. A run opens on a page of its
// own. Its History rolls back to a version. Making one with Grasp's chat is
// workflow-drawn-decides.e2e.ts.

/** How long a read from core may take to show. */
const pageRead = { timeout: 15_000 };

/** A value's schema: an object of exactly `fields`, each required. */
const objectOf = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** A definition answering `status`, its one step given `extra` keys. */
const definition = (
  status: string,
  extra: Record<string, unknown> = {}
): string =>
  JSON.stringify(
    {
      $schema: workflowSchemaUrl,
      args: objectOf({}),
      returns: objectOf({ status: { kind: "string" } }),
      result: { status },
      steps: [{ id: "finish", type: "wait", for: "1 second", ...extra }],
    },
    null,
    2
  );

/**
 * Creates a blank workflow of `person`'s, as the agent would for a
 * question (`env.workflowBuild.create`), and opens it on `page`: its name,
 * once its page shows it. Making one from Make something asks Grasp first
 * (the last test here).
 */
const create = async (page: Page, person: Person): Promise<string> => {
  const { core, api } = apiOf(person);
  try {
    const name = `editor-${crypto.randomUUID().slice(0, 8)}`;
    const { id } = await api.workflowResources.create(name);
    await page.goto(`/workflows/${id}`);
    await expect(page.getByRole("heading", { level: 1, name })).toBeAttached(
      pageRead
    );
    return name;
  } finally {
    core[Symbol.dispose]();
  }
};

/**
 * Opens builder tool `name` of the workflow on `page` from the Workshop
 * on its page: Steps, Runs and tests, or Settings.
 */
const view = async (page: Page, name: string): Promise<void> => {
  await page.goto(new URL(page.url()).pathname);
  await page.getByRole("button", { name: `Open ${name}` }).click(pageRead);
};

/** Opens section `name` of the workflow's Settings on `page`. */
const section = async (page: Page, name: string): Promise<void> => {
  await view(page, "Settings");
  await goTo(page.getByRole("navigation", { name: "Settings sections" }), name);
};

/** Shows the definition's JSON on `page`, in its Settings. */
const definitionOf = async (page: Page): Promise<void> => {
  await section(page, "Definition");
};

/** A step that waits a second, as `id`. */
const pause = (id: string) => ({ id, type: "wait", for: "1 second" });

/** Routing by who: an `if` whose branches join at `finished`. */
const routing = (): string =>
  JSON.stringify(
    {
      $schema: workflowSchemaUrl,
      args: objectOf({ who: { kind: "string" } }),
      returns: objectOf({ status: { kind: "string" } }),
      result: {
        status: { $expr: 'args.who === "Ada" ? "ada" : "other"' },
      },
      steps: [
        {
          id: "route",
          type: "if",
          condition: { $expr: 'args.who === "Ada"' },
          // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
          then: [pause("greetAda")],
          else: [pause("greetOther")],
        },
        pause("finished"),
      ],
    },
    null,
    2
  );

/** Saves `text` as the draft on `page`. */
const save = async (page: Page, text: string): Promise<void> => {
  await definitionOf(page);
  await page.getByLabel("workflow.json").fill(text);
  await page.getByRole("button", { name: "Check and save" }).click();
};

/** The bar's Publish on `page`: the wide bar's, or the narrow one's icon. */
const publishIn = (page: Page) =>
  page
    .getByRole("button", { name: "Publish", exact: true })
    .filter({ visible: true });

/** Publishes the draft on `page` to the team, from its bar's Publish. */
const publish = async (page: Page): Promise<void> => {
  await publishIn(page).click();
  const dialog = page.getByRole("dialog", { name: /^Publish /u });
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(toastSaying(page, / is live/u)).toBeVisible(pageRead);
  // Closed once published, before the bar's next action.
  await expect(dialog).toHaveCount(0);
};

/** A workflow's version as History names it, `vN`. */
const versionLabel = /^v\d+/u;

/** What the editor says of a draft that passes. */
const passes = "It passes its checks.";

test("a builder writes a workflow's definition, fixes what core finds, shares it, and keeps their text when someone saved first", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowEditor");
  const page = await pageOf(builder);
  const reads = await callGate(page, '["workflowResources","draft"]');
  await create(page, builder);
  // Where it stands, in its bar: beside the docked chat it gives way to the
  // name and the actions, so it is there, unseen.
  await expect(page.getByText("Only you see this")).toBeAttached();

  // A key the format doesn't know: refused at its pointer, and it can't
  // be published until it passes.
  await save(page, definition("done", { unknown: true }));
  const problems = page.getByRole("region", { name: "What to fix" });
  await expect(problems.getByText("/steps/0/unknown")).toBeVisible();
  await expect(
    page.getByText("It doesn't pass yet: what to fix is below.")
  ).toBeVisible();
  await publishIn(page).click();
  const dialog = page.getByRole("dialog", { name: /^Publish /u });
  await expect(
    dialog.getByText("It can't be published yet: 1 problem")
  ).toBeVisible(pageRead);
  await expect(
    dialog.getByRole("button", { name: "Publish", exact: true })
  ).toBeDisabled();
  await page.keyboard.press("Escape");

  await save(page, definition("done"));
  await expect(page.getByText(passes)).toBeVisible();
  await expect(problems).toHaveCount(0);
  await publish(page);
  // Its History names the version its team has.
  await section(page, "History");
  await expect(page.getByText("Your team has this one")).toBeVisible(pageRead);
  await section(page, "Definition");

  // Another tab of theirs saves while this one is typing: saving here is
  // told so, keeps its text, and can take the other instead. (Nothing
  // typed, the editor takes what anyone saves as it lands.)
  const mine = definition("mine");
  await page.getByLabel("workflow.json").fill(mine);
  const other = await pageOf(builder);
  await other.goto(page.url());
  // While theirs is on its way, the editor holds still: nothing typed then
  // is overwritten when it arrives. Held from before they save, as this
  // tab follows the shared draft and reads theirs as soon as core tells
  // of it, which may come after the conflict below shows.
  reads.hold();
  await save(other, definition("theirs"));
  await expect(other.getByText(passes)).toBeVisible();
  await page.getByRole("button", { name: "Check and save" }).click();
  await expect(
    page.getByText("Someone changed this draft since you read it.", {
      exact: false,
    })
  ).toBeVisible();
  await expect(page.getByLabel("workflow.json")).toHaveValue(mine);
  // Two reads of theirs held: the one following their save, and Take
  // theirs.
  await page.getByRole("button", { name: "Take theirs" }).click();
  await expect.poll(reads.stalled).toBe(2);
  await expect(page.getByLabel("workflow.json")).not.toBeEditable();
  reads.release();
  await expect(page.getByLabel("workflow.json")).toHaveValue(
    definition("theirs")
  );
  await expect(page.getByLabel("workflow.json")).toBeEditable();
});

test("a builder sees every declared branch of the checked definition, a test run marks only the tasks it reached, and they pause it and roll it back", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowDiagram");
  const page = await pageOf(builder);
  const name = await create(page, builder);

  await save(page, routing());
  await expect(page.getByText(passes)).toBeVisible();
  await view(page, "Steps");
  const diagram = page.getByRole("region", { name: "Diagram", exact: true });
  const route = diagram.getByRole("listitem", { name: "route" });
  await expect(route.getByText("When it holds")).toBeVisible();
  await expect(route.getByText("Otherwise")).toBeVisible();
  for (const task of ["greetAda", "greetOther", "finished"]) {
    // oxlint-disable-next-line no-await-in-loop -- one task at a time
    await expect(diagram.getByRole("listitem", { name: task })).toBeVisible();
  }

  await publish(page);

  // A run of the live version, started with Run in the bar.
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const start = page.getByRole("dialog", { name: "Start a run" });
  await start.getByLabel("who").fill("Ada");
  await start.getByRole("button", { name: "Start the run" }).click();
  await expect(
    start.getByText("The run started. It is listed with the workflow's runs.")
  ).toBeVisible(pageRead);
  await start.getByRole("button", { name: "Close" }).first().click();
  await expect(start).toHaveCount(0);

  // A second version, published as the first was.
  await save(page, definition("done"));
  await expect(page.getByText(passes)).toBeVisible();
  await publish(page);

  // Runs: the run of version 1, on its own page, with what it returned to
  // whoever started it, and in its Workshop each step its journal recorded
  // laid over its version's diagram, marking only the tasks it reached.
  await view(page, "Runs and tests");
  await page
    .getByRole("table", { name: "Runs" })
    .getByRole("row")
    .last()
    .getByRole("button")
    .first()
    .click();
  await expect(page).toHaveURL(/\/runs\/[^/?]+$/u, pageRead);
  await expect(
    page.getByRole("button", { name: "What it returned" })
  ).toBeVisible({ timeout: 30_000 });
  // Its steps speak the workflow's code: folded away until a builder asks.
  await page.getByRole("button", { name: "Open its steps" }).click();
  const ran = page.getByRole("region", {
    name: "What the run of version 1 did",
  });
  // Each task's own mark: `route` holds its branches' tasks, and their
  // marks, inside it.
  for (const task of ["route", "greetAda", "finished"]) {
    // oxlint-disable-next-line no-await-in-loop -- one task at a time
    await expect(ran.getByRole("listitem", { name: task })).toHaveAttribute(
      "data-state",
      "reached"
    );
  }
  await expect(
    ran
      .getByRole("listitem", { name: "greetAda" })
      .getByText("Done", { exact: true })
  ).toBeVisible();
  await expect(
    ran.getByRole("listitem", { name: "greetOther" })
  ).toHaveAttribute("data-state", "none");
  await page.goBack();

  // Paused once the person says so and the moment to take it back has
  // passed: it says so, and Resume runs it again.
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Pause it" }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeAttached(
    pageRead
  );
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true })
  ).toBeVisible(pageRead);

  // Its History goes back to the first version, once the person confirms.
  await section(page, "History");
  const versions = page.getByRole("region", { name: "Versions" });
  const first = versions.getByRole("listitem").last();
  const named = await first.textContent();
  const label = versionLabel.exec(named ?? "")?.[0];
  await versions.getByRole("button", { name: `Actions for ${label}` }).click();
  await page.getByRole("menuitem", { name: "Go back to this version" }).click();
  await expect(
    page.getByText("Its triggers start it from now on", { exact: false })
  ).toBeVisible();
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(first.getByText("Your team has this one")).toBeVisible(pageRead);
  await expect(page.getByRole("heading", { level: 1, name })).toBeAttached();
});

test("a builder changes one step on the Flow, saved as the draft's next change, which the JSON then holds", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowDiagram");
  const page = await pageOf(builder);
  await create(page, builder);
  await save(page, routing());
  await expect(page.getByText(passes)).toBeVisible();

  await view(page, "Steps");
  await page.getByRole("button", { name: "Change step greetAda" }).click();
  const step = page.getByRole("dialog");
  await expect(step.getByLabel("The step, as JSON")).toHaveValue(
    JSON.stringify({ type: "wait", for: "1 second" }, null, 2)
  );
  await step
    .getByLabel("The step, as JSON")
    .fill(JSON.stringify({ type: "wait", for: "1 second", title: "hi ada" }));
  await step.getByRole("button", { name: "Check and save" }).click();
  await expect(step).toBeHidden();

  await definitionOf(page);
  await expect(page.getByLabel("workflow.json")).toHaveValue(/hi ada/u);
  await expect(page.getByText(passes)).toBeVisible();
});
