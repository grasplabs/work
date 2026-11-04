import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";
import { origin } from "./stack.ts";

// Reaching Apps from the product: sign in, find an App in the Apps list,
// open it, and use its page with live data from its App's functions; its
// workflows and who opens it are in its settings. Only the people core
// opens Apps to see them.

const schema = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ clicks: defineTable({ at: v.number() }) });
`;

const operations = `import { v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

export const count = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("clicks").take(100)).length,
});

export const addOne = mutation({
  args: {},
  returns: v.id("clicks"),
  handler: async (ctx) => await ctx.db.insert("clicks", { at: Date.now() }),
});
`;

/** The counter's registration, its one screen `screen`. */
const registration = (
  screen: string
): string => `import { app } from "@grasp-os/sdk";
import { addOne, count } from "./operations/counter.ts";
import schema from "./schema.ts";

export default app({
  name: "Counter",
  schema,
  access: { tables: { clicks: { read: "appMembers", write: "appMembers" } } },
  operations: { counter: { count, addOne } },
  internalOperations: {},
  screens: [{ name: "${screen}", path: "/", source: "screens/${screen}.tsx" }],
  uses: [],
});
`;

const screen = `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "#grasp";

export default function Counter() {
  const count = useQuery(api.counter.count, {});
  const addOne = useMutation(api.counter.addOne);
  return (
    <main className="flex flex-col gap-4 p-4">
      <h2 className="text-lg font-medium">Counter</h2>
      <output aria-label="Count">{count ?? 0}</output>
      <Button onClick={() => void addOne({})}>Add one</Button>
    </main>
  );
}
`;

/** The counter App's code: its schema, functions and one screen, `name`. */
const counterApp = (name = "counter"): Record<string, string> => ({
  "schema.ts": schema,
  "operations/counter.ts": operations,
  "app.ts": registration(name),
  [`screens/${name}.tsx`]: screen,
});

const tally = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "tally",
  { input: z.unknown(), params: {} },
  async (step) => await step.do("count", { description: "Count" }, async () => 1)
);
`;

const tallyTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import tally from "./tally.ts";

