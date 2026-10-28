import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn, release, teamMadeBy } from "./people.ts";

// The team that owns a workflow, end to end: a builder picks one of the
// organization's teams on the workflow's page, and the dashboard's teams
// count the workflow under it; a member the App is shared with reads the
// team, with nothing to change it by; the builder takes it off again. Who
// may set it, and to which teams, are core's tests
// (apps/core/test/workflow-teams.test.ts).

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

test("a builder picks the team that owns a workflow on its page, the dashboard counts it there, a member reads it, and the builder takes it off", async ({
  pageOf,
}) => {
  const { admin, builder, member } = peopleIn("workflowTeam");
  const tag = crypto.randomUUID().slice(0, 8);
  const finance = `Finance ${tag}`;
  await Promise.all([
    teamMadeBy(admin, finance),
    teamMadeBy(admin, `Sales ${tag}`),
  ]);
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({ name: `Ledger ${tag}` }));
    await release(
      api,
      app,
      {
        "workflows/tally.ts": tally,
        "workflows/tally.workflow-tests.ts": tallyTests,
      },
      "Invoice counts"
    );
    await api.apps.members.add(app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
  } finally {
    core[Symbol.dispose]();
  }

  // The builder picks Finance beside the owner.
  const page = await pageOf(builder);
  await page.goto(`/workflows/${app}/tally`);
  const team = page.getByRole("combobox", { name: "Team" });
  await expect(team).toHaveText("No team", pageRead);
  await team.click();
  await page.getByRole("option", { name: finance }).click();
  await expect(team).toHaveText(finance, pageRead);

  // The dashboard's teams count it under Finance.
  await page.goto("/dashboard");
  const teams = page.getByRole("region", { name: "Teams with AI" });
  await expect(teams).toContainText(finance, pageRead);

  // A member reads the team, with nothing to change it by.
  const memberPage = await pageOf(member);
  await memberPage.goto(`/workflows/${app}/tally`);
  await expect(memberPage.getByText(`Team: ${finance}`)).toBeVisible(pageRead);
  await expect(memberPage.getByRole("combobox", { name: "Team" })).toHaveCount(
    0
  );

  // Taken off again: the workflow has no team, and Finance isn't counted.
  await page.goto(`/workflows/${app}/tally`);
  await expect(team).toHaveText(finance, pageRead);
  await team.click();
  await page.getByRole("option", { name: "No team" }).click();
  await expect(team).toHaveText("No team", pageRead);
  await page.goto("/dashboard");
  await expect(teams).toBeVisible(pageRead);
  await expect(teams).not.toContainText(finance, pageRead);
});
