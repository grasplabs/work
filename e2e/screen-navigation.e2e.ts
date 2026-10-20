import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { hoppingFiles, navigationFiles } from "./notes-app.ts";
import { apiOf, peopleIn, release } from "./people.ts";

// Moving between an App's screens (spec 10.7.7) in a real browser: a screen
// opens another by its route with typed input, which the page has core
// check before it goes there, and the screen it opens gets that input as
// its props. Leaving a screen whose form holds unsaved edits is confirmed
// once, in Grasp's own dialog outside the frame: staying keeps the screen
// and its edits, leaving goes on. What core refuses, and what the page
// passes on, are core's and the web's own tests.

test("a screen opens another with its input, and leaving unsaved edits is confirmed once", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("screenNavigation");
  const name = `Notes ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({ name }));
    await release(api, app, navigationFiles(), name);
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(builder);
  await page.clock.install();
  await page.goto(`/domains/${app}/apps/home/full`);
  const start = page.frameLocator('iframe[title="home app"]');
  await expect(start.getByRole("heading", { name: "Start" })).toBeVisible({
    timeout: 20_000,
  });

  // Opened by its route, in the page's own address, with its input.
  await start
    .getByRole("button", { name: "Open note n42", exact: true })
    .click();
  // What it opens with is in the page's history, never its address.
  await expect(page).toHaveURL(/\/apps\/note\/full$/u);
  const note = page.frameLocator('iframe[title="note app"]');
  await expect(note.getByRole("heading", { name: "Note n42" })).toBeVisible({
    timeout: 20_000,
  });

  // Asked for where it already is, it is there: nothing is refused.
  await note.getByRole("button", { name: "Open this note again" }).click();
  await page.waitForTimeout(1500);
  await expect(note.getByText("Refused 0")).toBeVisible();

  // Unsaved: going back asks once; staying keeps the screen and the edit.
  const leave = page.getByRole("alertdialog", { name: "Leave this app?" });
  await note.getByLabel("Title").fill("Groceries");
  await note.getByRole("button", { name: "Back to start" }).click();
  await expect(leave).toBeVisible();
  await expect(leave).toHaveCount(1);
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(leave).toBeHidden();
  await expect(note.getByLabel("Title")).toHaveValue("Groceries");
  await expect(note.getByText("Refused 1")).toBeVisible();

  // Asked again at once, the screen is refused without the question.
  await note.getByRole("button", { name: "Back to start" }).click();
  await expect(note.getByText("Refused 2")).toBeVisible();
  await expect(leave).toHaveCount(0);

  // A while later it asks again, and leaving goes on to the screen asked for.
  await page.clock.fastForward(10_000);
  await note.getByRole("button", { name: "Back to start" }).click();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Leave" }).click();
  await expect(start.getByRole("heading", { name: "Start" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(leave).toBeHidden();
});

test("a screen loaded again holds none of the edits it lost, so leaving it asks nothing", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("screenNavigation");
  const name = `Notes ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({ name }));
    await release(api, app, navigationFiles(), name);
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(builder);
  await page.clock.install();
  await page.goto(`/domains/${app}/apps/home/full`);
  const start = page.frameLocator('iframe[title="home app"]');
  await start
    .getByRole("button", { name: "Open note n42", exact: true })
    .click();
  const note = page.frameLocator('iframe[title="note app"]');
  await note.getByLabel("Title").fill("Groceries");

  const again = apiOf(builder);
  try {
    const files = navigationFiles();
    await release(
      again.api,
      app,
      { ...files, "screens/home.tsx": `${files["screens/home.tsx"]}\n` },
      "Again"
    );
  } finally {
    again.core[Symbol.dispose]();
  }
  // The frame asks for a new version every 30 seconds.
  await page.clock.fastForward(30_000);
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(note.getByLabel("Title")).toHaveValue("");

  await note.getByRole("button", { name: "Back to start" }).click();
  await expect(start.getByRole("heading", { name: "Start" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByRole("alertdialog", { name: "Leave this app?" })
  ).toHaveCount(0);
});

test("a screen in the chat's side panel opens what it navigates to in the main pane as a new entry, never in place of the chat's", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("screenNavigation");
  const name = `Notes ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  let app: string;
  let chat: string;
  try {
    ({ id: app } = await api.apps.create({ name }));
    await release(api, app, navigationFiles(), name);
    ({ id: chat } = await api.chats.create(name));
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(builder);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?chat=${chat}`);
  await page.getByRole("button", { name: "Side panel" }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByRole("button", { name }).click();
  const home = panel.frameLocator('iframe[title="home app"]');
  // The screen asks to replace the page's entry: the panel's never does.
  await home.getByRole("button", { name: "Open note n42 in place" }).click();
  await expect(page).toHaveURL(new RegExp(`/domains/${app}/apps/note$`, "u"));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/\\?chat=${chat}`, "u"));
});

test("screens that navigate as they mount go once in the tab, so they can't fill the history or keep the person from going back", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("screenNavigation");
  const name = `Hops ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({ name }));
    await release(api, app, hoppingFiles(), name);
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(builder);
  // The person doesn't act at all. This browser reports the activation from
  // opening the page for as long as the page is open, so the page is told
  // what a person who never clicked would leave it with.
  await page.addInitScript(() => {
    Object.defineProperty(UserActivation.prototype, "isActive", {
      get: () => false,
    });
  });
  await page.goto(`/domains/${app}/apps/takeoff/full`);
  // The start goes on its own, once: the hop it opens may not go on.
  const hop = page.frameLocator('iframe[title="hop app"]');
  await expect(hop.getByRole("heading", { name: "Hop 1" })).toBeVisible({
    timeout: 20_000,
  });
  // A hop asks as it mounts; give a second one the time it would take.
  await page.waitForTimeout(3000);
  await expect(hop.getByRole("heading", { name: "Hop 1" })).toBeVisible();
  await expect(page).not.toHaveURL(/%5C%222%5C%22/u);

  // Back leaves the hop for good: the start, mounting again and asking
  // again, stays put.
  await page.goBack();
  const takeoff = page.frameLocator('iframe[title="takeoff app"]');
  await expect(takeoff.getByRole("heading", { name: "Takeoff" })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(3000);
  await expect(takeoff.getByRole("heading", { name: "Takeoff" })).toBeVisible();
  await expect(page).toHaveURL(/\/apps\/takeoff\/full$/u);
});
