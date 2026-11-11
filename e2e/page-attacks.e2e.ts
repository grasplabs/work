import { createSocket } from "node:dgram";
import type { Socket } from "node:dgram";
import { once } from "node:events";

import { appFilesPath } from "@grasp-os/shared/app-file-limits";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import type { TestSource } from "../apps/core/test/app-definitions.ts";
import { attackAppFiles, injectingAppFiles } from "./attack-apps.ts";
import { fileCast, test } from "./contexts.ts";
import { recordCspViolations } from "./csp.ts";
import { pageAppFiles, serveAttacker } from "./page-app.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";

// A page is code nobody reviewed line by line. These are the ways it
// tries to get out of its frame, or to make the page believe something
// about it, each in Chromium, Firefox and WebKit: navigation, forms,
// scripts, workers, frames, popups and the network; a frame that never
// starts, or says it did; WebRTC; and a page's build letting in code
// that isn't part of it.
//
// Every attack is aimed at a receiver this file runs, and carries only a
// made-up marker. A test passes when the receiver heard nothing, or when
// the page stopped the page. WebRTC, which no directive closes, is
// taken from the frame before the page runs, and the page can make
// no document of its own whose WebRTC or network it could use (core's
// page-frame.ts).

const timedOut = "This page didn't start in time.";
const left = "This page left its frame and was stopped.";
const disconnected = "This page lost its connection to Grasp and was stopped.";

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
 * The page's bridge as a frame holds it, with what a page past the SDK
 * would try on it.
 */
