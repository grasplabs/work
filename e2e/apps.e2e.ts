import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  changesOf,
  commitApp,
  testApp,
  withFiles,
} from "../apps/core/test/app-definitions.ts";
import type { TestApp, TestSource } from "../apps/core/test/app-definitions.ts";
import { fileCast } from "./contexts.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";
import { origin } from "./stack.ts";

// Reaching Apps from the product: sign in, find an App in the Apps list,
// open it, and use its page with live data from its App's functions; its
// workflows and who opens it are in its settings. Only the people core
// opens Apps to see them.

const serverCode = `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

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

const appPage = `import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "@server/_generated/api";

function Counter() {
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
export const Route = createFileRoute("/")({ component: Counter });
`;

/** The counter App's code: its definition, functions and one page, its `/`. */
const counterApp = (): TestApp =>
  testApp(
    {
      name: "Counter",
      tables: {
        clicks: {
          fields: { at: "v.number()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
    },
    {
      "server/counter.ts": serverCode,
      "src/routes/index.tsx": appPage,
    }
  );

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
  files: TestSource = counterApp()
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

/** A counter page on the page, once it has built. */
const counterPage = async (page: Page) => {
  const frame = page.frameLocator('iframe[title="App"]');
  // The first open builds the page, which on a loaded machine takes a
  // while (pages.e2e.ts).
  await expect(frame.getByRole("heading", { name: "Counter" })).toBeVisible({
    timeout: 20_000,
  });
  return frame;
};

/** The counter with a second page, `/home`, of the counter's code. */
const twoPages = (): TestApp =>
  withFiles(counterApp(), {
    "src/routes/home.tsx": appPage.replace(
      'createFileRoute("/")',
      'createFileRoute("/home")'
    ),
  });

let builder: Person;
let user: Person;
let admin: Person;
let name: string;
let app: string;

test.beforeAll(async () => {
  await fileCast();
  ({ builder, user, admin } = peopleIn("apps"));
  // Builders see every App, other tests' too: this one's name is its own.
  name = `Counter ${crypto.randomUUID()}`;
  app = await newApp(builder, name, twoPages());
});

test("a builder finds an App in the list, opens it and uses its page with live data", async ({
  pageOf,
}) => {
  // Seven more Apps of this run's own: five published, two drafts, so the
  // Apps page offers its search and tabs. One of them, `books`, has two
  // pages: it is one App with two pages, never two apps. Their names
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
          each === "books" ? twoPages() : counterApp(),
          "First"
        );
        return [each, id] as const;
      }),
      ...drafts.map(async (each) => {
        const { id } = await api.apps.create({ name: `${each} ${run}` });
        const { version } = await commitApp(
          api.apps.files,
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
  // pages, each saying where it stands.
  await search.fill(run);
  await expect(cards).toHaveCount(7);
  await expect(cards.filter({ hasText: "Published" })).toHaveCount(5);
  await expect(cards.filter({ hasText: "Draft" })).toHaveCount(2);

  // The App with two pages is one card; opened, it shows its first, `/`.
  await search.fill(`books ${run}`);
  await expect(cards).toHaveCount(1);
  await cards.getByRole("link", { name: `books ${run}` }).click();
  await expect(page).toHaveURL(
    new RegExp(`/apps/${ids.get("books") ?? ""}$`, "u")
  );
  await counterPage(page);
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
  const counter = await counterPage(page);
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
  ).toHaveAttribute("href", new RegExp(`^/apps/${app}/full/?$`, "u"));
  await page.keyboard.press("Escape");

  // Its settings, beside the chat in its workspace: what it is, its
  // connections and its members.
  await page.getByRole("link", { name: "Edit" }).click();
  await page
    .getByRole("navigation", { name: "Workspace views" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page.getByLabel("What it is for")).toHaveValue("Counts clicks");
  const sections = page.getByRole("navigation", { name: "Settings sections" });
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
    // The company's agents: the ones a person may ask, and for admins all of them.
    "Agents",
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
        // The event sources outside systems send events to, for admins.
        "Webhooks",
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
  await page.goto(`/apps/${app}/pages/home`);
  await expect(
    page.getByText("Use your organization’s account to go on.")
  ).toBeVisible();
  const returnTo = new URL(page.url()).searchParams.get("returnTo");
  expect(returnTo).toBe(`/apps/${app}/pages/home`);

  const signedIn = await pageOf(builder);
  await signedIn.goto(
    `/sign-in?returnTo=${encodeURIComponent(returnTo ?? "")}`
  );
  await expect(signedIn).toHaveURL(new RegExp(`/apps/${app}/pages/home$`, "u"));
  await counterPage(signedIn);
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

test("loading a page again after a new version shows that version, and the App's not-found page when the one open is gone", async ({
  pageOf,
}) => {
  const swapped = await newApp(
    builder,
    `Swap ${crypto.randomUUID()}`,
    twoPages()
  );
  const page = await pageOf(builder);
  await page.goto(`/apps/${swapped}/pages/home`);
  await counterPage(page);

  await withApi(builder, async (api) => {
    await release(
      api,
      swapped,
      changesOf(twoPages(), {
        "src/routes/home.tsx": null,
      }),
      "Drop the second page"
    );
  });
  // Told over the tab's connection, the page holds nothing unsaved, so
  // it loads again by itself: no timer, and nothing to click. The page
  // asked for is gone, so the App's router says so, where it was.
  const frame = page.frameLocator('iframe[title="App"]');
  await expect(frame.getByText("Not Found")).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`/apps/${swapped}/pages/home$`, "u"));
});
