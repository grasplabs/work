import { composioConsentText } from "@grasp-os/shared/connect";
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { seededConnections, seededTools } from "./connections-seed.ts";
import type { SeededConnection } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// The Integrations pages: a person finds each account they connected on
// its integration's page, a row each with where it stands, signs in again
// to one whose access ran out and disconnects one from its own row; an
// admin sees which Apps hold a permission for a shared connection and
// revokes it there, and reads a Composio connection's consent. The
// connections are what finished flows leave behind
// (e2e/connections-seed.ts): the flows through Entra and Composio are
// core's tests.

/** The row for `connection` among the accounts on its integration's page. */
const rowOf = (page: Page, { account }: SeededConnection): Locator =>
  page
    .getByRole("list", { name: "Connection", exact: true })
    .getByRole("listitem")
    .filter({ hasText: account });

test("a person comes back from connecting Microsoft 365, sees each account on its page, and signs in again to or disconnects one whose access ran out from its row", async ({
  pageOf,
}) => {
  const { admin, user } = peopleIn("connections");
  const { mine, expired } = seededConnections();
  const page = await pageOf(user);

  // The list: one of their Microsoft 365 connections ran out beside ones
  // that work, so its tile says it needs someone, not how to fix one
  // account. Opened beside the list, its Manage menu offers to sign in again.
  await page.goto("/integrations");
  const search = page.getByRole("searchbox", { name: "Search integrations" });
  await search.fill("micro");
  await expect(page).toHaveURL(/[?&]q=micro/u);
  const connected = page.getByRole("list", { name: "Connected" });
  const tile = connected.getByRole("button", { name: /^Microsoft 365/u });
  await expect(tile).toBeVisible();
  await expect(tile).toContainText("Needs you");
  await expect(tile).not.toContainText("Sign in again");
  await tile.click();
  await expect(page).toHaveURL(/[?&]app=native%3Amicrosoft/u);
  const panel = page.getByRole("complementary", { name: "Microsoft 365" });
  await panel.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Sign in again" })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  // A search that matches nothing says so.
  await search.fill("no such app at all");
  await expect(page.getByText("No apps match your search")).toBeVisible();

  // A link can name any ID: only a connection the page lists is news.
  await page.goto(
    `/integrations/native:microsoft?connection=${crypto.randomUUID()}`
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Microsoft 365" })
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Where core's callback sends the browser once a flow finished: the
  // success screen, with what was chosen, until it is closed.
  await page.goto(`/integrations/native:microsoft?connection=${mine.id}`);
  const done = page.getByRole("dialog", {
    name: "Microsoft 365 is connected",
  });
  await expect(done.getByText("Just for you")).toBeVisible();
  // A Close, the footer's or the corner's: both close it.
  await done.getByRole("button", { name: "Close" }).first().click();
  // Hidden from the start of its way out, it still takes the page's
  // clicks until it is gone.
  await expect(page.getByRole("dialog", { includeHidden: true })).toHaveCount(
    0
  );
  expect(new URL(page.url()).searchParams.get("connection")).toBeNull();
  // Its accounts, a row each: who connected it and where it stands.
  const mineRow = rowOf(page, mine);
  await expect(mineRow).toContainText("Connected");
  await expect(mineRow).toContainText("You,");

  // Its access ran out: it offers to sign in again, in the connect dialog,
  // which starts the provider's flow again. The test stack has no Microsoft
  // tenant set up, so core refuses the start, and the dialog says so.
  const expiredRow = rowOf(page, expired);
  await expect(expiredRow).toContainText("Signed out");
  await expiredRow
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
  // While an admin doesn't offer Microsoft 365, core refuses every start:
  // its row offers no sign-in, and the page says what has to happen first. The
  // catalog no longer lists the entry to this person, so its ID stands in
  // for its name.
  const { core, api } = apiOf(admin);
  try {
    await api.connections.setOffered("native", "microsoft", false);
    await page.reload();
    await expect(
      page.getByText(
        "Its access ran out. An admin must offer this connector again before it can be reconnected."
      )
    ).toBeVisible();
    await expect(
      rowOf(page, expired).getByRole("button", { name: /^Sign in to/u })
    ).toHaveCount(0);
  } finally {
    await api.connections.setOffered("native", "microsoft", true);
    core[Symbol.dispose]();
  }
  await page.reload();
  await expect(
    expiredRow.getByRole("button", { name: /^Sign in to/u })
  ).toBeVisible();
  // It can be disconnected instead; what the Brain kept from their own
  // Microsoft 365 goes with it, and the dialog says so.
  await expiredRow
    .getByRole("button", {
      name: `Disconnect Microsoft 365 (${expired.account})`,
    })
    .click();
  await expect(
    page
      .getByRole("alertdialog")
      .getByText("Everything the Brain kept from it is erased for good.")
  ).toBeVisible();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(expiredRow).toHaveCount(0);
  await expect(mineRow).toBeVisible();

  // Connecting another account, from the head's Manage menu, which leaves
  // disconnecting to each account's row: the test stack has no Microsoft
  // tenant set up, so core refuses the start, and the dialog says so.
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  const another = page.getByRole("menuitem", {
    name: "Connect another account",
  });
  await expect(another).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Disconnect" })).toHaveCount(
    0
  );
  await another.click();
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

  // A flow that failed comes back refused, and says what to do; a code
  // nobody knows says only the page's own words.
  await page.goto("/integrations?connectionError=connection.already_connected");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "That account is already connected here. Disconnect it first to connect it again."
  );
  await page.goto(
    "/integrations?connectionError=%3Cb%3Eclick%20here%3C%2Fb%3E"
  );
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Connecting didn't work. Try again, or ask an admin."
  );
  // A flow that finished, sent back without a page of its own, says so.
  await page.goto(`/integrations?connection=${mine.id}`);
  await expect(
    page.getByRole("dialog", { name: "Microsoft 365 is connected" })
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // An integration there isn't is not found, in the frame.
  await page.goto("/integrations/native:no-such-app");
  await expect(
    page.getByRole("heading", { name: "App not found" })
  ).toBeVisible();
  await expect(
    page.getByText("It may have been renamed or removed.")
  ).toBeVisible();
});

