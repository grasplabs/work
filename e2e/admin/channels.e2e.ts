import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";

/**
 * How long a deploy of one client may take: its operation against the
 * fake Cloudflare API (apps/admin/test/e2e-worker.ts), on a loaded machine.
 */
const deployMs = 90_000;

/** What the admin's seed made (apps/admin/test/e2e-seed.ts). */
const seededSchema = z.object({
  clientId: z.string(),
  releaseId: z.string(),
  previousReleaseId: z.string(),
});

/**
 * A new placed client on Stable, the only active one, running Stable's
 * release, with a newer one on Edge.
 */
const seed = async (
  request: APIRequestContext
): Promise<z.infer<typeof seededSchema>> => {
  const response = await request.post("/__e2e/seed");
  expect(response.status()).toBe(200);
  return seededSchema.parse(await response.json());
};

/**
 * Opens `path` once its page is hydrated: the admin renders on the
 * server first, and a click before its scripts ran sends the form natively.
 */
const visit = async (page: Page, path: string): Promise<void> => {
  await page.goto(path, { waitUntil: "networkidle" });
};

/** A channel's panel on Platform. */
const channel = (page: Page, name: "Edge" | "Beta" | "Stable") =>
  page.getByRole("region", { name, exact: true });

/** Sets `name` to `releaseId` from its panel on Platform. */
const promote = async (
  page: Page,
  name: "Beta" | "Stable",
  releaseId: string
): Promise<void> => {
  await visit(page, "/platform");
  const panel = channel(page, name);
  await panel.getByLabel(`Release for ${name}`).selectOption(releaseId);
  await panel.getByRole("button", { name: "Promote" }).click();
  await expect(panel.getByRole("link", { name: releaseId })).toBeVisible();
};

/**
 * Waits until Stable's panel says its one company runs its release,
 * ticking the reconciler as the admin's cron does and reading the page
 * again.
 */
const stableUpToDate = async (
  page: Page,
  request: APIRequestContext
): Promise<void> => {
  await expect(async () => {
    const ticked = await request.post("/__e2e/tick");
    expect(ticked.status()).toBe(204);
    await visit(page, "/platform");
    await expect(
      channel(page, "Stable").getByText("1 of 1 up to date")
    ).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: deployMs });
};

/** The client's Setup in the admin, on `tab`. */
const setupOf = (clientId: string, tab: string): string =>
  `/organizations/${clientId}/setup?tab=${tab}`;

test("staff promote a release from Edge to Beta to Stable, and its company takes it", async ({
  page,
  request,
}) => {
  const { clientId, releaseId } = await seed(request);
  await visit(page, "/platform");
  // Stable takes only what Beta had: the new release isn't offered yet.
  await expect(
    channel(page, "Stable").getByRole("option", { name: releaseId })
  ).toHaveCount(0);

  await promote(page, "Beta", releaseId);
  await promote(page, "Stable", releaseId);

  await stableUpToDate(page, request);
  await visit(page, setupOf(clientId, "releases"));
  await expect(
    page.getByRole("definition").filter({ hasText: releaseId }).first()
  ).toBeVisible();
  // The promotions are on record, newest first.
  await visit(page, "/platform");
  await expect(
    page
      .getByRole("region", { name: "Promotions" })
      .getByRole("listitem")
      .first()
  ).toContainText(`Stable set to ${releaseId}`);
});

test("staff set Stable back to the release it had, and its company goes back to it", async ({
  page,
  request,
}) => {
  const { clientId, releaseId, previousReleaseId } = await seed(request);
  await promote(page, "Beta", releaseId);
  await promote(page, "Stable", releaseId);
  await stableUpToDate(page, request);

  await promote(page, "Stable", previousReleaseId);

  await stableUpToDate(page, request);
  await visit(page, setupOf(clientId, "releases"));
  await expect(
    page.getByRole("definition").filter({ hasText: previousReleaseId }).first()
  ).toBeVisible();
});
