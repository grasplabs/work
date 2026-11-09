import { readdirSync } from "node:fs";
import nodePath from "node:path";

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import {
  componentOverlays,
  desktop,
  exampleOverlays,
} from "../packages/ui/catalog/overlays.ts";
import type { Overlay, Target } from "../packages/ui/catalog/overlays.ts";
import { recordCspViolations } from "./csp.ts";

// The UI kit's pages of the local gallery (apps/web/src/routes/kit_.*)
// under core's Content Security Policy, which only the stack serves: no
// component or example breaks it, nor does any overlay once open, as a
// popup may start a request, load an image or a script, or open a frame
// only then (the overlays: packages/ui/catalog/overlays.ts). What makes
// each accessible, in light and dark, on a phone and a desktop, is the
// kit's own component tests in a real Chromium
// (packages/ui/test/kit.browser.test.tsx), apart from the stack: they read
// nothing from core, and took 18% of all e2e time here (November 2026).
// The list comes from the kit's components and examples directories, so
// a component added to the kit is checked here too.

/** The names of the `.tsx` modules in `dir` of the UI kit, tests aside. */
const modulesIn = (dir: string): string[] =>
  readdirSync(nodePath.join(import.meta.dirname, "../packages/ui", dir))
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
    .map((file) => file.slice(0, -".tsx".length));

const pages = [
  ...modulesIn("src/components").map((name) => ({
    path: `/kit/components/${name}`,
    overlays: componentOverlays(name),
  })),
  ...modulesIn("catalog/examples").map((name) => ({
    path: `/kit/examples/${name}`,
    overlays: exampleOverlays(name),
  })),
];

/** The element `target` names (packages/ui/catalog/overlays.ts). */
const locate = (page: Page, target: Target): Locator => {
  if ("text" in target) {
    return page.getByText(target.text);
  }
  const within =
    "inMain" in target && target.inMain === true
      ? page.getByRole("main")
      : page;
  return within.getByRole(target.role, {
    name: target.name,
    exact: "exact" in target ? target.exact : undefined,
  });
};

/**
 * Opens `overlay` as a person does, waits until it shows, then closes it
 * with Escape and waits until it is gone, so the next one opens on its own.
 */
const open = async (page: Page, overlay: Overlay): Promise<void> => {
  await page.setViewportSize(overlay.viewport ?? desktop);
  const trigger = locate(page, overlay.trigger);
  if (overlay.open === "hover") {
    await trigger.hover();
  } else if (overlay.open === "right click") {
    await trigger.click({ button: "right" });
  } else {
    await trigger.focus();
    if (overlay.open === "focus") {
      // Focus from the keyboard, which is what opens a tooltip.
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
    } else {
      await page.keyboard.press(overlay.open);
    }
  }
  const opened = locate(page, overlay.opened);
  await expect(opened).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(opened).toBeHidden();
};

test("every page of the UI kit keeps to core's Content Security Policy, its overlays open", async ({
  page,
}) => {
  const violations = await recordCspViolations(page);
  for (const { path, overlays } of pages) {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    await page.goto(path);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await expect(page.locator("[data-catalog-content]")).toBeVisible();
    for (const overlay of overlays) {
      // oxlint-disable-next-line no-await-in-loop -- one overlay open at a time
      await open(page, overlay);
    }
  }
  expect(violations).toStrictEqual([]);
});
