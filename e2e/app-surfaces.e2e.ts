import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { navigationFiles, surfaceFiles } from "./notes-app.ts";
import { apiOf, peopleIn, release } from "./people.ts";

// An App's surfaces (spec 34.1) in a real browser: the same screen as a
// route and in the shell's panel, the panel staying open while a screen
// in it opens a route in the main pane, closing it, the App's sidebar
// entries and settings tab, and a deep link opened signed out, which
// opens nothing until the person signed in and core checked it. What core
// refuses is core's own tests (screen-surfaces.test.ts).

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

test("a screen opens in the shell's panel and as a route alike, and the panel stays while the main pane navigates until it is closed", async ({
  pageOf,
}) => {
  const { builder, name, app, chat } = await surfacedApp();
  const page = await pageOf(builder);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/?chat=${chat}`);
  await page.getByRole("button", { name: "Side panel" }).click();
  await page
    .getByRole("complementary", { name: "Side panel" })
    .getByRole("button", { name })
    .click();

  // The App's panel surface, in the shell's panel, in place of the chat's:
  // one panel at a time.
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await expect(
    panel.getByRole("heading", { name: "Start beside" })
  ).toBeVisible();
  await expect(panel).toHaveCount(1);
  const beside = panel.frameLocator('iframe[title="home app"]');
  await expect(beside.getByRole("heading", { name: "Start" })).toBeVisible({
    timeout: 20_000,
  });

  // A route from the panel opens in the main pane; the panel stays.
  await beside
    .getByRole("button", { name: "Open note n42", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/domains/${app}/apps/note$`, "u"));
  const main = page.getByRole("main").frameLocator('iframe[title="note app"]');
  await expect(main.getByRole("heading", { name: "Note n42" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(beside.getByRole("heading", { name: "Start" })).toBeVisible();

  // A screen opens another of its surfaces in the panel, in place of the first.
  await beside.getByRole("button", { name: "Peek at note n9" }).click();
  await expect(panel.getByRole("heading", { name: "Peek" })).toBeVisible();
  const peek = panel.frameLocator('iframe[title="note app"]');
  await expect(peek.getByRole("heading", { name: "Note n9" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('iframe[title="home app"]')).toHaveCount(0);

  // Unsaved edits in the panel hold up nothing of the page's own: the main
  // pane goes on, the panel and its edits stay.
  await peek.getByLabel("Title").fill("Groceries");
  const leave = page.getByRole("alertdialog", { name: "Leave this app?" });
  await main.getByRole("button", { name: "Back to start" }).click();
  await expect(
    page
      .getByRole("main")
      .frameLocator('iframe[title="home app"]')
      .getByRole("heading", { name: "Start" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(leave).toHaveCount(0);
  await expect(peek.getByLabel("Title")).toHaveValue("Groceries");

  // Closing the panel then asks first; staying keeps it and its edits.
  await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(peek.getByLabel("Title")).toHaveValue("Groceries");

  // Closed, its frame goes; the main pane's screen stays.
  await panel.getByRole("button", { name: "Close panel" }).click();
  await leave.getByRole("button", { name: "Leave" }).click();
  await expect(panel).toHaveCount(0);
  await expect(
    page
      .getByRole("main")
      .frameLocator('iframe[title="home app"]')
      .getByRole("heading", { name: "Start" })
  ).toBeVisible();
});

test("a panel's screen goes nowhere on the person's act elsewhere on the page", async ({
  pageOf,
}) => {
  const { builder, name, app, chat } = await surfacedApp();
  const page = await pageOf(builder);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/?chat=${chat}`);
  await page.getByRole("button", { name: "Side panel" }).click();
  await page
    .getByRole("complementary", { name: "Side panel" })
    .getByRole("button", { name })
    .click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  const beside = panel.frameLocator('iframe[title="home app"]');
  const later = beside.getByRole("button", { name: "Open note n77 later" });

  // Asked a moment after the person's click in the panel: it goes.
  await later.click({ timeout: 20_000 });
  const main = page.getByRole("main").frameLocator('iframe[title="note app"]');
  await expect(main.getByRole("heading", { name: "Note n77" })).toBeVisible({
    timeout: 20_000,
  });

  // Asked after the person went on to click elsewhere on the page: the
  // act the browser still remembers is theirs on the page, not the
  // panel's, so it goes nowhere.
  await beside.getByRole("button", { name: "Open the list later" }).click();
  await main.getByRole("heading", { name: "Note n77" }).click();
  await page.waitForTimeout(2500);
  await expect(page).toHaveURL(new RegExp(`/domains/${app}/apps/note$`, "u"));
  await expect(page.locator('iframe[title="notes app"]')).toHaveCount(0);
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
  await page.goto(`/?chat=${chat}`);
  await page.getByRole("button", { name: "Side panel" }).click();
  await page
    .getByRole("complementary", { name: "Side panel" })
    .getByRole("button", { name })
    .click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  const beside = panel.frameLocator('iframe[title="home app"]');
  await expect(beside.getByRole("heading", { name: "Start" })).toBeVisible({
    timeout: 20_000,
  });
  // A screen of it in the main pane too.
  await beside
    .getByRole("button", { name: "Open note n42", exact: true })
    .click();
  const main = page.locator('main iframe[title="note app"]');
  await expect(
    page
      .frameLocator('main iframe[title="note app"]')
      .getByRole("heading", { name: "Note n42" })
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
  // The frame checks on its App every 30 seconds.
  await page.clock.fastForward(30_000);
  await expect(page.locator('iframe[title="home app"]')).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(panel.getByRole("button", { name: "Close panel" })).toHaveCount(
    0
  );
  // The main pane's screen stopped too: its frame emptied, no code of it
  // running on behind the message.
  await expect(main).not.toHaveAttribute("src");
});

test("an App's sidebar entry opens its screen, and its settings screen is a tab on its page", async ({
  pageOf,
}) => {
  const { builder, name, app } = await surfacedApp();
  const page = await pageOf(builder);
  await page.goto(`/domains/${app}`);
  const shortcuts = page.getByRole("list", { name: "Domain shortcuts" });
  await expect(shortcuts.getByRole("link", { name })).toBeVisible();
  await page.getByRole("tab", { name: "Settings" }).click();
  // Opened by its address, with nothing: its defaults.
  const settings = page.frameLocator('iframe[title="prefs app"]');
  await expect(
    settings.getByRole("heading", { name: "Preferences general" })
  ).toBeVisible({
    timeout: 20_000,
  });

  await shortcuts
    .getByRole("listitem")
    .filter({ hasText: name })
    .getByRole("link", { name: "All notes" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/domains/${app}/apps/notes$`, "u"));
  await expect(page.locator('iframe[title="notes app"]')).toHaveCount(1);

  // A screen's navigation to the App's settings opens its page's tab.
  await page.goto(`/domains/${app}/apps/home`);
  await page
    .frameLocator('iframe[title="home app"]')
    .getByRole("button", { name: "Open preferences" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/domains/${app}\\?tab=settings$`, "u")
  );
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  // A domain without settings, its settings asked for by address.
  const { core, api } = apiOf(builder);
  let plain: string;
  try {
    ({ id: plain } = await api.apps.create({ name: `${name} plain` }));
    await release(api, plain, navigationFiles(), name);
  } finally {
    core[Symbol.dispose]();
  }
  await page.goto(`/domains/${plain}?tab=settings`);
  // No Settings tab: the page opens on its first.
  await expect(page.getByRole("tab", { name: /^Apps/u })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveCount(0);

  // A tab the page doesn't know, by address: the page, on its first tab.
  await page.goto(`/domains/${app}?tab=workflows`);
  await expect(page.getByRole("tab", { name: /^Apps/u })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});

test("a deep link opened signed out leads through sign-in, then to its screen with its input once core checked it", async ({
  page,
  pageOf,
}) => {
  const { builder, app } = await surfacedApp();
  const link = `/links/${app}/shared?input=${encodeURIComponent(JSON.stringify({ id: "n7" }))}`;
  // A refused sign-in's error on the link isn't carried back to it.
  await page.goto(`${link}&error=forbidden`);
  await expect(
    page.getByText("Use your organization’s account to go on.")
  ).toBeVisible();
  const returnTo = new URL(page.url()).searchParams.get("returnTo");
  expect(returnTo).toBe(link);
  // Nothing of the App ran for someone signed out.
  await expect(page.locator("iframe")).toHaveCount(0);

  const signedIn = await pageOf(builder);
  await signedIn.goto(
    `/sign-in?returnTo=${encodeURIComponent(returnTo ?? "")}`
  );
  await expect(signedIn).toHaveURL(
    new RegExp(`/domains/${app}/apps/note$`, "u")
  );
  const note = signedIn.frameLocator('iframe[title="note app"]');
  await expect(note.getByRole("heading", { name: "Note n7" })).toBeVisible({
    timeout: 20_000,
  });
  // Loaded again, the entry still opens it as core resolved it.
  await signedIn.reload();
  await expect(note.getByRole("heading", { name: "Note n7" })).toBeVisible({
    timeout: 20_000,
  });

  // An address written to open a screen with input of its own choosing
  // opens it with its default input only: the input comes from what the
  // page itself resolved with core, never from the address.
  await signedIn.goto(
    `/domains/${app}/apps/note?route=note&input=${encodeURIComponent(JSON.stringify({ id: "n666" }))}&surface=peek`
  );
  await expect(
    signedIn.getByText(
      "This link opens the app with something it doesn't take. Open the app from its domain instead."
    )
  ).toBeVisible({ timeout: 20_000 });
  await expect(note.getByRole("heading", { name: "Note n666" })).toHaveCount(0);

  // A surface the App doesn't declare as a deep link opens nothing.
  await signedIn.goto(`/links/${app}/start`);
  await expect(
    signedIn.getByRole("heading", {
      name: "This link doesn't open anything you can open",
    })
  ).toBeVisible();
  await expect(signedIn.locator("iframe")).toHaveCount(0);
});

test("a navigation to an App's settings opens them with its input, again after the person chose another tab", async ({
  pageOf,
}) => {
  const { builder, name, app, chat } = await surfacedApp();
  const page = await pageOf(builder);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/?chat=${chat}`);
  await page.getByRole("button", { name: "Side panel" }).click();
  await page
    .getByRole("complementary", { name: "Side panel" })
    .getByRole("button", { name })
    .click();
  const beside = page
    .getByRole("complementary", { name: "Side panel" })
    .frameLocator('iframe[title="home app"]');
  const billing = beside.getByRole("button", {
    name: "Open billing preferences",
  });
  await billing.click({ timeout: 20_000 });
  await expect(page).toHaveURL(
    new RegExp(`/domains/${app}\\?tab=settings$`, "u")
  );
  const settings = page.frameLocator('main iframe[title="prefs app"]');
  await expect(
    settings.getByRole("heading", { name: "Preferences billing" })
  ).toBeVisible({ timeout: 20_000 });

  // The person picks another tab; the panel's screen asks for the
  // settings again: they show again.
  await page.getByRole("tab", { name: /^Apps/u }).click();
  await billing.click();
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(
    settings.getByRole("heading", { name: "Preferences billing" })
  ).toBeVisible({ timeout: 20_000 });
});

test("closing the panel, or opening another in its place, asks first while its screen holds edits", async ({
  pageOf,
}) => {
  const { builder, app } = await surfacedApp();
  const page = await pageOf(builder);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/domains/${app}/apps/home`);
  const home = page.frameLocator('main iframe[title="home app"]');
  // The note's panel, with an edit in it.
  await home
    .getByRole("button", { name: "Peek at note n9" })
    .click({ timeout: 20_000 });
  const panel = page.getByRole("complementary", { name: "Side panel" });
  const peek = panel.frameLocator('iframe[title="note app"]');
  await peek.getByLabel("Title").fill("Groceries", { timeout: 20_000 });
  const leave = page.getByRole("alertdialog", { name: "Leave this app?" });
  await page.waitForTimeout(500);

  // Another panel asked for in its place: asked first; staying keeps it.
  await home.getByRole("button", { name: "Peek at note n9" }).click();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(peek.getByLabel("Title")).toHaveValue("Groceries");

  // On a narrow window it is a sheet: its own close asks too.
  await page.setViewportSize({ width: 600, height: 900 });
  const sheet = page.getByRole("dialog", { name: "Side panel" });
  const inSheet = sheet.frameLocator('iframe[title="note app"]');
  await inSheet.getByLabel("Title").fill("Groceries", { timeout: 20_000 });
  // The screen tells the page of its edit over its channel, a moment after
  // the keystroke; a person never closes faster than that.
  await page.waitForTimeout(500);
  // The sheet's own close, not the panel's.
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Leave" }).click();
  await expect(sheet).toHaveCount(0);
});
