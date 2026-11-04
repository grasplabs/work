import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { seedDependencyRequest } from "./dependency-request.ts";
import { apiOf, peopleIn } from "./people.ts";

// An App's approved npm packages, and taking an approval back: its
// builders see them under Packages in its settings, and retire or revoke
// them after reading what that ends. The approval is written as a
// builder's decision leaves it (dependency-request.ts): a local stack
// can't resolve from the registry.

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

/** An engine of `builder`'s with one approved package, shared with `approver` as a builder. */
const engineWithPackages = async (
  scene:
    | "enginePackages"
    | "enginePackagesRefresh"
    | "enginePackagesFresh"
    | "enginePackagesTab"
    | "enginePackagesBusy"
    | "enginePackagesStale",
  name: string
) => {
  const people = peopleIn(scene);
  const asBuilder = apiOf(people.builder);
  const { id: app } = await asBuilder.api.apps.create({ name });
  await asBuilder.api.apps.members.add(app, {
    type: "person",
    id: people.approver.userId,
    role: "builder",
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
  asBuilder.core[Symbol.dispose]();
  return { ...people, app, request };
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

test("a builder of the App retires its packages, and every builder sees why", async ({
  pageOf,
}) => {
  const { builder, approver, app } = await engineWithPackages(
    "enginePackages",
    "Charts"
  );

  const page = await pageOf(approver);
  await page.goto(`/apps/${app}/settings?section=packages`);
  const table = page.getByRole("table", { name: "Approved packages" });
  const row = table.getByRole("row").filter({ hasText: "charts@3.1.0" });
  await expect(row).toContainText("Approved", pageRead);
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

  // Its other builder sees them under Packages in its settings, ended.
  const builderPage = await pageOf(builder);
  await builderPage.goto(`/apps/${app}/settings?section=packages`);
  const builderRow = builderPage
    .getByRole("table", { name: "Approved packages" })
    .getByRole("row")
    .filter({ hasText: "charts@3.1.0" });
  await expect(builderRow).toContainText("Retired", pageRead);
  await expect(builderRow).toContainText("Replaced by the platform's chart.");
});

test("reads the packages again when a decision fails, keeping why", async ({
  pageOf,
}) => {
  const { approver, app, request } = await engineWithPackages(
    "enginePackagesRefresh",
    "Ledger"
  );
  const page = await pageOf(approver);
  await page.goto(`/apps/${app}/settings?section=packages`);
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
    page.getByText("No packages are approved for this App.")
  ).toBeVisible();
});

test("shows the packages as the page reads them again, when someone else ended them meanwhile", async ({
  pageOf,
}) => {
  const { approver, app, request } = await engineWithPackages(
    "enginePackagesFresh",
    "Budget"
  );
  const page = await pageOf(approver);
  await page.goto(`/apps/${app}/settings?section=packages`);
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
  await page.getByRole("button", { name: "Person", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Language/u }).click();
  await page.getByRole("menuitemradio", { name: "Nederlands" }).click();

  await expect(
    page
      .getByRole("table", { name: "Pakketten goedgekeurd" })
      .getByRole("row")
      .filter({ hasText: "charts@3.1.0" })
  ).toContainText("Uitgefaseerd", pageRead);
});

test("reads a builder's packages when their section opens, not when the page loaded", async ({
  pageOf,
}) => {
  const { builder, approver, app, request } = await engineWithPackages(
    "enginePackagesTab",
    "Forecast"
  );
  const page = await pageOf(builder);
  await page.goto(`/apps/${app}/settings`);
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await expect(sections.getByRole("link", { name: "Packages" })).toBeVisible(
    pageRead
  );

  await retireElsewhere(approver, request);
  await sections.getByRole("link", { name: "Packages" }).click();

  await expect(
    page
      .getByRole("table", { name: "Approved packages" })
      .getByRole("row")
      .filter({ hasText: "charts@3.1.0" })
  ).toContainText("Retired", pageRead);
});

test("stays busy until the list was read again, so a decision is never sent twice", async ({
  pageOf,
}) => {
  const { approver, app } = await engineWithPackages(
    "enginePackagesBusy",
    "Payroll"
  );
  const page = await pageOf(approver);
  await page.goto(`/apps/${app}/settings?section=packages`);
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
  pageOf,
}) => {
  const { builder, approver, app } = await engineWithPackages(
    "enginePackagesStale",
    "Travel"
  );
  const page = await pageOf(approver);
  await page.goto(`/apps/${app}/settings?section=packages`);
  await page
    .getByRole("button", { name: "Retire the packages for Travel" })
    .click(pageRead);
  const dialog = page.getByRole("dialog", {
    name: "Retire the packages for Travel?",
  });
  await dialog.getByLabel("Why").fill("Replaced.");

  // No longer a builder of the App meanwhile: the decision is refused,
  // and the list, which they read as one, can't be read again.
  const asBuilder = apiOf(builder);
  await asBuilder.api.apps.members.remove(app, {
    type: "person",
    id: approver.userId,
  });
  asBuilder.core[Symbol.dispose]();
  await dialog.getByRole("button", { name: "Retire", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(
    page.getByRole("alert").filter({ hasText: "this list may be out of date" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Read again" })).toBeVisible();
});
