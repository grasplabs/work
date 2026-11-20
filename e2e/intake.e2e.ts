import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";
import { e2eModel } from "./stack.ts";

// The intake, the built-in App, end to end: an admin creates an App from
// it, takes an interview as a draft with its statements and tags, keeps
// it, reviews it again from the list, retags a statement, and saves it:
// the source is then listed as saved, in the App's own store, and the
// draft is gone. And sends notes to be read by a model, following the
// reading on the screen.

const intake = "intake";

/**
 * How long the release's install may take to list the built-in: it runs
 * on the first request, in the background.
 */
const installedMs = 30_000;

/** An App `admin` created from the intake, its model bound. */
const intakeFor = async (admin: Person): Promise<string> => {
  const { core, api } = apiOf(admin);
  try {
    await expect
      .poll(
        async () => {
          const listed = await api.apps.blueprints.list();
          return listed.some(({ id }) => id === intake);
        },
        { timeout: installedMs }
      )
      .toBeTruthy();
    const created = await api.apps.blueprints.create(intake, {
      name: `Intake ${crypto.randomUUID().slice(0, 8)}`,
    });
    for (const { id } of created.permissions) {
      // Reviewed before a version of the copy is live.
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await api.permissions.grant(id, { version: null });
    }
    // Live, for the people it is shared with (until then, its
    // builders' alone).
    await api.versions.rollback({ kind: "app", id: created.app.id }, 1);
    // The model its reading goes through: the `ai` of the `extract`
    // workflow the copy got (the one it asked to start), approved as an admin
    // approves it on the workflow's page, for the stack's first model
    // (e2e/stack.ts). The local stack's provider refuses unscripted requests'
    // keys, so the reading waits for it. Core's tests read notes with a
    // scripted model (apps/core/test/intake.test.ts).
    const extract = created.permissions.find(
      ({ binding }) => binding === "EXTRACT"
    );
    if (extract?.object.type !== "workflow") {
      throw new Error("Expected the copy to ask to start its workflow");
    }
    await api.workflowResources.approveBinding(extract.object.workflowId, {
      alias: "ai",
      target: { kind: "model", model: e2eModel },
      reviewed: { version: 1 },
    });
    return created.app.id;
  } finally {
    core[Symbol.dispose]();
  }
};

/** The intake's page in `page`, once it shows. */
const openIntake = async (page: Page, app: string) => {
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator('iframe[title="App"]');
  // The first open builds the page, which takes a while on a loaded machine.
  await expect(appPage.getByRole("heading", { name: "Intake" })).toBeVisible({
    timeout: 20_000,
  });
  return appPage;
};

test("an admin takes an interview as a draft, reviews it again, and saves its tagged statements", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("intake");
  const tag = crypto.randomUUID().slice(0, 8);
  const title = `Interview ${tag}`;
  const app = await intakeFor(admin);
  const page = await pageOf(admin);
  const appPage = await openIntake(page, app);

  await appPage.getByRole("button", { name: "New source" }).click();
  await appPage.getByLabel("Source title").fill(title);
  await appPage.getByLabel("Date").fill("2026-09-21");
  await appPage.getByLabel("From").fill("Anna, controller");
  await appPage.getByRole("button", { name: "Add a statement" }).click();
  await appPage
    .getByLabel("Statement 1", { exact: true })
    .fill("Closing takes three days.");
  // Not kept until every statement has a tag.
  await expect(appPage.getByText("Tag statement 1.")).toBeVisible();
  await appPage
    .getByRole("checkbox", { name: "Time sink, statement 1" })
    .click();
  await appPage.getByRole("button", { name: "Add a statement" }).click();
  await appPage
    .getByLabel("Statement 2", { exact: true })
    .fill("Close should take a day.");
  await appPage.getByRole("checkbox", { name: "Goal, statement 2" }).click();
  await appPage.getByRole("button", { name: "Keep as a draft" }).click();
  await expect(appPage.getByRole("heading", { name: "Review" })).toBeVisible();

  // Back to the list, and reviewed again from it.
  await appPage.getByRole("button", { name: "Back" }).click();
  const drafts = appPage.getByRole("table", { name: "Drafts" });
  const row = drafts.getByRole("row").filter({ hasText: title });
  await expect(row.getByRole("cell")).toHaveText([
    title,
    "Typed in",
    "2026-09-21",
    "2",
    "Review",
  ]);
  await row.getByRole("button", { name: `Review ${title}` }).click();
  await expect(appPage.getByLabel("Statement 2", { exact: true })).toHaveValue(
    "Close should take a day."
  );
  await appPage
    .getByRole("checkbox", { name: "Handover, statement 1" })
    .click();
  await appPage.getByRole("button", { name: "Save", exact: true }).click();
  await expect(appPage.getByRole("status")).toHaveText(
    "Saved: 2 statements and their source."
  );
  await expect(drafts.getByRole("row").filter({ hasText: title })).toHaveCount(
    0
  );
  const saved = appPage
    .getByRole("table", { name: "Saved sources" })
    .getByRole("row")
    .filter({ hasText: title });
  await expect(saved.getByRole("cell")).toHaveText([
    title,
    "Interview",
    "2026-09-21",
    "Anna, controller",
  ]);
});

test("an admin sends notes to be read, and sees the reading wait while the AI provider refuses the key", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("intake");
  const title = `Notes ${crypto.randomUUID().slice(0, 8)}`;
  const app = await intakeFor(admin);
  // The local stack's provider refuses unscripted requests' keys
  // (e2e/model-fake.ts), so the reading's model call fails on the
  // organization's key.
  const page = await pageOf(admin);
  const appPage = await openIntake(page, app);

  await appPage.getByRole("button", { name: "Read notes" }).click();
  const start = appPage.getByRole("button", { name: "Take out statements" });
  await expect(start).toBeDisabled();
  await appPage.getByLabel("Source title").fill(title);
  await appPage
    .getByLabel("Notes", { exact: true })
    .fill("Closing the month takes three days.");
  await start.click();

  // Followed live: the reading waits rather than fail, as a run does while
  // the organization's provider refuses its key, and goes on by itself once
  // an admin replaces it (the banner that tells admins so is the web's
  // tests', apps/web/src/frame/ai-key-banner.test.tsx).
  const reading = appPage.getByRole("region", { name: "Notes being read" });
  const item = reading.getByRole("listitem").filter({ hasText: title });
  await expect(item).toContainText("Waiting its turn to read the notes", {
    timeout: 30_000,
  });
  // Nothing to dismiss: it hasn't ended, and keeps no draft.
  await expect(item.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
});
