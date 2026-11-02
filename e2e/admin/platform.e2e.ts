import { expect, test } from "@playwright/test";

// Platform's places: links in a navigation landmark under each page's
// title, the page shown marked as the current one.

test("a whole page that fails says so as the page, under the bar with the way to the sidebar, and Try again brings it back", async ({
  page,
  request,
}) => {
  const seeded = await request.post("/__e2e/seed-create");
  expect(seeded.status()).toBe(200);
  await page.goto("/platform", { waitUntil: "networkidle" });
  // The page's read fails as staff go to it from the page they are on.
  const faulted = await request.post("/__e2e/fault", {
    data: { fn: "fetchReleases", mode: "error" },
  });
  expect(faulted.status()).toBe(204);
  try {
    const main = page.getByRole("main");
    await main
      .getByRole("navigation", { name: "Platform" })
      .getByRole("link", { name: "Releases" })
      .click();
    await expect(
      main.getByRole("heading", { level: 1, name: "This couldn’t be shown" })
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: "Show or hide the sidebar" })
    ).toBeVisible();

    await request.post("/__e2e/fault", { data: { fn: null } });
    await main.getByRole("button", { name: "Try again" }).click();
    await expect(
      main.getByRole("heading", { level: 1, name: "Releases" })
    ).toBeVisible();
  } finally {
    await request.post("/__e2e/fault", { data: { fn: null } });
  }
});

test("staff move between Platform's places from its navigation", async ({
  page,
  request,
}) => {
  // The admin's database, with no client: these pages read none.
  const seeded = await request.post("/__e2e/seed-create");
  expect(seeded.status()).toBe(200);
  await page.goto("/platform", { waitUntil: "networkidle" });
  const nav = page.getByRole("main").getByRole("navigation", {
    name: "Platform",
  });
  await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page"
  );

  for (const [name, path] of [
    ["Releases", "/platform/releases"],
    ["Rollouts", "/platform/rollouts"],
    ["Offboarded", "/platform/offboarded"],
    ["Overview", "/platform"],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one place after another, as staff move
    await nav.getByRole("link", { name }).click();
    // oxlint-disable-next-line no-await-in-loop -- one place after another, as staff move
    await expect(page).toHaveURL(new RegExp(`${path}$`, "u"));
    // oxlint-disable-next-line no-await-in-loop -- one place after another, as staff move
    await expect(nav.getByRole("link", { name })).toHaveAttribute(
      "aria-current",
      "page"
    );
    // oxlint-disable-next-line no-await-in-loop -- one place after another, as staff move
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  }
});
