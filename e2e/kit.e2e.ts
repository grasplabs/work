import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";

const bodyBackground = async (page: Page): Promise<string> =>
  await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);

const expectKitRendered = async (page: Page): Promise<void> => {
  await page.goto("/kit");
  await expect(page.getByRole("heading", { name: "UI kit" })).toBeVisible();
  await expect(page.getByLabel("Name")).toBeVisible();

  const model = page.getByRole("combobox", { name: "Model" });
  await expect(model).toContainText("Small");
  await model.click();
  await page.getByRole("option", { name: "Large" }).click();
  await expect(model).toContainText("Large");

  const summary = page.getByRole("checkbox", { name: "Email me a summary" });
  await expect(summary).toBeChecked();
  await summary.click();
  await expect(summary).not.toBeChecked();

  const notifications = page.getByRole("switch", { name: "Notifications" });
  await expect(notifications).not.toBeChecked();
  await notifications.click();
  await expect(notifications).toBeChecked();

  await expect(page.getByRole("cell", { name: "Weekly report" })).toBeVisible();

  await page.getByRole("tab", { name: "Actions" }).click();
  await page.getByRole("button", { name: "Open dialog" }).click();
  await expect(page.getByRole("dialog", { name: "Dialog" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Show toast" }).click();
  await expect(page.getByText("Your changes are saved.")).toBeVisible();

  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
  await expect(page.getByText("A title is needed.")).toBeVisible();

  await page.getByRole("button", { name: "Open sheet" }).click();
  const sheet = page.getByRole("dialog", { name: "Sheet" });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await page.getByRole("button", { name: "Open popover" }).click();
  await expect(page.getByText("Anchored to its button.")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Show details" }).click();
  await expect(page.getByText("The details.")).toBeVisible();

  // Every page's states: not found, an error with its reference and a way
  // to try again, and skeletons while it loads.
  await expect(
    page.getByRole("heading", { name: "Workflow not found" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "This page didn't load" })
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "Reference: " })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading…" })).toBeVisible();
};

test("renders the UI kit in light mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await expectKitRendered(page);
});

test("renders the UI kit in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/kit");
  const light = await bodyBackground(page);

  // The page follows a change of the system scheme without a reload.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => await bodyBackground(page)).not.toBe(light);

  // And starts dark when the system already is.
  await expectKitRendered(page);
  expect(await bodyBackground(page)).not.toBe(light);
});

test("serves the Grasp favicon the page names", async ({ page }) => {
  await page.goto("/kit");
  const href = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(href).toBe("/favicon.svg");
  const icon = await page.request.get("/favicon.svg");
  expect(icon.ok()).toBe(true);
  expect(icon.headers()["content-type"]).toContain("image/svg+xml");
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
  await expect(figures).toHaveCount(11);
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
