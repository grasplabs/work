import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";

const bodyBackground = async (page: Page): Promise<string> =>
  await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);

// Which theme the page paints is the browser's cascade, from the system's
// scheme. What the components do, the journeys that use them show; how a
// person's choice is kept, apps/web/src/frame/theme.test.ts.
test("paints the system's scheme, dark from the start and following a change without a reload", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/kit");
  await expect(page.getByRole("heading", { name: "UI kit" })).toBeVisible();
  const dark = await bodyBackground(page);

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => await bodyBackground(page)).not.toBe(dark);
  const light = await bodyBackground(page);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => await bodyBackground(page)).not.toBe(light);
});

test("a page sidebar folds from the keyboard and stays folded over a reload", async ({
  page,
}) => {
  await page.goto("/kit");
  const documents = page.getByRole("complementary", { name: "Documents" });
  await expect(
    documents.getByRole("button", { name: "Pricing" })
  ).toContainText("Pricing");

  await documents.getByRole("button", { name: "Fold the documents" }).focus();
  await page.keyboard.press("Enter");
  // Folded, each entry is its icon, named by its tooltip.
  const expand = documents.getByRole("button", {
    name: "Expand the documents",
  });
  await expect(expand).toBeVisible();
  await expect(documents.getByRole("button", { name: "Pricing" })).toHaveText(
    ""
  );

  await page.reload();
  await expect(expand).toBeVisible();
  await expand.click();
  await expect(
    documents.getByRole("button", { name: "Pricing" })
  ).toContainText("Pricing");
});

test("the dot brain prints every figure, and on a phone too", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/kit");
  const card = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("Dot brain", { exact: true }) });
  const figures = card.locator("figure");
  await expect(figures).toHaveCount(14);
  // Each figure's dots are on its canvas: the fewest any of them printed.
  await expect
    .poll(
      async () =>
        await figures.locator("canvas").evaluateAll((canvases) =>
          Math.min(
            ...canvases.map((canvas) => {
              if (!(canvas instanceof HTMLCanvasElement)) {
                return 0;
              }
              const pixels =
                canvas
                  .getContext("2d")
                  ?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
              let printed = 0;
              for (let at = 3; at < pixels.length; at += 4) {
                printed += (pixels[at] ?? 0) > 0 ? 1 : 0;
              }
              return printed;
            })
          )
        )
    )
    .toBeGreaterThan(500);
  // None runs off a phone's screen.
  const rights = await figures.evaluateAll((all) =>
    all.map((figure) => figure.getBoundingClientRect().right)
  );
  expect(Math.max(...rights)).toBeLessThanOrEqual(390);
});

test("the dot brain holds still for people who ask for less motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/kit");
  const card = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("Dot brain", { exact: true }) });
  // The figures that move most: the laptop's sweep and two people taking turns.
  const drawn = async (): Promise<string[]> =>
    await card
      .locator("figure")
      .filter({
        has: page.locator("figcaption", {
          hasText: /^(?:Laptop|Two people)$/u,
        }),
      })
      .locator("canvas")
      .evaluateAll((canvases) =>
        canvases.map((canvas) =>
          canvas instanceof HTMLCanvasElement ? canvas.toDataURL() : ""
        )
      );
  await card
    .locator("figcaption", { hasText: "Two people" })
    .scrollIntoViewIfNeeded();
  // Settled once its first frames are drawn; then it stays as it is.
  await expect
    .poll(async () => {
      const urls = await drawn();
      return urls.length === 2 && urls.every((url) => url.length > 1000);
    })
    .toBe(true);
  const first = await drawn();
  // Longer than a turn of two voices (2.4 s) and a sweep's step.
  await page.waitForTimeout(3000);
  expect(await drawn()).toEqual(first);
});
