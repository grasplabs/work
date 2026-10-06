import { createSocket } from "node:dgram";
import type { Socket } from "node:dgram";
import { once } from "node:events";

import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { attackAppFiles } from "./attack-apps.ts";
import { recordCspViolations } from "./csp.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";
import { screenAppFiles, serveAttacker } from "./screen-app.ts";

// A screen is code nobody reviewed line by line. These are the ways it
// tries to get out of its frame, or to make the page believe something
// about it, each in Chromium, Firefox and WebKit: navigation, forms,
// scripts, workers, frames, popups and the network; a frame that never
// starts, or says it did; WebRTC; and approved code letting in code
// nobody approved.
//
// Every attack is aimed at a receiver this file runs, and carries only a
// made-up marker. A test passes when the receiver heard nothing, or when
// the page stopped the screen. The way out no policy closes, WebRTC, is
// written down as what the browser did, never counted as blocked (core's
// security-headers.ts).

const timedOut = "This app didn't start in time.";
const left = "This app left its frame and was stopped.";
const disconnected =
  "This app lost its connection to the page and was stopped.";

/**
 * Stops the page's clock where it is: from here on, time passes only when
 * a test moves it, so "not yet" and "after ten seconds" don't depend on
 * how fast the machine is. Only once the page has got as far as the test
 * needs: starting up, it waits on timers of its own.
 */
const stopClock = async (page: Page): Promise<void> => {
  // A clock stops at a time ahead of it, never behind: two seconds on,
  // which reading it and stopping it never take, and well short of ten.
  const ahead = 2000;
  await page.clock.pauseAt(await page.evaluate((ms) => Date.now() + ms, ahead));
};

/**
 * The page's bridge as a frame holds it, with what a screen past the SDK
 * would try on it.
 */
interface PageBridge {
  call: (method: unknown, args: unknown[]) => Promise<unknown>;
  authenticate: () => Promise<unknown>;
  apps: { list: () => Promise<unknown> };
  screens: {
    call: (app: string, method: string, args: unknown[]) => Promise<unknown>;
  };
  constructor: (code: string) => Promise<unknown>;
}

/** A UDP port standing in for a TURN server: it only counts packets. */
const serveTurn = async (): Promise<{
  url: string;
  packets: () => number;
  socket: Socket;
}> => {
  let packets = 0;
  const socket = createSocket("udp4");
  socket.on("message", () => {
    packets += 1;
  });
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  return {
    url: `turn:127.0.0.1:${socket.address().port}?transport=udp`,
    packets: () => packets,
    socket,
  };
};

/**
 * A new App named `name` with `files`, made current by `builder`, its
 * screens approved by `admin` exactly as core builds them: its data stays
 * sensitive.
 */
const approvedApp = async (
  by: { builder: Person; admin: Person },
  name: string,
  files: Record<string, string>
): Promise<string> => {
  const building = apiOf(by.builder);
  const deciding = apiOf(by.admin);
  try {
    const { id } = await building.api.apps.create({ name });
    const { version } = await building.api.apps.files.commit(id, files, name);
    await building.api.apps.versions.setCurrent(id, version);
    const review = await deciding.api.screenTrust.review(id);
    await deciding.api.screenTrust.approve(id, {
      version: review.version,
      generation: review.generation,
      artifacts: builtArtifacts(review.screens),
    });
    return id;
  } finally {
    building.core[Symbol.dispose]();
    deciding.core[Symbol.dispose]();
  }
};

