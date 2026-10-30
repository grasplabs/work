import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * How long a step may take: its attempt against the fake Cloudflare API
 * (apps/admin/test/e2e-worker.ts) and the Setup's 5 s refreshes, on a
 * loaded machine.
 */
const stepMs = 90_000;

/**
 * Opens `path` once its page is hydrated: the admin renders on the
 * server first, and a click before its scripts ran sends the form natively.
 */
const visit = async (page: Page, path: string): Promise<void> => {
  await page.goto(path, { waitUntil: "networkidle" });
};

// Staff create an organization from its three fields: its web address
// made from its name, how its people sign in found from its domain, and
// its first admin filled from the domain; then it sets itself up, and
// its Setup shows each step as it happens (src/routes/new-organization.tsx).
test("staff create an organization in three fields, and watch it set itself up", async ({
  page,
  request,
}) => {
  const response = await request.post("/__e2e/seed-create");
  expect(response.status()).toBe(200);
  const name = `Acme ${crypto.randomUUID().slice(0, 6)}`;
  const clientId = name.toLowerCase().replaceAll(" ", "-");

  await visit(page, "/new-organization");
  await page.getByLabel("Name").fill(name);
  await expect(page.getByLabel("Web address")).toHaveValue(clientId);
  await expect(page.getByText(".grasp.test", { exact: true })).toBeVisible();
  await page.getByLabel("Company email domain").fill("acme.test");
  await expect(page.getByText("Sign-in: Google Workspace")).toBeVisible();
  await expect(page.getByLabel("First admin's email")).toHaveValue(
    "@acme.test"
  );
  await page.getByLabel("First admin's email").fill("ada@acme.test");
  await expect(
    page.getByRole("checkbox", { name: "Keep data in the EU" })
  ).toBeChecked();
  await page.getByRole("button", { name: "Create organization" }).click();

  await expect(page).toHaveURL(
    new RegExp(`/organizations/${clientId}/setup`, "u")
  );
  const steps = page.getByRole("list", { name: "Steps" });
  await expect(
    steps.getByText(`Reserving ${clientId}.grasp.test`)
  ).toBeVisible();
  await expect(steps.getByText("Inviting admins")).toBeVisible();
  // Its storage made by itself, with nobody clicking anything.
  await expect(
    steps
      .getByRole("listitem")
      .filter({ hasText: "Creating its databases and file storage" })
      .getByText("Done")
  ).toBeVisible({ timeout: stepMs });
});

/** The create page's sign-in lookup, as it asks the server. */
const lookup = (url: URL): boolean =>
  url.pathname.startsWith("/_serverFn/") &&
  decodeURIComponent(url.search).includes("domain");

// A sign-in lookup that fails never leaves the form waiting: staff choose
// by hand, or try the lookup again (src/routes/new-organization.tsx).
test("offers the sign-in choice and a try again when looking it up fails", async ({
  page,
  request,
}) => {
  const response = await request.post("/__e2e/seed-create");
  expect(response.status()).toBe(200);
  await page.route(lookup, async (route) => {
    await route.fulfill({ status: 500, body: "unavailable" });
  });

  await visit(page, "/new-organization");
  await page.getByLabel("Name").fill(`Acme ${crypto.randomUUID().slice(0, 6)}`);
  await page.getByLabel("Company email domain").fill("acme.test");
  await expect(
    page.getByText("We couldn't look up how acme.test signs in just now.")
  ).toBeVisible();
  await expect(
    page.getByLabel("Google Workspace primary domain")
  ).toBeVisible();
  await expect(page.getByText("Finding how they sign in…")).toBeHidden();

  await page.unroute(lookup);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Sign-in: Google Workspace")).toBeVisible();
});
