import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { seedDependencyRequest } from "./dependency-request.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";
import { pileOf, toCard } from "./pile.ts";

// The dashboard, from the nav: what waits on the person; the widget
// board under it, with where their workflows and engines stand, the runs
// this week and what could be better, each block opening in full; and,
// for admins, the latest of the audit trail. Each person lays out their
// own board: widgets taken off, added back and moved stay so over a
// reload, until they put it back as it began. What waits is a pile of
// cards gone through one at a time, and what is settled on its own page
// under it; what fills them is the failed-run, held-write and approval
// journeys' (notifications, chat, activity, screen approval).

/** Counts in one step, and is done. */
const tally = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("tally", { input: z.unknown(), params: {} }, async (step) =>
  await step.do("count", { description: "Count the invoices" }, async () => 3)
);
`;

const tallyTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import tally from "./tally.ts";

export default workflowTests(tally, [
  { name: "counts", mocks: { count: 3 }, expect: {} },
]);
`;

/** Never started here. */
const later = tally.replaceAll('"tally"', '"later"');

const laterTests = tallyTests.replaceAll("tally", "later");

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

test("someone with nothing waiting sees no pile or activity, and a board with nothing on it yet", async ({
  browser,
}) => {
  const { user } = peopleIn("dashboard");
  const page = await pageOf(browser, user);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Dashboard", exact: true })
    .click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboard" })
  ).toBeVisible();
  // A pile nothing is on isn't there at all.
  await expect(page.getByRole("region", { name: "To do" })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Waiting elsewhere" })
  ).toHaveCount(0);
  // The board is there, with nothing on it yet.
  await expect(page.getByRole("region", { name: "Workflows" })).toContainText(
    "No workflows yet.",
    pageRead
  );
  await expect(page.getByRole("region", { name: "Engines" })).toContainText(
    "No engines yet.",
    pageRead
  );
  await expect(
    page.getByRole("region", { name: "Runs this week" })
  ).toContainText("No runs this week.", pageRead);
  await expect(
    page.getByRole("region", { name: "Could be better" })
  ).toContainText("Nothing to make better right now.", pageRead);
  await expect(page.getByRole("region", { name: "Activity" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a builder sees their workflows and engine on the board, and opens them in full", async ({
  browser,
}) => {
  const { builder } = peopleIn("dashboardBoard");
  const name = `Invoices ${crypto.randomUUID()}`;
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({ name }));
    await release(
      api,
      app,
      {
        "workflows/tally.ts": tally,
        "workflows/tally.workflow-tests.ts": tallyTests,
        "workflows/later.ts": later,
        "workflows/later.workflow-tests.ts": laterTests,
      },
      "Invoice counts"
    );
    const run = await api.workflows.start(app, "tally");
    await expect(async () => {
      const { status } = await api.workflows.status(run.id);
      expect(status).toBe("completed");
    }).toPass({ timeout: 30_000 });
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(browser, builder);
  await page.goto("/dashboard");

  // Where the workflows stand: a dot for each, in its state's column.
  const workflows = page.getByRole("region", { name: "Workflows" });
  await expect(
    workflows
      .getByRole("list", { name: "Ran" })
      .getByRole("link", { name: `tally in ${name}` })
  ).toBeVisible(pageRead);
  await expect(
    workflows
      .getByRole("list", { name: "Not run yet" })
      .getByRole("link", { name: `later in ${name}` })
  ).toBeVisible();

  // The engine, with how many of its workflows ran.
  const engines = page.getByRole("region", { name: "Engines" });
  await expect(
    engines.getByRole("listitem").filter({ hasText: name })
  ).toContainText("1 of 2 workflows ran");

  // In full, each engine with its workflows.
  await engines.getByRole("button", { name: "Open Engines in full" }).click();
  let dialog = page.getByRole("dialog", { name: "Engines" });
  await expect(
    dialog.getByRole("region", { name }).getByRole("link", { name: "later" })
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  // The run, completed today, which needed nobody.
  const runs = page.getByRole("region", { name: "Runs this week" });
  await expect(runs).toContainText("100% without a person", pageRead);
  const today = runs
    .getByRole("table", { name: "Runs by the day they started" })
    .getByRole("row")
    .last();
  // Its day, then completed, failed, waiting, and the rest.
  await expect(today.getByRole("cell").nth(1)).toHaveText(/^[1-9]\d*$/u);

  // In full, the month, with each workflow's runs.
  await runs
    .getByRole("button", { name: "Open Runs this week in full" })
    .click();
  dialog = page.getByRole("dialog", { name: "Runs this week" });
  await expect(
    dialog
      .getByRole("region", { name: "By workflow" })
      .getByRole("row")
      .filter({ hasText: name })
  ).toContainText("tally");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  // In full, each state with its workflows, each opening its own page.
  await workflows
    .getByRole("button", { name: "Open Workflows in full" })
    .click();
  dialog = page.getByRole("dialog", { name: "Workflows" });
  const ran = dialog
    .getByRole("region", { name: "Ran" })
    .getByRole("listitem")
    .filter({ hasText: name });
  await expect(ran).toContainText("tally");
  await ran.getByRole("link", { name: "tally" }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${app}/tally$`, "u"));
});

/** The board's widgets, by their titles, in the order they stand. */
const boardTitles = (page: Page) =>
  page.getByRole("heading", {
    level: 2,
    name: /^(?:Workflows|Engines|Runs this week|Could be better)$/u,
  });

test("a person takes a widget off, adds it back and moves it, kept over a reload, and puts the board back as it began", async ({
  browser,
}) => {
  const { user } = peopleIn("dashboardLayout");
  const { core, api } = apiOf(user);
  const saved = async () => {
    const layout = await api.dashboard.layout();
    return layout?.widgets;
  };
  const page = await pageOf(browser, user);
  await page.goto("/dashboard");
  const titles = boardTitles(page);
  const reset = page.getByRole("button", { name: "Back to how it began" });

  // As it begins: every widget, and nothing to put back.
  await expect(titles).toHaveText([
    "Workflows",
    "Engines",
    "Runs this week",
    "Could be better",
  ]);
  await expect(reset).toHaveCount(0);

  // Taken off, it stays off.
  await page
    .getByRole("button", { name: "Remove Engines", exact: true })
    .click();
  await expect(titles).toHaveText([
    "Workflows",
    "Runs this week",
    "Could be better",
  ]);
  await expect.poll(saved).toStrictEqual(["workflows", "runs", "signals"]);
  await page.reload();
  await expect(titles).toHaveText([
    "Workflows",
    "Runs this week",
    "Could be better",
  ]);

  // Added back from the empty card, last; with every widget on the board,
  // the card is gone.
  await page.getByRole("button", { name: "Add a widget" }).click();
  await page
    .getByRole("dialog", { name: "Add a widget" })
    .getByRole("button", { name: "Engines" })
    .click();
  await expect(titles).toHaveText([
    "Workflows",
    "Runs this week",
    "Could be better",
    "Engines",
  ]);
  await expect(page.getByRole("button", { name: "Add a widget" })).toHaveCount(
    0
  );
  await expect
    .poll(saved)
    .toStrictEqual(["workflows", "runs", "signals", "engines"]);

  // Moved a place back with the keys on its grip, which keeps them.
  const grip = page.getByRole("button", { name: "Move Engines", exact: true });
  await grip.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(titles).toHaveText([
    "Workflows",
    "Runs this week",
    "Engines",
    "Could be better",
  ]);
  await expect(grip).toBeFocused();
  await expect
    .poll(saved)
    .toStrictEqual(["workflows", "runs", "engines", "signals"]);
  await page.reload();
  await expect(titles).toHaveText([
    "Workflows",
    "Runs this week",
    "Engines",
    "Could be better",
  ]);

  // Back as it began, over a reload too.
  await reset.click();
  await expect(titles).toHaveText([
    "Workflows",
    "Engines",
    "Runs this week",
    "Could be better",
  ]);
  await expect(reset).toHaveCount(0);
  await expect
    .poll(saved)
    .toStrictEqual(["workflows", "engines", "runs", "signals"]);
  await page.reload();
  await expect(titles).toHaveText([
    "Workflows",
    "Engines",
    "Runs this week",
    "Could be better",
  ]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  core[Symbol.dispose]();
});

test("an admin sees the latest activity, with the way to the audit trail", async ({
  browser,
}) => {
  const { admin } = peopleIn("dashboard");
  const page = await pageOf(browser, admin);
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

test("someone given the permission approves the packages proposed for an engine, and an admin without it isn't asked", async ({
  browser,
}) => {
  const { admin, builder, approver } = peopleIn("dependencyApproval");
  const asAdmin = apiOf(admin);
  const asBuilder = apiOf(builder);
  const { id: app } = await asBuilder.api.apps.create({ name: "Totals" });
  await asAdmin.api.dependencies.grantApprover({
    type: "person",
    userId: approver.userId,
  });
  const origin = "https://registry.npmjs.org";
  const request = await seedDependencyRequest({
    app,
    requestedBy: builder.userId,
    purpose: "Draw the monthly totals as a chart.",
    targets: ["browser"],
    approved: false,
    graph: {
      direct: [{ name: "charts", version: "3.1.0" }],
      packages: [
        {
          name: "charts",
          version: "3.1.0",
          origin,
          integrity: `sha512-${"A".repeat(86)}==`,
          license: "MIT",
          dependencies: [{ name: "d3-scale", version: "4.0.2" }],
          peers: [],
        },
        {
          name: "d3-scale",
          version: "4.0.2",
          origin,
          integrity: `sha512-${"B".repeat(86)}==`,
          license: "ISC",
          dependencies: [],
          peers: [],
        },
      ],
      platformPeers: {},
    },
  });
  // A second request, so the pile has more than one card to go through.
  const { id: other } = await asBuilder.api.apps.create({ name: "Ledger" });
  await seedDependencyRequest({
    app: other,
    requestedBy: builder.userId,
    purpose: "Format the ledger's amounts.",
    targets: ["browser"],
    approved: false,
    graph: {
      direct: [{ name: "money", version: "1.0.0" }],
      packages: [
        {
          name: "money",
          version: "1.0.0",
          origin,
          integrity: `sha512-${"C".repeat(86)}==`,
          license: "MIT",
          dependencies: [],
          peers: [],
        },
      ],
      platformPeers: {},
    },
  });

  // An admin manages who approves, and is asked nothing without it.
  const adminPage = await pageOf(browser, admin);
  await adminPage.goto("/dashboard");
  await expect(
    adminPage.getByRole("heading", { level: 1, name: "Dashboard" })
  ).toBeVisible();
  await expect(
    adminPage.getByRole("article", { name: "Packages for Totals" })
  ).toHaveCount(0);

  const page = await pageOf(browser, approver);
  await page.goto("/dashboard");
  let card = await toCard(page, "Packages for Totals");
  // Skipped, it goes to the back of the pile, and is still there to do.
  const pile = pileOf(page);
  await pile.getByRole("button", { name: "Skip" }).click();
  await expect(card).toHaveCount(0);
  card = await toCard(page, "Packages for Totals");
  await expect(pile.getByText(/^\d+ of \d+$/u)).toHaveText(
    /^(?<count>\d+) of \k<count>$/u
  );
  // The arrow keys go to the card before and after, round the pile.
  await card
    .getByRole("button", { name: "Show the packages for Totals" })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(card).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await expect(card).toBeVisible();

  await expect(
    card.getByText("Draw the monthly totals as a chart.")
  ).toBeVisible();
  // What it asks for, by name, and that Grasp resolved it from the registry.
  await expect(card.getByText("charts@3.1.0", { exact: true })).toBeVisible();
  await expect(
    card.getByText("2 packages in all, to run in: Browser")
  ).toBeVisible();
  await expect(
    card.getByText(/resolved these packages from the npm registry/u)
  ).toBeVisible();
  // Approving waits for the whole graph to be shown; rejecting doesn't.
  const approveButton = card.getByRole("button", {
    name: "Approve the packages for Totals",
  });
  await expect(approveButton).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "Reject the packages for Totals" })
  ).toBeEnabled();
  await card
    .getByRole("button", { name: "Show the packages for Totals" })
    .click();
  // The whole graph: what the direct package brings, too.
  await expect(
    card.getByRole("row").filter({ hasText: "ISC" }).getByRole("cell").first()
  ).toHaveText("d3-scale@4.0.2");
  await approveButton.click();

  await expect(card).toHaveCount(0);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Approved: Packages for Totals." })
  ).toHaveCount(1);
  await expect
    .poll(async () => {
      const { approved } = await asBuilder.api.dependencies.status(app);
      return approved?.id;
    })
    .toBe(request.id);
  asAdmin.core[Symbol.dispose]();
  asBuilder.core[Symbol.dispose]();
});
