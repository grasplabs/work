import { createHash } from "node:crypto";

import { canonicalJson } from "@grasp-os/shared/json";
import { expect } from "@playwright/test";

import { execute, quoted } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";
import { toCard } from "./pile.ts";

// A run's change whose answer was lost, so nobody can tell whether it took
// effect: its person finds it on their dashboard, beside what else waits on
// them, reads what was sent, says it happened, and the run goes on and
// completes without sending it again. The run's page says why it waited.
// The local stack reaches no Microsoft 365, so the lost answer is written
// into connect's local database as a lost send leaves it, under the run's
// step's key, while the run sleeps before that step; connect then answers
// the step's call as for any lost answer, and the run waits on its person.
// What connect and core do with it (who may resolve it, what each choice
// does) is their tests' (apps/connect/test/unknown-outcomes.test.ts,
// apps/core/test/unknown-outcome-runs.test.ts).

const mail = {
  mailbox: "invoices@acme.test",
  subject: "Payment of invoice INV-7",
  body: "Paid today.",
  to: ["billing@northwind.example.org"],
};

/**
 * Sleeps, so the test can lose its send's answer first, then sends the
 * mail under its step's key; said to have happened, the send answers
 * `connect.resolved_done`, and the step says so.
 */
const mailer = `import { resolvedDone, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("mailer", { params: {}, input: z.unknown() }, async (step, { env }) => {
  await step.sleep("pause", { description: "Wait a moment", duration: "15 seconds" });
  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(mail)}, retries: { limit: 0 } },
    async ({ idempotencyKey, input }) => {
      try {
        return JSON.parse((await env.MAIL.call("mail.send", input, { idempotencyKey })).output);
      } catch (error) {
        if (error.code === resolvedDone) {
          return { resolved: true };
        }
        throw error;
      }
    }
  );
});
`;

const mailerTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import mailer from "./mailer.ts";

