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

declare global {
  interface Window {
    /**
     * What the page showed each frame, sampled by a test below: its
     * address, the App name in its chrome and its page frame's address.
     */
    chromeNames: { path: string; name: string; frame: string }[];
  }
}

/**
 * How long no further connection may open once the page has reconnected.
 * A second round of attempts would have tried about when the one that held
 * did (each waits up to 2 s after the refused attempt), so it shows within
 * this.
 */
const noMoreConnectionsMs = 2000;

const timedOut = "This page didn't start";

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
    await release(api, id, pageAppFiles(attacker), name);
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

test("two people see each other's notes live, in their theme, and a failing page lands in the App's error log", async ({
  pageOf,
}) => {
  const [first, second] = await Promise.all([pageOf(one), pageOf(two)]);
  await first.emulateMedia({ colorScheme: "light" });
  const [firstPage, secondPage] = await Promise.all([
    openPage(first, app),
    openPage(second, app),
  ]);

  // The page marks what the App draws as the App's, around the frame.
  await expect(first.getByText("App page", { exact: true })).toBeVisible();
  await expect(first.getByRole("heading", { name: "Notes" })).toBeVisible();

  // The page follows its page's theme.
  const frame = first.frame({ url: /\/page-frame\?load=/u });
  const dark = async () =>
    await frame?.evaluate(() =>
      document.documentElement.classList.contains("dark")
    );
  expect(await dark()).toBeFalsy();
  await first.emulateMedia({ colorScheme: "dark" });
  await expect.poll(dark).toBeTruthy();

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

test("a page opens through core failing at first, subscribes again after its connection drops, and tries one connection at a time", async ({
  pageOf,
}) => {
  const page = await pageOf(one);
  let drop: (() => Promise<void>) | undefined;
  let dropped = false;
  let connections = 0;
  let afterDrop = 0;
  // Core is out of reach for the first attempt, and again for the next
  // attempt after the drop.
  let refuse = 1;
  // Core fails the first open, on whichever connection it comes, by
  // closing that connection instead of passing the open on.
  let failOpens = 1;
  let failedOpens = 0;
  await page.routeWebSocket("**/rpc", async (socket) => {
    connections += 1;
    if (dropped) {
      afterDrop += 1;
    }
    if (refuse > 0) {
      refuse -= 1;
      await socket.close();
      return;
    }
    const server = socket.connectToServer();
    socket.onMessage(async (message) => {
      if (failOpens > 0 && String(message).includes('["pages","open"]')) {
        failOpens -= 1;
        failedOpens += 1;
        await socket.close();
        return;
      }
      server.send(message);
    });
    drop = async () => {
      dropped = true;
      refuse = 1;
      await socket.close();
    };
  });
  const appPage = await openPage(page, app);
  // The page opens no connection but the page's own (this route has no
  // shell): the refused first attempt, the one whose open failed, and the
  // one the page opened on.
  expect(failedOpens).toBe(1);
  expect(connections).toBe(3);
  await drop?.();

  // Only a new subscription, on the page's new connection, can bring it:
  // the note the other person adds on their own page after the drop.
  const other = await openPage(await pageOf(two), app);
  await other.getByRole("button", { name: "Add a note" }).click();
  await expect(
    appPage
      .getByRole("list", { name: "Notes" })
      .getByText(`Call Acme by ${two.userId}`)
  ).toBeVisible({ timeout: 20_000 });
  // One refused attempt, then one that holds, and none beside or after it:
  // a failed attempt doesn't start another round of attempts of its own.
  await expect.poll(() => afterDrop).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(noMoreConnectionsMs);
  expect(afterDrop).toBe(2);
});

test("a page whose open core never answers is given up on in its time, and opens when tried again", async ({
  pageOf,
}) => {
  const page = await pageOf(one);
  await page.clock.install();
  let stall = true;
  const stalled = Promise.withResolvers<boolean>();
  // Core never hears the open, as with a build that stalls or a
  // connection that does: the page's own deadline is all that ends it.
  await page.routeWebSocket("**/rpc", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (stall && String(message).includes('["pages","open"]')) {
        stalled.resolve(true);
        return;
      }
      server.send(message);
    });
  });
  await page.goto(`/apps/${app}/full`);
  await stalled.promise;
  await expect(page.getByText(timedOut)).toHaveCount(0);

  await page.clock.runFor(20_000);
  await expect(page.getByText(timedOut)).toBeVisible();

  stall = false;
  await page.clock.resume();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page
      .frameLocator('iframe[title="App"]')
      .getByRole("heading", { name: "Notes" })
  ).toBeVisible({ timeout: 20_000 });
});

