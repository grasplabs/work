import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// The dashboard, from the nav: what waits on the person; the widget
// board under it, with the prototype's return, goals, teams and
// workflows, then the Apps, the runs this week and what could be better,
// each block opening in full; and,
// for admins, the latest of the audit trail. Each person lays out their
// own board: widgets taken off, added back and moved stay so over a
// reload, until they put it back as it began. Without a plan for the
// interviews there is no programme week and no weekly report: those, with
// a plan, are in e2e/onboarding.e2e.ts, which runs after this file, as a
// plan can't be taken back. What waits is a pile of
// cards gone through one at a time, and what is settled on its own page
// under it; what fills them is the held-write and approval journeys'
// (chat, activity, page approval).

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

/** A value's schema: an object of exactly `fields`, each required. */
const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** An independent workflow that is done at once, its status counted. */
const countingDefinition = (): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: "counted" },
    steps: [],
  });

test("a builder sees their workflows on the board, and opens them in full", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("dashboardBoard");
  const tag = crypto.randomUUID().slice(0, 8);
  const { core, api } = apiOf(builder);
  let made: { id: string; name: string }[] = [];
  try {
    made = await Promise.all(
      [`tally-${tag}`, `later-${tag}`].map(async (name) => {
        const workflow = await api.workflowResources.create(name);
        // A new workflow's draft is at revision 0: written, then published.
        await api.drafts.write({ kind: "workflow", id: workflow.id }, 0, {
          "workflow.json": countingDefinition(),
        });
        await api.drafts.publish({ kind: "workflow", id: workflow.id }, 1);
        return { id: workflow.id, name: workflow.name };
      })
    );
    const [counted] = made;
    if (counted === undefined) {
      throw new Error("No workflow was made");
    }
    const { runId } = await api.workflowResources.start(counted.id, {
      args: { who: "Ada" },
      key: `count-${tag}`,
    });
    await expect(async () => {
      // Awaited first: `expect` would probe the RPC promise's stub itself.
      const run = await api.workflowResources.run(counted.id, runId ?? "");
      expect(run.status).toBe("completed");
    }).toPass({ timeout: 30_000 });
  } finally {
    core[Symbol.dispose]();
  }
  const [tally, later] = made;
  if (tally === undefined || later === undefined) {
    throw new Error("Expected two workflows");
  }

  const page = await pageOf(builder);
  await page.goto("/dashboard");

  // Where the workflows stand: a dot for each, in its state's column.
  const workflows = page.getByRole("region", { name: "Workflows" });
  await expect(
    workflows
      .getByRole("list", { name: "Ran" })
      .getByRole("link", { name: tally.name })
  ).toBeVisible(pageRead);
  await expect(
    workflows
      .getByRole("list", { name: "Not run yet" })
      .getByRole("link", { name: later.name })
  ).toBeVisible();

  // The run, completed today, which needed nobody.
  const runs = page.getByRole("region", { name: "Runs this week" });
  await expect(runs).toContainText("100% without a person", pageRead);

  // In full, the month, with each workflow's runs.
  await runs.getByRole("button", { name: "Open in full" }).click();
  let dialog = page.getByRole("dialog", { name: "Runs this week" });
  await expect(
    dialog
      .getByRole("region", { name: "By workflow" })
      .getByRole("row")
      .filter({ hasText: tally.name })
  ).toContainText("1");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  // In full, each state with its workflows, each opening its own page.
  await workflows.getByRole("button", { name: "Open in full" }).click();
  dialog = page.getByRole("dialog", { name: "Workflows" });
  await dialog
    .getByRole("list", { name: "Ran" })
    .getByRole("link", { name: tally.name })
    .click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${tally.id}$`, "u"));
});

/** The board's widgets, by their titles, in the order they stand. */
const boardTitles = (page: Page) =>
  page.getByRole("heading", {
    level: 2,
    name: /^(?:Return a month|Board goals|Workflows|Apps|Runs this week|Could be better)$/u,
  });

test("a person with nothing waiting finds an empty board, takes a widget off, adds it back and moves it, kept over a reload, puts the board back as it began, and finds nothing in their inbox", async ({
  pageOf,
}) => {
  const { user } = peopleIn("dashboardLayout");
  const { core, api } = apiOf(user);
  const saved = async () => {
    const layout = await api.dashboard.layout();
    return layout?.widgets;
  };
  const page = await pageOf(user);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Dashboard", exact: true })
    .click();
  const titles = boardTitles(page);
  const reset = page.getByRole("button", { name: "Back to how it began" });

  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" })
  ).toBeVisible();
  // No plan for the interviews yet: no programme week, and no report.
  await expect(
    page.getByText(
      "What waits on you, each with its next step, and what could be better."
    )
  ).toBeVisible();
  await expect(page.getByText(/^Week \d/u)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export report" })).toHaveCount(
    0
  );
  // A pile nothing is on isn't there at all.
  await expect(page.getByRole("region", { name: "To do" })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Waiting elsewhere" })
  ).toHaveCount(0);
  // The board is there, with nothing of theirs on it yet: core counts no
  // hours, and there are no workflows in their columns. The board's goals
  // are the company's: another journey's may be on it
  // (e2e/board-goals.e2e.ts).
  await expect(
    page.getByRole("region", { name: "Return a month" })
  ).toContainText("No workflow with counted hours here yet.");
  const workflows = page.getByRole("region", { name: "Workflows" });
  await expect(workflows.getByRole("list", { name: "Ran" })).toBeAttached(
    pageRead
  );
  await expect(workflows.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Apps" })).toContainText(
    "No Apps yet.",
    pageRead
  );
  await expect(
    page.getByRole("region", { name: "Runs this week" })
  ).toContainText("No runs this week.", pageRead);
  await expect(
    page.getByRole("region", { name: "Could be better" })
  ).toContainText("Nothing to make better right now.", pageRead);
  await expect(page.getByRole("region", { name: "Activity" })).toHaveCount(0);
  // What the models cost is for admins only.
  await expect(
    page.getByRole("region", { name: "AI spend this month" })
  ).toHaveCount(0);

  // As it begins: every widget, and nothing to put back.
  const begun = [
    "Return a month",
    "Board goals",
    "Workflows",
    "Apps",
    "Runs this week",
    "Could be better",
  ];
  await expect(titles).toHaveText(begun);
  await expect(reset).toHaveCount(0);
  // The empty card is always there, last, to ask Grasp for a widget; with
  // every one of Grasp's own on the board there is none to put back.
  const add = page.getByRole("button", { name: "Add a widget" });
  await add.click();
  const card = page.getByRole("dialog", { name: "Add a widget" });
  await expect(
    card.getByRole("textbox", { name: "Ask Grasp for a widget" })
  ).toBeVisible();
  await expect(card.getByText("Put one back")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Taken off, it stays off.
  await page
    .getByRole("region", { name: "Apps" })
    .getByRole("button", { name: "Take off the dashboard" })
    .click();
  const without = begun.filter((title) => title !== "Apps");
  await expect(titles).toHaveText(without);
  await expect
    .poll(saved)
    .toStrictEqual(["return", "goals", "workflows", "runs", "signals"]);
  await page.reload();
  await expect(titles).toHaveText(without);

  // Added back from the empty card, last.
  await add.click();
  await page
    .getByRole("dialog", { name: "Add a widget" })
    .getByRole("button", { name: "Apps" })
    .click();
  await expect(titles).toHaveText([...without, "Apps"]);
  await expect
    .poll(saved)
    .toStrictEqual(["return", "goals", "workflows", "runs", "signals", "apps"]);

  // Moved a place back with the keys on its grip, which keeps them.
  const grip = page.getByRole("button", {
    name: "Move Apps: drag it, or use the arrow keys",
    exact: true,
  });
  // Once the card has closed and given the focus back to what opened it,
  // which would otherwise take it off the grip.
  await expect(page.getByRole("dialog", { name: "Add a widget" })).toHaveCount(
    0
  );
  await grip.focus();
  await expect(grip).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  const moved = [
    "Return a month",
    "Board goals",
    "Workflows",
    "Runs this week",
    "Apps",
    "Could be better",
  ];
  await expect(titles).toHaveText(moved);
  await expect(grip).toBeFocused();
  await expect
    .poll(saved)
    .toStrictEqual(["return", "goals", "workflows", "runs", "apps", "signals"]);
  await page.reload();
  await expect(titles).toHaveText(moved);

  // Back as it began, over a reload too.
  await reset.click();
  await expect(titles).toHaveText(begun);
  await expect(reset).toHaveCount(0);
  await expect
    .poll(saved)
    .toStrictEqual(["return", "goals", "workflows", "apps", "runs", "signals"]);
  await page.reload();
  await expect(titles).toHaveText(begun);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Their inbox: nothing waits, nothing was dealt with, and the audit
  // trail is for admins.
  await page.goto("/inbox");
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Inbox")
  ).toBeVisible(pageRead);
  await expect(page.getByRole("tab", { name: /^To do/u })).toHaveText(
    /^To do\s*0$/u
  );
  await expect(
    page
      .getByRole("region", { name: "What waits on you" })
      .getByText("Nothing waits on you.")
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveCount(0);
  await page.getByRole("tab", { name: /^Done/u }).click();
  await expect(page.getByText(/^Nothing dealt with yet\./u)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  core[Symbol.dispose]();
});

test("an admin sees what the models cost this month, with the way to AI spend in Settings", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("dashboard");
  const page = await pageOf(admin);
  await page.goto("/dashboard");

  // Other tests' calls count too, so the amount isn't pinned.
  const spend = page.getByRole("region", { name: "AI spend this month" });
  await expect(spend).toContainText(
    "for every model call this month",
    pageRead
  );
  await spend.getByRole("link", { name: "AI spend in Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/spend$/u);
});

test("an admin sees the latest activity, with the way to the audit trail", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("dashboard");
  const page = await pageOf(admin);
  await page.goto("/dashboard");

  const activity = page.getByRole("region", { name: "Activity" });
  // The trail records the roles the setup gave the cast, at least.
  await expect(
    activity
      .getByRole("list", { name: "Latest activity" })
      .getByRole("listitem")
  ).not.toHaveCount(0);
  await activity.getByRole("link", { name: "The full audit trail" }).click();
  await expect(page).toHaveURL(/\/settings\/audit$/u);
});
