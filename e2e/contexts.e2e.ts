import { expect } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";

import { test } from "./contexts.ts";
import { peopleIn } from "./people.ts";

// The contexts a test opens with `pageOf` and `newContext` close when it
// ends, passed or failed: the next test, in the same worker's browser,
// finds none of them open.
test.describe.configure({ mode: "serial" });

const left: BrowserContext[] = [];

test("a test that passes opens contexts", async ({ newContext, pageOf }) => {
  const { member } = peopleIn("contexts");
  const page = await pageOf(member);
  left.push(page.context(), await newContext());
  expect(left).toHaveLength(2);
});

test("a test that fails opens contexts", async ({ newContext, pageOf }) => {
  test.fail();
  const { member } = peopleIn("contexts");
  const page = await pageOf(member);
  left.push(page.context(), await newContext());
  throw new Error("This test fails on purpose, with its contexts open");
});

test("none of them is open afterwards", ({ browser }) => {
  expect(left).toHaveLength(4);
  const open = browser.contexts();
  for (const context of left) {
    expect(open).not.toContain(context);
  }
});
