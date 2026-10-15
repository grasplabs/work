import { execFileSync } from "node:child_process";
import path from "node:path";

import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";
import { stateDir } from "./stack.ts";

/** The checkout this stack runs from. */
const repoRoot = path.join(import.meta.dirname, "..");

// The Workflows page, end to end: a builder finds their App's workflows
// with a waiting run, finds that run at the top of Runs and follows it to
// where it is decided; then opens a workflow, reads its steps, changes a
// parameter and tests it with the new value. Someone the App is shared
// with as a user reads its steps without their code, with no parameters,
// Test or decision to offer them; where their App's workflows can't be
// read, the Runs tab's Workflow filter says so.

/** Waits for one decision, asked of the reviewer the parameter names. */
const approval = `import { person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "approval",
  { input: z.unknown(), params: { reviewer: person({ label: "Reviewer", default: "role:admin" }) } },
  async (step, { params }) =>
    await step.decision("review", {
      description: "Approve invoice INV-7",
      from: params.reviewer,
      ask: async () => {},
      timeout: "7 days",
    })
);
`;

const approvalTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import approval from "./approval.ts";

export default workflowTests(approval, [
  { name: "ends with the answer", decisions: { review: { approved: true, by: "anna" } }, expect: {} },
]);
`;

/**
 * Reads an invoice's total with a model, through its App's `reader`
 * binding, asks a reviewer above a limit, and books it. Its runs here are
 * Tests, which mock the model step, so no binding is approved.
 */
const approve = `import { money, person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "approve",
  {
    input: z.object({ text: z.string() }),
    params: {
      limit: money({ label: "Review invoices above", currency: "EUR", default: 500_000, sensitive: true }),
      reviewer: person({ label: "Reviewer", default: "role:admin" }),
    },
  },
  async (step, { input, params }) => {
    const extracted = await step.llm("extract", {
      description: "Read the invoice's total",
      binding: "reader",
      instructions: "Read the total in cents.",
      input: input.text,
      schema: z.object({ total: z.int() }),
    });
    if (extracted.total > params.limit) {
      await step.decision("review", {
        description: "Ask the reviewer to approve it",
        from: params.reviewer,
        ask: async () => {},
        timeout: "7 days",
      });
    }
    return await step.do(
      "book",
      { description: "Book the invoice", sideEffect: true, input: { total: extracted.total } },
      async () => "booked"
    );
  }
);
`;

const approveTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import approve from "./approve.ts";

export default workflowTests(approve, [
  {
    name: "books a large invoice once approved",
    input: { text: "Total €8,000" },
    mocks: { extract: { total: 800_000 } },
    decisions: { review: { approved: true, by: "anna" } },
    expect: {},
  },
]);
`;

/**
 * How long a page may take to show what core said: it reads core within
 * a few seconds a read (apps/web/src/core.ts), and a Test builds and runs
 * the workflow's tests first.
 */
const pageRead = { timeout: 20_000 };

/** Runs `run` with `person`'s API over `/rpc`, closed after. */
const withApi = async <T>(
  person: Person,
  run: (api: ReturnType<typeof apiOf>["api"]) => Promise<T>
): Promise<T> => {
  const { core, api } = apiOf(person);
  try {
    return await run(api);
  } finally {
    core[Symbol.dispose]();
  }
};

/**
 * A new App of `builder`'s, shared with `user`, with a run of `approval`
 * waiting for its decision, asked of `builder` alone: every admin would
 * be too many in a local database that keeps earlier runs' people.
 */
