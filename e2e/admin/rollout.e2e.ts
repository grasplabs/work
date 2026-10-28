import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";

/**
 * How long a rollout to ring 0 may take to finish: the client's operation
 * releasing it (apps/admin/src/hosting/operation.ts), and the page's 5 s
 * refreshes.
 */
const rolloutMs = 90_000;

/** What the admin's seed made (apps/admin/test/e2e-seed.ts). */
const seededSchema = z.object({
  clientId: z.string(),
  releaseId: z.string(),
  previousReleaseId: z.string(),
});

/**
 * A new placed client in ring 0, the only active one, running a release,
 * with a newer one imported.
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

/**
 * Starts a rollout of the newest release, `releaseId`, from the form on
 * the admin's Platform.
 */
const startRollout = async (page: Page, releaseId: string): Promise<void> => {
  await visit(page, "/platform/rollouts");
  await expect(page.getByLabel("Release")).toHaveValue(releaseId);
  await expect(
    page.getByText(
      "Only Alpha has active clients, so this reaches only our own deployments."
    )
  ).toBeVisible();
  await page.getByRole("button", { name: "Start rollout" }).click();
  await expect(page).toHaveURL(/\/platform\/rollouts\/[\da-f-]{36}$/u);
};

/** The client's row on a rollout's page: its name, then its id under it. */
const targetRow = (page: Page, clientId: string) =>
  page.getByRole("row").filter({ hasText: clientId });

/** The client's Setup in the admin, on `tab`. */
const setupOf = (clientId: string, tab: string): string =>
  `/organizations/${clientId}/setup?tab=${tab}`;

/**
 * Each of the client's Workers as its drift check reads them, from its
 * Setup in the admin: the version the admin made live, what runs, and
 * its state.
 */
const checkDrift = async (page: Page, clientId: string) => {
  await visit(page, setupOf(clientId, "resources"));
  await page.getByRole("button", { name: "Read what runs" }).click();
  const rows = page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Running" }) })
    .getByRole("row")
    .filter({ has: page.getByRole("cell") });
  await expect(rows.first()).toBeVisible();
  const workers = await rows.evaluateAll((each) =>
    each.map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent)
    )
  );
  return workers.map(([worker, madeLive, running, state]) => ({
    worker,
    madeLive,
    running,
    state,
  }));
};

test("staff roll a release out to Alpha and watch it go and finish", async ({
  page,
  request,
}) => {
  const { clientId, releaseId } = await seed(request);

  await startRollout(page, releaseId);

  await expect(page.getByText("Rolling out to Alpha")).toBeVisible();
  // Named by the release's version, not its id.
  await expect(
    page.getByRole("heading", { name: /^Rollout of v\d+\.\d+$/u })
  ).toBeVisible();
  await expect(targetRow(page, clientId)).toBeVisible();
  // The page follows the run on its own, without a reload: the rollout's
  // status, then the client's.
  await expect(page.getByText("Done", { exact: true })).toBeVisible({
    timeout: rolloutMs,
  });
  await expect(targetRow(page, clientId).getByRole("cell").nth(1)).toHaveText(
    "On it"
  );

  await page.goto(setupOf(clientId, "releases"));
  // What it runs now; the latest rollout, beside it, names the release too.
  await expect(
    page.getByRole("definition").filter({ hasText: releaseId }).first()
  ).toBeVisible();
});

test("staff roll a client back from a rollout and see it on its previous release", async ({
  page,
  request,
}) => {
  const { clientId, releaseId, previousReleaseId } = await seed(request);
  const before = await checkDrift(page, clientId);
  await startRollout(page, releaseId);
  const rollout = page.url();
  await expect(targetRow(page, clientId).getByRole("cell").nth(1)).toHaveText(
    "On it",
    { timeout: rolloutMs }
  );
  const rolledOut = await checkDrift(page, clientId);

  await visit(page, rollout);
  await targetRow(page, clientId)
    .getByRole("button", { name: "Roll back" })
    .click();

  await expect(targetRow(page, clientId).getByRole("cell").nth(1)).toHaveText(
    "Rolled back",
    { timeout: rolloutMs }
  );
  const after = await checkDrift(page, clientId);
  const inSync = "In sync: it runs what the admin made live";
  // Back on the release it ran: run again, so on new versions of it.
  await page.goto(setupOf(clientId, "releases"));
  await expect(
    page.getByRole("definition").filter({ hasText: previousReleaseId }).first()
  ).toBeVisible();
  expect({
    before: before.map(({ state }) => state),
    rolledOut: rolledOut.every(
      (worker, index) => worker.madeLive !== before[index]?.madeLive
    ),
    after: after.map(({ worker, state }) => ({ worker, state })),
    rolledBack: after.every(
      (worker, index) => worker.madeLive !== rolledOut[index]?.madeLive
    ),
  }).toStrictEqual({
    before: before.map(() => inSync),
    rolledOut: true,
    after: before.map(({ worker }) => ({ worker, state: inSync })),
    rolledBack: true,
  });
});
