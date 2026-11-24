import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { testApp } from "../apps/core/test/app-definitions.ts";
import type { TestSource } from "../apps/core/test/app-definitions.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";

// An App at /apps/<id>, one address for everyone: as its people use it,
// its one bar with its name, its page under the bar, and no chat; for its
// builders, its workspace there, where they build it with the chat docked
// beside a preview, publish it, and restore it once archived. Its
// settings are a page of their own, and a view of the workspace. Who may
// change what is core's test (apps/core/test/app-settings.test.ts).

/** The page at `path` that says which it is, `title`, and links to `other`. */
const pageSaying = (
  path: string,
  title: string,
  other: string
) => `import { createFileRoute, Link } from "@tanstack/react-router";

const Page = () => {
  return (
    <main className="p-4">
      <h2 className="text-lg font-medium">${title}</h2>
      <Link to="${other}">Go to ${other}</Link>
    </main>
  );
};
export const Route = createFileRoute("${path}")({ component: Page });
`;

/** Two pages, the board at `/` and the list at `/list`, and nothing else. */
const twoPages = testApp(
  {
    name: "Boards",
    tables: { marks: { fields: { at: "v.number()" } } },
  },
  {
    "src/routes/index.tsx": pageSaying("/", "The board", "/list"),
    "src/routes/list.tsx": pageSaying("/list", "The list", "/"),
  }
);

/** A new App named `name`, released (so live) with `files` if any. */
const newApp = async (
  person: Person,
  name: string,
  files: TestSource = {}
): Promise<string> => {
  const { core, api } = apiOf(person);
  try {
    const { id } = await api.apps.create({ name, description: "Boards" });
    if (Object.keys(files).length > 0) {
      await release(api, id, files);
    }
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

/** The App in its frame, once built, on the page saying `title`. */
const pageShowing = async (page: Page, title: string) => {
  const frame = page.frameLocator('iframe[title="App"]');
  // The first open builds the page, which on a loaded machine takes a
  // while (pages.e2e.ts).
  await expect(frame.getByRole("heading", { name: title })).toBeVisible({
    timeout: 20_000,
  });
  return frame;
};

test("someone it is shared with uses the live App and moves between its pages; its builder opens the same address on its workspace", async ({
  pageOf,
}) => {
  const { builder, colleague } = peopleIn("appPage");
  const name = `Boards ${crypto.randomUUID()}`;
  const app = await newApp(builder, name, twoPages);
  const { core, api } = apiOf(builder);
  try {
    await api.apps.members.add(app, {
      type: "person",
      id: colleague.userId,
      role: "user",
    });
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(colleague);
  await page.goto(`/apps/${app}`);

  await expect(page.getByRole("heading", { level: 1, name })).toBeAttached();
  // Its first page, `/`, opens first.
  const frame = await pageShowing(page, "The board");
  // A link in the App moves it, and the page's address with it: back
  // goes back to where it was.
  await frame.getByRole("link", { name: "Go to /list" }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/pages/list$`, "u"));
  await pageShowing(page, "The list");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}$`, "u"));
  await pageShowing(page, "The board");
  // Its address opens it there again.
  await page.goto(`/apps/${app}/pages/list`);
  await pageShowing(page, "The list");

  // The live App is its people's: nothing to share here, no workspace
  // in the sidebar, and no chat about the App.
  await expect(page.getByRole("button", { name: /^Share/u })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: /s workspace$/u })
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Ask for a change" })
  ).toHaveCount(0);

  // Its builder, at the same address, has its workspace: with nothing
  // changed over the live version, the preview is the App as its team
  // sees it, the chat beside it, and nothing to share yet.
  const workspace = await pageOf(builder);
  await workspace.goto(`/apps/${app}`);
  await expect(
    workspace.getByRole("heading", { level: 1, name })
  ).toBeAttached();
  const preview = workspace.getByRole("region", {
    name: `${name}, as your team sees it`,
  });
  await expect(
    preview.frameLocator("iframe").getByRole("heading", { name: "The board" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    workspace.getByRole("region", { name: "Changes only you see" })
  ).toHaveCount(0);
  const chat = workspace.getByRole("region", { name: "Chat" });
  await expect(
    chat.getByRole("textbox", { name: "Ask for a change" })
  ).toBeVisible();

  // Its settings are the sidebar's rows of its workspace, beside the chat.
  await workspace
    .getByRole("navigation", { name: /s workspace$/u })
    .getByRole("link", { name: "General" })
    .click();
  await expect(workspace).toHaveURL(
    new RegExp(`/apps/${app}\\?view=settings&section=general$`, "u")
  );
  await expect(workspace.getByLabel("Name", { exact: true })).toHaveValue(name);
});

test("a builder renames an App and says what it is for in its settings, archives it there, and restores it", async ({
  pageOf,
}) => {
  const { builder, user } = peopleIn("appPage");
  const name = `Settings ${crypto.randomUUID()}`;
  const renamed = `Renamed ${crypto.randomUUID()}`;
  const app = await newApp(builder, name, twoPages);
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/settings`);

  await expect(
    page.getByRole("heading", { level: 1, name: `Settings of ${name}` })
  ).toBeAttached();
  // Saved as the field is left, through core's audited update.
  await page.getByLabel("Name").fill(renamed);
  await page.getByLabel("Name").press("Enter");
  await expect(
    page.getByRole("heading", { level: 1, name: `Settings of ${renamed}` })
  ).toBeAttached();
  await page.getByLabel("What it is for").fill("Where the boards are kept.");
  await page.getByLabel("What it is for").blur();
  await expect(page.getByLabel("What it is for")).toHaveValue(
    "Where the boards are kept."
  );

  // Archived only once asked, and restored live again at once: it has a
  // live version.
  await page.getByRole("button", { name: "Archive and take offline" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  // Restore once the question has gone, as a person sees it go: while it
  // leaves, the page under it takes no press.
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Restore" }).click();
  // Live again once core has put its version back, which takes a while
  // on a loaded machine.
  await expect(page.getByText("Archived", { exact: true })).toHaveCount(0, {
    timeout: 20_000,
  });

  // Its integrations, under Connections: none yet for a new App, which its
  // builder adds to.
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Connections" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/apps/${app}/settings\\?section=connections$`, "u")
  );
  const integrations = page.getByRole("region", { name: "Integrations" });
  await expect(integrations.getByText("No integrations yet.")).toBeVisible();
  await expect(
    integrations.getByRole("button", { name: "Add an integration" })
  ).toBeVisible();

  // Someone it isn't shared with reads nothing of it.
  const other = await pageOf(user);
  await other.goto(`/apps/${app}/settings`);
  await expect(
    other.getByRole("heading", { name: "App not found" })
  ).toBeVisible();
});
