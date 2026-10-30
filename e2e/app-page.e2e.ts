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

  // No Edit button: the chat bottom right is the App's own, where Grasp
  // changes it, named after it, in place of Ask Grasp.
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Ask Grasp" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name })).toHaveAttribute(
    "placeholder",
    "Say what should change"
  );
  await page.getByRole("button", { name: "Open the chat" }).click();
  const appChat = page.getByRole("region", { name });
  await expect(appChat).toContainText(
    `Say what should change in ${name}. Every change is a new version of it.`
  );
  await appChat.getByRole("button", { name: "Fold the chat away" }).click();

  // Its settings are its domain's page.
  await page.getByRole("link", { name: `Settings of ${name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/domains/${app}$`, "u"));
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
    page
      .getByRole("region", { name })
      .getByRole("button", { name: "Fold the chat away" })
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
  // Archived, it is neither changed nor published: the chat is Ask Grasp.
  await expect(page.getByRole("textbox", { name: "Ask Grasp" })).toBeVisible();

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await expect(page.getByText("This app is archived.")).toHaveCount(0);
  await screenShowing(page, "board", "The board");
  await expect(page.getByRole("button", { name: "Publish" })).toBeEnabled();
});
