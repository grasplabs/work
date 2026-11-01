import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// What changed in the brain since a person last looked, on Brain ›
// Activity: a document they saved shows as added, and once they have
// looked, it is no longer new. Which changes a person may see is core's
// test (apps/core/test/brain-changes.test.ts).

/** How long a page of the brain may take to read the brain. */
const brainRead = { timeout: 15_000 };

test("a person sees a document added since they last looked at the brain's activity, and not again once they have", async ({
  pageOf,
}) => {
  const { member } = peopleIn("brainChanges");
  const title = `Desk booking ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(member);
  try {
    const { id: collectionId } = await api.knowledge.createCollection({
      name: `Office ${crypto.randomUUID()}`,
      access: "me",
    });
    await api.knowledge.saveDocument({
      collectionId,
      path: "desks.md",
      text: `# ${title}\n\nBook a desk a day ahead.\n`,
      ifVersion: 0,
    });
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(member);
  await page.goto("/brain/activity");
  const since = page.getByRole("region", { name: "Since you last looked" });
  const line = since.getByRole("listitem").filter({ hasText: title });
  await expect(line).toBeVisible(brainRead);
  await expect(line).toContainText("Added");
  await line.getByRole("link", { name: title }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: title })
  ).toBeVisible(brainRead);

  // Looked at: the next look starts from then. Other tests may add what
  // everyone reads meanwhile, so only this one is checked.
  await page.goto("/brain/activity");
  await expect(
    since.getByText(/^Nothing has changed since/u).or(since.getByRole("list"))
  ).toBeVisible(brainRead);
  await expect(line).toHaveCount(0);
});
