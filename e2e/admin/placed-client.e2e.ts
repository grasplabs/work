import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";

/**
 * How long provisioning, a release or a rollback may take: its attempt's
 * steps against the fake Cloudflare API (apps/admin/test/e2e-worker.ts),
 * and the Setup's 5 s refreshes, on a loaded machine.
 */
const operationMs = 90_000;

/** What the admin's placed seed made (apps/admin/test/e2e-seed.ts). */
const seededSchema = z.object({
  destinationId: z.string(),
  releaseIds: z.tuple([z.string(), z.string()]),
});

/** A dedicated destination, and two releases a placed client runs, oldest first. */
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

/** Waits until the client's operation is done on `releaseId`, as the Setup follows it. */
const doneOn = async (page: Page, releaseId: string): Promise<void> => {
  const facts = hosting(page).getByRole("definition");
  await expect(
    facts.filter({ hasText: new RegExp(`^${releaseId}$`, "u") })
  ).toBeVisible({
    timeout: operationMs,
  });
  await expect(facts.filter({ hasText: /^done$/u })).toBeVisible({
    timeout: operationMs,
  });
};

// Staff add an organization, provision it in a dedicated destination,
// release it to a later release, roll it back and offboard it, from the
// console alone (GRA-387, GRA-384): no engineer, no command line.
test("staff provision a client as a placement, release it, roll it back and offboard it", async ({
  page,
  request,
}) => {
  const { destinationId, releaseIds } = await seed(request);
  const [first, second] = releaseIds;
  const clientId = `placed-${crypto.randomUUID().slice(0, 8)}`;

  // Added: who it is and how its people sign in. No account, no release.
  await visit(page, "/new-organization");
  await page.getByLabel("Name").fill("Placed Acme");
  await page.getByLabel("Its address").fill(clientId);
  await page.getByLabel("Email", { exact: true }).fill("ada@acme.test");
  await page.getByLabel("Email domains").fill("acme.test");
  await page.getByLabel("Google Workspace domain").fill("acme.test");
  await page.getByRole("button", { name: "Add organization" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/organizations/${clientId}/setup`, "u")
  );

  // Placed in the dedicated destination staff choose, on the older release.
  const section = hosting(page);
  await section
    .getByRole("button", { name: "Advanced: dedicated hosting" })
    .click();
  await section.getByText(destinationId, { exact: true }).click();
  await section.getByLabel("Release").selectOption(first);
  await section
    .getByRole("button", { name: "Place and start provisioning" })
    .click();
  await doneOn(page, first);
  await expect(
    section.getByText(`Placed in ${destinationId}`, { exact: false })
  ).toBeVisible();

  // Released to the later one.
  await section.getByLabel("Release").selectOption(second);
  await section.getByRole("button", { name: "Release it" }).click();
  await doneOn(page, second);

  // Rolled back to the one before.
  await section.getByRole("button", { name: `Roll back to ${first}` }).click();
  await doneOn(page, first);
  await expect(
    section.getByRole("button", { name: `Roll back to ${second}` })
  ).toBeVisible();

  // Offboarded: unrouted at once, and listed for deletion once its
  // retention is over, which it isn't yet.
  await section
    .getByRole("checkbox", { name: "It stops serving its people now" })
    .click();
  await section.getByRole("button", { name: "Offboard it" }).click();
  await visit(page, "/platform/offboarded");
  const listed = page.getByRole("listitem").filter({ hasText: clientId });
  await expect(listed).toBeVisible();
  await listed
    .getByRole("checkbox", {
      name: "No export of it was made, and I delete its resources without one",
    })
    .click();
  await listed.getByRole("button", { name: "Delete its resources" }).click();
  await expect(listed.getByRole("alert")).toContainText(
    "kept for 30 days after it was offboarded"
  );
});
