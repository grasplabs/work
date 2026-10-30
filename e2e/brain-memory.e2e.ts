import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn, teamMadeBy, teamMemberAddedBy } from "./people.ts";

// The Brain's memory, end to end: a person asks Grasp to remember
// something, finds it among their own records as proposed, and shares it
// with a team they are in, where a teammate reads it as accepted, by them.
// Who may publish where, and on what, is core's test
// (apps/core/test/memory-publish.test.ts and the brain's own).

/** How long the memory page may take to read the records. */
const pageRead = { timeout: 15_000 };

test("a person asks Grasp to remember something and shares it with their team, where a teammate reads it", async ({
  pageOf,
}) => {
  const { admin, one, two } = peopleIn("brainMemoryShare");
  const tag = crypto.randomUUID().slice(0, 8);
  const team = `Facilities ${tag}`;
  const teamId = await teamMadeBy(admin, team);
  await teamMemberAddedBy(admin, teamId, one.userId);
  await teamMemberAddedBy(admin, teamId, two.userId);
  const statement = `The bike shed opens at seven ${tag}.`;

  const page = await pageOf(one);
  await page.goto("/brain/memory");
  await page.getByRole("button", { name: "Remember something" }).click();
  const remember = page.getByRole("dialog", { name: "Remember something" });
  await remember.getByRole("radio", { name: "A fact" }).click();
  await remember.getByLabel("What to remember").fill(statement);
  await remember.getByRole("button", { name: "Remember it" }).click();
  await expect(remember).toBeHidden();

  // Theirs, proposed, and open beside the list.
  const panel = page.getByRole("region", { name: statement });
  await expect(panel).toBeVisible(pageRead);
  await expect(panel.getByText("Proposed", { exact: true })).toBeVisible();

  // Shared with the team: a person who isn't an admin can't share with
  // the whole company.
  await panel.getByRole("button", { name: "Share it" }).click();
  const share = page.getByRole("dialog", { name: "Share this record" });
  await expect(share.getByRole("radio")).toHaveCount(1);
  await expect(share.getByRole("radio", { name: team })).toBeChecked();
  await share.getByRole("button", { name: "Share it" }).click();
  await expect(share).toBeHidden();
  const published = page.getByRole("region", { name: statement });
  await expect(published.getByText("Team", { exact: true })).toBeVisible(
    pageRead
  );
  await expect(published.getByText("Accepted", { exact: true })).toBeVisible();

  // A teammate reads it among what is shared with them, by its publisher.
  const teammate = await pageOf(two);
  await teammate.goto("/brain/memory");
  await teammate.getByRole("tab", { name: "Shared with you" }).click();
  await expect(teammate.getByRole("button", { name: statement })).toBeVisible(
    pageRead
  );
});
