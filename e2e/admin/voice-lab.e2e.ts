import { expect, test } from "@playwright/test";

// The Voice Lab in the admin: staff choose who they talk with and in
// which language, and start a call. The local admin has no Mistral key,
// as a store nobody put one in, so the call says why it can't begin; a
// session opened with the key is the admin's tests'
// (apps/admin/test/voice-lab.test.ts), and what happens in one is
// Mistral's.

test("staff find the Voice Lab, choose Claire in German, and are told why no call begins without Grasp's key", async ({
  page,
  request,
}) => {
  const seeded = await request.post("/__e2e/seed-create");
  expect(seeded.status()).toBe(200);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Voice Lab" }).click();
  await expect(page.getByRole("heading", { name: "Voice Lab" })).toBeVisible();

  await page.getByRole("button", { name: "Claire" }).click();
  await page.getByLabel("Language").selectOption("de");
  await page.getByRole("button", { name: "Start talking" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Grasp's Mistral key isn't in Secrets Store"
  );
  // The call is over, and can be started again.
  await expect(page.getByRole("button", { name: "Talk again" })).toBeVisible();
});
