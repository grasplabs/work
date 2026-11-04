/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { modelScripts } from "./model-scripts.ts";
import { apiOf, peopleIn } from "./people.ts";

// A builder writes an independent workflow's definition in the editor:
// core checks each save against the profile and says what to fix at its
// task and JSON Pointer, only a revision that passes publishes, and of two
// people saving the same revision, the second is told and keeps their text.
// The page opens on its Flow, the revision that passed drawn, where a step
// is changed too; the JSON is behind it, on Definition. A new workflow
// opens on an empty Flow with Grasp's chat docked beside it, which asks
// which business process it is for and draws it as its draft passes.

/** How long a read from core may take to show. */
const pageRead = { timeout: 15_000 };

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

/** A new workflow's name, as New workflow makes one. */
const newName = /^new-workflow-[\da-f]{8}$/u;

/**
 * Creates a workflow from the Workflows page's New workflow, which opens
 * it: its name, once its page shows it.
 */
const create = async (page: Page): Promise<string> => {
  await page.getByRole("button", { name: "New workflow" }).click();
  const title = page.getByRole("heading", { name: newName });
  await expect(title).toBeVisible(pageRead);
  return (await title.textContent()) ?? "";
};

/** Shows the definition's JSON on `page`, behind its Flow. */
const definitionOf = async (page: Page): Promise<void> => {
  await page.getByRole("tab", { name: "Definition" }).click();
};

/** Saves `text` as the draft on `page`. */
const save = async (page: Page, text: string): Promise<void> => {
  await definitionOf(page);
  await page.getByLabel("workflow.json").fill(text);
  await page.getByRole("button", { name: "Check and save" }).click();
};

test("a builder writes a workflow's definition, fixes what core finds, publishes it, and keeps their text when someone saved first", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowEditor");
  const page = await pageOf(builder);
  const reads = await callGate(page, '["workflowResources","draft"]');
  await page.goto("/workflows");
  const name = await create(page);
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
  await page.goto("/workflows");
  const name = await create(page);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  // The definition it starts from saves as it is.
  await definitionOf(page);
  await page.getByRole("button", { name: "Check and save" }).click();
  await expect(
    page.getByText("Revision 1 passes the profile and can be published.")
  ).toBeVisible();

  // Another tab publishes it first.
  const other = await pageOf(builder);
  await other.goto(page.url());
  await definitionOf(other);
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
  const { builder, admin } = peopleIn("workflowDiagram");
  const page = await pageOf(builder);
  await page.goto("/workflows");
  const name = await create(page);
  await expect(page.getByRole("heading", { name })).toBeVisible();

  await save(page, routing(name));
  await expect(
    page.getByText("Revision 1 passes the profile and can be published.")
  ).toBeVisible();
  await page.getByRole("tab", { name: "Flow" }).click();
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

  // Text that doesn't pass leaves the diagram on the revision that did,
  // and no step to change on it.
  await save(page, "{ not yet");
  await page.getByRole("tab", { name: "Flow" }).click();
  await expect(page.getByText("Diagram of revision 1")).toBeVisible();
  await expect(
    diagram.getByRole("button", { name: "Change step route" })
  ).toHaveCount(0);
  await save(page, routing(name));
  await page.getByRole("button", { name: "Publish revision 3" }).click();
  await expect(page.getByText("Version 1", { exact: true })).toBeVisible();

  // A test run of the current version, under its Flow.
  await page.getByRole("tab", { name: "Flow" }).click();

  await page.getByLabel("Input").fill('{ "who": "Ada" }');
  await page.getByRole("button", { name: "Start a run", exact: true }).click();
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

  // A version with no build that runs is admitted and never runs: the
  // panel says so instead of waiting on a run that doesn't exist.
  await save(
    page,
    definition(
      name,
      "unused",
      { set: { status: "done", ["k".repeat(2100)]: "${ . }" } },
      "1.1.0"
    )
  );
  await page.getByRole("button", { name: "Publish revision 4" }).click();
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByLabel("Input").fill("{}");
  await page.getByRole("button", { name: "Start a run", exact: true }).click();
  await expect(
    page.getByText("Version 2 has no build that runs, so nothing ran", {
      exact: false,
    })
  ).toBeVisible();

  // Traces: the run of version 1, opened beside the page, with what it
  // returned to whoever started it, and each step its journal recorded
  // laid over its version's diagram.
  await page.getByRole("tab", { name: "Traces" }).click();
  await page
    .getByRole("tabpanel")
    .getByRole("button", { name: /^Open the run started/u })
    .last()
    .click();
  const steps = page.getByRole("dialog");
  await expect(steps.getByText("What it returned")).toBeVisible(pageRead);
  await expect(steps.getByText("Step by step")).toBeVisible(pageRead);
  await expect(
    steps
      .getByRole("region", { name: "What the run of version 1 did" })
      .getByRole("listitem", { name: "greet-ada" })
      .getByText("Reached")
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // Before it went live, it shows its stage; its builder asks for the
  // newest version to go live, and it then says that version waits.
  await page
    .getByRole("button", { name: `Testing. Change whether ${name} runs` })
    .click();
  await page
    .getByRole("menuitem", { name: "Ask to go live with version 2" })
    .click();
  await expect(page.getByText("Version 2 waits to go live")).toBeVisible(
    pageRead
  );

  // An admin finds it among what needs them, and lets it go live from
  // its page: it is live, and nothing waits any more.
  const decides = await pageOf(admin);
  await decides.goto("/workflows?tab=needs");
  await decides
    .getByRole("region", { name: "Waiting for you to let them go live" })
    .getByRole("link", { name })
    .click();
  await decides.getByRole("button", { name: "Approve and go live" }).click();
  await expect(
    decides.getByRole("button", { name: /^Live since .*\. Change whether/u })
  ).toBeVisible(pageRead);
  await expect(decides.getByText("Version 2 waits to go live")).toBeHidden();
});

