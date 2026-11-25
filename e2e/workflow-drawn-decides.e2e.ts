import { createHmac, randomBytes } from "node:crypto";

import { eventSourceHeaders } from "@grasp-os/shared/event-sources";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { inboxList, toItem } from "./inbox.ts";
import { approvalDrawn, modelScripts } from "./model-scripts.ts";
import { peopleIn } from "./people.ts";
import type { Person } from "./people.ts";
import { toastSaying } from "./said.ts";
import { origin } from "./stack.ts";

// An independent workflow, end to end, as its people make and use it: a
// builder makes it from Make something, saying what they want done, and
// Grasp's chat draws it once they say Build it (the stack's scripted
// model saves an invoice approval, a person's decision, as its draft,
// e2e/model-scripts.ts); the builder publishes it with Publish in its
// bar; an admin names who answers its decision in its Settings'
// Files and apps; the builder starts a run with Run, naming the
// approver, who decides from their inbox, on the decision's own page,
// confirmed in Grasp's own dialog: its link, which anyone
// else who opens it only sees isn't for them; and the run ends with their
// answer. Then a webhook: an admin adds a source in Settings, the builder
// starts the workflow on its events, the admin grants that request from
// the inbox, and an event signed with the source's secret starts a run.

/** A turn of the agent's, its model's calls and the tools they call. */
const agentTurn = { timeout: 30_000 };

/** A read from core on a loaded stack, or a run's next step. */
const pageRead = { timeout: 15_000 };

/** A run's next step, as pages read again until they show it. */
const untilItHappens = { timeout: 45_000 };

// Never tried again, as the serial journeys aren't (playwright.config.ts):
// a flaky journey shows as itself, with the trace of the run that failed,
// and a failing one costs its part one attempt of its long wait, not three.
// Each action waits as long as a read: one that never can fails as
// itself, not as the whole test's timeout.
test.use({ trace: "retain-on-failure", actionTimeout: pageRead.timeout });
test.describe.configure({ retries: 0 });

/** What the plan calls the workflow: its title, which its page is headed by. */
const planned = "Invoice approval";

/**
 * A new workflow's name, as Build it makes one from the plan: what the
 * inbox still calls it by.
 */
const newName = String.raw`[a-z\d-]+-[\da-f]{6}`;

/** Picks `person` in the open list of people, teams and roles on `page`. */
const pick = async (page: Page, person: Person): Promise<void> => {
  await page
    .getByPlaceholder("Search people, teams and roles")
    .fill(person.email);
  await page.getByRole("option", { name: "Person" }).click();
};

/**
 * Opens, in `page`'s inbox, the decision a run of workflow `name` asks:
 * read again until it is there, as the inbox reads once and the run asks
 * on its own time, after its start or delivery was answered.
 */
const decisionIn = async (page: Page, name: string): Promise<void> => {
  const listed = inboxList(page)
    .getByRole("link")
    .filter({ hasText: new RegExp(name, "u") })
    .first();
  await expect(async () => {
    await page.goto("/inbox");
    // However long a read takes: then it is listed, or not yet.
    await expect(listed).toBeVisible(pageRead);
  }).toPass(untilItHappens);
  await listed.click();
};

/**
 * Makes a new workflow saying what it should do, which Grasp's chat draws
 * as the approval on its Flow, and publishes it, its first version, as the
 * builder on `page`: its ID and name.
 */
const drawnAndPublished = async (
  page: Page
): Promise<{ workflow: string; name: string }> => {
  await page.goto("/workflows");
  await page.getByRole("link", { name: "Make something" }).click();
  // Nothing is made until Build it: then it lands on the workflow, where
  // Grasp draws it in the chat docked beside it.
  await expect(
    page.getByRole("heading", { name: "What do you want to get done?" })
  ).toBeVisible(pageRead);
  const ask = page.getByRole("textbox", { name: "Your question" });
  await ask.fill(modelScripts.drawsApproval.opener);
  await ask.press("Enter");
  await page
    .getByRole("region", { name: "Here's what Grasp will make" })
    .getByRole("button", { name: "Build it" })
    .click(agentTurn);
  await expect(page).toHaveURL(/\/workflows\/[^/?]+\?view=flow$/u, agentTurn);
  await expect(
    page.getByRole("heading", { level: 1, name: planned, exact: true })
  ).toBeAttached(pageRead);
  const workflow = new URL(page.url()).pathname.split("/").at(-1) ?? "";

  // The chat docked beside the Flow draws the approval.
  const chat = page.getByRole("region", { name: "Chat" });
  await expect(chat.getByText(approvalDrawn)).toBeVisible(agentTurn);
  const diagram = page.getByRole("region", { name: "Diagram", exact: true });
  await expect(diagram.getByRole("listitem", { name: "approve" })).toBeVisible(
    pageRead
  );

  // Publish, in its bar, makes the draft its first version.
  await page
    .getByRole("button", { name: "Publish", exact: true })
    .filter({ visible: true })
    .click(pageRead);
  await page
    .getByRole("dialog", { name: /^Publish /u })
    .getByRole("button", { name: "Publish", exact: true })
    .click(pageRead);
  await expect(toastSaying(page, / is live/u)).toBeVisible(pageRead);
  return { workflow, name: newName };
};