export default workflowTests(tally, [{ name: "counts", mocks: { count: 1 }, expect: { output: 1 } }]);
`;

/** The counter App's files: a screen and a workflow. */
const counterFiles = {
  ...counterApp(),
  "workflows/tally.ts": tally,
  "workflows/tally.workflow-tests.ts": tallyTests,
};

/** Runs `run` with `person`'s API over `/rpc`, closed after. */
const withApi = async <T>(
  person: Person,
  run: (api: ReturnType<typeof apiOf>["api"]) => Promise<T>
): Promise<T> => {
  const { core, api } = apiOf(person);
  try {
    return await run(api);
  } finally {
    core[Symbol.dispose]();
  }
};

/**
 * A new App named `appName`, released with `files` unless there are none.
 * Returns its ID.
 */
const newApp = async (
  person: Person,
  appName: string,
  files: Record<string, string> = counterFiles
): Promise<string> =>
  await withApi(person, async (api) => {
    const { id } = await api.apps.create({
      name: appName,
      description: "Counts clicks",
    });
    if (Object.keys(files).length > 0) {
      await release(api, id, files, "First version");
    }
    return id;
  });

/** A counter screen on the page, once it has built. */
const counterScreen = async (page: Page, title = "counter app") => {
  const frame = page.frameLocator(`iframe[title="${title}"]`);
  // The first open builds the screen, which on a loaded machine takes a
  // while (screens.e2e.ts).
  await expect(frame.getByRole("heading", { name: "Counter" })).toBeVisible({
    timeout: 20_000,
  });
  return frame;
};

let builder: Person;
let user: Person;
let admin: Person;
let name: string;
let app: string;

test.beforeAll(async () => {
  ({ builder, user, admin } = peopleIn("apps"));
  // Builders see every App, other tests' too: this one's name is its own.
  name = `Counter ${crypto.randomUUID()}`;
  app = await newApp(builder, name);
});

/** An App's registration with two screens, `home` and `counter`, of the counter's code. */
const twoScreens = (): Record<string, string> => ({
  ...counterApp(),
  "app.ts": registration("counter").replace(
    'screens: [{ name: "counter"',
    'screens: [{ name: "home", path: "/home", source: "screens/home.tsx" }, { name: "counter"'
  ),
  "screens/home.tsx": screen,
});

test("a builder finds an App in the list, opens it and uses its page with live data", async ({
  pageOf,
}) => {
  // Seven more Apps of this run's own: five published, two drafts, so the
  // Apps page offers its search and tabs. One of them, `books`, has two
  // screens: it is one App with two pages, never two apps. Their names
  // carry `run`, which no other test's do.
  const run = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    String.fromCodePoint(97 + (byte % 26))
  ).join("");
  const published = ["books", "payroll", "stock", "fleet", "sales"];
  const drafts = ["hiring", "legal"];
  const ids = await withApi(builder, async (api) => {
    const made = await Promise.all([
      ...published.map(async (each) => {
        const { id } = await api.apps.create({ name: `${each} ${run}` });
        await release(
          api,
          id,
          each === "books" ? twoScreens() : counterApp(),
          "First"
        );
        return [each, id] as const;
      }),
      ...drafts.map(async (each) => {
        const { id } = await api.apps.create({ name: `${each} ${run}` });
        const { version } = await api.apps.files.commit(
          id,
          counterApp(),
          "First"
        );
        await api.apps.versions.setCurrent(id, version);
        return [each, id] as const;
      }),
    ]);
    return new Map(made);
  });

  const page = await pageOf(builder);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Apps" }).click();
  const cards = page.getByRole("list", { name: "Apps" }).getByRole("listitem");
  const search = page.getByRole("textbox", { name: "Search the Apps" });

  // A search by name finds this run's Apps, one card each whatever their
  // screens, each saying where it stands.
  await search.fill(run);
  await expect(cards).toHaveCount(7);
  await expect(cards.filter({ hasText: "Published" })).toHaveCount(5);
  await expect(cards.filter({ hasText: "Draft" })).toHaveCount(2);

  // The App with two screens is one card; opened, its two pages are tabs
  // in its bar.
  await search.fill(`books ${run}`);
  await expect(cards).toHaveCount(1);
  await cards.getByRole("link", { name: `books ${run}` }).click();
  await expect(page).toHaveURL(
    new RegExp(`/apps/${ids.get("books") ?? ""}$`, "u")
  );
  await expect(
    page.getByRole("navigation", { name: "Pages" }).getByRole("link")
  ).toHaveText(["counter", "home"]);
  await page.goBack();

  // A search nothing matches says so, and lists nothing.
  await search.fill(`nothing-${run}`);
  await expect(
    page.getByText(`No App is called “nothing-${run}”`)
  ).toBeVisible();
  await expect(cards).toHaveCount(0);
  await search.fill("");

  // Each App's card opens it, on its first page.
  await cards.filter({ hasText: name }).getByRole("link", { name }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}$`, "u"));
  const counter = await counterScreen(page);
  // One page heading: the App's bar names it.
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", {
      name: "Apps",
    })
  ).toBeVisible();
  await expect(counter.getByRole("status", { name: "Count" })).toHaveText("0");
  await counter.getByRole("button", { name: "Add one" }).click();
  await expect(counter.getByRole("status", { name: "Count" })).toHaveText("1");
  await page.getByRole("button", { name: `More for ${name}` }).click();
  await expect(
    page.getByRole("menuitem", { name: "Open full page" })
  ).toHaveAttribute("href", `/apps/${app}/full?screen=counter`);
  await page.keyboard.press("Escape");

  // Its settings, beside the chat in its workspace: what it is, its
  // workflows and their runs, its connections and its members.
  await page.getByRole("link", { name: "Edit" }).click();
  await page
    .getByRole("navigation", { name: "Workspace views" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page.getByLabel("What it is for")).toHaveValue("Counts clicks");
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("link", { name: "Workflows" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "tally" }).getByRole("link")
  ).toHaveText("tally");
  await expect(page.getByText("No runs yet.")).toBeVisible();
  // A builder sees the connections it uses; this one uses none.
  await sections.getByRole("link", { name: "Connections" }).click();
  await expect(
    page.getByText("This App doesn't use a connection yet.")
  ).toBeVisible();
  await sections.getByRole("link", { name: "Sharing" }).click();
  await expect(page.getByText("Created by you.")).toBeVisible();
});

