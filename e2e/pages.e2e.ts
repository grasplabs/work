import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { fileCast } from "./contexts.ts";
import { test } from "./csp.ts";
import { pageAppFiles, serveAttacker } from "./page-app.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";

// An App's page in its sandboxed frame, end to end: the page, the frame,
// core and the App's sealed release, in a real browser. The page reads
// and writes through its App's functions, sees another person's changes
// live, and reports its errors. What it does as code nobody reviewed line
// by line, to get anywhere else, is in page-attacks.e2e.ts, in every
// browser.

/**
 * A new App named `name` running the sample, released by `builder`, and
 * shared with `sharedWith` to use.
 */
const releaseApp = async (
  builder: Person,
  attacker: string,
  name = "Notes",
  sharedWith?: Person
): Promise<string> => {
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({ name });
    await release(api, id, pageAppFiles(attacker));
    if (sharedWith !== undefined) {
      await api.apps.members.add(id, {
        type: "person",
        id: sharedWith.userId,
        role: "user",
      });
    }
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

/**
 * Opens the notes page, once it shows. The first open of an App's page
 * builds it before the frame can show anything, which on a loaded machine
 * takes longer than the default 5 seconds.
 */
const openPage = async (page: Page, app: string) => {
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator('iframe[title="App"]');
  await expect(appPage.getByRole("heading", { name: "Notes" })).toBeVisible({
    timeout: 20_000,
  });
  return appPage;
};

let attacker: Awaited<ReturnType<typeof serveAttacker>>;
let one: Person;
let two: Person;
let app: string;

test.beforeAll(async () => {
  attacker = await serveAttacker();
  await fileCast();
  ({ one, two } = peopleIn("pages"));
  app = await releaseApp(one, attacker.url, "Notes", two);
});

test.afterAll(() => {
  attacker.server.close();
});

test("two people see each other's notes live, and a failing page lands in the App's error log", async ({
  pageOf,
}) => {
  const [first, second] = await Promise.all([pageOf(one), pageOf(two)]);
  const [firstPage, secondPage] = await Promise.all([
    openPage(first, app),
    openPage(second, app),
  ]);

  // The page marks what the App draws as the App's: its name heads the
  // chrome around the frame.
  await expect(first.getByRole("heading", { name: "Notes" })).toBeVisible();

  await firstPage.getByRole("button", { name: "Add a note" }).click();
  const note = `Call Acme by ${one.userId}`;
  await expect(
    secondPage.getByRole("list", { name: "Notes" }).getByText(note)
  ).toBeVisible();
  await expect(
    firstPage.getByRole("list", { name: "Notes" }).getByText(note)
  ).toBeVisible();

  await secondPage.getByRole("button", { name: "Fail" }).click();
  const { core, api } = apiOf(one);
  try {
    await expect
      .poll(async () => {
        const { entries } = await api.pages.errors(app);
        return entries.map(({ message }) => message);
      })
      .toContain("Invoice 7 has no total");
  } finally {
    core[Symbol.dispose]();
  }
});
