import { readFile } from "node:fs/promises";

import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { saidOf, toItem } from "./inbox.ts";
import { apiOf, peopleIn } from "./people.ts";
import { expectNoError } from "./said.ts";

// The Activity page: an admin grants one App's permission request in the
// Inbox and declines another, finds the approval in the audit log with
// its details, and exports what the log's filters match. Search, export
// and the grant themselves are core's tests, a grant refused once another
// version was published since the list was read among them
// (apps/core/test/app-version-approval.test.ts).

test("an admin approves a permission request, finds it in the audit log, and exports it", async ({
  pageOf,
}) => {
  const { admin, builder } = peopleIn("activity");
  const appName = `Board pack ${crypto.randomUUID()}`;
  // Another App asks to read the Brain: each row names one request.
  const brainApp = `Board notes ${crypto.randomUUID()}`;
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
    const { id: brainAppId } = await api.apps.create({
      name: brainApp,
      description: "Reads the Brain for the board meeting",
    });
    await api.permissions.request({
      subject: { type: "app", appId: brainAppId },
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(admin);
  // An admin's permission requests wait in the Inbox, among other tests'.
  await page.goto("/inbox");
  const reading = await toItem(
    page,
    new RegExp(`^${appName}$`, "u"),
    new RegExp(`^Grant ${appName}: statistics on Platform statistics\\.`, "u")
  );
  await reading.getByRole("button", { name: "Details" }).click();
  // A binding's name in code says nothing to a person: it isn't shown.
  await expect(reading).toContainText("Version to review: None live");
  await reading.getByRole("button", { name: "Grant it" }).click();
  await expect(
    saidOf(page).filter({
      hasText: `Approved: Grant ${appName}: statistics on Platform statistics.`,
    })
  ).toHaveCount(1);
  await expect(reading).toHaveCount(0);

  const recalling = await toItem(
    page,
    new RegExp(`^${brainApp}$`, "u"),
    new RegExp(`^Grant ${brainApp}: brain on Company Brain, read only\\.`, "u")
  );
  await recalling.getByRole("button", { name: "Decline" }).click();
  await expect(
    saidOf(page).filter({ hasText: `Declined: Grant ${brainApp}` })
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
  // A link to the audit trail keeps its filters.
  await page.goto(`/settings/audit?target=${approved}`);
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
  await expectNoError(page);
});
