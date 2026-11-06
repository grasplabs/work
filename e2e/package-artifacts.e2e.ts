import type { PackageArtifactAddress } from "@grasp-os/shared/packages";
import { expect } from "@playwright/test";
import { z } from "zod";

import { test } from "./contexts.ts";
import { recordCspViolations } from "./csp.ts";
import { hostileName, seedHostileArtifact } from "./package-artifact.ts";
import type { SeededArtifact } from "./package-artifact.ts";
import { serveAttacker } from "./page-app.ts";
import { apiOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";
import { origin } from "./stack.ts";

// An approved npm package that turns hostile once it runs, and the browser
// refusing each thing it tries: a worker from a computed name,
// `importScripts`, a fetch elsewhere, images, fonts and stylesheets from
// elsewhere (one through a custom property set from script), and script in
// an SVG. Its files are served under the artifact policy (core's
// packages/serve.ts); a page runs under the frame's. Each is tried where
// a browser could run the file: as a worker (from a stand-in page, as the
// product page can't start one), as a document opened on its own, and
// from a real page. Every attempt is aimed at a receiver
// this file runs; a test passes when the browser reported refusing it and
// the receiver heard nothing.

let attacker: Awaited<ReturnType<typeof serveAttacker>>;
let builder: Person;
let seeded: SeededArtifact;

test.beforeAll(async () => {
  attacker = await serveAttacker();
  ({ builder } = peopleIn("packageArtifacts"));
  seeded = await seedHostileArtifact(builder, attacker.url);
});

test.afterAll(() => {
  attacker.server.close();
});

test.beforeEach(() => {
  // What the browser was given, for the trace and the pull request.
  test.info().annotations.push({
    type: "artifact",
    description: JSON.stringify({
      app: seeded.app,
      graphHash: seeded.graphHash,
      approval: seeded.approval,
      compiler: seeded.compiler,
      artifact: seeded.hash,
    }),
  });
});

/**
 * A page that tries to load the package's module and start it as a
 * worker, shows its SVG, fetches elsewhere, and sets a remote image
 * through a custom property and an `@import` from script: what the
 * package's code would do once in a page.
 */
const widgetPage = (
  receiver: string,
  { directory, query }: PackageArtifactAddress
): string => `import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const attacker = "${receiver}";
const artifact = "${directory}";
const query = "${query}";
// The build's design lint refuses these by name (grasp/no-style-escapes);
// spelled so it can't read them, as code evading it would, so this
// checks that the frame still holds.
const unread = (...parts: string[]): string => parts.join("");
const headOf = (): HTMLElement => Reflect.get(document, unread("he", "ad")) as HTMLElement;

const loaded = async (element: HTMLScriptElement | HTMLImageElement): Promise<string> =>
  await new Promise((resolve) => {
    element.addEventListener("load", () => resolve("loaded"));
    element.addEventListener("error", () => resolve("refused"));
  });

const probe = async (): Promise<Record<string, string>> => {
  const script = document.createElement("script");
  script.type = "module";
  let scriptOutcome: Promise<string>;
  try {
    script.src = \`\${artifact}${hostileName}.js\${query}\`;
    scriptOutcome = loaded(script);
    headOf().append(script);
  } catch {
    // Refused outright: a script's address takes no string (Trusted Types).
    scriptOutcome = Promise.resolve("refused");
  }

  let worker = "started";
  try {
    const Make = (globalThis as unknown as Record<string, typeof Worker>)[["Wor", "ker"].join("")];
    new Make(\`\${artifact}${hostileName}.js\${query}\`);
  } catch (error) {
    worker = \`refused: \${error instanceof Error ? error.name : "?"}\`;
  }

  const image = new Image();
  image.src = \`\${artifact}assets/hostile.svg\${query}\`;
  const svgOutcome = loaded(image);

  const styleOf = (element: HTMLElement): CSSStyleDeclaration =>
    Reflect.get(element, unread("sty", "le")) as CSSStyleDeclaration;
  styleOf(document.documentElement).setProperty("--remote", \`url(\${attacker}/var.png)\`);
  const styled = document.createElement("div");
  styleOf(styled).backgroundImage = "var(--remote)";
  styled.textContent = "Widget";
  document.body.append(styled);
  const style = document.createElement(unread("sty", "le"));
  style.textContent = \`@import url(\${attacker}/import.css);\`;
  headOf().append(style);

  let fetched = "ran";
  try {
    await fetch(\`\${attacker}/fetched\`);
  } catch {
    fetched = "refused";
  }
  return {
    script: await scriptOutcome,
    worker,
    svg: await svgOutcome,
    fetch: fetched,
    // The rule is there; only the policy keeps its image out.
    varImage: getComputedStyle(styled).backgroundImage.includes("/var.png") ? "applied" : "missing",
  };
};

function Widget() {
  const [probes, setProbes] = useState("");
  useEffect(() => {
    void probe().then((results) => {
      setProbes(JSON.stringify(results));
    });
  }, []);
  return (
    <main className="p-4">
      <h1 className="text-lg font-medium">Widget</h1>
      <output aria-label="Probes">{probes}</output>
    </main>
  );
}
export const Route = createFileRoute("/")({ component: Widget });
`;

/** What the hostile worker posts (package-artifact.ts), or its error. */
const workerReports = z.array(
  z.object({
    outcomes: z.record(z.string(), z.string()).optional(),
    violation: z.string().optional(),
    error: z.string().optional(),
  })
);

test("a package's code started as a worker can't start another, import scripts or fetch elsewhere", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  const workerUrl = new URL(
    `${seeded.address.directory}${hostileName}.js${seeded.address.query}`,
    origin
  ).href;
  // No page of the deployment can start it any more: the product page's
  // policy allows no worker, and core refuses its same-origin requests for
  // the file (product-page-scripts.e2e.ts). This stands in for a page of
  // the origin that could, as defence in depth: a page without a policy at
  // a made-up address, and the worker's script fetched from core as a
  // browser that sends no Sec-Fetch-Site would, its headers (the
  // artifact's policy among them) passed on as they came. The worker then
  // runs under the artifact's policy alone.
  await page.route(`${origin}/worker-host`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Worker host</title>",
    });
  });
  // Matched exactly: a string route is a glob, which reads `?` as a wildcard.
  await page.route(
    (url) => url.href === workerUrl,
    async (route) => {
      const headers = Object.fromEntries(
        Object.entries(await route.request().allHeaders()).filter(
          ([name]) => !name.startsWith("sec-fetch-")
        )
      );
      await route.fulfill({ response: await route.fetch({ headers }) });
    }
  );
  await page.goto("/worker-host");
  // Everything the worker posts, and any error starting it, kept on the
  // page as it comes.
  await page.evaluate((url) => {
    const reports: unknown[] = [];
    Reflect.set(globalThis, "workerReports", reports);
    const worker = new Worker(url);
    worker.addEventListener("message", (event: MessageEvent) => {
      reports.push(event.data);
    });
    worker.addEventListener("error", (event) => {
      reports.push({ error: event.message });
    });
  }, workerUrl);
  // The worker's outcomes and the violations the browser reported to it,
  // whichever order they come in: polled until all are there.
  const reported = async () => {
    const all = workerReports.parse(
      await page.evaluate((): unknown =>
        Reflect.get(globalThis, "workerReports")
      )
    );
    return {
      outcomes: all.find((report) => report.outcomes !== undefined)?.outcomes,
      violations: all
        .flatMap(({ violation }) =>
          violation === undefined ? [] : [violation]
        )
        .toSorted(),
      errors: all.filter((report) => report.error !== undefined),
    };
  };

  await expect.poll(reported).toStrictEqual({
    outcomes: {
      importScripts: "refused: NetworkError",
      worker: "refused: SecurityError",
      fetch: "refused: TypeError",
    },
    // Chromium refuses the nested worker by throwing, without an event.
    violations: [
      `connect-src ${attacker.url}/fetched`,
      `script-src-elem ${attacker.url}/imported.js`,
    ],
    errors: [],
  });
  // A worker's requests aren't the page's: the receiver says nothing
  // reached it.
  expect(attacker.hits).toStrictEqual([]);
});