test("the sidebar shows everyone the sections, and Settings each person the sections they may open", async ({
  pageOf,
}) => {
  const everyone = [
    "Chat",
    "Brain",
    "Projects",
    "Apps",
    "Workflows",
    "Integrations",
  ];
  const roleNames = { admin: "Admin", builder: "Builder", user: "User" };
  const sidebarOf = async (person: Person) => {
    const page = await pageOf(person);
    // In Workflows, where an admin's Requests is under it.
    await page.goto("/workflows");
    const links = page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link");
    // The nav shows once the person's identity is in.
    await expect(links.first()).toBeVisible();
    await expect(links.filter({ hasText: /^Dashboard/u })).toBeVisible();
    // The Apps' own entries, which come on their own read, aren't Grasp's
    // sections (app-surfaces.e2e.ts adds some on the shared deployment):
    // every link but theirs, in one read of the page.
    const texts = await links.evaluateAll((found) =>
      found
        .filter((link) => link.closest('[aria-label="App shortcuts"]') === null)
        .map((link) => link.textContent ?? "")
    );
    // The person menu, at the sidebar's foot, by their name; their role is
    // said inside it.
    await page.getByRole("button", { name: "Person", exact: true }).click();
    await expect(
      page.getByRole("menu").getByText(roleNames[person.role], { exact: true })
    ).toBeVisible();
    const items = page.getByRole("menuitem");
    await expect(items.filter({ hasText: "Sign out" })).toBeVisible();
    const menuTexts = await items.allTextContents();
    const menu = menuTexts.filter((text) =>
      ["Settings", "Sign out"].includes(text)
    );
    await items.filter({ hasText: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings\/profile$/u);
    const sections = page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("link");
    await expect(sections.last()).toHaveText("Security");
    return {
      // Without how many wait.
      nav: texts.map((text) =>
        text.replace(/\d+ (?:things? waiting|workflows? needs? you)$/u, "")
      ),
      menu,
      settings: await sections.allTextContents(),
    };
  };
  const [chat, ...rest] = everyone;
  const nav = [chat, "Dashboard", ...rest];
  // Stephen's requests sit under Workflows for admins only, while they are
  // in Workflows.
  const adminNav = nav.flatMap((section) =>
    section === "Workflows" ? [section, "Requests"] : [section]
  );
  const menu = ["Settings", "Sign out"];
  const account = ["Profile", "Security"];
  expect({
    admin: await sidebarOf(admin),
    builder: await sidebarOf(builder),
    user: await sidebarOf(user),
  }).toStrictEqual({
    admin: {
      nav: adminNav,
      menu,
      settings: [
        "Workspace",
        "Members and roles",
        // The organization's own AI provider keys and the models its calls use.
        "AI providers",
        "Models",
        "AI spend",
        // The company's groups of teams, the brain's regions: right after
        // AI spend, as in the prototype.
        "Brain",
        // Who can reach Stephen and what he may do for whom.
        "Stephen",
        // The company admin's view of the onboarding interviews.
        "Onboarding",
        "Audit trail",
        // Every person's calls of unknown outcome, read only, for admins.
        "Unknown outcomes",
        "Billing",
        ...account,
      ],
    },
    builder: { nav, menu, settings: account },
    user: { nav, menu, settings: account },
  });
  // Outside Workflows, Requests isn't under it.
  const page = await pageOf(admin);
  await page.goto("/");
  const main = page.getByRole("navigation", { name: "Main" });
  await expect(main.getByRole("link", { name: "Chat" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Requests" })).toHaveCount(0);
});

test("a link to an app, opened signed out, leads through sign-in to the app in the frame", async ({
  page,
  pageOf,
}) => {
  await page.goto(`/apps/${app}?screen=counter`);
  await expect(
    page.getByText("Use your organization’s account to go on.")
  ).toBeVisible();
  const returnTo = new URL(page.url()).searchParams.get("returnTo");
  expect(returnTo).toBe(`/apps/${app}?screen=counter`);

  const signedIn = await pageOf(builder);
  await signedIn.goto(
    `/sign-in?returnTo=${encodeURIComponent(returnTo ?? "")}`
  );
  await expect(signedIn).toHaveURL(
    new RegExp(`/apps/${app}\\?screen=counter$`, "u")
  );
  await counterScreen(signedIn);
});

test("someone with the user role finds no App to open", async ({ pageOf }) => {
  const page = await pageOf(user);
  // The Apps page has none for them, and no way to make one.
  await page.goto("/apps");
  await expect(
    page.getByText("The Apps your colleagues share with you show here.")
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "New App" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("signing in goes back to the page asked for, and only to a page of this site", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  await page.goto("/sign-in?returnTo=%2Fapps");
  await expect(page.getByRole("heading", { name: "Apps" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/apps");

  for (const elsewhere of [
    "//evil.test/apps",
    "/\\evil.test",
    "/\t/evil.test",
    "https://evil.test",
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one address at a time
    await page.goto(`/sign-in?returnTo=${encodeURIComponent(elsewhere)}`);
    // Chat's box, whether its heading greets or offers the tour.
    // oxlint-disable-next-line no-await-in-loop -- one address at a time
    await expect(page.getByLabel("Your question")).toBeVisible();
    expect(page.url()).toBe(`${origin}/`);
  }
});

test("a runs read that never comes leaves the App's workflows usable, and says so", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  const gate = await callGate(page, '["workflows","runs"]');
  gate.hold();
  await page.goto(`/apps/${app}/settings?section=workflows`);

  await expect(
    page.getByRole("row").filter({ hasText: "tally" }).getByRole("link")
  ).toHaveText("tally");
  await expect(
    page.getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible({ timeout: 15_000 });
  gate.release();
});

test("loading a page again after a new version shows that version, and the App's first page when the one open is gone", async ({
  pageOf,
}) => {
  const swapped = await newApp(
    builder,
    `Swap ${crypto.randomUUID()}`,
    counterApp()
  );
  const page = await pageOf(builder);
  await page.goto(`/apps/${swapped}?screen=counter`);
  await counterScreen(page);

  await withApi(builder, async (api) => {
    await release(
      api,
      swapped,
      { ...counterApp("tally"), "screens/counter.tsx": null },
      "Rename the screen"
    );
  });
  // Told over the tab's connection, the screen holds nothing unsaved, so
  // it loads again by itself: no timer, and nothing to click. The page
  // asked for is gone, so the App opens on its first.
  await counterScreen(page, "tally app");
  await expect(page.getByRole("navigation", { name: "Pages" })).toHaveCount(0);
});