const appWithWaitingRun = async (
  builder: Person,
  user: Person,
  name: string
): Promise<string> =>
  await withApi(builder, async (api) => {
    const { id } = await api.apps.create({ name });
    await release(
      api,
      id,
      {
        "workflows/approval.ts": approval,
        "workflows/approval.workflow-tests.ts": approvalTests,
        "workflows/approve.ts": approve,
        "workflows/approve.workflow-tests.ts": approveTests,
      },
      "Invoice approvals"
    );
    await api.apps.members.add(id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await api.workflows.params.set(
      id,
      "approval",
      "reviewer",
      `person:${builder.userId}`
    );
    const run = await api.workflows.start(id, "approval");
    await expect(async () => {
      const waiting = await api.workflows.runs({ app: id, status: "waiting" });
      expect(waiting.runs.map(({ id: runId }) => runId)).toStrictEqual([
        run.id,
      ]);
    }).toPass({ timeout: 30_000 });
    return id;
  });

test("a builder follows a waiting run to its decision, then changes and tests a workflow", async ({
  browser,
}) => {
  const { builder, user } = peopleIn("workflows");
  const name = `Invoices ${crypto.randomUUID()}`;
  const app = await appWithWaitingRun(builder, user, name);

  const page = await pageOf(browser, builder);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Workflows" })
    .click();
  const rows = page.getByRole("row").filter({ hasText: name });
  await expect(rows).toHaveCount(2, pageRead);
  // Its row: the workflow, its App and version, and where it stands, with
  // the run waiting for a decision a link to it.
  const row = rows.first();
  await expect(
    row.getByRole("link", { name: "approval", exact: true })
  ).toBeVisible();
  await expect(row).toContainText(name);
  await expect(row).toContainText("Version 1");
  await expect(row).toContainText("Waiting for a decision");
  await expect(
    row.getByRole("link", { name: "1 waiting run of approval" })
  ).toBeVisible();
  // It has run, so it is at work; its line begins with its engine, which opens it.
  await expect(page.getByRole("heading", { name: "At work" })).toBeVisible();
  await expect(
    row.getByRole("link", { name: `Open the engine ${name}` })
  ).toHaveAttribute("href", `/engines/${app}`);
  // A run waits for a decision: it needs attention.
  await page.getByRole("tab", { name: "Needs attention" }).click();
  await expect(page).toHaveURL(/tab=needs/u);
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: name })
      .getByRole("link", { name: "approval", exact: true })
  ).toBeVisible();

  // The waiting run comes first on the Runs tab, with where to decide it.
  await page.getByRole("tab", { name: "Runs" }).click();
  const first = page.getByRole("row").nth(1);
  await expect(first).toContainText("Waiting for a decision", pageRead);
  await first.getByRole("link", { name: "Decide" }).click();
  await expect(
    page.getByRole("heading", { name: "Approve invoice INV-7" })
  ).toBeVisible(pageRead);

  // The workflow view: its steps, a parameter changed, and a Test with it.
  await page.goto(`/workflows/${app}/approve`);
  await expect(
    page.getByRole("heading", { level: 1, name: "approve" })
  ).toBeVisible(pageRead);
  const steps = page.getByRole("tabpanel");
  await expect(steps.getByText("Read the invoice's total")).toBeVisible();
  // Who does each step: an agent where a model answers, a person where it
  // waits for a decision.
  await expect(steps.getByText("Agent", { exact: true })).toBeVisible();
  await expect(steps.getByText("Person", { exact: true })).toBeVisible();
  await expect(
    steps.getByText("If extracted.total > params.limit:")
  ).toBeVisible();

  await page.getByRole("tab", { name: "Parameters" }).click();
  const limit = page.getByRole("textbox", { name: "Review invoices above" });
  await expect(limit).toHaveValue("5000");
  const saveLimit = page
    .getByRole("form", { name: "Review invoices above" })
    .getByRole("button", { name: "Save" });
  // More decimals than euros have: refused, not rounded.
  await limit.fill("1.005");
  await expect(
    page.getByText("An amount in EUR has at most 2 decimals.")
  ).toBeVisible();
  await expect(saveLimit).toBeDisabled();
  await limit.fill("10000");
  await page
    .getByRole("form", { name: "Review invoices above" })
    .getByRole("button", { name: "Save" })
    .click();
  await expect(page.getByRole("status")).toHaveText("Saved.", pageRead);
  await withApi(builder, async (api) => {
    const params = await api.workflows.params.list(app, "approve");
    expect(params.find(({ name: param }) => param === "limit")?.value).toBe(
      1_000_000
    );
  });
  // Another tab and back: the field shows what was saved, with nothing
  // left to save.
  await page.getByRole("tab", { name: "Steps" }).click();
  await page.getByRole("tab", { name: "Parameters" }).click();
  await expect(limit).toHaveValue("10000");
  await expect(
    page
      .getByRole("form", { name: "Review invoices above" })
      .getByRole("button", { name: "Save" })
  ).toBeDisabled();

  await page.getByRole("button", { name: "Test" }).click();
  const dialog = page.getByRole("dialog", { name: "Test of approve" });
  const report = dialog.getByText(/^Dry run of approve/u);
  await expect(report).toBeVisible(pageRead);
  // Above the invoice's total now: nobody is asked, and it books.
  await expect(report).toContainText('- book {"total":800000}');
  await expect(report).not.toContainText("review#ask");
});