test("a person reaches their account on an integration's page while the catalog or its tools don't come", async ({
  pageOf,
}) => {
  const { user } = peopleIn("connections");
  const { mine } = seededConnections();

  // The tools never come: the page and its accounts don't wait for them.
  const slowTools = await pageOf(user);
  const toolsGate = await callGate(slowTools, '["connections","catalogTools"]');
  toolsGate.hold();
  await slowTools.goto("/integrations/native:microsoft");
  await expect(
    rowOf(slowTools, mine).getByRole("button", {
      name: `Disconnect Microsoft 365 (${mine.account})`,
    })
  ).toBeVisible();
  toolsGate.release();

  // The catalog never comes: a connected integration still shows from its
  // connections, with its accounts, and says why its tools don't.
  const slowCatalog = await pageOf(user);
  const catalogGate = await callGate(slowCatalog, '["connections","catalog"]');
  catalogGate.hold();
  await slowCatalog.goto("/integrations/native:microsoft");
  // Its name is the catalog's: without it, its ID.
  await expect(
    slowCatalog.getByRole("heading", { level: 1, name: "microsoft" })
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    slowCatalog.getByText(
      "The catalog of integrations couldn't be read, so this page shows only what your accounts say about it."
    )
  ).toBeVisible();
  await expect(
    rowOf(slowCatalog, mine).getByRole("button", {
      name: `Disconnect microsoft (${mine.account})`,
    })
  ).toBeVisible();
  catalogGate.release();
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
  await expect(used).toContainText("Connected for everyone");
  await expect(
    used.getByRole("link", { name: "Manage Microsoft 365" })
  ).toBeVisible();
  await expect(inUse.getByRole("listitem")).toHaveCount(1);

  await page.goto("/integrations/native:microsoft");
  const mailboxRow = rowOf(page, mailbox);
  await expect(mailboxRow).toContainText("Connected");
  await expect(mailboxRow).toContainText("Everyone");
  const holders = page.getByRole("heading", {
    name: "Apps and agents with a permission",
  });
  const holder = page
    .getByRole("list", { name: "Apps and agents with a permission" })
    .getByRole("listitem")
    .filter({ hasText: appName });
  await expect(holders).toBeVisible();
  await expect(holder).toContainText(`App ${appName}`);
  await expect(holder).toContainText("mail.read on the whole connection");
  await expect(holder).toHaveCount(1);
  await holder
    .getByRole("button", { name: `Revoke App ${appName}'s permission` })
    .click();
  await expect(holder).toHaveCount(0);
  // Nothing holds one now: the page says nothing of holders.
  await expect(holders).toHaveCount(0);

  // Composio holds this one's tokens: who consented, to what, for which
  // tools. The test stack lists no Composio toolkits, so its ID stands in
  // for its name. Its one account is disconnected from its row; the head
  // has nothing else to manage, so no Manage menu.
  await page.goto("/integrations/composio:hubspot");
  await page
    .getByRole("button", { name: /consented to this before connecting it$/u })
    .click();
  await expect(page.getByText(composioConsentText)).toBeVisible();
  await expect(page.getByRole("main")).toContainText(
    `Tools allowed: ${seededTools.join(", ")}`
  );
  await expect(
    rowOf(page, toolkit).getByRole("button", {
      name: `Disconnect hubspot (${toolkit.account})`,
    })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manage", exact: true })
  ).toHaveCount(0);
});
