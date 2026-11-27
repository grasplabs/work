import { expect, test } from "@playwright/test";
import { z } from "zod";

/** What the organizations seed made (apps/admin/test/e2e-seed.ts). */
const seededSchema = z.object({ answered: z.string() });

// Staff set how much onboarding a company goes through: from a preset,
// changed by hand, saved as one command, and read back from its Grasp.
test("staff set a company's flow from a preset, are told why one can't work, save it and take it back", async ({
  page,
  request,
}) => {
  const response = await request.post("/__e2e/seed-organizations");
  const { answered } = seededSchema.parse(await response.json());
  // The Flow is a tab of the Steps.
  await page.goto(`/organizations/${answered}/steps?tab=flow`, {
    waitUntil: "networkidle",
  });
  const main = page.getByRole("main");
  await expect(main.getByRole("tab", { name: "Flow" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  const save = main.getByRole("button", { name: "Save flow" });

  // All of it, as kept: nothing to save.
  await expect(save).toBeDisabled();
  await expect(
    main.getByText("Its Grasp opens when Grasp gives its go")
  ).toBeVisible();
  await expect(main.getByRole("button", { name: "Full" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  // No onboarding is a preset too: the steps are held until another is picked.
  await main.getByRole("button", { name: "No onboarding" }).click();
  await expect(main.getByText("Its Grasp opens at once")).toBeVisible();
  await expect(main.getByRole("switch", { name: "Welcome" })).toBeDisabled();

  // A preset is a draft: the steps follow it, and nothing is sent yet.
  await main.getByRole("button", { name: "Setup only" }).click();
  await expect(main.getByRole("switch", { name: "Welcome" })).toBeEnabled();
  await expect(
    main.getByRole("switch", { name: "How this works" })
  ).not.toBeChecked();
  await expect(
    main.getByText("Its Grasp opens when its admin finishes the last step.")
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

  // Moved by hand from the keyboard: picked up by its handle, one place
  // up, put down. Each step keeps whether it is on.
  // The admin's steps in their order, by their handles' names.
  const order = async () =>
    await main
      .getByRole("button", { name: /^Move /u })
      .evaluateAll((handles) =>
        handles.map((handle) => handle.getAttribute("aria-label"))
      );
  const before = await order();
  const moved = before.indexOf("Move Team leads");
  const handle = main.getByRole("button", { name: "Move Team leads" });
  await handle.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  const after = [...before];
  after.splice(moved - 1, 0, ...after.splice(moved, 1));
  await expect.poll(order).toStrictEqual(after);

  // Saved, it is what the company's Grasp keeps, and can be taken back.
  await save.click();
  await expect(
    main.getByText("This is what the company’s Grasp keeps.")
  ).toBeVisible();
  await expect(main.getByRole("switch", { name: "Team leads" })).toBeChecked();
  await expect(
    main.getByRole("switch", { name: "Interviews" })
  ).not.toBeChecked();
  // Read back from its Grasp: the order as moved.
  await page.reload({ waitUntil: "networkidle" });
  await expect.poll(order).toStrictEqual(after);
  await expect(main.getByRole("switch", { name: "Team leads" })).toBeChecked();

  await main
    .getByRole("button", { name: "Take the whole onboarding back" })
    .click();
  await expect(main.getByRole("switch", { name: "Interviews" })).toBeChecked();
  await expect(save).toBeDisabled();
});