export default workflowTests(mailer, [
  { name: "sends", mocks: { send: { sent: true } }, expect: {} },
]);
`;

/** A shared Microsoft 365 connection, as connect keeps one: its ID. */
const sharedMail = async (admin: Person, account: string): Promise<string> => {
  const id = crypto.randomUUID();
  const now = String(Date.now());
  await execute(
    `INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, account_id, account_name, connected_by, created_at, updated_at) VALUES (${[
      quoted(id),
      quoted("microsoft"),
      quoted("shared"),
      "NULL",
      quoted("active"),
      quoted("native"),
      quoted("microsoft-365"),
      quoted(`account-${id}`),
      quoted(account),
      quoted(admin.userId),
      now,
      now,
    ].join(", ")})`
  );
  return id;
};

/**
 * The run's send, as connect records one whose answer was lost: of
 * unknown outcome, with what was sent and where it came from, claimed long
 * ago by no connector build that could look it up, so nothing recovers it.
 */
const loseSend = async ({
  admin,
  app,
  run,
  connectionId,
  permissionId,
}: {
  admin: Person;
  app: string;
  run: string;
  connectionId: string;
  permissionId: string;
}): Promise<void> => {
  const inputHash = createHash("sha256")
    .update(canonicalJson({ resource: null, input: mail }))
    .digest("hex");
  const origin = {
    mode: "workflow",
    appVersion: 1,
    permissionId,
    context: { type: "run", appId: app, runId: run },
    restricted: false,
  };
  const sentAt = String(Date.now() - 60 * 60 * 1000);
  await execute(
    `INSERT INTO idempotent_calls (subject_type, subject_id, on_behalf_of, connection_id, action, idempotency_key, input_hash, state, created_at, claimed_at, connector_version, resource, input, origin) VALUES (${[
      quoted("app"),
      quoted(app),
      quoted(admin.userId),
      quoted(connectionId),
      quoted("mail.send"),
      quoted(`${run}:send`),
      quoted(inputHash),
      quoted("unknown"),
      sentAt,
      sentAt,
      "NULL",
      "NULL",
      quoted(JSON.stringify(mail)),
      quoted(JSON.stringify(origin)),
    ].join(", ")})`
  );
};

test("a run's lost answer shows up for its person, and saying it happened completes the run", async ({
  browser,
}) => {
  const { admin, other, member } = peopleIn("unknownOutcome");
  const account = `invoices-${crypto.randomUUID().slice(0, 8)}@acme.test`;
  const connectionId = await sharedMail(admin, account);
  const { core, api } = apiOf(admin);
  let app: string;
  let run: string;
  try {
    ({ id: app } = await api.apps.create({ name: "Invoice mailer" }));
    await release(
      api,
      app,
      {
        "workflows/mailer.ts": mailer,
        "workflows/mailer.workflow-tests.ts": mailerTests,
      },
      "Invoice mailer"
    );
    const { id: permissionId } = await api.permissions.request({
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId },
      actions: ["mail.send"],
      binding: "MAIL",
    });
    await api.permissions.grant(permissionId, { version: 1 });
    ({ id: run } = await api.workflows.start(app, "mailer"));
    await loseSend({ admin, app, run, connectionId, permissionId });
    // Its step comes back of unknown outcome, and the run waits.
    await expect(async () => {
      const { items } = await api.workflows.history(run, { pageSize: 100 });
      expect(
        items.some(
          (entry) =>
            entry.kind === "wait" && entry.waitKind === "outcome_unknown"
        )
      ).toBe(true);
    }).toPass({ timeout: 60_000 });
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(browser, admin);
  // The run's page says why it waits, and where its person says.
  await page.goto(`/workflows/${app}/mailer/runs/${run}`);
  await expect(
    page.getByText(
      /^A change by .+ was sent but its answer was lost: it waits for the person the run acts for to say whether it happened$/u
    )
  ).toBeVisible({ timeout: 15_000 });
  await page
    .getByRole("link", {
      name: "The person the run acts for says what happened on their dashboard",
    })
    .click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await expect(
    page.getByRole("link", { name: /^Dashboard.*\bthings? waiting$/u })
  ).toBeVisible();

  // On the pile, with what was sent.
  const name = `Did this happen? Send an email on Microsoft 365 (${account})`;
  const card = await toCard(page, name);
  await expect(card).toContainText(
    "Grasp sent this, but its answer was lost: nobody can tell whether it took effect."
  );
  await expect(card).toContainText(mail.subject);
  await expect(card).toContainText(mail.body);

  // Another admin reads it in Settings, without what was sent, and can't
  // say what happened.
  const otherPage = await pageOf(browser, other);
  await otherPage.goto("/settings/outcomes");
  const listed = otherPage.getByRole("row").filter({ hasText: account });
  await expect(listed).toContainText("Send an email");
  await expect(listed).not.toContainText(mail.subject);
  await expect(otherPage.getByRole("button", { name: /happen/u })).toHaveCount(
    0
  );

  // Anyone else who follows a link to it goes to their own settings.
  const memberPage = await pageOf(browser, member);
  await memberPage.goto("/settings/outcomes");
  await expect(memberPage).toHaveURL(/\/settings\/profile$/u);

  // Asked once more, then said: the card goes, and the run completes.
  await card
    .getByRole("button", {
      name: `It happened: Send an email on Microsoft 365 (${account})`,
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "Say it happened?" });
  await expect(dialog).toContainText("Nothing is changed or undone");
  await dialog.getByRole("button", { name: "It happened" }).click();
  await expect(page.getByRole("article", { name, exact: true })).toHaveCount(
    0,
    { timeout: 15_000 }
  );

  const check = apiOf(admin);
  try {
    await expect(async () => {
      const status = await check.api.workflows.status(run);
      expect(status).toMatchObject({
        status: "completed",
        output: { resolved: true },
      });
    }).toPass({ timeout: 60_000 });
    expect(await check.api.unknownOutcomes.list()).toStrictEqual([]);
  } finally {
    check.core[Symbol.dispose]();
  }
});