interface PageBridge {
  call: (method: unknown, args: unknown[]) => Promise<unknown>;
  callFunction: (request: unknown) => Promise<unknown>;
  authenticate: () => Promise<unknown>;
  apps: { list: () => Promise<unknown> };
  pages: {
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

/** A new App named `name` with `files`, released by `builder`. */
const releaseApp = async (
  builder: Person,
  name: string,
  files: TestSource
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

/** The full page of `app` at its route `path`, `""` for its `/`. */
const pagePath = (app: string, path = ""): string => `/apps/${app}/full${path}`;

/**
 * Opens `path` on `page`, waiting only for Grasp's page to arrive. A
 * page's `load` waits for its frames too, here an attack, and what each
 * test checks it waits for itself. In Firefox, waiting for `load` now and
 * then never ended, and the test timed out on it (in CI, and in 1 of about
 * 430 runs on a Mac, November 2026).
 */
const open = async (page: Page, path: string): Promise<void> => {
  await page.goto(path, { waitUntil: "commit" });
};

/** The page's frame for a page, emptied or not. */
const frameOf = (page: Page) => page.locator("iframe");

let attacker: Awaited<ReturnType<typeof serveAttacker>>;
let turn: Awaited<ReturnType<typeof serveTurn>>;
let builder: Person;
/** The App whose page probes every way out (page-app.ts). */
let probing: string;
/** The App whose pages leave, never render, and try WebRTC. */
let attacking: string;
/** The App whose page renders what lets other code in. */
let injecting: string;

test.beforeAll(async () => {
  attacker = await serveAttacker();
  turn = await serveTurn();
  await fileCast();
  ({ builder } = peopleIn("pageAttacks"));
  const files = attackAppFiles({ attacker: attacker.url, turn: turn.url });
  probing = await releaseApp(builder, "Probes", pageAppFiles(attacker.url));
  attacking = await releaseApp(builder, "Attacks", files);
  injecting = await releaseApp(builder, "Injecting", injectingAppFiles());
});

test.afterAll(() => {
  attacker.server.close();
  turn.socket.close();
});

test("a page reaches nothing but its own App's functions", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  const popups: string[] = [];
  page.on("popup", (popup) => {
    popups.push(popup.url());
  });
  await open(page, pagePath(probing));
  const appPage = page.frameLocator('iframe[title="App"]');
  // The first open builds the page before the frame shows anything.
  await expect(appPage.getByRole("heading", { name: "Notes" })).toBeVisible({
    timeout: 30_000,
  });

  await expect(appPage.getByRole("status", { name: "Probes" })).not.toBeEmpty();
  const probes: unknown = JSON.parse(
    (await appPage.getByRole("status", { name: "Probes" }).textContent()) ?? ""
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

  // An answer shaped like the platform's error is only an answer, whether
  // a call's result or a live query's snapshot pushed over the page's own
  // connection: the page doesn't end the session over it. The request the
  // page's client sent for the call is kept: a valid one, for the probes
  // below.
  const asked = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().includes("/api/app-functions/")
  );
  await appPage.getByRole("button", { name: "Ask" }).click();
  const askRequest = await asked;
  const validRequest = askRequest.postData() ?? "";
  expect(validRequest).toContain(
    '"reference":{"name":"notes.lookLikeThePlatform","kind":"action"}'
  );
  await expect(appPage.getByRole("status", { name: "Answer" })).toHaveText(
    "an answer"
  );
  await expect(appPage.getByRole("status", { name: "Followed" })).toHaveText(
    "an answer"
  );
  await expect(page.getByText("Your session has ended")).toHaveCount(0);

  // The bridge, reached past the SDK, offers only the App's own functions.
  // A page's own code can't get there: the frame runs only its build's
  // modules (the test below), so the test reaches in itself, as a
  // browser's devtools can.
  const frame = page.frame({ url: /\/page-frame\?load=/u });
  const bridge: unknown = await frame?.evaluate(
    async ({ runtime, valid }) => {
      // SAFETY: the runtime's own module, whose `bridge` is the page's
      // bridge as the frame holds it (@grasp-os/runtime/page).
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
      // A function call that reached core: "ran" if the function ran,
      // otherwise why not.
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- see above
      const called = async (run: () => Promise<unknown>): Promise<string> => {
        try {
          const answer: unknown = await run();
          const result: unknown =
            typeof answer === "object" && answer !== null && "result" in answer
              ? answer.result
              : undefined;
          if (typeof result === "object" && result !== null && "ok" in result) {
            return result.ok === true ? "ran" : "failed";
          }
          return "unread";
        } catch (error) {
          return typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "refused";
        }
      };
      // Arrays cross the port intact (Cap'n Web drops an object's own
      // `toString`), and one of a single string reads as that string to
      // anything that coerces it.
      return {
        // A call of the App's server: the bridge has none.
        serverCall: await tried(async () => await toPage.call("notes", [])),
        // The valid request as text runs (its key answers the kept answer)...
        control: await called(async () => await toPage.callFunction(valid)),
        // ...and the same request in an array is refused before core.
        request: await called(async () => await toPage.callFunction([valid])),
        session: await tried(async () => await toPage.authenticate()),
        apps: await tried(async () => await toPage.apps.list()),
        pages: await tried(
          async () => await toPage.pages.call("another-app", "notes", [])
        ),
        prototype: await tried(
          async () => await toPage.constructor("return 1")
        ),
      };
    },
    { runtime: "@grasp-os~runtime~page.js", valid: validRequest }
  );
  expect(bridge).toStrictEqual({
    serverCall: "refused",
    control: "ran",
    request: "page.invalid",
    session: "refused",
    apps: "refused",
    pages: "refused",
    prototype: "refused",
  });

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
    url: `${new URL(page.url()).pathname}${new URL(page.url()).search}`,
  }).toStrictEqual({
    hits: [],
    ran: [undefined, undefined, undefined],
    popups: [],
    url: pagePath(probing),
  });
});

test("a page runs its build and nothing else: no handler, inline script, data: or blob: module or eval it lets in", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  await open(page, pagePath(injecting));
  const appPage = page.frameLocator('iframe[title="App"]');
  // Its own modules run: it renders, and reads its App's query.
  await expect(appPage.getByRole("heading", { name: "Injecting" })).toBeVisible(
    {
      timeout: 30_000,
    }
  );
  await expect(
    appPage.getByRole("status", { name: "Injected" })
  ).not.toBeEmpty();
  const tried: unknown = JSON.parse(
    (await appPage.getByRole("status", { name: "Injected" }).textContent()) ??
      ""
  );
  const frame = page.frame({ url: /\/page-frame\?load=/u });

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
      // The HTML parser takes no string in the frame (Trusted Types), so
      // the App's HTML never becomes elements, nor the script text code.
      html: "blocked",
      inlineScript: "blocked",
      dataModule: "blocked",
      blobModule: "blocked",
      eval: "blocked",
      function: "blocked",
      dataImport: "blocked",
    },
    ran: [],
  });
});

/** The address of the page's module a page's frame names, token and all. */
const frameEntry = async (page: Page): Promise<string> => {
  const described = page.frameLocator('iframe[title="App"]').locator("#page");
  await expect(described).toBeAttached({ timeout: 30_000 });
  return z
    .object({ entry: z.string() })
    .parse(JSON.parse((await described.textContent()) ?? "")).entry;
};

