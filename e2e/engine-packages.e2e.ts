import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { seedDependencyRequest } from "./dependency-request.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// An engine's approved npm packages, and taking an approval back: its
// builders see them in the engine's Packages tab; someone who may approve
// packages sees them too, and only them when they aren't one of the
// engine's members, and retires or revokes them after reading what that
// ends. The approval is written as a person's decision leaves it
// (dependency-request.ts): a local stack can't resolve from the registry.

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

/** An engine of `builder`'s with one approved package, and `approver` given the permission. */
const engineWithPackages = async (
  scene:
    | "enginePackages"
    | "enginePackagesBuilder"
    | "enginePackagesRefresh"
    | "enginePackagesFresh"
    | "enginePackagesTab"
    | "enginePackagesBusy"
    | "enginePackagesStale",
  name: string
) => {
  const people = peopleIn(scene);
  const asAdmin = apiOf(people.admin);
  const asBuilder = apiOf(people.builder);
  const { id: app } = await asBuilder.api.apps.create({ name });
  const grant = await asAdmin.api.dependencies.grantApprover({
    type: "person",
    userId: people.approver.userId,
  });
  const request = await seedDependencyRequest({
    app,
    requestedBy: people.builder.userId,
    purpose: "Draw the monthly totals as a chart.",
    targets: ["browser"],
    approved: true,
    graph: {
      direct: [{ name: "charts", version: "3.1.0" }],
      packages: [
        {
          name: "charts",
          version: "3.1.0",
          origin: "https://registry.npmjs.org",
          integrity: `sha512-${"A".repeat(86)}==`,
          license: "MIT",
          dependencies: [],
          peers: [],
        },
      ],
      platformPeers: {},
    },
  });
  asAdmin.core[Symbol.dispose]();
  asBuilder.core[Symbol.dispose]();
  return { ...people, app, request, grant: grant.id };
};

/** Retires `request`'s graph as `person` through the API: someone else, for the page. */
const retireElsewhere = async (
  person: Parameters<typeof apiOf>[0],
  request: { id: string }
) => {
  const as = apiOf(person);
  const impact = await as.api.dependencies.impact(request.id);
  await as.api.dependencies.retire(request.id, {
    reviewed: {
      graphHash: impact.graphHash,
      policyGeneration: impact.policyGeneration,
      approvalsDigest: impact.endings.retire.digest,
    },
    reason: "Replaced.",
  });
  as.core[Symbol.dispose]();
};

test("someone who may approve packages and isn't a member sees only an engine's packages, and retires them", async ({
  browser,
}) => {
  const { builder, approver, app } = await engineWithPackages(
    "enginePackages",
    "Charts"
  );

  const page = await pageOf(browser, approver);
  await page.goto(`/engines/${app}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Charts" })
  ).toBeVisible(pageRead);
  // Only the packages: none of the engine's tabs.
  await expect(page.getByRole("tab")).toHaveCount(0);
  const table = page.getByRole("table", { name: "Approved packages" });
  const row = table.getByRole("row").filter({ hasText: "charts@3.1.0" });
  await expect(row).toContainText("Approved");
  await row
    .getByRole("button", { name: "Retire the packages for Charts" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Retire the packages for Charts?",
  });
  await expect(
    dialog.getByText("This ends 1 approval of these packages.")
  ).toBeVisible();
  const retire = dialog.getByRole("button", { name: "Retire", exact: true });
  // Why is required.
  await expect(retire).toBeDisabled();
  await dialog.getByLabel("Why").fill("Replaced by the platform's chart.");
  await retire.click();

  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText("Retired");
  await expect(row).toContainText("Replaced by the platform's chart.");

  // A builder sees them in the engine's Packages tab, and ends nothing.
  const builderPage = await pageOf(browser, builder);
  await builderPage.goto(`/engines/${app}`);
  await builderPage.getByRole("tab", { name: "Packages" }).click();
  const builderRow = builderPage
    .getByRole("table", { name: "Approved packages" })
    .getByRole("row")
    .filter({ hasText: "charts@3.1.0" });
  await expect(builderRow).toContainText("Retired", pageRead);
  await expect(builderRow.getByRole("button")).toHaveCount(0);
});

test("someone who may approve packages and builds other engines sees only this one's packages", async ({
  browser,
}) => {
  // An approver's organization role doesn't decide it: core lets them
  // list the packages of an engine they aren't a member of.
  const { approver, app } = await engineWithPackages(
    "enginePackagesBuilder",
    "Ledger"
  );

  const page = await pageOf(browser, approver);
  await page.goto(`/engines/${app}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Ledger" })
  ).toBeVisible(pageRead);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(
    page
      .getByRole("table", { name: "Approved packages" })
      .getByRole("row")
      .filter({ hasText: "charts@3.1.0" })
  ).toContainText("Approved");
});