test("moving to another App's page never shows the App it left in the chrome", async ({
  pageOf,
}) => {
  const other = await releaseApp(one, attacker.url, "Tasks");
  const page = await pageOf(one);
  await openPage(page, app);
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();

  // Every frame, what the page shows at its address.
  await page.evaluate(() => {
    const names: Window["chromeNames"] = [];
    window.chromeNames = names;
    const sample = () => {
      names.push({
        path: location.pathname,
        name: document.querySelector("header h1")?.textContent ?? "",
        frame: document.querySelector("iframe")?.getAttribute("src") ?? "",
      });
      requestAnimationFrame(sample);
    };
    sample();
  });
  // Within the page, as a link would: a new document would start afresh.
  const otherPath = `/apps/${other}/full`;
  await page.evaluate((path) => {
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, otherPath);
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  // Until a sample has caught it too, not only the page.
  await expect
    .poll(
      async () =>
        await page.evaluate(() =>
          window.chromeNames.some(({ name }) => name === "Tasks")
        )
    )
    .toBeTruthy();

  const shown = await page.evaluate(() => window.chromeNames);
  const [first] = shown;
  // The address changes a moment before the page renders for it. It has
  // rendered for the new App once its frame is no longer the one it had.
  const rendered = shown.filter(
    ({ path, frame }) =>
      path === otherPath.split("?")[0] && frame !== first?.frame
  );
  const named = rendered.findIndex(({ name }) => name === "Tasks");
  expect({
    renderedWithOldName: rendered.some(({ name }) => name === "Notes"),
    namedTheNewApp: named !== -1,
    oldNameAfterNew: rendered.slice(named).some(({ name }) => name === "Notes"),
  }).toStrictEqual({
    renderedWithOldName: false,
    namedTheNewApp: true,
    oldNameAfterNew: false,
  });
});

test("a tab holds one connection to core for its shell and every App frame it opens", async ({
  pageOf,
}) => {
  const other = await releaseApp(one, attacker.url, "Board");
  const page = await pageOf(one);
  const sockets: string[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname === "/rpc") {
      sockets.push(socket.url());
    }
  });
  /** Moves within the page, as a link would: a new document starts afresh. */
  const moveTo = async (path: string): Promise<void> => {
    await page.evaluate((to) => {
      history.pushState(null, "", to);
      dispatchEvent(new PopStateEvent("popstate"));
    }, path);
  };
  /** The App frame on the page, once its page shows `name`. */
  const shows = async (name: string) => {
    const appPage = page.frameLocator('iframe[title="App"]');
    await expect(
      page.getByRole("heading", { exact: true, level: 1, name })
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(appPage.getByRole("heading", { name: "Notes" })).toBeVisible({
      timeout: 20_000,
    });
    return appPage;
  };

  // The shell, then one App's frame after another, and back to the first.
  await page.goto("/dashboard");
  await expect(page.getByRole("navigation").first()).toBeVisible();
  await moveTo(`/apps/${app}`);
  await shows("Notes");
  await moveTo(`/apps/${other}`);
  await shows("Board");
  await moveTo(`/apps/${app}`);
  const appPage = await shows("Notes");

  // The frame reads and writes through that same connection.
  await appPage.getByRole("button", { name: "Add a note" }).click();
  await expect(
    appPage
      .getByRole("list", { name: "Notes" })
      .getByText(`Call Acme by ${one.userId}`)
      .first()
  ).toBeVisible();
  expect(sockets).toHaveLength(1);
});

test("a page with nothing unsaved switches to a new current version by itself", async ({
  pageOf,
}) => {
  const page = await pageOf(one);
  const appPage = await openPage(page, app);
  const frameAddress = async (): Promise<string | null> =>
    await page.locator('iframe[title="App"]').getAttribute("src");
  const before = await frameAddress();
  const { core, api } = apiOf(one);
  try {
    await release(
      api,
      app,
      {
        "src/routes/index.tsx": `${pageAppFiles(attacker.url).files["src/routes/index.tsx"]}// v2\n`,
      },
      "v2"
    );
  } finally {
    core[Symbol.dispose]();
  }

  // Told over the tab's connection, not on a timer: no clock runs here.
  await expect.poll(frameAddress, { timeout: 20_000 }).not.toBe(before);
  await expect(appPage.getByRole("heading", { name: "Notes" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
