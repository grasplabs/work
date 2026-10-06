import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { z } from "zod";

// The SDK's value schemas check what a person types in a screen before the
// host checks it again, so they must give the same answers in a browser as
// in workerd. This runs the SDK's own conformance cases
// (packages/sdk/test/value-cases.ts, which workerd runs through
// values.test.ts) in the browser, from the same source files.

const sdkDir = path.join(import.meta.dirname, "../packages/sdk");

/** An origin of its own, served below: no page of Grasp is involved. */
const origin = "http://sdk-values.test";

/** The SDK's source and test modules, and nothing else on disk. */
const modulePath = /^\/(?:src|test)\/[\w-]+\.ts$/u;

const outcomesSchema = z
  .array(
    z.object({ actual: z.string(), expected: z.string(), name: z.string() })
  )
  .min(1);

test("the SDK's values give the same outcomes in a browser as in workerd", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("requestfailed", (request) => failures.push(request.url()));

  // The browser loads the SDK's modules as they are written: the types are
  // removed (they are erasable by the repo's TypeScript settings), nothing
  // is bundled or rewritten.
  await page.route(`${origin}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>SDK values</title><pre id="outcomes"></pre>
          <script type="module">
            import { runValueCases } from "/test/value-cases.ts";
            document.querySelector("#outcomes").textContent =
              JSON.stringify(runValueCases());
          </script>`,
      });
      return;
    }
    if (!modulePath.test(pathname)) {
      await route.fulfill({ status: 404 });
      return;
    }
    const source = await readFile(path.join(sdkDir, pathname), "utf-8");
    await route.fulfill({
      contentType: "text/javascript",
      body: stripTypeScriptTypes(source),
    });
  });

  await page.goto(`${origin}/`);
  const outcomes = page.locator("#outcomes");
  await expect(outcomes).not.toBeEmpty();
  expect(failures).toStrictEqual([]);

  const text = await outcomes.textContent();
  for (const { actual, expected, name } of outcomesSchema.parse(
    JSON.parse(text ?? "")
  )) {
    expect(JSON.parse(actual), name).toStrictEqual(JSON.parse(expected));
  }
});
