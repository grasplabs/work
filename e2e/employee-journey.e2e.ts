import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import {
  answered,
  first,
  invited,
  personIn,
  readBack,
} from "./interview-turns.ts";
import { signInStaff } from "./people.ts";

// An employee's interview, end to end on a phone (GRA-339): they open
// their link at a phone's width, go through the screens before it, have
// the interview by typing, agree to the read-back, and then delete it,
// which leaves nothing of what they said. Stephen's turns are answered in
// the browser, as core would (e2e/interview-turns.ts): the local stack
// reaches no model. Its own Playwright project, after the onboarding's
// and the interviews' (playwright.config.ts): sending a link tells the
// team, and nothing undoes that.

/** What Mila answers. */
const said = "I check it in Exact, then I send it to Sam.";

/** A small phone's screen, held in portrait, touched rather than clicked. */
test.use({
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
});

/** How long "Delete my interview" is held before it asks (interview/closed.tsx), and a little more. */
const holdMs = 4500;

/** Whether the page is wider than the phone: anything to scroll sideways. */
const scrollsSideways = async (page: Page): Promise<boolean> =>
  await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );

test("an employee has their interview by typing on a phone, agrees to it, and deletes it", async ({
  page,
  cspViolations,
}) => {
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const person = `mila-${run}`;
  const link = await invited(staff, person, "Mila");
  const asked = await answered(page);

  // The screens before it: their language, who they talk with, what this is.
  await page.goto(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Stephen", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Hi Mila, I’m Stephen. I’m an AI, and I work for Grasp.",
    })
  ).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
  await page
    .getByRole("button", { name: "Type instead, without sound" })
    .click();

  // The interview, typed.
  await expect(page.getByText(first)).toBeVisible();
  const answer = page.getByLabel("Your answer");
  await answer.fill(said);
  await answer.press("Enter");

  // The read-back, and they agree to it as it is.
  await expect(page.getByText(readBack)).toBeVisible();
  await expect(
    page.getByRole("list").filter({ hasText: "Exact" }).getByRole("listitem")
  ).toHaveText(["You check the invoice in Exact.", "You send it to Sam."]);
  expect(await scrollsSideways(page)).toBe(false);
  await page.getByRole("button", { name: "Yes, that’s correct" }).click();
  await expect(
    page.getByRole("heading", { name: "Thank you, Mila." })
  ).toBeVisible();
  await expect
    .poll(async () => await personIn(staff, person))
    .toBe("completed");

  // Deleting is held, then asked, then done.
  const remove = page.getByRole("button", { name: "Delete my interview" });
  await remove.scrollIntoViewIfNeeded();
  const box = await remove.boundingBox();
  await page.mouse.move(
    (box?.x ?? 0) + (box?.width ?? 0) / 2,
    (box?.y ?? 0) + (box?.height ?? 0) / 2
  );
  await page.mouse.down();
  const asking = page.getByRole("dialog", { name: "Delete your interview?" });
  await expect(asking).toBeVisible({ timeout: holdMs * 2 });
  await page.mouse.up();
  await asking.getByRole("button", { name: "Delete it" }).click();
  await expect(
    page.getByText("Deleted. Nothing you said is kept.")
  ).toBeVisible();

  // Nothing of it is kept in core, nor on the page opened again.
  await expect.poll(async () => await personIn(staff, person)).toBeUndefined();
  await page.reload();
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.getByText(said)).toHaveCount(0);
  expect({
    turns: asked.turns.map(({ event }) => event),
    refused: asked.refused,
  }).toStrictEqual({ turns: ["start", "answer"], refused: [] });
  expect(cspViolations).toStrictEqual([]);
});