test("a page imports no module but its build's: not another App's, a file's or one past its directory, however escaped", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  const violations = await recordCspViolations(page);
  // Another App's build, as its own frame names it, valid token and all.
  await open(page, pagePath(probing));
  const other = new URL(await frameEntry(page));
  const { scope = "", file = "" } =
    /^\/page-modules\/(?<scope>[^/]+)\/(?<file>[^/]+)$/u.exec(other.pathname)
      ?.groups ?? {};
  await open(page, pagePath(injecting));
  const own = new URL(await frameEntry(page));
  const directory = new URL("./", own).href;
  const { origin } = own;
  // Refused by the frame's policy: each is outside its two directories.
  const outside = {
    anotherApp: other.href,
    // The URL parser resolves `%2e%2e` before the policy matches it.
    dotSegments: `${directory}%2e%2e/${scope}/1/${file}${other.search}`,
    sharedKit: `${origin}/page-modules/kit/${file}`,
    appFile: `${origin}${appFilesPath}/${"e".repeat(32)}/content`,
  };
  // Under its directory as the browser matches the path, another App's
  // module once decoded: core answers none of them.
  const escaped = {
    escapedSlash: `${directory}..%2F${scope}/${file}${other.search}`,
    escapedBackslash: `${directory}..%5C${scope}%5C${file}${other.search}`,
  };
  const frame = page.frame({ url: /\/page-frame\?load=/u });
  const tried = await frame?.evaluate(
    async (addresses) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(addresses).map(
            async ([name, address]) =>
              [
                name,
                await import(address).then(
                  (): string => "ran",
                  (): string => "blocked"
                ),
              ] as const
          )
        )
      ),
    { ...outside, ...escaped }
  );

  expect(tried).toStrictEqual({
    anotherApp: "blocked",
    dotSegments: "blocked",
    sharedKit: "blocked",
    appFile: "blocked",
    escapedSlash: "blocked",
    escapedBackslash: "blocked",
  });
  // The policy refused those outside, not some other failure to load.
  await expect
    .poll(() =>
      Object.entries(outside)
        .filter(
          ([, address]) =>
            !violations.some((line) => line.includes(new URL(address).pathname))
        )
        .map(([name]) => name)
    )
    .toStrictEqual([]);
});

test("a page can't send its frame to another origin", async ({ pageOf }) => {
  const page = await pageOf(builder);
  const violations = await recordCspViolations(page);
  await open(page, pagePath(attacking, "/leaving"));

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
    url: `${new URL(page.url()).pathname}${new URL(page.url()).search}`,
  }).toStrictEqual({ carried: [], url: pagePath(attacking, "/leaving") });
});

test("a page that loads another document in its frame is stopped", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  await open(page, pagePath(attacking, "/wandering"));

  await expect(page.getByText(left)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  // Emptied: whatever the frame went to is no longer on the page.
  await expect(frameOf(page)).not.toHaveAttribute("src");
});

test("a page that sends more than its port takes is stopped, and the page says so", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  await open(page, pagePath(attacking, "/oversized"));

  await expect(page.getByText(disconnected)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(frameOf(page)).not.toHaveAttribute("src");
});

