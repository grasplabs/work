import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { appDefinition } from "../apps/core/test/app-definitions.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";

// An App as its people use it at /apps/<id>: its bar with its name and
// its pages as tabs, its page under the bar, and no chat; and its
// workspace at /apps/<id>/edit, where its builders build it with the chat
// docked beside a preview, publish and unpublish it, and restore it once
// archived. Its settings are a page of their own, and a section of the
// workspace. Only its builders edit, publish or restore it, and a draft is
// theirs alone.

/** The page at `path` that says which it is, `title`, and links to `other`. */
const pageSaying = (
  path: string,
  title: string,
  other: string
) => `import { createFileRoute, Link } from "@tanstack/react-router";

function Page() {
  return (
    <main className="p-4">
      <h2 className="text-lg font-medium">${title}</h2>
      <Link to="${other}">Go to ${other}</Link>
    </main>
  );
}
export const Route = createFileRoute("${path}")({ component: Page });
`;

/** Two pages, the board at `/` and the list at `/list`, and nothing else. */
const twoPages = {
  ...appDefinition({
    name: "Boards",
    tables: { marks: { fields: { at: "v.number()" } } },
  }),
  "src/routes/index.tsx": pageSaying("/", "The board", "/list"),
  "src/routes/list.tsx": pageSaying("/list", "The list", "/"),
};

/** A new App named `name`, released (so published) with `files` if any. */
const newApp = async (
  person: Person,
  name: string,
  files: Record<string, string> = {}
): Promise<string> => {
  const { core, api } = apiOf(person);
  try {
    const { id } = await api.apps.create({ name, description: "Boards" });
    if (Object.keys(files).length > 0) {
      await release(api, id, files, "First version");
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

test("a builder uses the live App, moves between its pages, and publishes and unpublishes it in its workspace", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("appPage");
  const name = `Boards ${crypto.randomUUID()}`;
  const app = await newApp(builder, name, twoPages);
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}`);

  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  // Its first page, `/`, opens first.
  const frame = await pageShowing(page, "The board");
  // The App's name heads the page once: the page's frame, open now,
  // names it a level below.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
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

  // The live App is its people's: no chat and nothing to publish here.
  await expect(page.getByRole("textbox", { name: "Ask Grasp" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Publish/u })).toHaveCount(0);

  // Edit opens its workspace: the chat beside the preview, which shows
  // the App's latest version as a preview, never the live App, and says
  // which version it is.
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/edit$`, "u"));
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  const preview = page.getByRole("region", { name: `Preview of ${name}` });
  await expect(
    preview.frameLocator("iframe").getByRole("heading", { name: "The board" })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    preview.getByText("Preview: changes nothing, reads no real data")
  ).toBeVisible();
  await expect(page.getByText("Version 1 is live")).toBeVisible();
  await expect(
    page.getByText("Unpublished changes", { exact: true })
  ).toHaveCount(0);
  const chat = page.getByRole("region", { name: "Chat" });
  await expect(
    chat.getByRole("textbox", { name: "Ask for a change" })
  ).toBeVisible();

  // Back to a draft, from the Publish menu, and published again.
  await page.getByRole("button", { name: "Published" }).click();
  await page.getByRole("menuitem", { name: /^Unpublish/u }).click();
  await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByRole("menuitem", { name: /^Publish/u }).click();
  await expect(page.getByRole("button", { name: "Published" })).toBeVisible();

  // Its settings are a view of the workspace, beside the chat.
  await page
    .getByRole("navigation", { name: "Workspace views" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/apps/${app}/edit\\?view=settings$`, "u")
  );
  await expect(page.getByLabel("Name")).toHaveValue(name);
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

  // Archived only once asked, and restored as a draft.
  await page.getByRole("button", { name: "Archive and take offline" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();

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

  // Someone who only uses Apps reads nothing of a draft.
  const other = await pageOf(user);
  await other.goto(`/apps/${app}/settings`);
  await expect(
    other.getByRole("heading", { name: "App not found" })
  ).toBeVisible();
});

test("someone an App is shared with as a user reads its settings and changes none of them, though they build in the organization", async ({
  pageOf,
}) => {
  const { builder, colleague } = peopleIn("appPage");
  const name = `Read ${crypto.randomUUID()}`;
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
  // The live App offers them its settings, never its workspace.
  await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await page.getByRole("button", { name: `More for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/settings$`, "u"));

  await expect(
    page.getByRole("heading", { level: 1, name: `Settings of ${name}` })
  ).toBeAttached();
  // Their role in this App decides, not their role in the organization.
  await expect(page.getByLabel("Name")).toHaveAttribute("readonly", "");
  await expect(page.getByLabel("What it is for")).toHaveAttribute(
    "readonly",
    ""
  );
  await expect(page.getByLabel("Made for")).toBeDisabled();
  await expect(
    page.getByText("Only its builders change these settings.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Archive/u })).toHaveCount(0);
  // Nor is the workspace theirs.
  await page.goto(`/apps/${app}/edit`);
  await expect(
    page.getByText(`Only its builders change ${name}`)
  ).toBeVisible();
});

test("an App with nothing built yet has no page, and its builder builds it in its workspace", async ({
  pageOf,
}) => {
  const { builder, user } = peopleIn("appPage");
  const name = `Described ${crypto.randomUUID()}`;
  const app = await newApp(builder, name);
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}`);

  await expect(page.getByText("No page yet")).toBeVisible();
  await page.getByRole("link", { name: "Build it" }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/edit$`, "u"));
  await expect(page.getByText("Nothing built yet")).toBeVisible();
  // Nothing to publish before it has a version.
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
  await expect(
    page
      .getByRole("region", { name: "Chat" })
      .getByRole("textbox", { name: "Ask for a change" })
  ).toBeVisible();

  // A draft is its builders' alone: anyone else finds no App.
  const other = await pageOf(user);
  await other.goto(`/apps/${app}`);
  await expect(
    other.getByRole("heading", { name: "App not found" })
  ).toBeVisible();
});

test("an archived App opens no page, and its builder restores it as a draft in its workspace", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("appPage");
  const name = `Archived ${crypto.randomUUID()}`;
  const app = await newApp(builder, name, twoPages);
  const { core, api } = apiOf(builder);
  try {
    await api.apps.archive(app);
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}`);

  await expect(page.getByText("This App is archived")).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);

  await page.getByRole("link", { name: "Restore it" }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/edit$`, "u"));
  // Archived, it is neither changed nor published: no chat, no Publish.
  await expect(page.getByRole("region", { name: "Chat" })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("button", { name: "Publish" })).toBeEnabled();

  await page.goto(`/apps/${app}`);
  await pageShowing(page, "The board");
});