test("a package's SVG opened on its own runs no script and loads nothing from elsewhere, nor does its stylesheet", async ({
  pageOf,
}) => {
  const page = await pageOf(builder);
  const requested: string[] = [];
  const blocked: string[] = [];
  page.on("request", (request) => {
    requested.push(request.url());
  });
  page.on("requestfailed", (request) => {
    // Chromium's reason for a request its policy stopped.
    if (/csp/iu.test(request.failure()?.errorText ?? "")) {
      blocked.push(request.url());
    }
  });
  // The SVG names its stylesheet relative to itself, which keeps the path
  // and drops the query: the request goes without the address's token,
  // and core refuses it. The policy must hold all the same should one
  // load, so the browser's request is handed on with the token, as the
  // stylesheet would be asked for with one.
  const stylesheet = new URL(
    `${seeded.address.directory}${hostileName}.css`,
    origin
  ).href;
  const withoutToken = await page.request.get(stylesheet);
  await page.route(
    (url) => url.href === stylesheet,
    async (route) => {
      await route.continue({ url: `${stylesheet}${seeded.address.query}` });
    }
  );
  await page.goto(
    `${seeded.address.directory}assets/hostile.svg${seeded.address.query}`
  );
  await page.waitForLoadState("load");

  // Its script and its `onload` never ran, and its inline style was never
  // applied: none of them asked for anything.
  await expect(page.locator("svg")).not.toHaveAttribute("data-ran", "script");
  const remote = (urls: string[]): string[] =>
    urls
      .filter((url) => url.startsWith(attacker.url))
      .map((url) => url.slice(attacker.url.length))
      .toSorted();
  // Its own stylesheet loaded, from its own origin, and everything it and
  // the SVG asked of anywhere else the policy blocked before it was sent:
  // the `@import`, the font, the image the custom property names, the
  // background, and the SVG's `<image>`.
  await expect
    .poll(() => remote(blocked))
    .toStrictEqual([
      "/background.png",
      "/css-import.css",
      "/font.woff2",
      "/svg-image.png",
      "/var.png",
    ]);
  expect(remote(requested)).toStrictEqual(remote(blocked));
  expect(attacker.hits).toStrictEqual([]);
  expect(withoutToken.status()).toBe(403);
});

