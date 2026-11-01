import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";

// Adapting a Grasp skill: an admin reading one of the skills Grasp ships
// copies it into Our skills, and the copy opens there to edit; copying it
// again says Our skills has it already, and changes nothing. A member
// reading the same skill is offered no copy. What a copy carries, and who
// may make one, is core's test (apps/core/test/skills.test.ts).

/** How long a Knowledge page may take to read what it shows. */
const pageRead = { timeout: 15_000 };

test("an admin copies a Grasp skill into Our skills to adapt it, while a member is offered no copy", async ({
  pageOf,
}) => {
  const { admin, member } = peopleIn("knowledgeSkills");
  const { core, api } = apiOf(admin);
  let skill: { id: string; path: string; title: string };
  try {
    const { documents } = await api.knowledge.listDocuments("grasp-skills");
    const skills = documents.filter(({ type }) => type === "skill");
    // Another skill on each retry: a retry's stack keeps the copy made
    // before.
    const picked = skills[test.info().retry % skills.length];
    if (picked === undefined) {
      throw new Error("The release ships no Grasp skills");
    }
    skill = picked;
  } finally {
    core[Symbol.dispose]();
  }
  const address = `/knowledge/grasp-skills?doc=${skill.id}`;

  const reader = await pageOf(member);
  await reader.goto(address);
  await expect(
    reader.getByRole("heading", { level: 1, name: skill.title })
  ).toBeVisible(pageRead);
  await expect(
    reader.getByRole("button", { name: "Copy into Our skills" })
  ).toHaveCount(0);

  const page = await pageOf(admin);
  await page.goto(address);
  await page.getByRole("button", { name: "Copy into Our skills" }).click();
  await expect(page).toHaveURL(/\/knowledge\/skills\?doc=/u, pageRead);
  await expect(
    page.getByRole("heading", { level: 1, name: skill.title })
  ).toBeVisible(pageRead);
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();

  // Copied once: the next copy changes nothing, and says why.
  await page.goto(address);
  await page.getByRole("button", { name: "Copy into Our skills" }).click();
  await expect(
    page.getByText(
      `Our skills has a skill at ${skill.path} already: adapt that one.`
    )
  ).toBeVisible();
  await expect(page).toHaveURL(/\/knowledge\/grasp-skills\?doc=/u);
});
