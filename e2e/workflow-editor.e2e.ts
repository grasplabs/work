import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { modelScripts, workflowPlanned } from "./model-scripts.ts";
import { apiOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";

// A builder writes an independent workflow's definition in the editor:
// core checks each save against grasp-workflow/2 and says what to fix at
// its JSON Pointer, only a draft that passes is shared with the team (Share
// with your team, in its bar, as an App's), and of two people saving the
// same draft, the second is told and keeps their text. The page opens on
// its Flow, drawn from the draft every builder shares, which follows what
// anyone saves; a step is changed there too, and the JSON is behind it,
// in its Settings' Definition. Its History rolls back to a version. New
// workflow opens the workflow's shell asking what it should do; once
// answered, the workflow is made and opens on an empty Flow with Grasp's
// chat docked beside it, which draws it as its draft passes.

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

/** Opens view `name` of the workflow on `page`: Flow, Runs or Settings. */
const view = async (page: Page, name: string): Promise<void> => {
  await page
    .getByRole("navigation", { name: "Workflow views" })
    .getByRole("link", { name })
    .click();
};

/** Opens section `name` of the workflow's Settings on `page`. */
const section = async (page: Page, name: string): Promise<void> => {
  await view(page, "Settings");
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name })
    .click();
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

/** Shares the draft on `page` with the team, as its bar's lime action does. */
const share = async (page: Page, label: string): Promise<void> => {
  await page.getByRole("button", { name: label }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Share", exact: true })
    .click();
  await expect(page.getByText("Your changes are shared")).toBeVisible(pageRead);
};

/** A version's label, `YY.MM.N`, as History names it. */
const versionLabel = /\d{2}\.\d{2}\.\d+/u;

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
  // be shared until it passes.
  await save(page, definition("done", { unknown: true }));
  const problems = page.getByRole("region", { name: "What to fix" });
  await expect(problems.getByText("/steps/0/unknown")).toBeVisible();
  await expect(
    page.getByText("It doesn't pass yet: what to fix is below.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Share with your team" }).click();
  const sheet = page.getByRole("dialog");
  await expect(
    sheet.getByText("It can't be shared yet: 1 problem")
  ).toBeVisible(pageRead);
  await expect(
    sheet.getByRole("button", { name: "Share", exact: true })
  ).toBeDisabled();
  await page.keyboard.press("Escape");

  await save(page, definition("done"));
  await expect(page.getByText(passes)).toBeVisible();
  await expect(problems).toHaveCount(0);
  await share(page, "Share with your team");
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
  await save(other, definition("theirs"));
  await expect(other.getByText(passes)).toBeVisible();
  await page.getByRole("button", { name: "Check and save" }).click();
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
    definition("theirs")
  );
  await expect(page.getByLabel("workflow.json")).toBeEditable();
});

test("a builder's Flow follows the draft another builder's tab saves, as it is shared by everyone who builds it", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowEditor");
  const page = await pageOf(builder);
  await create(page, builder);
  const diagram = page.getByRole("region", { name: "Diagram", exact: true });
  await expect(diagram.getByRole("listitem", { name: "route" })).toHaveCount(0);

  // Another tab saves it: this one's Flow draws it, unasked.
  const other = await pageOf(builder);
  await other.goto(page.url());
  await save(other, routing());
  await expect(other.getByText(passes)).toBeVisible();
  await expect(diagram.getByRole("listitem", { name: "route" })).toBeVisible(
    pageRead
  );
});

