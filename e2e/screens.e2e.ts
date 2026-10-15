import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";
import { screenAppFiles, serveAttacker } from "./screen-app.ts";

// An App's screen in its sandboxed frame, end to end: the page, the frame,
// core and the App's server, in a real browser. The screen reads and writes
// through its server, sees another person's changes live, and reports its
// errors. What it does as code nobody reviewed line by line, to get
// anywhere else, is in screen-attacks.e2e.ts, in every browser.

declare global {
  interface Window {
    /**
     * What the page showed each frame, sampled by a test below: its
     * address, the App name in its chrome and its screen frame's address.
     */
    chromeNames: { path: string; name: string; frame: string }[];
  }
}

/**
 * How long no further connection may open once the page has reconnected.
 * A second round of attempts would have tried at the same moment as the
 * one that held (both wait 2 s after the refused attempt), so it shows
 * well within this.
 */
const noMoreConnectionsMs = 2000;

const timedOut = "This app didn't start in time.";

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
    await release(api, id, screenAppFiles(attacker), name);
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
 * Opens the notes screen, once it shows. The first open of an App's screen
 * builds it before the frame can show anything, which on a loaded machine
 * takes longer than the default 5 seconds.
 */
const openScreen = async (page: Page, app: string) => {
  await page.goto(`/domains/${app}/apps/notes/full`);
  const screen = page.frameLocator('iframe[title="notes app"]');
  await expect(screen.getByRole("heading", { name: "Notes" })).toBeVisible({
    timeout: 20_000,
  });
  return screen;
};

let attacker: Awaited<ReturnType<typeof serveAttacker>>;
let one: Person;
let two: Person;
let app: string;

test.beforeAll(async () => {
  attacker = await serveAttacker();
  ({ one, two } = peopleIn("screens"));
  app = await releaseApp(one, attacker.url, "Notes", two);
});

test.afterAll(() => {
  attacker.server.close();
});

test("two people see each other's notes live, in their theme, and a failing screen lands in the App's error log", async ({
  browser,
}) => {
  const [first, second] = await Promise.all([
    pageOf(browser, one),
    pageOf(browser, two),
  ]);
  await first.emulateMedia({ colorScheme: "light" });
  const [firstScreen, secondScreen] = await Promise.all([
    openScreen(first, app),
    openScreen(second, app),
  ]);

  // The page marks what the App draws as the App's, around the frame.
  await expect(first.getByText("Domain app", { exact: true })).toBeVisible();
  await expect(first.getByRole("heading", { name: "Notes" })).toBeVisible();

  // The screen follows its page's theme.
  const frame = first.frame({ url: /\/screen-frame\?load=/u });
  const dark = async () =>
    await frame?.evaluate(() =>
      document.documentElement.classList.contains("dark")
    );
  expect(await dark()).toBeFalsy();
  await first.emulateMedia({ colorScheme: "dark" });
  await expect.poll(dark).toBeTruthy();

  await firstScreen.getByRole("button", { name: "Add a note" }).click();
  const note = `Call Acme by ${one.userId}`;
  await expect(
    secondScreen.getByRole("list", { name: "Notes" }).getByText(note)
  ).toBeVisible();
  await expect(
    firstScreen.getByRole("list", { name: "Notes" }).getByText(note)
  ).toBeVisible();

  await secondScreen.getByRole("button", { name: "Fail" }).click();
  const { core, api } = apiOf(one);
  try {
    await expect
      .poll(async () => {
        const { entries } = await api.screens.errors(app);
        return entries.map(({ message }) => message);
      })
      .toContain("Invoice 7 has no total");
  } finally {
    core[Symbol.dispose]();
  }
});

test("a screen opens through core failing at first, subscribes again after its connection drops, and tries one connection at a time", async ({
  browser,
}) => {
  const page = await pageOf(browser, one);
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
      if (failOpens > 0 && String(message).includes('["screens","open"]')) {
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
  const screen = await openScreen(page, app);
  // The page opens no connection but the screen's own (this route has no
  // shell): the refused first attempt, the one whose open failed, and the
  // one the screen opened on.
  expect(failedOpens).toBe(1);
  expect(connections).toBe(3);
  await drop?.();

  // Only a new subscription, on the page's new connection, can bring it.
  const { core, api } = apiOf(two);
  try {
    await api.screens.call(app, "addNote", ["After the drop"]);
  } finally {
    core[Symbol.dispose]();
  }
  await expect(
    screen
      .getByRole("list", { name: "Notes" })
      .getByText(`After the drop by ${two.userId}`)
  ).toBeVisible({ timeout: 20_000 });
  // One refused attempt, then one that holds, and none beside or after it:
  // a failed attempt doesn't start another round of attempts of its own.
  await expect.poll(() => afterDrop).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(noMoreConnectionsMs);
  expect(afterDrop).toBe(2);
});

test("a screen whose open core never answers is given up on in its time, and opens when tried again", async ({
  browser,
}) => {
  const page = await pageOf(browser, one);
  await page.clock.install();
  let stall = true;
  const stalled = Promise.withResolvers<boolean>();
  // Core never hears the open, as with a build that stalls or a
  // connection that does: the page's own deadline is all that ends it.
  await page.routeWebSocket("**/rpc", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (stall && String(message).includes('["screens","open"]')) {
        stalled.resolve(true);
        return;
      }
      server.send(message);
    });
  });
  await page.goto(`/domains/${app}/apps/notes/full`);
  await stalled.promise;
  await expect(page.getByText(timedOut)).toHaveCount(0);

  await page.clock.runFor(20_000);
  await expect(page.getByText(timedOut)).toBeVisible();

  stall = false;
  await page.clock.resume();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page
      .frameLocator('iframe[title="notes app"]')
      .getByRole("heading", { name: "Notes" })
  ).toBeVisible({ timeout: 20_000 });
});

test("moving to another App's screen never shows the App it left in the chrome", async ({
  browser,
}) => {
  const other = await releaseApp(one, attacker.url, "Tasks");
  const page = await pageOf(browser, one);
  await openScreen(page, app);
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
  const otherPath = `/domains/${other}/apps/notes/full`;
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
    ({ path, frame }) => path === otherPath && frame !== first?.frame
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

test("a new current version is offered while the screen is open", async ({
  browser,
}) => {
  const page = await pageOf(browser, one);
  await page.clock.install();
  await openScreen(page, app);
  const { core, api } = apiOf(one);
  try {
    await release(
      api,
      app,
      {
        "screens/notes.tsx": `${screenAppFiles(attacker.url)["screens/notes.tsx"]}// v2\n`,
      },
      "v2"
    );
  } finally {
    core[Symbol.dispose]();
  }

  await page.clock.fastForward(30_000);
  await expect(
    page.getByText("A new version of this domain is available.")
  ).toBeVisible();
});
