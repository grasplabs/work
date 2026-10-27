import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";

// An App's own page at /apps/<id>: its bar with its name, status, screens
// as tabs, settings, Edit and the Publish menu; its screen under the bar;
// that it is only described while it has no screen; and, once archived,
// a notice with Restore. Only its builders edit, publish or restore it,
// and a draft is theirs alone.

const schema = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ marks: defineTable({ at: v.number() }) });
`;

/** A screen that says which it is, `title`. */
const screenSaying = (title: string) => `export default function Screen() {
  return (
    <main className="p-4">
      <h2 className="text-lg font-medium">${title}</h2>
    </main>
  );
}
`;

/** Two screens, `board` and `list`, and nothing else. */
const twoScreens = {
  "schema.ts": schema,
  "app.ts": `import { app } from "@grasp-os/sdk";
import schema from "./schema.ts";

export default app({
  name: "Boards",
  schema,
  access: { tables: { marks: { read: "appMembers", write: "appMembers" } } },
  operations: {},
  internalOperations: {},
  screens: [
    { name: "board", path: "/", source: "screens/board.tsx" },
    { name: "list", path: "/list", source: "screens/list.tsx" },
  ],
  uses: [],
});
`,
  "screens/board.tsx": screenSaying("The board"),
  "screens/list.tsx": screenSaying("The list"),
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

/** A screen of the App in its frame, once built, saying `title`. */
const screenShowing = async (page: Page, screen: string, title: string) => {
  const frame = page.frameLocator(`iframe[title="${screen} app"]`);
  // The first open builds the screen, which on a loaded machine takes a
  // while (screens.e2e.ts).
  await expect(frame.getByRole("heading", { name: title })).toBeVisible({
    timeout: 20_000,
  });
};

test("a builder opens an App's page, moves between its screens, unpublishes and publishes it, and edits it in the chat", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("appPage");
  const name = `Boards ${crypto.randomUUID()}`;
  const app = await newApp(builder, name, twoScreens);
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}`);

  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByRole("button", { name: "Published" })).toBeVisible();
  // Its first screen opens first; the other is a tab away.
  await screenShowing(page, "board", "The board");
  // The App's name heads the page once: the screen's frame, open now,
  // names it a level below.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  const screens = page.getByRole("navigation", { name: "Screens" });
  await expect(screens.getByRole("link", { name: "board" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await screens.getByRole("link", { name: "list" }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}\\?screen=list$`, "u"));
  await screenShowing(page, "list", "The list");

  // Back to a draft, from the Publish menu, and published again.
  await page.getByRole("button", { name: "Published" }).click();
  await page.getByRole("menuitem", { name: /^Unpublish/u }).click();
  await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByRole("menuitem", { name: /^Publish/u }).click();
  await expect(page.getByRole("button", { name: "Published" })).toBeVisible();

  // Edit opens the chat beside the page, where Grasp changes the App.
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(
    page.getByRole("button", { name: "Fold the chat away" })
  ).toBeVisible();

  // Its settings are a page of its own.
  await page.getByRole("link", { name: `Settings of ${name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/settings$`, "u"));
});

test("a builder renames an App and says what it is for in its settings, archives it there, and restores it", async ({
  pageOf,
}) => {
  const { builder, user } = peopleIn("appPage");
  const name = `Settings ${crypto.randomUUID()}`;
  const renamed = `Renamed ${crypto.randomUUID()}`;
  const app = await newApp(builder, name, twoScreens);
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/settings`);

  await expect(
    page.getByRole("heading", { level: 1, name: `Settings of ${name}` })
  ).toBeVisible();
  // Saved as the field is left, through core's audited update.
  await page.getByLabel("Name").fill(renamed);
  await page.getByLabel("Name").press("Enter");
  await expect(
    page.getByRole("heading", { level: 1, name: `Settings of ${renamed}` })
  ).toBeVisible();
  await page.getByLabel("What it is for").fill("Where the boards are kept.");
  await page.getByLabel("What it is for").blur();
  await expect(page.getByLabel("What it is for")).toHaveValue(
    "Where the boards are kept."
  );

  // Its integrations: none yet for a new App, which its builder adds to.
  const integrations = page.getByRole("region", { name: "Integrations" });
  await expect(integrations.getByText("No integrations yet.")).toBeVisible();
  await expect(
    integrations.getByRole("button", { name: "Add an integration" })
  ).toBeVisible();

  // Archived only once asked, and restored as a draft.
  await page.getByRole("button", { name: "Archive and take offline" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();

  // Someone who only uses Apps reads nothing of a draft.
  const other = await pageOf(user);
  await other.goto(`/apps/${app}/settings`);
  await expect(
    other.getByRole("heading", { name: "Domain not found" })
  ).toBeVisible();
});

test("someone an App is shared with as a user reads its settings and changes none of them, though they build in the organization", async ({
  pageOf,
}) => {
  const { builder, colleague } = peopleIn("appPage");
  const name = `Read ${crypto.randomUUID()}`;
  const app = await newApp(builder, name, twoScreens);
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
  await page.goto(`/apps/${app}/settings`);

  await expect(
    page.getByRole("heading", { level: 1, name: `Settings of ${name}` })
  ).toBeVisible();
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
});

test("an App with no screen yet is only described, and its builder designs it in the chat", async ({
  pageOf,
}) => {
  const { builder, user } = peopleIn("appPage");
  const name = `Described ${crypto.randomUUID()}`;
  const app = await newApp(builder, name);
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}`);

  await expect(page.getByText("Only described")).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  // Nothing to publish before it has a version.
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
  await page.getByRole("button", { name: "Design it in the chat" }).click();
  await expect(
    page.getByRole("button", { name: "Fold the chat away" })
  ).toBeVisible();

  // A draft is its builders' alone: anyone else finds no App.
  const other = await pageOf(user);
  await other.goto(`/apps/${app}`);
  await expect(
    other.getByRole("heading", { name: "App not found" })
  ).toBeVisible();
});

test("an archived App says so under its bar, opens no screen, and its builder restores it as a draft", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("appPage");
  const name = `Archived ${crypto.randomUUID()}`;
  const app = await newApp(builder, name, twoScreens);
  const { core, api } = apiOf(builder);
  try {
    await api.apps.archive(app);
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}`);

  await expect(
    page.getByText(
      "This app is archived. It is kept as it was, and nobody works on it."
    )
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  // Archived, it is neither edited nor published.
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await expect(page.getByText("This app is archived.")).toHaveCount(0);
  await screenShowing(page, "board", "The board");
  await expect(page.getByRole("button", { name: "Publish" })).toBeEnabled();
});
