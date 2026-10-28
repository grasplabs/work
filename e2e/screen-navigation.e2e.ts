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

test("a new version made current switches a clean screen at once, and asks an editor with unsaved edits once, which saves on the version it opened before it switches", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("screenNavigation");
  const name = `Notes ${crypto.randomUUID().slice(0, 8)}`;
  const files = navigationFiles();
  // The note's form saves, and holds nothing unsaved once it has.
  files["screens/note.tsx"] = (files["screens/note.tsx"] ?? "")
    .replace(
      'import { Form, TextField } from "@grasp-os/ui/form";',
      'import { Form, SubmitButton, TextField } from "@grasp-os/ui/form";'
    )
    .replace(
      '{ defaultValues: { title: "", body: "" } }',
      '{ defaultValues: { title: "", body: "" }, resetOnSuccess: true }'
    )
    .replace(
      '<TextField form={form} label="Title" name="title" />',
      '<TextField form={form} label="Title" name="title" />\n        <SubmitButton form={form}>Save note</SubmitButton>'
    );
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({ name }));
    await release(api, app, files, name);
  } finally {
    core[Symbol.dispose]();
  }
  /** Makes a new version current, its start screen changed by `mark`. */
  const releaseAgain = async (mark: string): Promise<void> => {
    const again = apiOf(builder);
    try {
      await release(
        again.api,
        app,
        {
          ...files,
          "screens/home.tsx": `${files["screens/home.tsx"]}// ${mark}\n`,
        },
        mark
      );
    } finally {
      again.core[Symbol.dispose]();
    }
  };

  // A clean screen in one tab: the start screen, which holds no form.
  const clean = await pageOf(builder);
  await clean.goto(`/domains/${app}/apps/home/full`);
  const start = clean.frameLocator('iframe[title="home app"]');
  await expect(start.getByRole("heading", { name: "Start" })).toBeVisible({
    timeout: 20_000,
  });
  const frameAddress = async (): Promise<string | null> =>
    await clean.locator('iframe[title="home app"]').getAttribute("src");
  const before = await frameAddress();

  // An editor with unsaved edits in another.
  const dirty = await pageOf(builder);
  await dirty.goto(`/domains/${app}/apps/home/full`);
  await dirty
    .frameLocator('iframe[title="home app"]')
    .getByRole("button", { name: "Open note n42", exact: true })
    .click();
  const note = dirty.frameLocator('iframe[title="note app"]');
  await note.getByLabel("Title").fill("Groceries");
  const ask = dirty.getByRole("alertdialog", {
    name: "A new version of this app is ready",
  });

  await releaseAgain("v2");

  // The clean screen switches by itself, to the new version's build, and
  // offers nothing.
  await expect.poll(frameAddress, { timeout: 20_000 }).not.toBe(before);
  await expect(start.getByRole("heading", { name: "Start" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(clean.getByRole("alertdialog")).toHaveCount(0);

  // The editor asks once, and saving first keeps its edits and the
  // version it opened, whose save runs, as its contract is the same.
  await expect(ask).toBeVisible({ timeout: 20_000 });
  await expect(ask).toHaveCount(1);
  await ask.getByRole("button", { name: "Save first" }).click();
  await expect(ask).toBeHidden();
  await expect(note.getByLabel("Title")).toHaveValue("Groceries");
  await expect(
    dirty.getByText("It opens once your changes are saved.", { exact: false })
  ).toBeVisible();
  await note.getByRole("button", { name: "Save note" }).click();
  // Saved, nothing is left unsaved, and it switches by itself.
  await expect(
    dirty.getByText("It opens once your changes are saved.", { exact: false })
  ).toBeHidden({ timeout: 20_000 });
  await expect(note.getByLabel("Title")).toHaveValue("", { timeout: 20_000 });
  await expect(ask).toHaveCount(0);
  // What it saved is there, in the App's list.
  await clean.goto(`/domains/${app}/apps/notes/full`);
  await expect(
    clean
      .frameLocator('iframe[title="notes app"]')
      .getByText("Groceries", { exact: true })
      .first()
  ).toBeVisible({ timeout: 20_000 });

  // Unsaved again, switching now drops the edits, and leaving the screen
  // afterwards asks nothing: nothing is left to lose.
  await note.getByLabel("Title").fill("Errands");
  await releaseAgain("v3");
  await expect(ask).toBeVisible({ timeout: 20_000 });
  await ask.getByRole("button", { name: "Switch now" }).click();
  await expect(ask).toBeHidden();
  await expect(note.getByLabel("Title")).toHaveValue("", { timeout: 20_000 });
  await note.getByRole("button", { name: "Back to start" }).click();
  await expect(
    dirty
      .frameLocator('iframe[title="home app"]')
      .getByRole("heading", { name: "Start" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    dirty.getByRole("alertdialog", { name: "Leave this app?" })
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

test("the screens a click opens can't each go on its activation: one click leaves at most one entry of the person's and one of the screen's own", async ({
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
  await page.goto(`/domains/${app}/apps/launch/full`);
  await page
    .frameLocator('iframe[title="launch app"]')
    .getByRole("button", { name: "Start hopping" })
    .click({ timeout: 20_000 });
  // The click opens Hop 1, still within its activation as Hop 1 mounts and
  // asks for Hop 2, which goes as the tab's one go on its own; Hop 2 may
  // not go on, however soon after the click it asks.
  const hop = page.frameLocator('iframe[title="hop app"]');
  await expect(hop.getByRole("heading", { name: "Hop 2" })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(3000);
  await expect(hop.getByRole("heading", { name: "Hop 2" })).toBeVisible();
  await expect(page).not.toHaveURL(/%5C%223%5C%22/u);
});

test("screens that focus themselves on one click's activation can't each go on it as the person's: the chain stops at one entry of the person's and one of the tab's own", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("screenNavigation");
  const name = `Focus hops ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({ name }));
    await release(api, app, hoppingFiles(), name);
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(builder);
  await page.goto(`/domains/${app}/apps/launch/full`);
  await page
    .frameLocator('iframe[title="launch app"]')
    .getByRole("button", { name: "Start focused hopping" })
    .click({ timeout: 20_000 });
  // The click goes to Focus hop 1, which focuses its own field and asks
  // for Focus hop 2: the page sees activation (Playwright's Chromium keeps
  // it for good, the worst case) in a focused frame, but the click was
  // spent, so it goes as the tab's one go on its own. Focus hop 2, focused
  // just the same, may not go on.
  const hop = page.frameLocator('iframe[title="focus-hop app"]');
  await expect(hop.getByRole("heading", { name: "Focus hop 2" })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(3000);
  await expect(hop.getByRole("heading", { name: "Focus hop 2" })).toBeVisible();
});

test("a screen's own code can't pass for the person acting, whatever it patches, dispatches or posts, and the person's own click still counts", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("screenNavigation");
  const name = `Forges ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({ name }));
    await release(api, app, hoppingFiles(), name);
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(builder);
  await page.goto(`/domains/${app}/apps/launch/full`);
  await page
    .frameLocator('iframe[title="launch app"]')
    .getByRole("button", { name: "Start forging" })
    .click({ timeout: 20_000 });
  // Forge 1 patches the frame's prototypes, dispatches input of its own,
  // posts act-shaped messages to the page and focuses itself: none of it
  // is the person's act, so its navigation goes as the tab's one go on
  // its own, and Forge 2, doing the same, may not go on.
  const forge = page.frameLocator('iframe[title="forge app"]');
  await expect(forge.getByRole("heading", { name: "Forge 2" })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(3000);
  await expect(forge.getByRole("heading", { name: "Forge 2" })).toBeVisible();
  // The person's own click in it, with its prototypes patched to drop
  // what an act report looks like: still theirs, and it goes.
  await forge.getByRole("button", { name: "Go back" }).click();
  await expect(
    page
      .frameLocator('iframe[title="launch app"]')
      .getByRole("heading", { name: "Launch" })
  ).toBeVisible({ timeout: 20_000 });
});
