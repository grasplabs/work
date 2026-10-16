import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn, release, signInTo } from "./people.ts";
import type { Person } from "./people.ts";

// A decision a workflow run waits for, answered from the link its ask
// sent: the person it was sent to opens it, signs in, approves, and
// confirms that answer in Grasp's dialog (cancelling first records
// nothing), and the run goes on with their answer. Anyone else who opens the same link
// only sees that it isn't for them.

/**
 * Keeps each ask's recipients, as a workflow that mails them would, in the
 * App's store: its `remember` mutation, and a screen that shows the last
 * ones kept.
 */
const schema = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ asks: defineTable({ recipients: v.string().max(16_000) }) });
`;

const operations = `import { v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

export const remember = mutation({
  args: { recipients: v.string().max(16_000) },
  returns: v.id("asks"),
  handler: async (ctx, args) => await ctx.db.insert("asks", args),
});

/** The recipients the last ask kept, as JSON text: "[]" before any. */
export const recipients = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => (await ctx.db.query("asks").take(100)).at(-1)?.recipients ?? "[]",
});
`;

const registration = `import { app } from "@grasp-os/sdk";
import { recipients, remember } from "./operations/asks.ts";
import schema from "./schema.ts";

export default app({
  name: "Approvals",
  schema,
  access: { tables: { asks: { read: "appMembers", write: "appMembers" } } },
  operations: { asks: { remember, recipients } },
  internalOperations: {},
  screens: [{ name: "asks", path: "/", source: "screens/asks.tsx" }],
  uses: [],
});
`;

const screen = `import { useQuery } from "@grasp-os/sdk/react";
import { api } from "#grasp";

export default function Asks() {
  const recipients = useQuery(api.asks.recipients, {});
  return (
    <main className="p-4">
      <h1>Asks</h1>
      <output aria-label="Recipients">{recipients ?? ""}</output>
    </main>
  );
}
`;

const approval = `import { workflow, z } from "@grasp-os/sdk/workflow";

/** The App's \`remember\`, as the ask names it. */
const remember = { contractId: "asks.remember", kind: "mutation" } as const;

export default workflow(
  "approval",
  { params: {}, input: z.object({ from: z.string() }) },
  async (step, { input, env }) =>
    await step.decision("review", {
      description: "Approve invoice INV-7",
      from: input.from,
      ask: async ({ recipients }) => {
        const kept = await env.APP.callFunction(remember, { recipients: JSON.stringify(recipients) });
        if (!kept.ok) {
          throw kept.error;
        }
      },
      timeout: "7 days",
    })
);
`;

const approvalTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import approval from "./approval.ts";

export default workflowTests(approval, [
  {
    name: "ends with the answer",
    input: { from: "role:admin" },
    decisions: { review: { approved: true, by: "anna" } },
    expect: { output: { timedOut: false, approved: true, by: "anna", payload: null } },
  },
]);
`;

/**
 * How long a decision page may take to show what core said. It reads core
 * up to twice first (who is signed in, then the decision), each read
 * within 5 seconds of its own (apps/web/src/core.ts), so the default
 * 5-second wait is shorter than the page's. An answer, on a connection
 * opened for it, gets the same room.
 */
const pageRead = { timeout: 15_000 };

/** The first recipient's link, from what the App kept. */
const linkIn = (recipients: unknown): string => {
  const first: unknown = Array.isArray(recipients) ? recipients.at(0) : null;
  return typeof first === "object" &&
    first !== null &&
    "link" in first &&
    typeof first.link === "string"
    ? first.link
    : "";
};

/**
 * Starts a run that asks `decider`; returns it and the link they got, read
 * on the App's screen as `builder` sees it on `page`.
 */
