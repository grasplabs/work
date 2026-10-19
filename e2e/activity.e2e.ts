import { readFile } from "node:fs/promises";

import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import { toCard } from "./pile.ts";

// The Activity page: an admin approves one App's permission request and
// rejects another, finds the approval in the audit log with its details,
// and exports what the log's filters match. Search, export and the grant
// themselves are core's tests.

/** A collection everyone reads, made by `admin`, for an App to ask for. */
const collectionOf = async (
  admin: Parameters<typeof apiOf>[0]
): Promise<string> => {
  const { core, api } = apiOf(admin);
  try {
    const { id } = await api.knowledge.createCollection({
      name: `Board pack ${crypto.randomUUID()}`,
      access: "everyone",
    });
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

test("an admin approves a permission request, finds it in the audit log, and exports it", async ({
  pageOf,
}) => {
  const { admin, builder } = peopleIn("activity");
  const appName = `Board pack ${crypto.randomUUID()}`;
  const collectionId = await collectionOf(admin);
  const { core, api } = apiOf(builder);
  let approved: string;
  try {
    const { id: appId } = await api.apps.create({
      name: appName,
      description: "Reads the board pack",
    });
    ({ id: approved } = await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "collection", collectionId },
      actions: ["read"],
      binding: "PLAYBOOK",
    }));
    await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "platform" },
      actions: ["guests"],
      binding: "GUESTS",
    });
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(admin);
  // An admin's permission requests wait on the dashboard; the old
  // Settings link leads there.
  await page.goto("/settings/approvals");
  await expect(page).toHaveURL(/\/dashboard$/u);
  // Other tests' requests wait in the pile too: it is gone through to this
  // App's cards.
  const reading = await toCard(
    page,
    `${appName}: read on Collection ${collectionId}`
  );
  await expect(reading).toContainText("as PLAYBOOK");
  await expect(reading).toContainText("Version to review: None current");
  await reading.getByRole("button", { name: /^Approve /u }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: `Approved: ${appName}: read on Collection ${collectionId}.`,
    })
  ).toHaveCount(1);
  await expect(reading).toHaveCount(0);

  const inviting = await toCard(
    page,
    new RegExp(`^${appName}: guests on Guest chats\\.`, "u")
  );
  await inviting.getByRole("button", { name: /^Reject /u }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Reject", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: `Rejected: ${appName}` })
  ).toHaveCount(1);
  await expect(inviting).toHaveCount(0);

  // The approval is in the log, found by what it granted, once the log has
  // taken its events from core's outbox, which it does in the background.
  const reader = apiOf(admin);
  try {
    await expect
      .poll(async () => {
        const { records } = await reader.api.audit.search({
          targetId: approved,
        });
        return new Set(records.map(({ event }) => event?.action));
      })
      .toStrictEqual(new Set(["permission.granted", "permission.requested"]));
  } finally {
    reader.core[Symbol.dispose]();
  }
  // An old link to the log leads to the audit trail, filters and all.
  await page.goto(`/activity?target=${approved}`);
  await expect(page).toHaveURL(/\/settings\/audit\?/u);
  await expect(page.getByRole("textbox", { name: "Target ID" })).toHaveValue(
    approved
  );
  // Each entry in words, under who did it and to what.
  const entries = page
    .getByRole("list", { name: "Entries" })
    .getByRole("listitem");
  const granted = entries.filter({ hasText: "Granted a permission" });
  await expect(granted).toHaveCount(1);
  await expect(granted).toContainText("Permission");
  await expect(granted).toContainText(`permission ${approved}`);
  await expect(
    entries.filter({ hasText: "Asked for a permission" })
  ).toHaveCount(1);
  await granted.getByRole("button", { name: /^Details of event /u }).click();
  await expect(
    page.getByText(`"requestedBy": "${builder.userId}"`)
  ).toBeVisible();
  await expect(granted).toContainText("permission.granted");

  // Narrowed to grants, the request drops out; the action is taken as
  // core takes it, whatever its case and a trailing dot.
  await page.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "Permission" }).click();
  await page
    .getByRole("textbox", { name: "Action" })
    .fill("Permission.Granted.");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/action=permission\.granted/u);
  await expect(
    entries.filter({ hasText: "Asked for a permission" })
  ).toHaveCount(0);
  await expect(granted).toHaveCount(1);

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export the audit trail" }).click();
  await page.getByRole("menuitem", { name: "Export CSV" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^audit-log-.+\.csv$/u);
  const csv = await readFile(await download.path(), "utf-8");
  const lines = csv.trimEnd().split("\r\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^seq,received_at,at,type,action,/u);
  expect(lines[1]).toContain(",permission,permission.granted,");
  expect(lines[1]).toContain(approved);

  // Text that can't start an action is dropped, not refused by core, and
  // so is a day no calendar has, rather than searched as the next month's.
  await page.goto(
    `/settings/audit?target=${approved}&action=${encodeURIComponent("no such action!")}&from=2024-02-29&to=2099-02-29`
  );
  await expect(page.getByRole("textbox", { name: "Action" })).toHaveValue("");
  // A leap day is a day; 2099 has none.
  await expect(page.getByLabel("From")).toHaveValue("2024-02-29");
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("");
  await expect(granted).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an admin sees a grant asked for again after a new version, and approves only the version the list shows", async ({
  pageOf,
}) => {
  const { admin, builder } = peopleIn("activityAgain");
  const appName = `Minutes ${crypto.randomUUID()}`;
  const builds = apiOf(builder);
  const decides = apiOf(admin);
  let appId: string;
  try {
    ({ id: appId } = await builds.api.apps.create({
      name: appName,
      description: "Invites guests to the minutes",
    }));
    await release(builds.api, appId, { "README.md": "One" }, "First");
    const { id } = await builds.api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "platform" },
      actions: ["guests"],
      binding: "GUESTS",
    });
    await decides.api.permissions.grant(id, { version: 1 });
    // The builder can't grant it, so a new version asks for it again.
    await release(builds.api, appId, { "README.md": "Two" }, "Second");
  } finally {
    decides.core[Symbol.dispose]();
  }

  try {
    const page = await pageOf(admin);
    // An old link to them leads there too.
    await page.goto("/activity?tab=pending");
    await expect(page).toHaveURL(/\/dashboard$/u);
    const card = await toCard(
      page,
      new RegExp(`^${appName}: guests on Guest chats\\.`, "u")
    );
    await expect(card).toContainText(
      /Asked again after version 2 was made current \(previously granted by .+ on .+\)/u
    );
    await expect(card).toContainText("Version to review: 2");

    // Another version is made current while the admin looks at version 2.
    await release(builds.api, appId, { "README.md": "Three" }, "Third");
    await card.getByRole("button", { name: /^Approve /u }).click();
    await expect(card.getByRole("alert")).toHaveText(
      "Another version of this domain was made current since this list was read. The list now shows it: review that version, then approve again."
    );
    await expect(card).toContainText("Version to review: 3");
    await expect(card).toContainText("Asked again after version 3");
    await expect(
      page.getByRole("status").filter({ hasText: "Approved:" })
    ).toHaveCount(0);

    await card.getByRole("button", { name: /^Approve /u }).click();
    await expect(
      page.getByRole("status").filter({
        hasText: `Approved: ${appName}: guests on Guest chats.`,
      })
    ).toHaveCount(1);
    await expect(card).toHaveCount(0);
  } finally {
    builds.core[Symbol.dispose]();
  }
});