test("a builder sees every declared branch of the checked definition, a test run marks only the tasks it reached, and they pause it and roll it back", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowDiagram");
  const page = await pageOf(builder);
  const name = await create(page, builder);

  await save(page, routing());
  await expect(page.getByText(passes)).toBeVisible();
  await view(page, "Flow");
  const diagram = page.getByRole("region", { name: "Diagram", exact: true });
  const route = diagram.getByRole("listitem", { name: "route" });
  await expect(route.getByText("When it holds")).toBeVisible();
  await expect(route.getByText("Otherwise")).toBeVisible();
  for (const task of ["greetAda", "greetOther", "finished"]) {
    // oxlint-disable-next-line no-await-in-loop -- one task at a time
    await expect(diagram.getByRole("listitem", { name: task })).toBeVisible();
  }

  // Text that doesn't pass leaves the diagram as it last passed, and no
  // step to change on it.
  await save(page, "{ not yet");
  await view(page, "Flow");
  await expect(
    page.getByText("The Flow shows it as it last passed.", { exact: false })
  ).toBeVisible();
  await expect(
    diagram.getByRole("button", { name: "Change step route" })
  ).toHaveCount(0);
  await save(page, routing());
  await expect(page.getByText(passes)).toBeVisible();
  await share(page, "Share with your team");

  // A run of the live version, started with Run in the bar.
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const start = page.getByRole("dialog", { name: "Start a run" });
  await start.getByLabel("who").fill("Ada");
  await start.getByRole("button", { name: "Start the run" }).click();
  await expect(start.getByRole("status")).toHaveText(
    "The run started. It is listed with the workflow's runs.",
    pageRead
  );
  await start.getByRole("button", { name: "Close" }).first().click();

  // A second version, shared as the first was.
  await save(page, definition("done"));
  await expect(page.getByText(passes)).toBeVisible();
  await share(page, "Share with your team");

  // Runs: the run of version 1, opened beside the page, with what it
  // returned to whoever started it, and each step its journal recorded
  // laid over its version's diagram, marking only the tasks it reached.
  await view(page, "Runs");
  await page
    .getByRole("button", { name: /^Open the run started/u })
    .last()
    .click();
  const steps = page.getByRole("dialog");
  await expect(steps.getByText("What it returned")).toBeVisible({
    timeout: 30_000,
  });
  await expect(steps.getByText("Step by step")).toBeVisible(pageRead);
  const ran = steps.getByRole("region", {
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
    ran.getByRole("listitem", { name: "greetAda" }).getByText("Reached")
  ).toBeVisible();
  await expect(
    ran.getByRole("listitem", { name: "greetOther" })
  ).toHaveAttribute("data-state", "none");
  await page.keyboard.press("Escape");

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
  // It opens on its Flow.
  await expect(
    page
      .getByRole("navigation", { name: "Workflow views" })
      .getByRole("link", { name: "Flow" })
  ).toHaveAttribute("aria-current", "page");
  await save(page, routing());
  await expect(page.getByText(passes)).toBeVisible();

  await view(page, "Flow");
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

test("a builder makes something that runs on its own by saying what they want done, which lands them on it with Grasp's chat docked beside it, not ready while nothing passes, and sees the Flow drawn once a draft passes", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowDrawn");
  const page = await pageOf(builder);
  const { opener, replies } = modelScripts.drawsWorkflow;
  const [, reply] = replies;
  await page.goto("/workflows");
  await page.getByRole("link", { name: "Make something" }).click();

  // Make something asks what they want done: nothing is made yet.
  await expect(page).toHaveURL(/\/\?make=workflow$/u);
  await expect(
    page.getByRole("heading", { name: "What do you want to get done?" })
  ).toBeVisible();
  const ask = page.getByRole("textbox", { name: "Your question" });
  await ask.fill(opener);
  await ask.press("Enter");

  // Grasp's plan: something that runs on its own, made on Build it.
  const plan = page.getByRole("region", {
    name: "Here's what Grasp will make",
  });
  await expect(plan.getByText("Runs on its own")).toBeVisible(pageRead);
  await expect(plan.getByText(workflowPlanned)).toBeVisible();
  await plan.getByRole("button", { name: "Build it" }).click();

  // Build it lands on the workflow at once, with Grasp's chat docked
  // beside it. This script only answers, so the turn ends with nothing
  // drawn: it isn't ready yet, with Try again, never an empty Flow.
  await expect(page).toHaveURL(/\/workflows\/[^/?]+$/u);
  const workflow = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  const chat = page.getByRole("region", { name: "Chat" });
  await expect(chat.getByText(opener)).toBeVisible();
  await expect(chat.getByText(reply.text)).toBeVisible(pageRead);
  await expect(
    page.getByText(`${workflowPlanned} isn't ready yet`)
  ).toBeVisible();

  // A first step that passes is saved as the chat's agent would save it
  // (`env.workflowBuild.edit`): this script only answers (a script that
  // saves through the agent's tools is workflow-drawn-decides.e2e.ts), so
  // the builder's own session saves it.
  const { core, api } = apiOf(builder);
  try {
    await api.drafts.write({ kind: "workflow", id: workflow }, 0, {
      "workflow.json": definition("received"),
    });
    // Once a draft passes, it is set up: its Flow draws it.
    await page.reload();
    await expect(
      page
        .getByRole("navigation", { name: "Workflow views" })
        .getByRole("link", { name: "Flow" })
    ).toHaveAttribute("aria-current", "page", pageRead);
    const diagram = page.getByRole("region", { name: "Diagram", exact: true });
    await expect(diagram.getByRole("listitem", { name: "finish" })).toBeVisible(
      pageRead
    );
  } finally {
    core[Symbol.dispose]();
  }
});