test("a builder changes one step on the Flow, saved as the draft's next revision, which the JSON then holds", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowDiagram");
  const page = await pageOf(builder);
  await page.goto("/workflows");
  const name = await create(page);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  // It opens on its Flow; nothing passed yet, so nothing is drawn.
  await expect(page.getByRole("tab", { name: "Flow" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await save(page, routing(name));
  await expect(
    page.getByText("Revision 1 passes the profile and can be published.")
  ).toBeVisible();

  await page.getByRole("tab", { name: "Flow" }).click();
  await page.getByRole("button", { name: "Change step greet-ada" }).click();
  const step = page.getByRole("dialog");
  await expect(step.getByLabel("The step, as JSON")).toHaveValue(
    JSON.stringify({ set: { status: "ada" }, then: "finished" }, null, 2)
  );
  await step
    .getByLabel("The step, as JSON")
    .fill(JSON.stringify({ set: { status: "hi ada" }, then: "finished" }));
  await step.getByRole("button", { name: "Check and save" }).click();
  await expect(step).toBeHidden();
  await expect(page.getByText("Diagram of revision 2")).toBeVisible();

  await definitionOf(page);
  await expect(page.getByLabel("workflow.json")).toHaveValue(/hi ada/u);
  await expect(
    page.getByText("Revision 2 passes the profile and can be published.")
  ).toBeVisible();
});

/** A module whose `total` sums whole numbers, as a calculation. */
const totalModule = `import { compute, v } from "@grasp-os/sdk/compute";

export const total = compute({
  input: v.array(v.number().integer().min(0)).max(100),
  output: v.number().integer().min(0),
  handler: (amounts) => amounts.reduce((all, amount) => all + amount, 0),
});
`;

/** A definition of `name` whose one task calls `local:code/total.ts#total`. */
const totalling = (name: string): string =>
  JSON.stringify(
    {
      ...JSON.parse(definition(name, "unused")),
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
            bindings: {
              total: { kind: "compute", contract: "local:code/total.ts#total" },
            },
          },
        },
      },
      output: {
        schema: {
          format: "json",
          document: {
            type: "object",
            properties: { sum: { type: "number" } },
            required: ["sum"],
            additionalProperties: false,
          },
        },
      },
      do: [
        {
          add: {
            call: "grasp.compute",
            with: { binding: "total", arguments: "${ [1, 2, 3] }" },
          },
        },
        { answer: { set: { sum: "${ . }" } } },
      ],
    },
    null,
    2
  );

