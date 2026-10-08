import { expect, test } from "@playwright/test";
import { z } from "zod";

import { recordCspViolations } from "./csp.ts";
import { hostileName, seedHostileArtifact } from "./package-artifact.ts";
import type { SeededArtifact } from "./package-artifact.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";
import { serveAttacker } from "./screen-app.ts";

// An approved npm package that turns hostile once it runs, and the browser
// refusing each thing it tries: a worker from a computed name,
// `importScripts`, a fetch elsewhere, images, fonts and stylesheets from
// elsewhere (one through a custom property set from script), and script in
// an SVG. Its files are served under the artifact policy (core's
// packages/serve.ts); a screen runs under the frame's. Each is tried where
// a browser can run the file today: as a worker, as a document opened on
// its own, and from a real screen. Every attempt is aimed at a receiver
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
 * A screen that tries to load the package's module and start it as a
 * worker, shows its SVG, fetches elsewhere, and sets a remote image
 * through a custom property and an `@import` from script: what the
 * package's code would do once in a screen.
 */
const widgetScreen = (
  receiver: string,
  address: string
): string => `import { useEffect, useState } from "react";

const attacker = "${receiver}";
const artifact = "${address}";

const loaded = async (element: HTMLScriptElement | HTMLImageElement): Promise<string> =>
  await new Promise((resolve) => {
    element.addEventListener("load", () => resolve("loaded"));
    element.addEventListener("error", () => resolve("refused"));
  });

const probe = async (): Promise<Record<string, string>> => {
  const script = document.createElement("script");
  script.type = "module";
  script.src = \`\${artifact}${hostileName}.js\`;
  const scriptOutcome = loaded(script);
  document.head.append(script);

  let worker = "started";
  try {
    const Make = (globalThis as unknown as Record<string, typeof Worker>)[["Wor", "ker"].join("")];
    new Make(\`\${artifact}${hostileName}.js\`);
  } catch (error) {
    worker = \`refused: \${error instanceof Error ? error.name : "?"}\`;
  }

  const image = new Image();
  image.src = \`\${artifact}assets/hostile.svg\`;
  const svgOutcome = loaded(image);

  document.documentElement.style.setProperty("--remote", \`url(\${attacker}/var.png)\`);
  const styled = document.createElement("div");
  styled.style.backgroundImage = "var(--remote)";
  styled.textContent = "Widget";
  document.body.append(styled);
  const style = document.createElement("style");
  style.textContent = \`@import url(\${attacker}/import.css);\`;
  document.head.append(style);

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

export default function Widget() {
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
  browser,
}) => {
  const page = await pageOf(browser, builder);
  // A page of the deployment's origin, whose own policy lets it start a
  // worker from that origin: the worker then runs under the artifact's.
  await page.goto("/");
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
  }, `${seeded.address}${hostileName}.js`);
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
  browser,
}) => {
  const page = await pageOf(browser, builder);
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
  await page.goto(`${seeded.address}assets/hostile.svg`);
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
});

test("a screen can't load a package's code, or bring in what the code would fetch", async ({
  browser,
}) => {
  const { core, api } = apiOf(builder);
  let app = "";
  try {
    ({ id: app } = await api.apps.create({ name: "Widget screen" }));
    await release(
      api,
      app,
      { "screens/widget.tsx": widgetScreen(attacker.url, seeded.address) },
      "Widget"
    );
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(browser, builder);
  const violations = await recordCspViolations(page);
  await page.goto(`/engines/${app}/apps/widget/full`);
  const screen = page.frameLocator('iframe[title="widget app"]');
  const probes = screen.getByRole("status", { name: "Probes" });
  await expect(probes).not.toBeEmpty({ timeout: 30_000 });

  expect(JSON.parse((await probes.textContent()) ?? "")).toStrictEqual({
    script: "refused",
    worker: "refused: SecurityError",
    svg: "refused",
    fetch: "refused",
    varImage: "applied",
  });
  // The frame's policy refused each (the worker by throwing, above); the
  // receiver heard nothing.
  await expect
    .poll(() =>
      ["script-src-elem", "img-src", "style-src-elem", "connect-src"].filter(
        (directive) => !violations.some((line) => line.startsWith(directive))
      )
    )
    .toStrictEqual([]);
  expect(attacker.hits).toStrictEqual([]);
});
