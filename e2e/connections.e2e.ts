import { composioConsentText } from "@grasp-os/shared/connect";
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { seededConnections, seededTools } from "./connections-seed.ts";
import type { SeededConnection } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";
import { expectErrorsShown } from "./said.ts";

// The Integrations pages: a person finds the account they connected on
// its integration's page, with where it stands, signs in again to one whose
// access ran out, and disconnects one; an admin sees which Apps hold a
// permission for a shared connection and revokes it there, and reads a
// Composio connection's consent. The connections are what finished flows
// leave behind (e2e/connections-seed.ts): the flows through Entra and
// Composio are core's tests.

/** An integration's page, on its Account tab. */
const accountOf = async (page: Page, key: string): Promise<void> => {
  await page.goto(`/integrations/${key}?tab=account`);
};

/** The card for `connection`, by its name and account. */
const cardOf = (
  page: Page,
  name: string,
  { account }: SeededConnection
): Locator =>
  page.getByRole("listitem").filter({
    has: page.getByRole("heading", {
      level: 3,
      name: `${name} (${account})`,
    }),
  });

test("a person comes back from connecting Microsoft 365, sees it on its page, and is offered to sign in again or disconnect one whose access ran out", async ({
  pageOf,
}) => {
  const { user } = peopleIn("connections");
  const { mine, expired } = seededConnections();
  const page = await pageOf(user);

  // The list: one of their Microsoft 365 connections ran out, but the
  // ones beside it work, so it is listed as connected; its row offers to
  // sign in again.
  await page.goto("/integrations");
  await page
    .getByRole("searchbox", { name: "Search integrations" })
    .fill("micro");
  await expect(
    page
      .getByRole("region", { name: /^Connected/u })
      .getByRole("listitem")
      .filter({
        has: page.getByRole("link", { name: "Microsoft 365", exact: true }),
      })
      .getByRole("button", { name: "Sign in to Microsoft 365 again" })
  ).toBeVisible();

  // Where core's callback sends the browser once a flow finished: the
  // success screen, with what was chosen, until it is closed.
  await page.goto(`/integrations/native:microsoft?connection=${mine.id}`);
  const done = page.getByRole("dialog", {
    name: "Microsoft 365 is connected",
  });
  await expect(done.getByText("Just for you")).toBeVisible();
  await done.getByRole("button", { name: "Close" }).click();
  await expect(done).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("connection")).toBeNull();
  // Its Overview's account card: where it stands, what it reaches, and
  // signing in again to the connection whose access ran out.
  const account = page.getByRole("region", { name: "Account" });
  await expect(account.getByRole("definition").first()).toHaveText(
    "Needs someone to sign in again"
  );
  await expect(
    account.getByText(
      "Every tool it has: Apps and agents use only what they are granted."
    )
  ).toBeVisible();
  await account.getByRole("button", { name: "Sign in again" }).click();
  await expect(
    page.getByRole("dialog", { name: "Sign in to Microsoft 365 again" })
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: /^Account/u }).click();
  const mineCard = cardOf(page, "Microsoft 365", mine);
  await expect(mineCard.getByRole("definition")).toHaveText([
    "Active, only for you",
    mine.account,
    "You",
    /\S/u,
  ]);

  // Its access ran out: it offers to sign in again, in the connect dialog,
  // which starts the provider's flow again. The test stack has no Microsoft
  // tenant set up, so core refuses the start, and the dialog says so.
  const expiredCard = cardOf(page, "Microsoft 365", expired);
  await expect(
    expiredCard.getByText("Needs someone to sign in again")
  ).toBeVisible();
  await expiredCard
    .getByRole("button", {
      name: `Sign in to Microsoft 365 (${expired.account}) again`,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Sign in to Microsoft 365 again",
  });
  await dialog
    .getByRole("button", { name: "Sign in to Microsoft 365" })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Connecting this provider isn't set up for this deployment."
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // It can be disconnected instead; what the Brain kept from their own
  // Microsoft 365 goes with it, and the dialog says so.
  await expiredCard
    .getByRole("button", {
      name: `Disconnect Microsoft 365 (${expired.account})`,
    })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("Everything the Brain kept from it is erased for good.")
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(expiredCard).toHaveCount(0);
  await expect(mineCard).toBeVisible();

  // Connecting another account: the test stack has no Microsoft tenant set
  // up, so core refuses the start, and the dialog says so.
  await page.getByRole("button", { name: "Connect another account" }).click();
  const connecting = page.getByRole("dialog", {
    name: "Connect Microsoft 365",
  });
  await connecting
    .getByRole("button", { name: "Sign in to Microsoft 365" })
    .click();
  await expect(connecting.getByRole("alert")).toHaveText(
    "Connecting this provider isn't set up for this deployment."
  );
  await page.keyboard.press("Escape");

  // A flow that failed comes back refused, and says what to do (what it
  // says for each code is apps/web/src/connection-errors.test.ts).
  await page.goto("/integrations?connectionError=connection.already_connected");
  await expectErrorsShown(page, [
    "That account is already connected here. Disconnect it first to connect it again.",
  ]);
});

test("an admin sees which Apps can use a shared connection, revokes a permission there, and reads a Composio connection's consent", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("connections");
  const { mailbox, toolkit } = seededConnections();
  const appName = `Mail triage ${crypto.randomUUID()}`;
  const { core, api } = apiOf(admin);
  let appId: string;
  try {
    ({ id: appId } = await api.apps.create({
      name: appName,
      description: "Sorts the shared mailbox",
    }));
    const { id } = await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "connection", connectionId: mailbox.id },
      actions: ["mail.read"],
      binding: "MAILBOX",
    });
    // Reviewed with no version of the App live yet.
    await api.permissions.grant(id, { version: null });
    // Only asked for, it allows nothing yet: not a holder.
    await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "connection", connectionId: mailbox.id },
      actions: ["mail.send"],
      binding: "MAILBOX_SEND",
    });
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(admin);
  // The App's Connections list the integrations of the connections it
  // may use, in those connections' state.
  await page.goto(`/apps/${appId}/settings?section=connections`);
  const inUse = page.getByRole("region", { name: "Connections in use" });
  const used = inUse.getByRole("listitem").filter({ hasText: "Microsoft 365" });
  await expect(
    used.getByRole("button", {
      name: "Manage Microsoft 365, connected for everyone",
    })
  ).toBeVisible();
  await expect(inUse.getByRole("listitem")).toHaveCount(1);

  await accountOf(page, "native:microsoft");
  const mailboxCard = cardOf(page, "Microsoft 365", mailbox);
  await expect(mailboxCard.getByRole("definition").first()).toHaveText(
    "Active, for the whole company"
  );
  const holder = mailboxCard.getByRole("listitem").filter({ hasText: appName });
  await expect(holder).toContainText(
    `App ${appName}: mail.read on the whole connection`
  );
  await expect(holder).toHaveCount(1);
  await holder
    .getByRole("button", { name: `Revoke App ${appName}'s permission` })
    .click();
  await expect(holder).toHaveCount(0);
  await expect(mailboxCard.getByText("None.")).toBeVisible();

  // Composio holds this one's tokens: who consented, to what, for which
  // tools. The test stack lists no Composio toolkits, so its ID stands in
  // for its name.
  await accountOf(page, "composio:hubspot");
  const toolkitCard = cardOf(page, "hubspot", toolkit);
  await expect(toolkitCard.getByText(composioConsentText)).toBeVisible();
  await expect(toolkitCard).toContainText(
    `Tools allowed: ${seededTools.join(", ")}`
  );
});