test("a builder writes a module beside the definition, calls it through a local binding, and publishes both", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowModules");
  const page = await pageOf(builder);
  await page.goto("/workflows");
  const name = await create(page);
  await expect(page.getByRole("heading", { name })).toBeVisible();

  // Without its module, the binding names nothing the workflow has.
  await save(page, totalling(name));
  await expect(
    page.getByText("Revision 1 doesn't pass yet, and no revision has.")
  ).toBeVisible();

  await page.getByLabel("Path of a new module").fill("code/total.ts");
  await page.getByRole("button", { name: "Add module" }).click();
  await page.getByLabel("code/total.ts", { exact: true }).fill(totalModule);
  await page.getByRole("button", { name: "Check and save" }).click();
  await expect(
    page.getByText("Revision 2 passes the profile and can be published.")
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Publish revision 2" }).click();
  await expect(page.getByText("Published as version 1.")).toBeVisible({
    timeout: 30_000,
  });

  // Read again, the draft carries the module it published.
  await page.reload();
  await expect(page.getByLabel("code/total.ts", { exact: true })).toHaveValue(
    totalModule
  );
});

test("a builder starts a new workflow on an empty Flow with Grasp's chat beside it, says which process it is for, and sees the Flow drawn as the chat's draft passes", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("workflowDrawn");
  const page = await pageOf(builder);
  const [reply] = modelScripts.drawsWorkflow.replies;
  await page.goto("/workflows");
  const name = await create(page);
  const workflow = new URL(page.url()).pathname.split("/").at(-1) ?? "";

  // It opens on its Flow, with nothing drawn yet, and Grasp's chat docked
  // open beside it, asking first which business process it is for.
  await expect(page.getByRole("tab", { name: "Flow" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(
    page.getByText(
      "Nothing is drawn yet. Tell Grasp in the chat how this work runs and its steps come here."
    )
  ).toBeVisible();
  const chat = page.getByRole("region", { name: "Ask Grasp" });
  await expect(
    chat.getByText(
      "Tell me how this work runs today, step by step: who does what, in which app, and how often. I draw it as you go."
    )
  ).toBeVisible();
  const asks = chat.getByRole("region", { name: "Grasp asks" });
  await expect(
    asks.getByText("Which business process is this workflow for?")
  ).toBeVisible();
  await expect(asks.getByRole("radio")).toHaveCount(7);
  await expect(
    asks.getByRole("radio", { name: "Something else" })
  ).toBeVisible();

  // A first step that passes is saved as the chat's agent would save it
  // (`env.workflowBuild.edit`): this script only answers (a script that
  // saves through the agent's tools is workflow-drawn-decides.e2e.ts), so
  // the builder's own session saves it, before the answer the page then
  // follows.
  const { core, api } = apiOf(builder);
  try {
    await api.workflowResources.editDraft(workflow, {
      expectedRevision: 0,
      source: definition(name, "received"),
      modules: {},
    });

    await asks.getByRole("radio", { name: "Purchase-to-Pay" }).click();
    await asks.getByRole("button", { name: "Send" }).click();
    await expect(chat.getByText(reply.text)).toBeVisible({ timeout: 30_000 });

    // The Flow follows the draft as the chat changed it, and the workflow
    // serves the process chosen.
    const diagram = page.getByRole("region", { name: "Diagram", exact: true });
    await expect(diagram.getByRole("listitem", { name: "finish" })).toBeVisible(
      pageRead
    );
    await expect(page.getByText("Diagram of revision 1")).toBeVisible();
    const resource = await api.workflowResources.get(workflow);
    expect(resource.process).toBe("p2p");
  } finally {
    core[Symbol.dispose]();
  }
});