test("reads the packages again when a decision fails, keeping why", async ({
  browser,
}) => {
  const { approver, app, request } = await engineWithPackages(
    "enginePackagesRefresh",
    "Ledger"
  );
  const page = await pageOf(browser, approver);
  await page.goto(`/engines/${app}`);
  await page
    .getByRole("button", { name: "Revoke the packages for Ledger" })
    .click(pageRead);
  const dialog = page.getByRole("dialog", {
    name: "Revoke the packages for Ledger?",
  });
  await expect(dialog).toBeVisible();

  // Revoked elsewhere while the dialog is open.
  const asApprover = apiOf(approver);
  const impact = await asApprover.api.dependencies.impact(request.id);
  await asApprover.api.dependencies.revoke(request.id, {
    reviewed: {
      graphHash: impact.graphHash,
      policyGeneration: impact.policyGeneration,
      approvalsDigest: impact.endings.revoke.digest,
    },
    reason: "Unsafe.",
  });
  asApprover.core[Symbol.dispose]();
  await dialog.getByLabel("Why").fill("Unsafe.");
  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();

  // Why it failed stays; the list behind it is read again.
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    page.getByText("No packages are approved for this domain.")
  ).toBeVisible();
});

test("shows the packages as the page reads them again, when someone else ended them meanwhile", async ({
  browser,
}) => {
  const { approver, app, request } = await engineWithPackages(
    "enginePackagesFresh",
    "Budget"
  );
  const page = await pageOf(browser, approver);
  await page.goto(`/engines/${app}`);
  await expect(
    page
      .getByRole("table", { name: "Approved packages" })
      .getByRole("row")
      .filter({ hasText: "charts@3.1.0" })
  ).toContainText("Approved", pageRead);

  // Retired by someone else, then the page reads its data again: switching
  // language re-runs the page's loaders (main.tsx).
  const asApprover = apiOf(approver);
  const impact = await asApprover.api.dependencies.impact(request.id);
  await asApprover.api.dependencies.retire(request.id, {
    reviewed: {
      graphHash: impact.graphHash,
      policyGeneration: impact.policyGeneration,
      approvalsDigest: impact.endings.retire.digest,
    },
    reason: "Replaced.",
  });
  asApprover.core[Symbol.dispose]();
  await page.getByRole("button", { name: /^P Person/u }).click();
  await page.getByRole("menuitem", { name: /^Language/u }).click();
  await page.getByRole("menuitemradio", { name: "Nederlands" }).click();

  await expect(
    page
      .getByRole("table", { name: "Pakketten goedgekeurd" })
      .getByRole("row")
      .filter({ hasText: "charts@3.1.0" })
  ).toContainText("Uitgefaseerd", pageRead);
});

test("reads a builder's packages when the tab opens, not when the page loaded", async ({
  browser,
}) => {
  const { builder, approver, app, request } = await engineWithPackages(
    "enginePackagesTab",
    "Forecast"
  );
  const page = await pageOf(browser, builder);
  await page.goto(`/engines/${app}`);
  await expect(page.getByRole("tab", { name: /^Apps/u })).toBeVisible(pageRead);

  await retireElsewhere(approver, request);
  await page.getByRole("tab", { name: "Packages" }).click();

  await expect(
    page
      .getByRole("table", { name: "Approved packages" })
      .getByRole("row")
      .filter({ hasText: "charts@3.1.0" })
  ).toContainText("Retired", pageRead);
});

test("stays busy until the list was read again, so a decision is never sent twice", async ({
  browser,
}) => {
  const { approver, app } = await engineWithPackages(
    "enginePackagesBusy",
    "Payroll"
  );
  const page = await pageOf(browser, approver);
  await page.goto(`/engines/${app}`);
  await page
    .getByRole("button", { name: "Retire the packages for Payroll" })
    .click(pageRead);
  const dialog = page.getByRole("dialog", {
    name: "Retire the packages for Payroll?",
  });
  await dialog.getByLabel("Why").fill("Replaced.");
  const retire = dialog.getByRole("button", { name: "Retire", exact: true });
  // Every time the button can be clicked again after the first click,
  // until the dialog is gone.
  await retire.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      throw new TypeError("Not a button");
    }
    const seen = { clicked: false, clickable: 0 };
    Reflect.set(window, "seenRetire", seen);
    button.addEventListener(
      "click",
      () => {
        seen.clicked = true;
      },
      { capture: true }
    );
    new MutationObserver(() => {
      if (seen.clicked && button.isConnected && !button.disabled) {
        seen.clickable += 1;
      }
    }).observe(button, { attributes: true });
  });
  await retire.click();

  await expect(dialog).toHaveCount(0);
  await expect(
    page
      .getByRole("table", { name: "Approved packages" })
      .getByRole("row")
      .filter({ hasText: "charts@3.1.0" })
  ).toContainText("Retired");
  const seen: unknown = await page.evaluate((): unknown =>
    Reflect.get(window, "seenRetire")
  );
  expect(seen).toStrictEqual({ clicked: true, clickable: 0 });
});

test("says the list may be out of date when it can't be read again", async ({
  browser,
}) => {
  const { admin, approver, app, grant } = await engineWithPackages(
    "enginePackagesStale",
    "Travel"
  );
  const page = await pageOf(browser, approver);
  await page.goto(`/engines/${app}`);
  await page
    .getByRole("button", { name: "Retire the packages for Travel" })
    .click(pageRead);
  const dialog = page.getByRole("dialog", {
    name: "Retire the packages for Travel?",
  });
  await dialog.getByLabel("Why").fill("Replaced.");

  // The permission taken away meanwhile: the decision is refused, and the
  // list, which this approver read only by it, can't be read again.
  const asAdmin = apiOf(admin);
  await asAdmin.api.dependencies.revokeApprover(grant);
  asAdmin.core[Symbol.dispose]();
  await dialog.getByRole("button", { name: "Retire", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(
    page.getByRole("alert").filter({ hasText: "this list may be out of date" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Read again" })).toBeVisible();
});
