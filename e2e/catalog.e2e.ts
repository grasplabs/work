import { readdirSync } from "node:fs";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";

import { recordCspViolations } from "./csp.ts";

// The UI kit's pages of the local gallery (apps/web/src/routes/kit_.*)
// under core's Content Security Policy, which only the stack serves: no
// component or example breaks it. What makes each accessible, in light
// and dark, on a phone and a desktop, is the kit's own component tests in
// a real Chromium (packages/ui/test/kit.browser.test.tsx), apart from the
// stack: they read nothing from core, and took 18% of all e2e time here
// (November 2026). The list comes from the kit's components and examples
// directories, so a component added to the kit is checked here too.

/** The names of the `.tsx` modules in `dir` of the UI kit, tests aside. */
const modulesIn = (dir: string): string[] =>
  readdirSync(nodePath.join(import.meta.dirname, "../packages/ui", dir))
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
    .map((file) => file.slice(0, -".tsx".length));

const paths = [
  ...modulesIn("src/components").map((name) => `/kit/components/${name}`),
  ...modulesIn("catalog/examples").map((name) => `/kit/examples/${name}`),
];

test("every page of the UI kit keeps to core's Content Security Policy", async ({
  page,
}) => {
  const violations = await recordCspViolations(page);
  for (const path of paths) {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    await page.goto(path);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await expect(page.locator("[data-catalog-content]")).toBeVisible();
  }
  expect(violations).toStrictEqual([]);
});