/** A Standard Webhooks signature of `body` with `secret` (`whsec_…`). */
const signed = (secret: string, id: string, timestamp: string, body: string) =>
  `v1,${createHmac(
    "sha256",
    Buffer.from(secret.replace(/^whsec_/u, ""), "base64")
  )
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")}`;

test("a builder draws an approval with Grasp, an admin names who answers it, the run ends with the approver's answer, and a signed webhook starts another", async ({
  pageOf,
}) => {
  // Its longest waits, one after another: 16 page reads (15 s each),
  // the agent's turn (30 s), and three rereads until a run asks or ends
  // (45 s each): 405 s, before its clicks.
  test.setTimeout(420_000);
  const { builder, admin, decider } = peopleIn("workflowDrawnDecides");
  const page = await pageOf(builder);
  const { workflow, name } = await drawnAndPublished(page);

  // Its decision waits for an admin to name who answers it.
  const asAdmin = await pageOf(admin);
  await asAdmin.goto(`/workflows/${workflow}?view=settings&section=files`);
  const waiting = asAdmin.getByRole("region", {
    name: "Waiting for your approval",
  });
  await waiting
    .getByRole("button", { name: "Add who answers" })
    .click(pageRead);
  await pick(asAdmin, decider);
  await waiting.getByRole("button", { name: "Approve approval" }).click();
  await expect(asAdmin.getByText("Approved: approval.")).toBeVisible(pageRead);

  // The builder starts a run with Run, naming the approver.
  await page.reload();
  await page.getByRole("button", { name: "Run", exact: true }).click(pageRead);
  const start = page.getByRole("dialog", { name: "Start a run" });
  await start.getByLabel("invoice").fill("INV-42");
  // Picked from the organization's people, never typed as an ID. Everyone
  // the stack signs in is called Person, and a starter sees names, not
  // emails: told apart by the end of the ID each goes by.
  const approver = start.getByRole("combobox", { name: "approver" });
  await start.getByRole("button", { name: "Show the choices" }).click();
  await page
    .getByRole("option")
    .filter({ hasText: `ID …${decider.userId.slice(-6)}` })
    .click();
  await expect(approver).toHaveValue(
    `Person (ID …${decider.userId.slice(-6)})`
  );
  await start.getByRole("button", { name: "Start the run" }).click();
  await expect(
    start.getByText("The run started. It is listed with the workflow's runs.")
  ).toBeVisible(pageRead);
  await start.getByRole("button", { name: "Close" }).first().click();
  await expect(start).toHaveCount(0);

  // The approver decides from their inbox.
  const asDecider = await pageOf(decider);
  await decisionIn(asDecider, name);
  // Opened beside the list, to be answered there: what it asks.
  await expect(
    asDecider.getByRole("region", { name: "Approve invoice INV-42" })
  ).toBeVisible(pageRead);
  // Its page is the decision's link: opened by anyone else, it only says
  // it isn't theirs. The approver answers it there.
  const decision = (
    new URL(asDecider.url()).searchParams.get("item") ?? ""
  ).replace(/^decision:/u, "");
  const link = `/decisions/${decision}`;
  await page.goto(link);
  await expect(
    page.getByText("This decision is for someone else to answer.")
  ).toBeVisible(pageRead);
  await asDecider.goto(link);
  await expect(
    asDecider.getByRole("heading", { name: "Approve invoice INV-42" })
  ).toBeVisible(pageRead);
  await asDecider.getByRole("button", { name: "Add a comment" }).click();
  const comment = asDecider.getByLabel("Comment (optional)");
  const confirmation = asDecider.getByRole("dialog", {
    name: "Confirm your approval",
  });
  // Approved with a comment, confirmed in Grasp's own dialog.
  await comment.fill("Paid on time.");
  await asDecider.getByRole("button", { name: "Approve" }).click();
  await expect(confirmation).toContainText("Paid on time.");
  await confirmation.getByRole("button", { name: "Confirm" }).click();
  await expect(
    asDecider
      .getByRole("status")
      .filter({ hasText: /^Approved by Person on /u })
  ).toBeVisible(pageRead);

  // The run ends with their answer: its list is read once, so read again
  // until the engine has finished it.
  const run = page.getByRole("row").nth(1);
  await expect(async () => {
    await page.goto(`/workflows/${workflow}?view=runs`);
    await expect(run).toBeVisible(pageRead);
    await expect(run).toContainText("Done", { timeout: 1000 });
  }).toPass(untilItHappens);
  // Its own page, with what it returned folded under its updates.
  await run.getByRole("button").first().click();
  await expect(page).toHaveURL(/\/runs\/[^/?]+$/u, pageRead);
  await page.getByRole("button", { name: "What it returned" }).click(pageRead);
  const returned = page.locator("[data-slot=code-block]");
  await expect(returned).toContainText('"status": "approved"', pageRead);
  await expect(returned).toContainText('"comment": "Paid on time."');
  await page.goBack();

  // A webhook: an admin adds a source, its secret shown once.
  const sourceName = `Invoices ${randomBytes(4).toString("hex")}`;
  await asAdmin.goto("/settings/webhooks");
  await asAdmin
    .getByRole("button", { name: "Add a source" })
    .first()
    .click(pageRead);
  const adding = asAdmin.getByRole("dialog");
  await adding.getByLabel("Name").fill(sourceName);
  await adding.getByRole("button", { name: "Next" }).click();
  // Each value stands in a snippet, beside the button that copies it.
  const copied = (button: string) =>
    adding
      .locator('[data-slot="snippet"]')
      .filter({ has: asAdmin.getByRole("button", { name: button }) })
      .locator('[data-slot="snippet-value"]');
  const secret = (await copied("Copy the secret").textContent()) ?? "";
  const url = (await copied("Copy the URL").textContent()) ?? "";
  await adding.getByRole("button", { name: "Done" }).click();

  // The builder starts the workflow on its invoices, from What starts it
  // in the Workshop on its page: its Settings' Triggers.
  await page.goto(`/workflows/${workflow}`);
  await page
    .getByRole("button", { name: "Open What starts it" })
    .click(pageRead);
  await page.getByRole("button", { name: "Add a trigger" }).click();
  const adder = page.getByRole("dialog", { name: "Add a trigger" });
  await adder.getByRole("combobox", { name: "What starts it" }).click();
  await page
    .getByRole("option", { name: "An event from a webhook source" })
    .click();
  await adder.getByRole("combobox", { name: "Source", exact: true }).click();
  await page.getByRole("option", { name: sourceName }).click();
  await adder.getByLabel("Event type").fill("invoice.received");
  await adder.getByRole("button", { name: "Add the trigger" }).click();
  await expect(page.getByText("Waiting for an admin")).toBeVisible(pageRead);

  // Its start waits for an admin, who allows it from their inbox. The
  // request names the trigger by its kind and source, and asks to let the
  // workflow start.
  await asAdmin.goto("/inbox");
  const grant = await toItem(
    asAdmin,
    new RegExp(`^Webhook trigger for .+${sourceName}`, "u"),
    /^Let .+ start when its webhook is called\?$/u
  );
  await grant.getByRole("button", { name: "Allow" }).click();
  await expect(grant).toHaveCount(0, pageRead);
  await page.goto(`/workflows/${workflow}?view=settings&section=triggers`);
  await expect(
    page.getByText(`On invoice.received events from ${sourceName}`)
  ).toBeVisible(pageRead);
  await expect(page.getByText("Waiting for an admin")).toHaveCount(0);

  // An event signed with the source's secret starts a run.
  const body = JSON.stringify({
    type: "invoice.received",
    data: { invoice: "INV-43", approver: `person:${decider.userId}` },
  });
  const id = `msg_${randomBytes(8).toString("hex")}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const delivered = await fetch(new URL(url, origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [eventSourceHeaders.id]: id,
      [eventSourceHeaders.timestamp]: timestamp,
      [eventSourceHeaders.signature]: signed(secret, id, timestamp, body),
    },
    body,
  });
  expect(delivered.status).toBeLessThan(300);
  // Its run asks the approver, as the one started by hand did.
  await decisionIn(asDecider, name);
  await expect(
    asDecider.getByRole("region", { name: "Approve invoice INV-43" })
  ).toBeVisible(pageRead);
});
