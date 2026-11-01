import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";

/**
 * How long a deploy may take: its run's steps against the fake Cloudflare
 * API (apps/admin/test/e2e-worker.ts), and the Setup's 5 s refreshes, on
 * a loaded machine.
 */
const operationMs = 90_000;

/** What the admin's placed seed made (apps/admin/test/e2e-seed.ts). */
const seededSchema = z.object({
  clientId: z.string(),
  releaseIds: z.tuple([z.string(), z.string()]),
});

/** A client live on Stable's release, in a dedicated destination of its own, and a newer release on Edge. */
const seed = async (
  request: APIRequestContext
): Promise<z.infer<typeof seededSchema>> => {
  const response = await request.post("/__e2e/seed-placed");
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

/** The Setup's Hosting section. */
const hosting = (page: Page) => page.getByRole("region", { name: "Hosting" });

/**
 * Waits until the client's operation is done on `releaseId`, ticking the
 * reconciler as the admin's cron does and reading its Setup again.
 */
const doneOn = async (
  page: Page,
  request: APIRequestContext,
  clientId: string,
  releaseId: string
): Promise<void> => {
  await expect(async () => {
    const ticked = await request.post("/__e2e/tick");
    expect(ticked.status()).toBe(204);
    await visit(page, `/organizations/${clientId}/setup`);
    await hosting(page)
      .getByRole("button", { name: "Show hosting details" })
      .click();
    const facts = hosting(page).getByRole("definition");
    await expect(
      facts.filter({ hasText: new RegExp(`^${releaseId}$`, "u") })
    ).toBeVisible({ timeout: 1000 });
    await expect(facts.filter({ hasText: /^done$/u })).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: operationMs });
};

// Staff pin a live client to another release, unpin it back to its
// channel's and offboard it, from the admin alone (GRA-387, GRA-384): no
// engineer, no command line. Adding one is the create journey's.
test("staff pin a placed client, unpin it and offboard it", async ({
  page,
  request,
}) => {
  const { clientId, releaseIds } = await seed(request);
  const [stable, newer] = releaseIds;
  const pinning = async (releaseId: string | null): Promise<void> => {
    await visit(page, `/organizations/${clientId}/setup?tab=releases`);
    if (releaseId === null) {
      await page.getByRole("button", { name: "Unpin" }).click();
      return;
    }
    await page.getByLabel("Pin it to").selectOption(releaseId);
    await page.getByRole("button", { name: "Pin", exact: true }).click();
  };
  const hostingDone = async (releaseId: string): Promise<void> => {
    await doneOn(page, request, clientId, releaseId);
  };

  await hostingDone(stable);
  // Pinned: the admin deploys it to the pinned release by itself.
  await pinning(newer);
  await hostingDone(newer);
  // Unpinned: back to its channel's release.
  await pinning(null);
  await hostingDone(stable);
  const section = hosting(page);

  // Offboarded: unrouted at once, and listed for deletion once its
  // retention is over, which it isn't yet.
  await section
    .getByRole("checkbox", { name: "It stops serving its people now" })
    .click();
  await section.getByRole("button", { name: "Offboard it" }).click();
  await visit(page, "/platform/offboarded");
  const listed = page.getByRole("listitem").filter({ hasText: clientId });
  await expect(listed).toBeVisible();
  // Not yet: deleting is off, saying from when (core refuses it too:
  // apps/admin/test/client-hosting.test.ts).
  await expect(
    listed.getByRole("checkbox", {
      name: "No export of it was made, and I delete its resources without one",
    })
  ).toBeDisabled();
  await expect(
    listed.getByRole("button", { name: "Delete its resources" })
  ).toBeDisabled();
  await expect(listed).toContainText("once its 30 days are over");
});
