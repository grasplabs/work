import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// Stephen's tour: offered on Chat the first time someone comes in, taken
// page by page, not offered again, and started again from the person menu.
// Which stops whose role skips is a unit test (apps/web/src/tour).

/** Each stop's page and the start of his line there, in order. */
const stops = [
  [/\/brain$/u, "This is the Brain."],
  [/\/domains$/u, "These are your domains."],
  [/\/workflows$/u, "This is the work itself"],
  [/\/integrations$/u, "On this page you connect"],
  [/\/integrations$/u, "That’s the tour."],
] as const;

test("offers the tour on first sign-in, takes it to its end, and starts it again from the person menu", async ({
  pageOf,
}) => {
  const { member } = peopleIn("tour");
  const page = await pageOf(member);
  const tour = page.getByRole("region", { name: "Tour of Grasp" });

  await page.goto("/");
  await expect(tour).toContainText(
    "Welcome to Grasp. Shall I show you around?"
  );
  await tour.getByRole("button", { name: "Start the tour" }).click();
  await expect(tour).toContainText("Are you ready?");
  await tour.getByRole("button", { name: "I’m ready" }).click();
  for (const [index, [address, line]] of stops.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- one stop after the other
    await expect(page).toHaveURL(address);
    // oxlint-disable-next-line no-await-in-loop -- see above
    await expect(tour).toContainText(line);
    // oxlint-disable-next-line no-await-in-loop -- see above
    await expect(tour).toContainText(`${index + 1} of ${stops.length}`);
    // oxlint-disable-next-line no-await-in-loop -- see above
    await tour
      .getByRole("button", {
        name: index === stops.length - 1 ? "Done" : "Next",
      })
      .click();
  }
  await expect(tour).toHaveCount(0);

  // Offered once: not again, in a new visit either.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "What should we look at today?" })
  ).toBeVisible();
  await expect(tour).toHaveCount(0);

  // From the person menu on any page, it begins again on Chat.
  await page.goto("/workflows");
  await page.getByRole("button", { name: /User$/u }).click();
  await page.getByRole("menuitem", { name: "Take the tour again" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(tour).toContainText("Are you ready?");
  await tour.getByRole("button", { name: "I’m ready" }).click();
  await expect(page).toHaveURL(stops[0][0]);
  await expect(tour).toContainText(stops[0][1]);
  await page.keyboard.press("Escape");
  await expect(tour).toHaveCount(0);
});