/** A new App named `name` with `files`, released by `builder`. */
const releaseApp = async (
  builder: Person,
  name: string,
  files: Record<string, string>
): Promise<string> => {
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({ name });
    await release(api, id, files, name);
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

const screenPath = (app: string, screen: string): string =>
  `/engines/${app}/apps/${screen}/full`;

/** The page's frame for a screen, emptied or not. */
const frameOf = (page: Page) => page.locator("iframe");

let attacker: Awaited<ReturnType<typeof serveAttacker>>;
let turn: Awaited<ReturnType<typeof serveTurn>>;
let builder: Person;
/** The App whose screen probes every way out (screen-app.ts). */
let probing: string;
/** The App whose screens leave, never render, and try WebRTC. */
let attacking: string;
/** The same screens, approved by an admin, for its data. */
let approved: string;

test.beforeAll(async () => {
  attacker = await serveAttacker();
  turn = await serveTurn();
  const cast = peopleIn("screenAttacks");
  ({ builder } = cast);
  const files = attackAppFiles({ attacker: attacker.url, turn: turn.url });
  probing = await releaseApp(builder, "Probes", screenAppFiles(attacker.url));
  attacking = await releaseApp(builder, "Attacks", files);
  approved = await approvedApp(cast, "Approved attacks", {
    "app/server.ts": files["app/server.ts"] ?? "",
    "screens/injecting.tsx": files["screens/injecting.tsx"] ?? "",
  });
});

test.afterAll(() => {
  attacker.server.close();
  turn.socket.close();
});

test("a screen reaches nothing but its own App's server", async ({
  browser,
}) => {
  const page = await pageOf(browser, builder);
  const popups: string[] = [];
  page.on("popup", (popup) => {
    popups.push(popup.url());
  });
  await page.goto(screenPath(probing, "notes"));
  const screen = page.frameLocator('iframe[title="notes app"]');
  // The first open builds the screen before the frame shows anything.
  await expect(screen.getByRole("heading", { name: "Notes" })).toBeVisible({
    timeout: 30_000,
  });

  await expect(screen.getByRole("status", { name: "Probes" })).not.toBeEmpty();
  const probes: unknown = JSON.parse(
    (await screen.getByRole("status", { name: "Probes" }).textContent()) ?? ""
  );
  expect(probes).toStrictEqual({
    fetch: "blocked",
    fetchCore: "blocked",
    image: "blocked",
    popup: "blocked",
    top: "blocked",
    parentDocument: "blocked",
    cookie: "blocked",
    storage: "blocked",
    tailwindRule: "applied",
    styleRule: "applied",
  });

  // The bridge, reached past the SDK, offers only the App's own server.
  // A screen's own code can't get there: the frame runs only its build's
  // modules (the test below), so the test reaches in itself, as a
  // browser's devtools can.
  const frame = page.frame({ url: /\/screen-frame\?load=/u });
  const bridge: unknown = await frame?.evaluate(async (runtime) => {
    // SAFETY: the runtime's own module, whose `bridge` is the page's
    // bridge as the frame holds it (@grasp-os/sdk/screen-runtime).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const { bridge: connected } = (await import(runtime)) as {
      bridge: () => PageBridge;
    };
    const toPage = connected();
    // In the frame, where this runs: nothing from outside it is there.
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- see above
    const tried = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run();
        return "allowed";
      } catch (error) {
        return typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "refused";
      }
    };
    return {
      nameObject: await tried(
        async () => await toPage.call({ toString: () => "notes" }, [])
      ),
      session: await tried(async () => await toPage.authenticate()),
      apps: await tried(async () => await toPage.apps.list()),
      screens: await tried(
        async () => await toPage.screens.call("another-app", "notes", [])
      ),
      prototype: await tried(async () => await toPage.constructor("return 1")),
    };
  }, "@grasp-os~sdk~screen-runtime.js");
  expect(bridge).toStrictEqual({
    nameObject: "screen.invalid",
    session: "refused",
    apps: "refused",
    screens: "refused",
    prototype: "refused",
  });

  // An answer shaped like the platform's error is only an answer: the page
  // doesn't end the session over it.
  await screen.getByRole("button", { name: "Ask" }).click();
  await expect(screen.getByRole("status", { name: "Answer" })).toHaveText(
    "an answer"
  );
  await expect(page.getByText("Your session has ended")).toHaveCount(0);

  // Nothing got out; no socket opened, and no worker or script of the
  // attacker's ran; and the page stayed where it was.
  expect({
    hits: attacker.hits.filter((hit) => !hit.startsWith("/left")),
    ran: await frame?.evaluate(() => [
      document.body.dataset.socket,
      document.body.dataset.worker,
      document.body.dataset.remoteScript,
    ]),
    popups,
    url: new URL(page.url()).pathname,
  }).toStrictEqual({
    hits: [],
    ran: [undefined, undefined, undefined],
    popups: [],
    url: screenPath(probing, "notes"),
  });
});

