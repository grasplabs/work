import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { withFiles } from "../apps/core/test/app-definitions.ts";
import type { TestSource } from "../apps/core/test/app-definitions.ts";
import { test } from "./csp.ts";
import { hoppingFiles, navigationFiles } from "./notes-app.ts";
import { apiOf, peopleIn, release } from "./people.ts";

// Moving between an App's pages in a real browser: the App routes itself
// in its frame, and the page keeps where it is in its own address. Only
// the person's own act in the frame adds an entry to the page's history;
// whatever the App's code does by itself takes the place of the current
// one, so it can't fill the history or keep the person from going back.
// What the page passes on, and how often, is the web's own tests
// (page-bridge.test.ts, page-host.test.ts).

/** A new App of `files`, released. Returns its ID. */
const newApp = async (files: TestSource): Promise<string> => {
  const { builder } = peopleIn("pageNavigation");
  const name = `Notes ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({ name });
    await release(api, id, files);
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

/** The App's frame on `page`. */
const frameOf = (page: Page) => page.frameLocator('iframe[title="App"]');

/** Waits for the App's frame to show the heading `name`. */
const showing = async (page: Page, name: string): Promise<void> => {
  await expect(frameOf(page).getByRole("heading", { name })).toBeVisible({
    timeout: 20_000,
  });
};

test("a new version made current switches a clean page at once, and asks an editor with unsaved edits once, which saves on the version it opened before it switches", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("pageNavigation");
  let files = navigationFiles();
  // The note's form saves, and holds nothing unsaved once it has.
  files = withFiles(files, {
    "src/routes/notes.$id.tsx": (files.files["src/routes/notes.$id.tsx"] ?? "")
      .replace(
        'import { Form, TextField } from "@grasp-os/app-kit/form";',
        'import { Form, SubmitButton, TextField } from "@grasp-os/app-kit/form";'
      )
      .replace(
        '{ defaultValues: { title: "", body: "" } }',
        '{ defaultValues: { title: "", body: "" }, resetOnSuccess: true }'
      )
      .replace(
        '<TextField form={form} label="Title" name="title" />',
        '<TextField form={form} label="Title" name="title" />\n        <SubmitButton form={form}>Save note</SubmitButton>'
      ),
  });
  const app = await newApp(files);
  /** Makes a new version current, its start page changed by `mark`. */
  const releaseAgain = async (mark: string): Promise<void> => {
    const again = apiOf(builder);
    try {
      await release(
        again.api,
        app,
        withFiles(files, {
          "src/routes/start.tsx": `${files.files["src/routes/start.tsx"]}// ${mark}\n`,
        })
      );
    } finally {
      again.core[Symbol.dispose]();
    }
  };

  // A clean page in one tab: the start page, which holds no form.
  const clean = await pageOf(builder);
  await clean.goto(`/apps/${app}/full/start`);
  await showing(clean, "Start");
  const frameAddress = async (): Promise<string | null> =>
    await clean.locator('iframe[title="App"]').getAttribute("src");
  const before = await frameAddress();

  // An editor with unsaved edits in another.
  const dirty = await pageOf(builder);
  await dirty.goto(`/apps/${app}/full/notes/n42`);
  const note = frameOf(dirty);
  await note.getByLabel("Title").fill("Groceries", { timeout: 20_000 });
  const ask = dirty.getByRole("alertdialog", {
    name: "A new version of this App is ready",
  });

  await releaseAgain("v2");

  // The clean page switches by itself, to the new version's build, where
  // it was, and offers nothing.
  await expect.poll(frameAddress, { timeout: 20_000 }).not.toBe(before);
  await showing(clean, "Start");
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
  // Saved, nothing is left unsaved, and it switches by itself, still on
  // the note.
  await expect(
    dirty.getByText("It opens once your changes are saved.", { exact: false })
  ).toBeHidden({ timeout: 20_000 });
  await expect(note.getByLabel("Title")).toHaveValue("", { timeout: 20_000 });
  await showing(dirty, "Note n42");
  await expect(ask).toHaveCount(0);
  // What it saved is there, in the App's list.
  await clean.goto(`/apps/${app}/full`);
  await expect(
    frameOf(clean).getByText("Groceries", { exact: true }).first()
  ).toBeVisible({ timeout: 20_000 });

  // Unsaved again, switching now drops the edits, and moving on
  // afterwards asks nothing: nothing is left to lose.
  await note.getByLabel("Title").fill("Errands");
  await releaseAgain("v3");
  await expect(ask).toBeVisible({ timeout: 20_000 });
  await ask.getByRole("button", { name: "Switch now" }).click();
  await expect(ask).toBeHidden();
  await expect(note.getByLabel("Title")).toHaveValue("", { timeout: 20_000 });
  await note.getByRole("link", { name: "Back to start" }).click();
  await showing(dirty, "Start");
  await expect(
    dirty.getByRole("alertdialog", { name: "Leave this page?" })
  ).toHaveCount(0);
});

test("pages that navigate as they mount, with no act of the person's, add nothing to the history: back leaves the App", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("pageNavigation");
  const app = await newApp(hoppingFiles());
  const page = await pageOf(builder);
  // The person doesn't act at all. This browser reports the activation from
  // opening the page for as long as the page is open, so the page is told
  // what a person who never clicked would leave it with.
  await page.addInitScript(() => {
    Object.defineProperty(UserActivation.prototype, "isActive", {
      get: () => false,
    });
  });
  await page.goto("/apps");
  await page.goto(`/apps/${app}/full/takeoff`);
  // The start goes on its own, and each hop after it, to the last.
  await showing(page, "Hop 5");
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/full/hops/5$`, "u"));

  // None of it took an entry of the page's history: back leaves the App.
  await page.goBack();
  await expect(page).toHaveURL(/\/apps$/u);
});

test("pages that patch, dispatch and post whatever passes for an act leaves one entry of the person's in the history, whatever the pages it opens do", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("pageNavigation");
  const app = await newApp(hoppingFiles());
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/full/launch`);
  await frameOf(page)
    .getByRole("link", { name: "Start forging" })
    .click({ timeout: 20_000 });
  // The click is the person's: its page goes in as an entry. Each page
  // after it opens the next as it mounts, which takes that entry's
  // place, never one of its own.
  await showing(page, "Forge 5");
  // The page's address follows the App a moment after it moves.
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/full/forges/5$`, "u"));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/full/launch$`, "u"));
  await showing(page, "Launch");
});

test("a page's own code can't pass for the person acting, and the person's own click in it still counts", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("pageNavigation");
  const app = await newApp(hoppingFiles());
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/full/launch`);
  await frameOf(page)
    .getByRole("link", { name: "Start forging" })
    .click({ timeout: 20_000 });
  await showing(page, "Forge 5");
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/full/forges/5$`, "u"));
  // The person's own click, with the frame's prototypes patched to drop
  // what an act report looks like: still theirs, so it goes in as an
  // entry of its own, and back returns to the forge.
  await frameOf(page).getByRole("link", { name: "Go back" }).click();
  await showing(page, "Launch");
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/full/launch$`, "u"));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/full/forges/5$`, "u"));
});