test("someone an App is shared with reads its workflow, with nothing to change or test", async ({
  browser,
}) => {
  const { builder, user } = peopleIn("workflows");
  const name = `Invoices ${crypto.randomUUID()}`;
  const app = await appWithWaitingRun(builder, user, name);

  const page = await pageOf(browser, user);
  // Core refuses the App's contents, as for an App it doesn't have: the
  // Runs tab's Workflow filter can't offer its workflows.
  await page.routeWebSocket("**/rpc", (socket) => {
    const toCore = socket.connectToServer();
    socket.onMessage((message) => {
      const text = String(message);
      toCore.send(
        text.includes('"contents"') ? text.replaceAll(app, "missing") : text
      );
    });
  });
  await page.goto(`/workflows/${app}/approve`);
  await expect(
    page.getByRole("heading", { level: 1, name: "approve" })
  ).toBeVisible(pageRead);
  await expect(page.getByText("Read the invoice's total")).toBeVisible();
  // The steps without their code: no condition, only that there is one.
  await expect(page.getByText("Only when a condition holds:")).toBeVisible();
  await expect(page.getByText("params.limit")).toHaveCount(0);
  // What starts it is shown to anyone with a role in the App, as its runs are.
  await expect(page.getByRole("tab")).toHaveText([
    "Steps",
    "Triggers",
    /^Runs/u,
  ]);
  await expect(page.getByRole("button", { name: "Test" })).toHaveCount(0);

  // The run waits for the builder's answer, not theirs: no link to decide.
  await page.goto(`/workflows?tab=runs&app=${app}`);
  const first = page.getByRole("row").nth(1);
  await expect(first).toContainText("Waiting for a decision", pageRead);
  await expect(first.getByRole("link", { name: "Decide" })).toHaveCount(0);
  // The App's workflows couldn't be read: the filter says so, and its runs
  // are listed all the same.
  await expect(
    page.getByText("Couldn't load this engine's workflows.")
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Workflow" })).toBeDisabled();
});

/** A workflow whose runs sleep a day: a run that goes on, with no decision. */
const idle = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("idle", { params: {}, input: z.unknown() }, async (step) => {
  await step.sleep("idle", { description: "Wait", duration: "1 day" });
  return 1;
});
`;

const idleTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import idle from "./idle.ts";

export default workflowTests(idle, [{ name: "waits, then ends", mocks: {}, expect: {} }]);
`;

/** Core's IDs: none of them is SQL. */
const plainId = /^[\w-]+$/u;

/**
 * Runs `statement` on the stack's core database, as the running core
 * keeps it: the test sets a run's place in the admission queue directly,
 * as a step waiting for a share would.
 */
const coreSql = (statement: string): void => {
  execFileSync(
    path.join(repoRoot, "node_modules/.bin/wrangler"),
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "-c",
      "wrangler.jsonc",
      "--persist-to",
      stateDir,
      "--command",
      statement,
    ],
    { cwd: path.join(repoRoot, "apps/core"), stdio: "pipe" }
  );
};

test("a run waiting for a share of its App's runs reads as queued, with when it tries again, not failed or running", async ({
  browser,
}) => {
  const { builder } = peopleIn("workflows");
  const name = `Reminders ${crypto.randomUUID()}`;
  const { app, run } = await withApi(builder, async (api) => {
    const { id } = await api.apps.create({ name });
    await release(
      api,
      id,
      {
        "workflows/idle.ts": idle,
        "workflows/idle.workflow-tests.ts": idleTests,
      },
      "Reminders"
    );
    const started = await api.workflows.start(id, "idle");
    return { app: id, run: started.id };
  });
  expect(app).toMatch(plainId);
  expect(run).toMatch(plainId);
  expect(builder.userId).toMatch(plainId);
  // Its step waits for its App's share, and asks again in ten minutes at
  // the latest. A place stays live a minute and a half after its step
  // asked: this one asked "now" a minute from now, room for pages to load.
  const asked = Date.now() + 60_000;
  const retryAt = Date.now() + 10 * 60_000;
  coreSql(
    `INSERT INTO workflow_admission_queue (run_id, step_hash, subject, resource, enqueued_at, seen_at, waiting_for, retry_at, turn, attempt_deadline) VALUES ('${run}', 'e2e-step', '${builder.userId}', '${app}', ${asked}, ${asked}, 'app', ${retryAt}, 0, ${retryAt})`
  );
  const page = await pageOf(browser, builder);
  try {
    // The Runs tab: queued, with the share and when it tries again.
    await page.goto(`/workflows?tab=runs&app=${app}`);
    const row = page.getByRole("row").nth(1);
    await expect(row).toContainText("Queued", pageRead);
    await expect(row).toContainText(
      "Waiting for a share of this App's runs; tries again by"
    );
    await expect(row).not.toContainText("Failed");
    await expect(row).not.toContainText("Running");
    // Its own page says the same, where the engine has it sleeping.
    await page.goto(`/workflows/${app}/idle/runs/${run}`);
    // Its heading and status, above its history.
    const header = page
      .getByRole("heading", { name: "Run of idle" })
      .locator("xpath=..");
    await expect(header).toContainText("Queued", pageRead);
    await expect(header).toContainText(
      "Waiting for a share of this App's runs; tries again by"
    );
    await expect(header).not.toContainText("Waiting for a decision");
    await expect(header).not.toContainText("Failed");
    await expect(header).not.toContainText("Running");
  } finally {
    coreSql(`DELETE FROM workflow_admission_queue WHERE run_id = '${run}'`);
    await withApi(builder, async (api) => {
      await api.workflows.cancel(run);
    });
  }
});
