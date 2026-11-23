import { readFile } from "node:fs/promises";

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";

// The Activity page: an admin approves one App's permission request in
// the inbox and rejects another, finds the approval in the audit log with
// its details, and exports what the log's filters match. Search, export
// and the grant themselves are core's tests.

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

/**
 * A name that starts `start` and goes on with what its permission's object
 * is for, if anything: the inbox names a request by what asks for what, on
 * what, and that object's own description.
 */
const startingWith = (start: string): RegExp =>
  new RegExp(`^${start}(?:\\. |\\?$|$)`, "u");

/**
 * Opens, in the inbox on `page`, the permission request `who` asks (its
 * row among other tests' items), and gives the item.
 */
const toRequest = async (page: Page, who: string): Promise<Locator> => {
  await page
    .getByRole("region", { name: "What waits on you" })
    .getByRole("button", { name: new RegExp(`^${who}`, "u") })
    .click(pageRead);
  const item = page.getByRole("article", {
    name: startingWith(`Grant ${who}`),
  });
  await expect(item).toBeVisible();
  return item;
};

/** The item's Approve: its next step, which its bar holds too. */
const approveOf = (item: Locator, who: string): Locator =>
  item.getByRole("button", { name: startingWith(`Approve ${who}`) }).first();

test("an admin approves a permission request, finds it in the audit log, and exports it", async ({
  pageOf,
}) => {
  const { admin, builder } = peopleIn("activity");
  const appName = `Board pack ${crypto.randomUUID()}`;
  const { core, api } = apiOf(builder);
  let approved: string;
  try {
    const { id: appId } = await api.apps.create({
      name: appName,
      description: "Reads the board pack",
    });
    ({ id: approved } = await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "platform" },
      actions: ["statistics"],
      binding: "BOARD_PACK",
    }));
    await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(admin);
  // An admin's permission requests wait in the inbox.
  await page.goto("/inbox");
  const statistics = `${appName}: statistics on Platform statistics`;
  const reading = await toRequest(page, statistics);
  await expect(reading).toContainText("as BOARD_PACK");
  await expect(reading).toContainText("Version to review: None live");
  await approveOf(reading, statistics).click();
  await expect(
    page.getByRole("status").filter({
      hasText: `Approved: ${appName}: statistics on Platform statistics.`,
    })
  ).toHaveCount(1);
  await expect(reading).toHaveCount(0);

  const brain = `${appName}: brain on Company Brain, read only`;
  const recalling = await toRequest(page, brain);
  await recalling
    .getByRole("button", { name: startingWith(`Reject ${brain}`) })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Reject", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: `Rejected: ${appName}` })
  ).toHaveCount(1);
  await expect(recalling).toHaveCount(0);

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
  // A link to the audit trail keeps its filters: the events about the
  // request, by its ID, set under Filters.
  await page.goto(`/settings/audit?target=${approved}`);
  await page.getByRole("button", { name: "Filters, 1 set" }).click();
  await expect(page.getByRole("textbox", { name: "About, by ID" })).toHaveValue(
    approved
  );
  await page.keyboard.press("Escape");
  // Each event in words, by who did it and to what kind of thing.
  const rows = page.getByRole("table", { name: "Events" }).getByRole("row");
  const granted = rows.filter({ hasText: "Granted a permission" });
  await expect(granted).toHaveCount(1);
  await expect(granted).toContainText("Permission");
  await expect(rows.filter({ hasText: "Asked for a permission" })).toHaveCount(
    1
  );
  // Its details beside the table, or in a sheet on a narrow page: what it
  // recorded, and its action to copy.
  await granted.getByRole("button", { name: /^Details of event /u }).click();
  await expect(
    page.getByRole("listitem").filter({ hasText: "RequestedBy" })
  ).toContainText(builder.userId);
  await expect(page.getByRole("region", { name: "Integrity" })).toContainText(
    "permission.granted"
  );
  await page.keyboard.press("Escape");

  // Narrowed to grants, the request drops out; the action is taken as
  // core takes it, whatever its case and a trailing dot.
  await page.goto(
    `/settings/audit?target=${approved}&action=${encodeURIComponent("Permission.Granted.")}`
  );
  await expect(
    page.getByRole("button", { name: "Filters, 2 set" })
  ).toBeVisible();
  await expect(granted).toHaveCount(1);
  await expect(rows.filter({ hasText: "Asked for a permission" })).toHaveCount(
    0
  );

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "CSV" }).click();
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
  await page.getByRole("button", { name: /^Filters, \d set$/u }).click();
  await expect(page.getByRole("textbox", { name: "Action" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(granted).toHaveCount(1);
  await expect(page.getByRole("alert").filter({ hasText: /\S/u })).toHaveCount(
    0
  );
});

test("an admin approves an App's request only for the version the list shows", async ({
  pageOf,
}) => {
  const { admin, builder } = peopleIn("activityAgain");
  const appName = `Minutes ${crypto.randomUUID()}`;
  const builds = apiOf(builder);
  try {
    const { id: appId } = await builds.api.apps.create({
      name: appName,
      description: "Reads the Brain for the minutes",
    });
    await release(builds.api, appId, { "README.md": "One" });
    await builds.api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });

    const page = await pageOf(admin);
    await page.goto("/inbox");
    const brain = `${appName}: brain on Company Brain, read only`;
    const card = await toRequest(page, brain);
    const approve = approveOf(card, brain);
    // Versions as people know them: YY.MM.N, the first this month.
    await expect(card).toContainText(/Version to review: \d{2}\.\d{2}\.1/u);

    // Another version is published while the admin looks at version 1.
    await release(builds.api, appId, { "README.md": "Two" });
    await approve.click();
    await expect(card.getByRole("alert")).toHaveText(
      "Another version of this App was published since this list was read. The list now shows it: review that version, then approve again."
    );
    await expect(card).toContainText(/Version to review: \d{2}\.\d{2}\.2/u);
    await expect(
      page.getByRole("status").filter({ hasText: "Approved:" })
    ).toHaveCount(0);

    await approve.click();
    await expect(
      page.getByRole("status").filter({
        hasText: `Approved: ${appName}: brain on Company Brain, read only.`,
      })
    ).toHaveCount(1);
    await expect(card).toHaveCount(0);
  } finally {
    builds.core[Symbol.dispose]();
  }
});
