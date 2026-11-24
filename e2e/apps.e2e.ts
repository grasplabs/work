import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { testApp, withFiles } from "../apps/core/test/app-definitions.ts";
import type { TestApp, TestSource } from "../apps/core/test/app-definitions.ts";
import { fileCast } from "./contexts.ts";
import { test } from "./csp.ts";
import { apiOf, drafted, peopleIn, release } from "./people.ts";
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
import { Button } from "@grasp-os/app-kit/components/button";
import { api } from "@server/_generated/api";

const Counter = () => {
  const count = useQuery(api.counter.count, {});
  const addOne = useMutation(api.counter.addOne);
  return (
    <main className="flex flex-col gap-4 p-4">
      <h2 className="text-lg font-medium">Counter</h2>
      <output aria-label="Count">{count ?? 0}</output>
      <Button onClick={() => void addOne({})}>Add one</Button>
    </main>
  );
};
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
      await release(api, id, files);
    }
    return id;
  });

/** A counter page on the page, once it has built. */
const counterPage = async (page: Page) => {
  // The live App's frame, or, in a builder's workspace, the draft's preview.
  const frame = page.frameLocator(
    'iframe[title="App"], iframe[title="Your version of the App"]'
  );
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
let name: string;
let app: string;

test.beforeAll(async () => {
  await fileCast();
  ({ builder } = peopleIn("apps"));
  // Builders see every App, other tests' too: this one's name is its own.
  name = `Counter ${crypto.randomUUID()}`;
  app = await newApp(builder, name, twoPages());
});

test("a builder finds an App in the list, opens it and uses its page with live data", async ({
  pageOf,
}) => {
  // Seven more Apps of this run's own: five live, two drafts, so the
  // Apps page offers its search and tabs. One of them, `books`, has two
  // pages: it is one App with two pages, never two apps. Their names
  // carry `run`, which no other test's do.
  const run = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    String.fromCodePoint(97 + (byte % 26))
  ).join("");
  const live = ["books", "payroll", "stock", "fleet", "sales"];
  const drafts = ["hiring", "legal"];
  const ids = await withApi(builder, async (api) => {
    const made = await Promise.all([
      ...live.map(async (each) => {
        const { id } = await api.apps.create({ name: `${each} ${run}` });
        await release(api, id, each === "books" ? twoPages() : counterApp());
        return [each, id] as const;
      }),
      // Drafted, never published: no version live yet.
      ...drafts.map(async (each) => {
        const { id } = await api.apps.create({ name: `${each} ${run}` });
        await drafted(api, id, counterApp());
        return [each, id] as const;
      }),
    ]);
    return new Map(made);
  });

  const page = await pageOf(builder);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Apps" }).click();
  // The tab open lists its Apps, a card each: the builder's own first.
  const cards = page.getByRole("tabpanel").getByRole("article");
  const search = page.getByRole("textbox", { name: "Search the Apps" });

  // A search by name finds this run's Apps, one card each whatever their
  // pages, each saying where it stands.
  await search.fill(run);
  await expect(cards).toHaveCount(7);
  const marked = (status: string) => cards.filter({ hasText: status });
  await expect(marked("Your team uses it")).toHaveCount(5);
  await expect(marked("Only you see this")).toHaveCount(2);

  // The App with two pages is one card; opened, it shows its first, `/`.
  await search.fill(`books ${run}`);
  await expect(cards).toHaveCount(1);
  await cards.getByRole("link", { name: `books ${run}` }).click();
  await expect(page).toHaveURL(
    new RegExp(`/apps/${ids.get("books") ?? ""}$`, "u")
  );
  await counterPage(page);
  await page.goBack();
  await search.fill("");

  // Each App's card opens it, on its first page: for its builder, in its
  // workspace, the preview of its draft.
  await cards.filter({ hasText: name }).getByRole("link", { name }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${app}$`, "u"));
  const counter = await counterPage(page);
  await expect(counter.getByRole("status", { name: "Count" })).toHaveText("0");
  await counter.getByRole("button", { name: "Add one" }).click();
  await expect(counter.getByRole("status", { name: "Count" })).toHaveText("1");

  // Its settings, beside the chat in its workspace: what it is, its
  // connections and its members.
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

test("a link to an app, opened signed out, leads through sign-in to the app in the frame", async ({
  page,
  pageOf,
}) => {
  await page.goto(`/apps/${app}/pages/home`);
  await expect(
    page.getByRole("link", { name: "Sign in with a code" })
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
    // Chat's box.
    // oxlint-disable-next-line no-await-in-loop -- one address at a time
    await expect(page.getByLabel("Your question")).toBeVisible();
    expect(page.url()).toBe(`${origin}/`);
  }
});
