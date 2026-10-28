import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn, release } from "./people.ts";

// The board's goals, end to end: an admin sets one on the Brain's Vision
// page, words it again and links a workflow that serves it; a member reads
// it there, with nothing to change it by, and on the dashboard, with its
// workflow. That only admins change goals, and what each reader sees of a
// goal's workflows, are core's tests (apps/core/test/brain-goals.test.ts).

/** Counts in one step, and is done: never started here. */
const tally = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("tally", { input: z.unknown(), params: {} }, async (step) =>
  await step.do("count", { description: "Count the invoices" }, async () => 3)
);
`;

const tallyTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import tally from "./tally.ts";

export default workflowTests(tally, [
  { name: "counts", mocks: { count: 3 }, expect: {} },
]);
`;

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

test("an admin sets a board goal, words it again and links a workflow; a member reads it on the Vision page and the dashboard, and can't change it", async ({
  pageOf,
}) => {
  const { admin, member } = peopleIn("boardGoals");
  const tag = crypto.randomUUID().slice(0, 8);
  const engine = `Ledger ${tag}`;
  const { core, api } = apiOf(admin);
  try {
    const { id } = await api.apps.create({ name: engine });
    await release(
      api,
      id,
      {
        "workflows/tally.ts": tally,
        "workflows/tally.workflow-tests.ts": tallyTests,
      },
      "Invoice counts"
    );
  } finally {
    core[Symbol.dispose]();
  }
  const first = `Close the books in three days ${tag}`;
  const worded = `Close the books in two days ${tag}`;

  const page = await pageOf(admin);
  await page.goto("/brain/sections/vision");
  const goals = page.getByRole("region", { name: "Board goals" });

  // A new goal, and how the company will notice it.
  await goals.getByRole("button", { name: "Add a goal" }).click(pageRead);
  let dialog = page.getByRole("dialog", { name: "New board goal" });
  await dialog.getByLabel("Goal").fill(first);
  await dialog.getByLabel("How we notice it").fill("The month closes early.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(goals).toContainText(first, pageRead);

  // Worded again: the newest wording shows.
  await goals.getByRole("button", { name: `Reword ${first}` }).click();
  dialog = page.getByRole("dialog", { name: "Reword the goal" });
  await dialog.getByLabel("Goal").fill(worded);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(goals).toContainText(worded, pageRead);

  // The workflow that serves it.
  await goals.getByRole("button", { name: `Workflows of ${worded}` }).click();
  dialog = page.getByRole("dialog", { name: `Workflows that serve ${worded}` });
  await dialog
    .getByRole("checkbox", { name: new RegExp(`tally.*${engine}`, "u") })
    .check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    goals.getByRole("listitem").filter({ hasText: worded })
  ).toContainText("1 workflow serves it", pageRead);

  // A member reads the goal, with nothing to change it by.
  const memberPage = await pageOf(member);
  await memberPage.goto("/brain/sections/vision");
  await expect(
    memberPage.getByRole("link", { name: new RegExp(worded, "u") })
  ).toBeVisible(pageRead);
  await expect(
    memberPage.getByRole("button", { name: "Add a goal" })
  ).toHaveCount(0);
  await expect(
    memberPage.getByRole("button", { name: `Reword ${worded}` })
  ).toHaveCount(0);

  // And on the admin's dashboard, with the workflow that serves it: built,
  // and not yet handling anything.
  await page.goto("/dashboard");
  const widget = page.getByRole("region", { name: "Board goals" });
  const goal = widget.getByRole("listitem").filter({ hasText: worded });
  await expect(goal).toContainText("0 of 1", pageRead);
});