test("a frame that never says it is ready is given up on after ten seconds", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  await page.clock.install();
  // In place of the frame's own document: one that says everything but
  // the one thing the page waits for.
  await page.route("**/page-frame?*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>
        const load = new URLSearchParams(location.search).get("load");
        parent.postMessage({ type: "grasp:page-ready", load: "another-load" }, "*");
        parent.postMessage({ type: "grasp:page-ready", load, trusted: true }, "*");
        parent.postMessage({ type: "grasp:page-mounted", load }, "*");
        parent.postMessage("grasp:page-ready", "*");
        document.documentElement.dataset.forged = "4";
      </script>`,
    });
  });
  await open(page, pagePath(probing));
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
  await page.unroute("**/page-frame?*");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page
      .frameLocator('iframe[title="App"]')
      .getByRole("heading", { name: "Notes" })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(timedOut)).toHaveCount(0);
});

test("a page that never renders is given up on after ten seconds, whatever it says", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  await page.clock.install();
  await open(page, pagePath(attacking, "/stuck"));
  // Its module ran, and told the page it had mounted, six ways.
  await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute(
    "data-forged",
    "6",
    { timeout: 30_000 }
  );
  // The page was only just handed over, so its ten seconds have only
  // begun.
  await stopClock(page);
  await expect(page.getByText(timedOut)).toHaveCount(0);

  await page.clock.runFor(10_000);
  await expect(page.getByText(timedOut)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(frameOf(page)).not.toHaveAttribute("src");
});

test("a page another site opened keeps no handle on that site, so its pages can post it nothing", async ({
  pageOf,
  baseURL,
}) => {
  const page = await pageOf(builder);
  // Straight to the attacker's site. Leaving Grasp's page while it still
  // loaded, Firefox failed the route's module, and the page left loading
  // itself again for the missing file cancelled the visit here
  // (NS_BINDING_ABORTED), in 5 of 12 tries (November 2026).
  const address = new URL(pagePath(attacking, "/turn"), baseURL).href;
  // The attacker's site opens Grasp, as a link with a target would.
  await page.goto(attacker.url);
  const [opened] = await Promise.all([
    page.waitForEvent("popup"),
    page.evaluate((url) => {
      window.open(url);
    }, address),
  ]);
  // Not its `load`, which waits for the attack's frame too (`open`).
  const appPage = opened.frameLocator('iframe[title="App"]');
  await expect(
    appPage.getByRole("status", { name: "Nested documents" })
  ).not.toBeEmpty({ timeout: 30_000 });
  const frame = opened.frame({ url: /\/page-frame\?load=/u });
  expect({
    pageOpener: await opened.evaluate(() => window.opener === null),
    frameOpener: await frame?.evaluate(() => window.top?.opener === null),
  }).toStrictEqual({ pageOpener: true, frameOpener: true });
});

test("a page makes no document of its own and reaches no network, WebRTC or a name looked up ahead of time", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  // Connections, not requests: a route that only opens a socket (a
  // preconnect) is counted too.
  const connectionsBefore = attacker.connections();
  const frameDocument = page.waitForResponse((response) =>
    response.url().includes("/page-frame?")
  );
  await open(page, pagePath(attacking, "/turn"));
  // No name the page writes is looked up ahead of time.
  const served = await frameDocument;
  expect(served.headers()["x-dns-prefetch-control"]).toBe("off");
  const appPage = page.frameLocator('iframe[title="App"]');
  const said = appPage.getByRole("status", { name: "Nested documents" });
  await expect(said).not.toBeEmpty({ timeout: 30_000 });
  const { sanitizer, parseHTMLUnsafe, shadowSetHTMLUnsafe, ...outcome } = z
    .record(z.string(), z.string())
    .parse(JSON.parse((await said.textContent()) ?? ""));

  // Where the browser has them: the Sanitizer API and the static parser
  // are refused outright, a shadow root's parser by Trusted Types.
  expect({
    sanitizer: ["refused: NotSupportedError", "no such method"].includes(
      sanitizer ?? ""
    ),
    parseHTMLUnsafe: ["refused: NotSupportedError", "no such method"].includes(
      parseHTMLUnsafe ?? ""
    ),
    shadowSetHTMLUnsafe: ["refused: TypeError", "no such method"].includes(
      shadowSetHTMLUnsafe ?? ""
    ),
  }).toStrictEqual({
    sanitizer: true,
    parseHTMLUnsafe: true,
    shadowSetHTMLUnsafe: true,
  });
  expect(outcome).toStrictEqual({
    // Every sink of the HTML parser refuses a string (Trusted Types).
    innerHTML: "refused: TypeError",
    shadowInnerHTML: "refused: TypeError",
    insertAdjacentHTML: "refused: TypeError",
    domParser: "refused: TypeError",
    // Writing into the document is refused before Trusted Types is asked.
    documentWrite: "refused: NotSupportedError",
    contextualFragment: "refused: TypeError",
    setHTMLUnsafe: "refused: TypeError",
    linkMarkup: "refused: TypeError",
    // The rest the frame's bootstrap refuses, by what was made.
    prefix: "refused: NotSupportedError",
    convertedTwice: "made: no realm",
    createDocument: "refused: NotSupportedError",
    customizedBuiltIn: "refused: NotSupportedError",
    customizedBuiltInByName: "refused: NotSupportedError",
    execCommand: "refused: NotSupportedError",
    xslt: "undefined",
    named: "none",
    indexed: "undefined",
    peer: "no WebRTC",
    // Nothing the bootstrap keeps is reachable by name from the page.
    bootstrapNames:
      "undefined,undefined,undefined,undefined,undefined,undefined,undefined",
    keptCreateElement: "not reachable",
    // A link may be made, but given no address, so nothing connects to
    // one ahead of time.
    "dns-prefetch": "refused: NotSupportedError",
    preconnect: "refused: NotSupportedError",
    prefetch: "refused: NotSupportedError",
    linkAttribute: "refused: NotSupportedError",
    linkAttributeNode: "refused: NotSupportedError",
    linkArrayPrototype: "no address",
    // A message from any source but the page or the frame itself is
    // dropped before the page's own listeners; its own still arrive.
    foreignMessage: "dropped",
    ownMessage: "heard",
    windows: "0",
  });
  const frame = page.frame({ url: /\/page-frame\?load=/u });
  expect(await frame?.evaluate(() => window.length)).toBe(0);

  // And nothing reached the attacker, nor the stand-in TURN server: every
  // way there was refused above, so this only notes one that wasn't.
  expect({
    attacker: attacker.connections() - connectionsBefore,
    turn: turn.packets(),
  }).toStrictEqual({ attacker: 0, turn: 0 });
});

test("markup pasted or dropped into a page's editable fields becomes text, never a document of its own, in a shadow root too", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  await open(page, pagePath(attacking, "/pasting"));
  const appPage = page.frameLocator('iframe[title="App"]');
  const field = appPage.getByRole("textbox", { name: "Paste here" });
  await expect(field).toBeVisible({ timeout: 30_000 });
  // The page tried to open its document again, which would clear the
  // paste guard: refused, so what follows is still guarded.
  await expect(appPage.getByRole("status", { name: "Reopened" })).toHaveText(
    "refused: NotSupportedError"
  );
  const frame = page.frame({ url: /\/page-frame\?load=/u });
  const nestedNow = async () =>
    await frame?.evaluate(() => ({
      windows: window.length,
      nested: document.querySelectorAll("iframe, frame, object, embed").length,
    }));
  // Copied from the page itself, as a person copies from anywhere: a
  // selection whose HTML holds a nested document.
  await page.evaluate(() => {
    const source = document.createElement("div");
    source.id = "copied";
    source.append("pasted-marker ");
    source.append(document.createElement("iframe"));
    document.body.append(source);
    const range = document.createRange();
    range.selectNode(source);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  });
  await page.keyboard.press("ControlOrMeta+C");
  await page.evaluate(() => {
    document.querySelector("#copied")?.remove();
  });
  await field.click();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(field).toContainText("pasted-marker");
  expect(await nestedNow()).toStrictEqual({ windows: 0, nested: 0 });

  // Inside an open shadow root: at the window, the paste names the host.
  const inOpen = appPage.getByRole("textbox", {
    name: "Paste in an open shadow root",
  });
  await inOpen.click();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(inOpen).toContainText("pasted-marker");
  expect(await nestedNow()).toStrictEqual({ windows: 0, nested: 0 });

  // Inside a closed one, which only the page reads.
  await appPage.getByRole("group", { name: "Closed shadow host" }).click();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(
    appPage.getByRole("status", { name: "Closed field" })
  ).toContainText("pasted-marker");
  expect(await nestedNow()).toStrictEqual({ windows: 0, nested: 0 });

  // A field that handles a paste itself gets it once, its way: nothing
  // is inserted into it besides.
  const tagged = appPage.getByRole("textbox", { name: "Paste as tags" });
  await tagged.click();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(appPage.getByRole("status", { name: "Tags" })).toHaveText(
    "pasted-marker"
  );
  await expect(tagged).toHaveText("Tags:");
  expect(await nestedNow()).toStrictEqual({ windows: 0, nested: 0 });

  // A drop is cancelled, wherever it lands, whatever it carries. A drag from
  // outside the frame can't be driven here, so the drop is dispatched,
  // and what counts is that the frame cancels it before any default.
  expect(
    await frame?.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/html", '<iframe name="dropped"></iframe>');
      data.setData("text/plain", "dropped");
      const drop = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
      });
      // What dispatching answers is the browser's own word on whether it
      // was cancelled; the event itself shows the page it wasn't.
      const handled = document
        .querySelector('[aria-label="Paste here"]')
        ?.dispatchEvent(drop);
      return {
        cancelled: handled === false,
        seenAsCancelled: drop.defaultPrevented,
        windows: window.length,
      };
    })
  ).toStrictEqual({ cancelled: true, seenAsCancelled: false, windows: 0 });
});
