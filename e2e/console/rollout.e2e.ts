import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";

/**
 * How long a rollout to ring 0 may take to finish: each of the client's
 * Workers through its gradual stages, held 2 s each
 * (apps/console/test/e2e-worker.ts), and the page's 5 s refreshes.
 */
const rolloutMs = 90_000;

/** What the console's seed made (apps/console/test/e2e-seed.ts). */
const seededSchema = z.object({
  clientId: z.string(),
  releaseId: z.string(),
});

/**
 * A new client in ring 0, the only active one, running a release, with a
 * newer one imported.
 */
const seed = async (
  request: APIRequestContext
): Promise<z.infer<typeof seededSchema>> => {
  const response = await request.post("/__e2e/seed");
  expect(response.status()).toBe(200);
  return seededSchema.parse(await response.json());
};

/**
 * Opens `path` once its page is hydrated: the console renders on the
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
  await visit(page, "/admin/platform/rollouts");
  await expect(page.getByLabel("Release")).toHaveValue(releaseId);
  await expect(
    page.getByText(
      "Only ring 0 has active clients, so this reaches only our own deployments."
    )
  ).toBeVisible();
  await page.getByRole("button", { name: "Start rollout" }).click();
  await expect(page).toHaveURL(/\/admin\/platform\/rollouts\/[\da-f-]{36}$/u);
};

/** The client's row on a rollout's page: its name, then its id under it. */
const targetRow = (page: Page, clientId: string) =>
  page.getByRole("row").filter({ hasText: clientId });

/**
 * Each of the client's Workers as its drift check reads them, from its
 * page: the version the console made live, what runs, and its state.
 */
const checkDrift = async (page: Page, clientId: string) => {
  await visit(page, `/clients/${clientId}`);
  await page.getByRole("button", { name: "Check drift" }).click();
  const rows = page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Made live" }) })
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

test("staff roll a release out to ring 0 and watch it go and finish", async ({
  page,
  request,
}) => {
  const { clientId, releaseId } = await seed(request);

  await startRollout(page, releaseId);

  await expect(page.getByText("Rolling out to ring 0")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: `Rollout of ${releaseId}` })
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

  await page.goto(`/clients/${clientId}`);
  await expect(
    page.getByRole("definition").filter({ hasText: releaseId })
  ).toBeVisible();
});

test("staff roll a client back from a rollout and see it on its previous versions", async ({
  page,
  request,
}) => {
  const { clientId, releaseId } = await seed(request);
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
  const inSync = "runs what the console made live";
  expect({
    before: before.map(({ state }) => state),
    rolledOut: rolledOut.every(
      (worker, index) => worker.madeLive !== before[index]?.madeLive
    ),
    after,
  }).toStrictEqual({
    before: before.map(() => inSync),
    rolledOut: true,
    after: before,
  });
});
