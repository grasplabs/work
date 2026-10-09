import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { recordCspViolations } from "./csp.ts";
import { hostileName, seedHostileArtifact } from "./package-artifact.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";
import { serveAttacker } from "./screen-app.ts";
import { origin } from "./stack.ts";

// Code this origin serves that we didn't write, run in the product page:
// an HTML injection that can't run inline script points a script element,
// a worker or a `srcdoc` frame at a screen's module or a file of an App's
// npm packages, which would then run with the page's origin and the
// person's session. The page's policy names only the frontend's own files
// (core's security-headers.ts), and core refuses the page's own requests
// for either path. The screen these addresses belong to still loads them
// in its frame. Each attempt causes a violation on purpose, so this file
// uses plain `test`.

let attacker: Awaited<ReturnType<typeof serveAttacker>>;
let builder: Person;
let artifactAddress: string;
let app: string;

const plainScreen = `export default function Plain() {
  return (
    <main className="p-4">
      <h1 className="text-lg font-medium">Plain</h1>
    </main>
  );
}
`;

test.beforeAll(async () => {
  attacker = await serveAttacker();
  ({ builder } = peopleIn("productPageScripts"));
  const seeded = await seedHostileArtifact(builder, attacker.url);
  artifactAddress = new URL(`${seeded.address}${hostileName}.js`, origin).href;
  const { core, api } = apiOf(builder);
  try {
    ({ id: app } = await api.apps.create({ name: "Plain screen" }));
    await release(api, app, { "screens/plain.tsx": plainScreen }, "Plain");
  } finally {
    core[Symbol.dispose]();
  }
});

test.afterAll(() => {
  attacker.server.close();
});

const importMap = z.object({ imports: z.record(z.string(), z.url()) });

/** What became of one attempt to run `url` in the product page. */
const attempt = async (
  page: Page,
  url: string
): Promise<Record<string, string>> =>
  await page.evaluate(async (address) => {
    // In the page, where this runs: nothing from outside it is there.
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- see above
    const settled = async (target: EventTarget): Promise<string> => {
      const { promise, resolve } = Promise.withResolvers<string>();
      target.addEventListener("load", () => {
        resolve("loaded");
      });
      target.addEventListener("error", () => {
        resolve("refused");
      });
      return await promise;
    };

    const element = document.createElement("script");
    element.type = "module";
    element.src = address;
    const scriptOutcome = settled(element);
    document.head.append(element);

    // Every engine refuses it with an error event, not by throwing. One that
    // started would never send it, and the test would time out.
    let worker = "";
    try {
      worker = await settled(new Worker(address, { type: "module" }));
    } catch (error) {
      worker = `refused: ${error instanceof Error ? error.name : "?"}`;
    }
    const script = await scriptOutcome;

    // A frame of the page's own origin, which inherits its policy; its
    // violation is reported to its own document (counted below).
    const frame = document.createElement("iframe");
    frame.title = "injected";
    frame.srcdoc = `<script type="module" src="${address}"></script>`;
    const framed = settled(frame);
    document.body.append(frame);
    await framed;

    // The page's own request for it, which its policy allows: core
    // refuses it, and the copy of the module the frame's load left in the
    // cache doesn't answer it (core's answers vary on Sec-Fetch-Site).
    const fetched = await fetch(address).then(
      (response) => String(response.status),
      (error: unknown) => `failed: ${String(error)}`
    );

    return { script, worker, fetch: fetched };
  }, url);

/**
 * Opens the App's screen on `page` and waits for it to render, which it
 * does only once its frame has loaded its modules from /screen-modules/;
 * returns the address of one, token and all, from the frame's import map.
 */
const openScreen = async (page: Page): Promise<string> => {
  await page.goto(`/domains/${app}/apps/plain/full`);
  const screen = page.frameLocator('iframe[title="plain app"]');
  await expect(screen.getByRole("heading", { name: "Plain" })).toBeVisible({
    timeout: 30_000,
  });
  const { imports } = importMap.parse(
    JSON.parse(
      (await screen.locator('script[type="importmap"]').textContent()) ?? ""
    )
  );
  const address = Object.values(imports).find((imported) =>
    new URL(imported).pathname.startsWith("/screen-modules/")
  );
  if (address === undefined) {
    throw new Error("The screen's frame imports its modules");
  }
  return address;
};

test("the product page runs no screen module or package file, however its HTML is injected, and its screens still run theirs", async ({
  browser,
  browserName,
}) => {
  const page = await pageOf(browser, builder);
  const violations = await recordCspViolations(page);
  const moduleAddress = await openScreen(page);

  const outcomes = {
    module: await attempt(page, moduleAddress),
    artifact: await attempt(page, artifactAddress),
  };
  const refused = {
    script: "refused",
    worker: "refused",
    fetch: "403",
  };
  expect(outcomes).toStrictEqual({ module: refused, artifact: refused });

  // Refused by the page's policy, not by some other failure to load: the
  // script element in the page and the one in the `srcdoc` frame (each
  // document reports its own), and the worker, for both addresses.
  // Firefox runs Playwright's init script in no `srcdoc` frame, so there
  // the frame's violation reaches only the console, which names the frame.
  const framedInConsole = (address: string): number =>
    browserName === "firefox"
      ? violations.filter(
          (line) =>
            line.includes(`(script-src-elem) at ${address} `) &&
            line.includes('{file: "about:srcdoc"')
        ).length
      : 0;
  const reported = (address: string) => ({
    script:
      violations.filter((line) =>
        line.startsWith(`script-src-elem blocked ${address} `)
      ).length + framedInConsole(address),
    worker: violations.filter((line) =>
      line.startsWith(`worker-src blocked ${address} `)
    ).length,
  });
  await expect
    .poll(() => ({
      module: reported(moduleAddress),
      artifact: reported(artifactAddress),
    }))
    .toStrictEqual({
      module: { script: 2, worker: 1 },
      artifact: { script: 2, worker: 1 },
    });
  expect(attacker.hits).toStrictEqual([]);
});

test("the product page runs no screen module through an escaped path under its own files", async ({
  browser,
}) => {
  const page = await pageOf(browser, builder);
  const moduleAddress = await openScreen(page);
  // The browser matches the policy on the path as written, so this passes
  // as one of the frontend's files; decoded, it is the module's address.
  // Core answers no such path.
  const escaped = moduleAddress.replace(
    "/screen-modules/",
    "/assets/..%2Fscreen-modules/"
  );

  const outcome = await page.evaluate(async (address) => {
    const element = document.createElement("script");
    element.type = "module";
    element.src = address;
    const { promise, resolve } = Promise.withResolvers<string>();
    element.addEventListener("load", () => {
      resolve("loaded");
    });
    element.addEventListener("error", () => {
      resolve("refused");
    });
    document.head.append(element);
    const response = await fetch(address);
    return { script: await promise, fetch: String(response.status) };
  }, escaped);

  expect(outcome).toStrictEqual({ script: "refused", fetch: "404" });
});
