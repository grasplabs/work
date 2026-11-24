import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { test } from "./csp.ts";
import { inboxList, saidOf } from "./inbox.ts";
import { apiOf, peopleIn } from "./people.ts";
import { expectNoError } from "./said.ts";

// The Inbox, from the nav: what waits on the person as a list, the item
// open beside it, and the walk through what waits: its place in the list,
// the next and the one before (by button, or J and K), Skip, which puts it
// at the back, the open item in the address, and a settled item leaving
// for the one after it. Other tests' items may wait in it too, so each
// test reads the list as it stands.

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

/** The address the row of item `id` leads to ends so. */
const rowOf = (page: Page, id: string): Locator =>
  inboxList(page).locator(`a[href$="item=${encodeURIComponent(id)}"]`);

/** Each row's item, in the list's order. */
const listedIds = async (page: Page): Promise<string[]> => {
  const hrefs = await inboxList(page)
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  return hrefs.map(
    (href) => new URL(href ?? "", "http://x").searchParams.get("item") ?? ""
  );
};

/** The item listed last. */
const lastId = async (page: Page): Promise<string | undefined> => {
  const listed = await listedIds(page);
  return listed.at(-1);
};

/** The item open now, as the address has it. */
const openId = (page: Page): string =>
  new URL(page.url()).searchParams.get("item") ?? "";

test("a person with nothing waiting finds their Inbox from the nav, with nothing in it and no weekly report", async ({
  pageOf,
}) => {
  const { user } = peopleIn("inboxEmpty");
  const page = await pageOf(user);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Inbox", exact: true })
    .click();
  await expect(page).toHaveURL(/\/inbox$/u);
  await expect(page.getByText("Nothing waits for you")).toBeVisible(pageRead);
  // No plan for the interviews yet: no programme week, and no report (with
  // a plan, e2e/onboarding.e2e.ts, which runs after this file).
  await expect(
    page.getByRole("list", { name: "Your weekly report" })
  ).toHaveCount(0);
  await expectNoError(page);
});

test("an admin walks through what waits: the next and the one before, Skip to the back, the open item kept in the address, and a declined one leaving for the one after", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("inbox");
  const tag = crypto.randomUUID().slice(0, 8);
  const ids: string[] = [];
  const { core, api } = apiOf(admin);
  try {
    for (const name of ["Atlas", "Beacon", "Compass"]) {
      // oxlint-disable-next-line no-await-in-loop -- one App, then its request
      const { id: appId } = await api.apps.create({
        name: `${name} ${tag}`,
        description: "Reads the statistics",
      });
      // oxlint-disable-next-line no-await-in-loop -- one App, then its request
      const { id } = await api.permissions.request({
        subject: { type: "app", appId },
        object: { type: "platform" },
        actions: ["statistics"],
        binding: "STATS",
      });
      ids.push(`request:${id}`);
    }
  } finally {
    core[Symbol.dispose]();
  }
  const [atlas = "", beacon = ""] = ids;
  const page = await pageOf(admin);

  // A row opens its item beside the list, and the address keeps it.
  await page.goto("/inbox");
  await rowOf(page, atlas).click(pageRead);
  await expect(page).toHaveURL(
    new RegExp(`item=${encodeURIComponent(atlas)}`, "u")
  );
  const head = page.getByText(/^\d+ of \d+$/u);
  const order = await listedIds(page);
  const at = order.indexOf(atlas);
  await expect(head).toHaveText(`${at + 1} of ${order.length}`);
  await expect(
    page.getByRole("group", { name: new RegExp(`^Grant Atlas ${tag}`, "u") })
  ).toBeVisible();

  // From the first, the next one by its button, then back with K and on
  // again with J; the button goes round from the last to the first.
  const [first = "", second = ""] = order;
  await rowOf(page, first).click();
  await page.getByRole("button", { name: "The next one" }).click();
  await expect.poll(() => openId(page)).toBe(second);
  await expect(head).toHaveText(`2 of ${order.length}`);
  await page.keyboard.press("k");
  await expect.poll(() => openId(page)).toBe(first);
  await page.keyboard.press("j");
  await expect.poll(() => openId(page)).toBe(second);
  await rowOf(page, order.at(-1) ?? "").click();
  await page.getByRole("button", { name: "The next one" }).click();
  await expect.poll(() => openId(page)).toBe(first);

  // Skipped, an item goes to the back of the list for this visit.
  await rowOf(page, atlas).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect.poll(async () => await lastId(page)).toBe(atlas);
  await expect.poll(() => openId(page)).not.toBe(atlas);

  // A reload keeps the open item.
  await page.goto(`/inbox?item=${encodeURIComponent(beacon)}`);
  const approval = page.getByRole("group", {
    name: new RegExp(`^Grant Beacon ${tag}`, "u"),
  });
  await expect(approval).toBeVisible(pageRead);
  await page.reload();
  await expect(approval).toBeVisible(pageRead);

  // Declined, it leaves the list, and the one after it opens in its place.
  await approval.getByRole("button", { name: "Decline" }).click();
  await expect(
    saidOf(page).filter({ hasText: `Declined: Grant Beacon ${tag}` })
  ).toHaveCount(1);
  await expect(rowOf(page, beacon)).toHaveCount(0);
  await expect(approval).toHaveCount(0);
  await expect(
    page.getByRole("complementary").getByRole("group").first()
  ).toBeVisible();
  await expectNoError(page);
});
