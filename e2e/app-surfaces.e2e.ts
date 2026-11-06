import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { navigationFiles, surfaceFiles } from "./notes-app.ts";
import { apiOf, peopleIn, release } from "./people.ts";

// An App's surfaces (spec 34.1) in a real browser: a page as a panel in
// the shell, moving within itself while the page under it stays, asking
// before it closes on edits, the App's sidebar entries and its settings
// page. What core refuses is core's own tests (page-surfaces.test.ts).

const surfacedApp = async () => {
  const { builder } = peopleIn("appSurfaces");
  const name = `Surfaces ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  try {
    const { id: app } = await api.apps.create({ name });
    await release(api, app, surfaceFiles(), name);
    const { id: chat } = await api.chats.create(name);
    return { builder, name, app, chat };
  } finally {
    core[Symbol.dispose]();
  }
};

/**
 * Opens the App `name`'s panel from the chat's side panel, beside the
 * chat on a wide window, a sheet over it on a narrow one.
 */
const openPanel = async (page: Page, chat: string, name: string) => {
  await page.goto(`/?chat=${chat}`);
  await page.getByRole("button", { name: "Side panel" }).click();
  await page
    .getByRole("complementary", { name: "Side panel" })
    .or(page.getByRole("dialog", { name: "Side panel" }))
    .getByRole("button", { name })
    .click();
};

test("a page opens in the shell's panel, moves within it while the page stays, and asks before it closes on edits", async ({
  pageOf,
}) => {
  const { builder, name, chat } = await surfacedApp();
  const page = await pageOf(builder);
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPanel(page, chat, name);

  // The App's panel surface, in the shell's panel, in place of the chat's:
  // one panel at a time.
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await expect(
    panel.getByRole("heading", { name: "Start beside" })
  ).toBeVisible();
  await expect(panel).toHaveCount(1);
  const beside = panel.frameLocator('iframe[title="App"]');
  await expect(beside.getByRole("heading", { name: "Start" })).toBeVisible({
    timeout: 20_000,
  });

  // A link in it moves the App in the panel; the page stays where it is.
  await beside.getByRole("link", { name: "Open note n42" }).click();
  await expect(beside.getByRole("heading", { name: "Note n42" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page).toHaveURL(new RegExp(`/\\?chat=${chat}$`, "u"));

  // Closing it on unsaved edits asks first; staying keeps it and its edits.
  await beside.getByLabel("Title").fill("Groceries");
  // The frame tells the page of its edit over its channel, a moment after
  // the keystroke; a person never closes faster than that.
  await page.waitForTimeout(500);
  const leave = page.getByRole("alertdialog", { name: "Leave this page?" });
  await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(beside.getByLabel("Title")).toHaveValue("Groceries");

  // The window narrowing doesn't start it again, losing the edit: it stays
  // beside the page while its page holds edits.
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(beside.getByLabel("Title")).toHaveValue("Groceries");
  await expect(page.getByRole("dialog", { name: "Side panel" })).toHaveCount(0);

  // Closed, its frame goes.
  await panel.getByRole("button", { name: "Close panel" }).click();
  await leave.getByRole("button", { name: "Leave" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('iframe[title="App"]')).toHaveCount(0);

  // Opened on a narrow window, it is a sheet: its own close asks too.
  await openPanel(page, chat, name);
  const sheet = page.getByRole("dialog", { name: "Side panel" });
  const inSheet = sheet.frameLocator('iframe[title="App"]');
  await inSheet
    .getByRole("link", { name: "Open note n42" })
    .click({ timeout: 20_000 });
  await inSheet.getByLabel("Title").fill("Groceries", { timeout: 20_000 });
  await page.waitForTimeout(500);
  // The sheet's own close, not the panel's.
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Leave" }).click();
  await expect(page.locator('iframe[title="App"]')).toHaveCount(0);
});

test("the panel closes once its App is no longer shared with the person", async ({
  pageOf,
}) => {
  const { builder, user } = peopleIn("appSurfaces");
  const name = `Surfaces ${crypto.randomUUID().slice(0, 8)}`;
  const owner = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await owner.api.apps.create({ name }));
    await release(owner.api, app, surfaceFiles(), name);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
  } finally {
    owner.core[Symbol.dispose]();
  }
  const theirs = apiOf(user);
  let chat: string;
  try {
    ({ id: chat } = await theirs.api.chats.create(name));
  } finally {
    theirs.core[Symbol.dispose]();
  }
  const page = await pageOf(user);
  await page.clock.install();
  await page.setViewportSize({ width: 1600, height: 900 });
  await openPanel(page, chat, name);
  const panel = page.getByRole("complementary", { name: "Side panel" });
  const beside = panel.frameLocator('iframe[title="App"]');
  await expect(beside.getByRole("heading", { name: "Start" })).toBeVisible({
    timeout: 20_000,
  });
  // A page of it in the main pane too, from its sidebar entry.
  await page
    .getByRole("list", { name: "App shortcuts" })
    .getByRole("link", { name: "All notes" })
    .click();
  const main = page.locator('main iframe[title="App"]');
  await expect(
    page
      .frameLocator('main iframe[title="App"]')
      .getByRole("heading", { name: "Notes" })
  ).toBeVisible({ timeout: 20_000 });

  const again = apiOf(builder);
  try {
    await again.api.apps.members.remove(app, {
      type: "person",
      id: user.userId,
    });
  } finally {
    again.core[Symbol.dispose]();
  }
  // Unshared: the App's version subscription refuses the person, and the
  // page stops its pages, with no timer to wait for: the panel goes.
  await expect(panel).toHaveCount(0, { timeout: 20_000 });
  // The main pane's page stopped too: its frame emptied, no code of it
  // running on behind the message.
  await expect(main).not.toHaveAttribute("src");
});

test("an App's sidebar entry opens its page, and its settings page is its settings' Options", async ({
  pageOf,
}) => {
  const { builder, name, app } = await surfacedApp();
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/settings`);
  const shortcuts = page.getByRole("list", { name: "App shortcuts" });
  await expect(shortcuts.getByRole("link", { name })).toBeVisible();
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("link", { name: "Options" }).click();
  const settings = page.frameLocator('iframe[title="App"]');
  await expect(
    settings.getByRole("heading", { name: "Preferences" })
  ).toBeVisible({ timeout: 20_000 });

  await shortcuts
    .getByRole("listitem")
    .filter({ hasText: name })
    .getByRole("link", { name: "All notes" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}$`, "u"));
  await expect(page.locator('iframe[title="App"]')).toHaveCount(1);

  // An App without settings, its Options asked for by address: none to
  // list, and it says so.
  const { core, api } = apiOf(builder);
  let plain: string;
  try {
    ({ id: plain } = await api.apps.create({ name: `${name} plain` }));
    await release(api, plain, navigationFiles(), name);
  } finally {
    core[Symbol.dispose]();
  }
  await page.goto(`/apps/${plain}/settings?section=options`);
  await expect(page.getByText("This App offers no options.")).toBeVisible();
  await expect(sections.getByRole("link", { name: "Options" })).toHaveCount(0);

  // A section the page doesn't know, by address, as text or as what reads
  // as a number: General.
  const general = sections.getByRole("link", { name: "General" });
  await page.goto(`/apps/${app}/settings?section=pages`);
  await expect(general).toHaveAttribute("aria-current", "page");
  await page.goto(`/apps/${app}/settings?section=1`);
  await expect(general).toHaveAttribute("aria-current", "page");
});
