import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// The dot brain (apps/web/src/brain/dot-brain.tsx) on the admin's
// onboarding, where it stands over each step: its dots are printed, it
// fits a phone, and it holds still for whoever asked for less motion.

/** The brain's canvas, found by the words that stand in for it. */
const brainOf = (page: Page): Locator =>
  page
    .getByText(/^The company brain:/u)
    .locator("xpath=..")
    .locator("canvas");

/** How many of the canvas's pixels are printed. */
const printed = async (canvas: Locator): Promise<number> =>
  await canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) {
      return 0;
    }
    const pixels =
      element
        .getContext("2d")
        ?.getImageData(0, 0, element.width, element.height).data ?? [];
    let count = 0;
    for (let at = 3; at < pixels.length; at += 4) {
      count += (pixels[at] ?? 0) > 0 ? 1 : 0;
    }
    return count;
  });

test("the dot brain prints its figure, and fits a phone", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("dotBrain");
  const page = await pageOf(admin);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/setup?step=sources");
  const brain = brainOf(page);
  await expect.poll(async () => await printed(brain)).toBeGreaterThan(500);
  const box = await brain.boundingBox();
  expect(
    (box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY)
  ).toBeLessThanOrEqual(390);
});

test("the dot brain holds still for people who ask for less motion", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("dotBrain");
  const page = await pageOf(admin);
  // A phone's screen, where the step leaves the brain its room.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/setup?step=sources");
  const brain = brainOf(page);
  const drawn = async (): Promise<string> =>
    await brain.evaluate((element) =>
      element instanceof HTMLCanvasElement ? element.toDataURL() : ""
    );
  // Settled once its first frames are drawn; then it stays as it is.
  await expect.poll(async () => await printed(brain)).toBeGreaterThan(500);
  const first = await drawn();
  // Longer than a turn of two voices (2.4 s) and a sweep's step.
  await page.waitForTimeout(3000);
  expect(await drawn()).toBe(first);
});