test("an approved screen runs its build and nothing else: no handler, inline script, data: or blob: module or eval it lets in", async ({
  browser,
}) => {
  const page = await pageOf(browser, builder);
  await page.goto(screenPath(approved, "injecting"));
  const screen = page.frameLocator('iframe[title="injecting app"]');
  // Its own modules run: it renders, and calls its server.
  await expect(screen.getByRole("heading", { name: "Injecting" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    screen.getByRole("status", { name: "Injected" })
  ).not.toBeEmpty();
  const tried: unknown = JSON.parse(
    (await screen.getByRole("status", { name: "Injected" }).textContent()) ?? ""
  );
  const frame = page.frame({ url: /\/screen-frame\?load=/u });
  // The HTML its server sent is on the page, and its image has failed,
  // which is when its `onerror` would have run.
  await expect
    .poll(
      async () =>
        await frame?.evaluate(() => {
          const image = document.querySelector("main img");
          return image instanceof HTMLImageElement && image.complete;
        })
    )
    .toBe(true);

  expect({
    tried,
    ran: await frame?.evaluate(() => {
      const marks = document.body.dataset;
      return [
        "inlineHandler",
        "inlineScript",
        "dataModule",
        "blobModule",
        "eval",
        "function",
        "dataImport",
      ].filter((mark) => mark in marks);
    }),
  }).toStrictEqual({
    tried: {
      dataModule: "blocked",
      blobModule: "blocked",
      eval: "blocked",
      function: "blocked",
      dataImport: "blocked",
    },
    ran: [],
  });
});

test("a screen can't send its frame to another origin", async ({ browser }) => {
  const page = await pageOf(browser, builder);
  const violations = await recordCspViolations(page);
  await page.goto(screenPath(attacking, "leaving"));

  // A sandboxed frame may navigate itself, and nothing in its own policy
  // says where. The page's does: it frames this origin only. A request
  // that didn't arrive proves nothing by itself; the browser saying the
  // policy refused it does.
  await expect
    .poll(() => violations.some((text) => text.includes("frame-src")), {
      timeout: 30_000,
    })
    .toBeTruthy();
  expect({
    carried: attacker.hits.filter((hit) => hit.startsWith("/left")),
    url: new URL(page.url()).pathname,
  }).toStrictEqual({ carried: [], url: screenPath(attacking, "leaving") });
});

test("a screen that loads another document in its frame is stopped", async ({
  browser,
}) => {
  const page = await pageOf(browser, builder);
  await page.goto(screenPath(attacking, "wandering"));

  await expect(page.getByText(left)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  // Emptied: whatever the frame went to is no longer on the page.
  await expect(frameOf(page)).not.toHaveAttribute("src");
});

test("a screen that sends more than its port takes is stopped, and the page says so", async ({
  browser,
}) => {
  const page = await pageOf(browser, builder);
  await page.goto(screenPath(attacking, "oversized"));

  await expect(page.getByText(disconnected)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(frameOf(page)).not.toHaveAttribute("src");
});

test("a frame that never says it is ready is given up on after ten seconds", async ({
  browser,
}) => {
  const page = await pageOf(browser, builder);
  await page.clock.install();
  // In place of the frame's own document: one that says everything but
  // the one thing the page waits for.
  await page.route("**/screen-frame?*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>
        const load = new URLSearchParams(location.search).get("load");
        parent.postMessage({ type: "grasp:screen-ready", load: "another-load" }, "*");
        parent.postMessage({ type: "grasp:screen-ready", load, trusted: true }, "*");
        parent.postMessage({ type: "grasp:screen-mounted", load }, "*");
        parent.postMessage("grasp:screen-ready", "*");
        document.documentElement.dataset.forged = "4";
      </script>`,
    });
  });
  await page.goto(screenPath(probing, "notes"));
  await expect(page.frameLocator("iframe").locator("html")).toHaveAttribute(
    "data-forged",
    "4"
  );
  // The frame has only just loaded, so its ten seconds have only begun.
  await stopClock(page);
  await expect(page.getByText(timedOut)).toHaveCount(0);

  await page.clock.runFor(10_000);
  await expect(page.getByText(timedOut)).toBeVisible();
  await expect(frameOf(page)).not.toHaveAttribute("src");

  // Trying again is a new frame, which starts as any other.
  await page.clock.resume();
  await page.unroute("**/screen-frame?*");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page
      .frameLocator('iframe[title="notes app"]')
      .getByRole("heading", { name: "Notes" })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(timedOut)).toHaveCount(0);
});

test("a screen that never renders is given up on after ten seconds, whatever it says", async ({
  browser,
}) => {
  const page = await pageOf(browser, builder);
  await page.clock.install();
  await page.goto(screenPath(attacking, "stuck"));
  // Its module ran, and told the page it had mounted, six ways.
  await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute(
    "data-forged",
    "6",
    { timeout: 30_000 }
  );
  // The screen was only just handed over, so its ten seconds have only
  // begun.
  await stopClock(page);
  await expect(page.getByText(timedOut)).toHaveCount(0);

  await page.clock.runFor(10_000);
  await expect(page.getByText(timedOut)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(frameOf(page)).not.toHaveAttribute("src");
});

test("WebRTC is left as the browser has it: nothing hidden, nothing claimed", async ({
  browser,
}) => {
  const page = await pageOf(browser, builder);
  await page.goto(screenPath(attacking, "turn"));
  const screen = page.frameLocator('iframe[title="turn app"]');
  await expect(screen.getByRole("status", { name: "WebRTC" })).not.toBeEmpty({
    timeout: 30_000,
  });
  const outcome = await screen
    .getByRole("status", { name: "WebRTC" })
    .textContent();

  // The frame has exactly the WebRTC its browser has. Taking it away in
  // the frame would only look safe: the screen's code runs there too.
  const frame = page.frame({ url: /\/screen-frame\?load=/u });
  expect(await frame?.evaluate(() => typeof RTCPeerConnection)).toBe(
    await page.evaluate(() => typeof RTCPeerConnection)
  );
  expect(["gathering", "refused", "unavailable"]).toContain(outcome);

  // What the browser then sent the stand-in TURN server is its own
  // doing, which no policy of the frame governs. Written down, either
  // way; a browser that sends nothing here is not thereby safe.
  // A few seconds is how long a browser that sends at all takes here.
  let reached = true;
  try {
    await expect.poll(turn.packets, { timeout: 3000 }).toBeGreaterThan(0);
  } catch {
    reached = false;
  }
  test.info().annotations.push({
    type: "limit: WebRTC to a TURN server",
    description: `${outcome}; ${
      reached
        ? `${turn.packets()} packets reached the stand-in server`
        : "no packet reached the stand-in server in 3 s"
    }`,
  });
});