test("a page can't load a package's code, or bring in what the code would fetch", async ({
  pageOf,
}) => {
  const { core, api } = apiOf(builder);
  let app = "";
  try {
    ({ id: app } = await api.apps.create({ name: "Widget page" }));
    await release(
      api,
      app,
      { "src/routes/index.tsx": widgetPage(attacker.url, seeded.address) },
      "Widget"
    );
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(builder);
  const violations = await recordCspViolations(page);
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator('iframe[title="App"]');
  const probes = appPage.getByRole("status", { name: "Probes" });
  await expect(probes).not.toBeEmpty({ timeout: 30_000 });

  expect(JSON.parse((await probes.textContent()) ?? "")).toStrictEqual({
    script: "refused",
    // A script's address takes no string (Trusted Types), a worker's
    // neither: refused before the policy's worker-src is asked.
    worker: "refused: TypeError",
    svg: "refused",
    fetch: "refused",
    varImage: "applied",
  });
  // The frame's policy refused each (the script and the worker as Trusted
  // Types, by throwing, above); the receiver heard nothing.
  await expect
    .poll(() =>
      [
        "require-trusted-types-for",
        "img-src",
        "style-src-elem",
        "connect-src",
      ].filter(
        (directive) => !violations.some((line) => line.startsWith(directive))
      )
    )
    .toStrictEqual([]);
  expect(attacker.hits).toStrictEqual([]);
});
