import { expect, test } from "@playwright/test";

// Staff follow a link to an address the admin has no page for (mistyped,
// or a page since removed), opened straight from outside: the admin says
// so in its frame, with its sidebar and the way back, never that the
// admin itself couldn't be read (src/routes/$.tsx).
test("staff opening an address with no page are told it isn't there, in the admin's frame", async ({
  page,
  request,
}) => {
  // An organization in the sidebar, as the admin has once one is added.
  const seeded = await request.post("/__e2e/seed");
  expect(seeded.status()).toBe(200);
  await page.goto("/no-such-page", { waitUntil: "networkidle" });

  await expect(
    page.getByRole("heading", { name: "This page is not here" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to the admin" })
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Organizations" })
  ).toBeVisible();
});
