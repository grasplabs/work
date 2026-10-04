import { composioConsentText } from "@grasp-os/shared/connect";
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { seededConnections, seededTools } from "./connections-seed.ts";
import type { SeededConnection } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

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
  browser,
}) => {
  const { admin, user } = peopleIn("connections");
  const { mine, expired } = seededConnections();
  const page = await pageOf(browser, user);

  // The list: Microsoft 365 is connected for them, and needs attention.
  await page.goto("/integrations");
  const search = page.getByRole("searchbox", { name: "Search integrations" });
  await search.fill("micro");
  await expect(page).toHaveURL(/[?&]q=micro/u);
  const connected = page.getByRole("region", { name: "Connected" });
  await expect(
    connected.getByRole("link", { name: "Microsoft 365", exact: true })
  ).toBeVisible();
  await page
    .getByRole("complementary", { name: "Filter integrations" })
    .getByRole("link", { name: /^Needs attention/u })
    .click();
  await expect(page).toHaveURL(/show=attention/u);
  await expect(
    connected.getByRole("button", { name: "Sign in to Microsoft 365 again" })
  ).toBeVisible();

  // A link can name any ID: only a connection the page lists is news.
  await page.goto(
    `/integrations/native:microsoft?connection=${crypto.randomUUID()}`
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Microsoft 365" })
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  // Where core's callback sends the browser once a flow finished.
  await page.goto(`/integrations/native:microsoft?connection=${mine.id}`);
  await expect(page.getByRole("status")).toHaveText("Connected.");
  await expect(page.getByText("Native", { exact: true })).toBeVisible();

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
  // While an admin doesn't offer Microsoft 365, core refuses every start:
  // the card offers no sign-in, and says what has to happen first. The
  // catalog no longer lists the entry to this person, so its ID stands in
  // for its name.
  const { core, api } = apiOf(admin);
  try {
    await api.connections.setOffered("native", "microsoft", false);
    await page.reload();
    const hiddenCard = cardOf(page, "microsoft", expired);
    await expect(
      hiddenCard.getByText(
        "An admin must offer this connector again before it can be reconnected."
      )
    ).toBeVisible();
    await expect(
      hiddenCard.getByRole("button", { name: /^Sign in to/u })
    ).toHaveCount(0);
  } finally {
    await api.connections.setOffered("native", "microsoft", true);
    core[Symbol.dispose]();
  }
  await page.reload();
  await expect(
    expiredCard.getByRole("button", { name: /^Sign in to/u })
  ).toBeVisible();
  // It can be disconnected instead.
  await expiredCard
    .getByRole("button", {
      name: `Disconnect Microsoft 365 (${expired.account})`,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(expiredCard).toHaveCount(0);
  await expect(mineCard).toBeVisible();
  // The notice was about the flow that came back, not about the page now.
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("connection")).toBeNull();

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

  // A flow that failed comes back through the old address, refused, and
  // says what to do; a code nobody knows says only the page's own words.
  await page.goto("/connections?connectionError=connection.already_connected");
  await expect(page).toHaveURL(/\/integrations\?connectionError=/u);
  await expect(page.getByRole("alert")).toHaveText(
    "That account is already connected here. Disconnect it first to connect it again."
  );
  await page.goto("/connections?connectionError=%3Cb%3Eclick%20here%3C%2Fb%3E");
  await expect(page.getByRole("alert")).toHaveText(
    "Connecting didn't work. Try again, or ask an admin."
  );

  // An integration there isn't is not found, in the frame.
  await page.goto("/integrations/native:no-such-app");
  await expect(
    page.getByRole("heading", { name: "Integration not found" })
  ).toBeVisible();
});

test("an admin sees which Apps can use a shared connection, revokes a permission there, and reads a Composio connection's consent", async ({
  browser,
}) => {
  const { admin } = peopleIn("connections");
  const { mailbox, toolkit } = seededConnections();
  const appName = `Mail triage ${crypto.randomUUID()}`;
  const { core, api } = apiOf(admin);
  try {
    const { id: appId } = await api.apps.create({
      name: appName,
      description: "Sorts the shared mailbox",
    });
    const { id } = await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "connection", connectionId: mailbox.id },
      actions: ["mail.read"],
      binding: "MAILBOX",
    });
    // Reviewed with no version of the App current yet.
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

  const page = await pageOf(browser, admin);
  await accountOf(page, "native:microsoft");
  const mailboxCard = cardOf(page, "Microsoft 365", mailbox);
  await expect(mailboxCard.getByRole("definition").first()).toHaveText(
    "Active, for the whole company"
  );
  const holder = mailboxCard.getByRole("listitem").filter({ hasText: appName });
  await expect(holder).toContainText(
    `Engine ${appName}: mail.read on the whole connection`
  );
  await expect(holder).toHaveCount(1);
  await holder
    .getByRole("button", { name: `Revoke Engine ${appName}'s permission` })
    .click();
  await expect(holder).toHaveCount(0);
  await expect(mailboxCard.getByText("None.")).toBeVisible();

  // Composio holds this one's tokens: who consented, to what, for which
  // tools. The test stack lists no Composio toolkits, so its ID stands in
  // for its name.
  await accountOf(page, "composio:hubspot");
  await expect(page.getByText("Via Composio")).toBeVisible();
  const toolkitCard = cardOf(page, "hubspot", toolkit);
  await expect(toolkitCard.getByText(composioConsentText)).toBeVisible();
  await expect(toolkitCard).toContainText(
    `Tools allowed: ${seededTools.join(", ")}`
  );
});
