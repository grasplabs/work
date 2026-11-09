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
    await release(api, id, files, name);
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

test("a link in a page opens another with its address, and back and reload land where the person was", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("pageNavigation");
  const app = await newApp(navigationFiles());
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/full/start`);
  await showing(page, "Start");

  await frameOf(page).getByRole("link", { name: "Open note n42" }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/full/notes/n42$`, "u"));
  await showing(page, "Note n42");

  await page.reload();
  await showing(page, "Note n42");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/full/start$`, "u"));
  await showing(page, "Start");
  await page.goForward();
  await showing(page, "Note n42");
});

test("a new version made current switches a clean page at once, and asks an editor with unsaved edits once, which saves on the version it opened before it switches", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("pageNavigation");
  let files = navigationFiles();
  // The note's form saves, and holds nothing unsaved once it has.
  files = withFiles(files, {
    "src/routes/notes.$id.tsx": (files.files["src/routes/notes.$id.tsx"] ?? "")
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
        }),
        mark
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

for (const { start, last, at, label } of [
  { start: "Start hopping", last: "Hop 5", at: "hops/5", label: "a click" },
  {
    start: "Start focused hopping",
    last: "Focus hop 5",
    at: "focus-hops/5",
    label: "pages that focus themselves on a click's activation",
  },
  {
    start: "Start forging",
    last: "Forge 5",
    at: "forges/5",
    label: "pages that patch, dispatch and post whatever passes for an act",
  },
] as const) {
  test(`${label} leaves one entry of the person's in the history, whatever the pages it opens do`, async ({
    pageOf,
  }) => {
    const { builder } = peopleIn("pageNavigation");
    const app = await newApp(hoppingFiles());
    const page = await pageOf(builder);
    await page.goto(`/apps/${app}/full/launch`);
    await frameOf(page)
      .getByRole("link", { name: start })
      .click({ timeout: 20_000 });
    // The click is the person's: its page goes in as an entry. Each page
    // after it opens the next as it mounts, which takes that entry's
    // place, never one of its own.
    await showing(page, last);
    // The page's address follows the App a moment after it moves.
    await expect(page).toHaveURL(new RegExp(`/apps/${app}/full/${at}$`, "u"));
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/apps/${app}/full/launch$`, "u"));
    await showing(page, "Launch");
  });
}

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

test("one press or one held key is one act of the person's: what its release or its repeats move to takes the press's entry", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("pageNavigation");
  const app = await newApp(hoppingFiles());
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/full/keys`);
  await showing(page, "Keys");
  const keys = new RegExp(`/apps/${app}/full/keys$`, "u");

  // A slow click: its press is the person's act, and goes in as an
  // entry; the move its release asks for, the act spent, takes its place.
  await frameOf(page).getByRole("button", { name: "Press and lift" }).hover();
  await page.mouse.down();
  await expect(page).toHaveURL(/\/full\/keys#down$/u);
  await page.mouse.up();
  await expect(page).toHaveURL(/\/full\/keys#up$/u);
  await page.goBack();
  await expect(page).toHaveURL(keys);

  // A held key: its first press goes in as an entry, its repeats take
  // that entry's place.
  await frameOf(page).getByRole("textbox", { name: "Keys" }).focus();
  await page.keyboard.down("a");
  await expect(page).toHaveURL(/\/full\/keys#pressed$/u);
  await page.keyboard.down("a");
  await page.keyboard.down("a");
  await page.keyboard.up("a");
  await expect(page).toHaveURL(/\/full\/keys#held$/u);
  await page.goBack();
  await expect(page).toHaveURL(keys);
});