const askedFor = async (builder: Person, decider: Person, page: Page) => {
  const { core, api } = apiOf(builder);
  try {
    const { id: app } = await api.apps.create({ name: "Approvals" });
    await release(
      api,
      app,
      {
        "schema.ts": schema,
        "operations/asks.ts": operations,
        "app.ts": registration,
        "screens/asks.tsx": screen,
        "workflows/approval.ts": approval,
        "workflows/approval.workflow-tests.ts": approvalTests,
      },
      "Approvals"
    );
    const run = await api.workflows.start(app, "approval", {
      from: `person:${decider.userId}`,
    });
    await page.goto(`/domains/${app}/apps/asks/full`);
    const kept = page
      .frameLocator('iframe[title="asks app"]')
      .getByRole("status", { name: "Recipients" });
    // The screen follows the query live: the ask's write reaches it.
    await expect(kept).toHaveText(/\/decisions\//u, { timeout: 30_000 });
    const link = linkIn(JSON.parse((await kept.textContent()) ?? "[]"));
    expect(link).toMatch(/\/decisions\/[^?]+$/u);
    const { pathname, search } = new URL(link);
    return { run: run.id, link: `${pathname}${search}` };
  } finally {
    core[Symbol.dispose]();
  }
};

test("the person a decision link was sent to approves it, and the run goes on", async ({
  newContext,
  pageOf,
}) => {
  const { builder, decider, other } = peopleIn("decisionAnswered");
  const { run, link } = await askedFor(builder, decider, await pageOf(builder));

  const forwarded = await pageOf(other);
  await forwarded.goto(link);
  await expect(
    forwarded.getByText("This decision is for someone else to answer.")
  ).toBeVisible(pageRead);

  // Opened signed out, the link only asks them to sign in. The local stack
  // has no IdP, so signing in is the session it leaves, and the browser
  // comes back to the same link.
  const context = await newContext();
  const page = await context.newPage();
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "Sign in to answer" })
  ).toBeVisible(pageRead);
  await signInTo(context, decider);
  await page.clock.install();
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "Approve invoice INV-7" })
  ).toBeVisible(pageRead);
  // From here time passes only when the test moves it, so Confirm's wait
  // is seen whatever the machine's speed. Stopped a little ahead, as a
  // clock stops only at a time to come.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 2000));
  const confirmButton = page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm" });
  await page.getByLabel("Comment (optional)").fill("Matches the PO");
  await page.getByRole("button", { name: "Approve" }).click();
  // Grasp asks to confirm exactly what is answered, to exactly what is
  // asked; cancelled, nothing is recorded and the comment stays.
  const confirmation = page.getByRole("alertdialog", {
    name: "Confirm your approval",
  });
  await expect(confirmation).toBeVisible(pageRead);
  // Confirm waits a moment, so a click already on its way confirms nothing.
  await expect(confirmButton).toBeDisabled();
  await page.clock.runFor(1000);
  await expect(confirmButton).toBeEnabled();
  await expect(confirmation).toContainText("Approve invoice INV-7");
  await expect(confirmation).toContainText("CommentMatches the PO");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  // The dialog's closing animation runs on the stopped clock too.
  await page.clock.runFor(1000);
  await expect(confirmation).toBeHidden();
  await expect(page.getByLabel("Comment (optional)")).toHaveValue(
    "Matches the PO"
  );
  await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(confirmation).toBeVisible(pageRead);
  // Opened again, it waits again.
  await expect(confirmButton).toBeDisabled();
  await page.clock.runFor(1000);
  await expect(confirmButton).toBeEnabled();
  await page.clock.resume();
  await confirmButton.click();
  await expect(page.getByRole("status")).toHaveText(
    /^Approved by Person on /u,
    pageRead
  );

  const { core, api } = apiOf(builder);
  try {
    await expect(async () => {
      // Awaited first: `expect` would probe the RPC promise's stub itself.
      const status = await api.workflows.status(run);
      expect(status).toMatchObject({
        status: "completed",
        output: {
          timedOut: false,
          approved: true,
          by: decider.userId,
          payload: { comment: "Matches the PO" },
        },
      });
    }).toPass({ timeout: 30_000 });
  } finally {
    core[Symbol.dispose]();
  }
});

test("says core can't be reached when a decision never loads", async ({
  pageOf,
}) => {
  const { decider } = peopleIn("decisionUnreachable");
  const page = await pageOf(decider);
  const gate = await callGate(page, '["decisions","get"]');
  gate.hold();
  await page.goto(`/decisions/${crypto.randomUUID()}`);
  await expect(
    page.getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible(pageRead);
  expect(gate.stalled()).toBe(1);
});
