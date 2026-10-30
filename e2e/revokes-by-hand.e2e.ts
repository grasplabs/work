import { expect } from "@playwright/test";

import { execute, quoted } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { peopleIn, signInTo } from "./people.ts";

// Access Grasp couldn't remove itself at an app (GRA-1197), as the
// company's admin finds it on Integrations: a revoke connect still tries
// but the provider has refused for a day, and one it gave up on, each with
// what to do by hand. Connect's database is written as connect leaves
// them (connections-seed.ts): the retries themselves are connect's tests.

test("an admin sees the access Grasp couldn't remove, with where to remove it by hand, and a member doesn't", async ({
  browser,
}) => {
  const { admin, owner } = peopleIn("revokesByHand");
  const tag = crypto.randomUUID().slice(0, 8);
  const personal = crypto.randomUUID();
  const shared = crypto.randomUUID();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const connection = (
    id: string,
    scope: "personal" | "shared",
    ownerId: string | null,
    accountName: string
  ) =>
    `INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, account_id, account_name, connected_by, created_at, updated_at) VALUES (${[
      quoted(id),
      quoted("google"),
      quoted(scope),
      ownerId === null ? "NULL" : quoted(ownerId),
      quoted("disconnected"),
      quoted("native"),
      quoted("google-workspace"),
      quoted(`account-${id}`),
      quoted(accountName),
      quoted(ownerId ?? admin.userId),
      String(now - 30 * day),
      String(now - 2 * day),
    ].join(", ")});`;
  await execute(
    [
      connection(personal, "personal", owner.userId, `own-${tag}@acme.test`),
      connection(shared, "shared", null, `mailbox-${tag}@acme.test`),
      // Refused for a day and more, tried again in an hour.
      `INSERT INTO token_revocations (id, connection_id, sealed, reason, attempts, retry_at, created_at) VALUES (${quoted(crypto.randomUUID())}, ${quoted(personal)}, 'sealed', 'disconnected', 9, ${now + 60 * 60 * 1000}, ${now - 2 * day});`,
      // Given up yesterday.
      `INSERT INTO given_up_revocations (id, connection_id, owed_for, reason, attempts, owed_at, given_up_at) VALUES (${quoted(crypto.randomUUID())}, ${quoted(shared)}, 'needs_reauth', 'unreadable', 3, ${now - 2 * day}, ${now - day});`,
    ].join("\n")
  );

  const adminPage = await browser.newPage();
  await signInTo(adminPage.context(), admin);
  await adminPage.goto("/integrations");
  const toDo = adminPage.getByRole("region", {
    name: "Access to remove by hand",
  });
  const givenUp = toDo
    .getByRole("listitem")
    .filter({ hasText: `mailbox-${tag}@acme.test` });
  await expect(givenUp).toContainText("Given up");
  await expect(givenUp).toContainText("Asked to connect again on");
  await expect(givenUp).toContainText(`signed in as mailbox-${tag}@acme.test`);
  await expect(
    givenUp.getByRole("link", { name: "myaccount.google.com/connections" })
  ).toHaveAttribute("href", "https://myaccount.google.com/connections");
  // The personal one, by its owner: never its account.
  const stuck = toDo
    .getByRole("listitem")
    .filter({ hasText: "Still trying · 9 tries" })
    .first();
  await expect(stuck).toContainText("Person's own");
  await expect(stuck).toContainText("Ask Person to remove Grasp at");
  await expect(toDo).not.toContainText(`own-${tag}@acme.test`);

  const memberPage = await browser.newPage();
  await signInTo(memberPage.context(), owner);
  await memberPage.goto("/integrations");
  await expect(
    memberPage.getByRole("heading", { name: "Integrations" })
  ).toBeVisible();
  await expect(
    memberPage.getByRole("region", { name: "Access to remove by hand" })
  ).toHaveCount(0);
});
