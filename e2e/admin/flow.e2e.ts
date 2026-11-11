import { expect, test } from "@playwright/test";
import { z } from "zod";

/** What the organizations seed made (apps/admin/test/e2e-seed.ts). */
const seededSchema = z.object({ answered: z.string(), unset: z.string() });

// Staff set how much onboarding a company goes through: from a preset,
// changed by hand, saved as one command, and read back from its Grasp.
test("staff set a company's flow from a preset, are told why one can't work, save it and take it back", async ({
  page,
  request,
}) => {
  const response = await request.post("/__e2e/seed-organizations");
  const { answered } = seededSchema.parse(await response.json());
  await page.goto(`/organizations/${answered}/flow`, {
    waitUntil: "networkidle",
  });
  const main = page.getByRole("main");
  const path = main.getByRole("region", {
    name: "What its admin goes through",
  });
  const save = main.getByRole("button", { name: "Save flow" });

  // All of it, as kept: nothing to save.
  await expect(save).toBeDisabled();
  await expect(path.getByText("When Grasp gives its go")).toBeVisible();

  // A preset is a draft: the path follows it, and nothing is sent yet.
  await main.getByRole("button", { name: "Setup only" }).click();
  await expect(path.getByRole("listitem")).toHaveText([
    "Welcome",
    "Its AI",
    "Who’s who",
    "Where the work is written down",
    "Documents",
  ]);
  await expect(
    path.getByText("When its admin finishes the last step.")
  ).toBeVisible();
  await expect(main.getByText("Not saved yet")).toBeVisible();

  // Team leads without who's who can't work: it says so, and can't be saved.
  await main.getByRole("switch", { name: "Team leads" }).click();
  await main.getByRole("switch", { name: "Who’s who" }).click();
  await expect(
    main.getByText("Team leads and the interviews go by the staff list")
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await main.getByRole("switch", { name: "Who’s who" }).click();

  // Saved, it is what the company's Grasp keeps, and can be taken back.
  await save.click();
  await expect(
    main.getByText("This is what the company’s Grasp keeps.")
  ).toBeVisible();
  await expect(main.getByRole("switch", { name: "Team leads" })).toBeChecked();
  await expect(
    main.getByRole("switch", { name: "Interviews" })
  ).not.toBeChecked();

  await main
    .getByRole("button", { name: "Take the whole onboarding back" })
    .click();
  await expect(main.getByRole("switch", { name: "Interviews" })).toBeChecked();
  await expect(save).toBeDisabled();
});
