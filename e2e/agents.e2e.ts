import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// The company's agents, end to end: an admin sets one up by hand, one
// question at a time, and its page opens once it is made; there it is
// turned off and deleted. Someone who isn't an admin makes one of their
// own in a chat with Grasp, and only they see it, on its own page. What
// each page keeps (whom it answers, its classes, its schedule, its
// documents) is in the pages' own tests (apps/web/src/agents).

/**
 * A name no other agent of the stack has: core keeps each name to one
 * agent, and a file run again, or beside itself, makes its agents anew.
 */
const named = (name: string): string =>
  `${name} ${crypto.randomUUID().slice(0, 6)}`;

/** The way on under the question shown: the last Next, or what it says on the last step. */
const goOn = async (page: Page, name = "Next") => {
  await page.getByRole("button", { name, exact: true }).last().click();
};

test("an admin sets up an agent for everyone by hand, turns it off from its page, and deletes it", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("agents");
  const name = named("Invoice chaser");
  const page = await pageOf(admin);
  await page.goto("/agents");
  await expect(
    page.getByRole("heading", { name: "Agents", level: 1 })
  ).toBeVisible();
  // The company's first agent, under Organization.
  await expect(
    page
      .getByRole("list", { name: "Agents" })
      .getByRole("link", { name: /Stephen/u })
  ).toBeVisible();

  await page.getByRole("link", { name: "New agent" }).click();
  await expect(
    page.getByRole("heading", { name: "How do you want to make it?" })
  ).toBeVisible();
  await page.getByRole("link", { name: /Set it up yourself/u }).click();

  // Who can use it comes first for an admin, Everyone as offered.
  await expect(
    page.getByRole("heading", { name: "Who can use it?" })
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: /Everyone/u })).toBeChecked();
  await goOn(page);

  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await goOn(page);

  // A starting point takes its job and its instructions, and goes on.
  await page.getByRole("button", { name: /Chase unpaid invoices/u }).click();
  await expect(page.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    /## Goal/u
  );
  await goOn(page);
  // Its apps, what it may do and how hard it thinks, as offered.
  await goOn(page);
  await goOn(page);
  await goOn(page);
  // When it works: when someone asks, as offered.
  await expect(
    page.getByRole("radio", { name: /When someone asks/u })
  ).toBeChecked();
  await goOn(page);

  await expect(
    page.getByRole("heading", { name: `Ready to make ${name}?` })
  ).toBeVisible();
  await goOn(page, `Make ${name}`);
  await expect(page).toHaveURL(/\/agents\/[^/?]+$/u, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByText("On", { exact: true })).toBeVisible();

  // Turned off from the heading's "…": it says so.
  await page.getByRole("button", { name: `More for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Turn off" }).click();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();

  // Deleted for good, only once asked again; the Agents page no longer has it.
  await page.getByRole("button", { name: `More for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete for good" }).click();
  await expect(page).toHaveURL(/\/agents$/u);
  await expect(
    page.getByRole("link", { name: new RegExp(name, "u") })
  ).toHaveCount(0);
});

test("an admin sets up an agent by keyboard alone, each question taking focus as it comes in", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("agents");
  const name = named("Keys");
  const page = await pageOf(admin);
  await page.goto("/agents/new?way=manual");
  /** Where focus is, never the page's body: the question, or the field it names. */
  const focused = async (): Promise<string> =>
    await page.evaluate(() => {
      const on = document.activeElement;
      if (on === null || on === document.body) {
        return "the page";
      }
      return on.closest("[data-question]") === null
        ? (on.getAttribute("aria-label") ?? on.tagName)
        : "the question";
    });
  const question = page.getByRole("heading", { level: 1 });

  // Who can use it: the question has focus, and Enter goes on.
  await expect(question).toHaveText("Who can use it?");
  await expect.poll(focused).toBe("the question");
  await page.keyboard.press("Enter");

  await expect(question).toHaveText("What should we call your agent?");
  await expect.poll(focused).toBe("Name");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");

  // A starting point by Tab and Enter: the card goes with its question,
  // and focus goes to the next question's field, never the page.
  await expect(question).toHaveText(`What should ${name} do?`);
  await expect.poll(focused).toBe("What it is for");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(question).toHaveText(`How should ${name} work?`);
  await expect.poll(focused).toBe("Instructions");
  // In a field of several lines, Mod+Enter goes on.
  await page.keyboard.press("ControlOrMeta+Enter");

  // Its apps, what it may do, its model and when it works, as offered.
  for (const asked of [
    `Which apps can ${name} use?`,
    `What can ${name} do?`,
    `Which model should ${name} use?`,
    `When should ${name} work?`,
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one question after another
    await expect(question).toHaveText(asked);
    // oxlint-disable-next-line no-await-in-loop -- one question after another
    await expect.poll(focused).toBe("the question");
    // oxlint-disable-next-line no-await-in-loop -- one question after another
    await page.keyboard.press("Enter");
  }
  await expect(question).toHaveText(`Ready to make ${name}?`);
  await expect.poll(focused).toBe("the question");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/agents\/[^/?]+$/u, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  // Made, its page took the setup's place: Back leads to where it began.
  await page.goBack();
  await expect(page).not.toHaveURL(/way=manual/u);
});

test("someone who isn't an admin makes an agent of their own in a chat, and only they see it", async ({
  pageOf,
}) => {
  const { member, admin } = peopleIn("agents");
  const name = named("Receipt sorter");
  const page = await pageOf(member);
  await page.goto("/agents/new");
  await page.getByRole("link", { name: /In a chat/u }).click();

  // What it should do, in their own words.
  await page
    .getByRole("textbox", { name: "Something else" })
    .fill("Sorts the receipts I forward.");
  await goOn(page);
  await page
    .getByRole("textbox", { name: "What should we call it?" })
    .fill(name);
  await goOn(page);
  // Its shape and its colours, as offered.
  await goOn(page);
  await goOn(page);
  // Nothing more it should always know: skipped, to the whole agent.
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("dialog")).toContainText(name);
  await page.getByRole("button", { name: "Make agent" }).click();

  await expect(page).toHaveURL(/\/agents\/[^/?]+$/u, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByText("Just for you")).toBeVisible();
  const own = page.url();

  await page.goto("/agents");
  await expect(
    page
      .getByRole("list", { name: "Your agents" })
      .getByRole("link", { name: new RegExp(name, "u") })
  ).toBeVisible();

  // Nobody else is shown it, the company's admin included.
  const adminPage = await pageOf(admin);
  await adminPage.goto("/agents?tab=organization");
  await expect(adminPage.getByRole("list", { name: "Agents" })).toBeVisible();
  await expect(
    adminPage.getByRole("link", { name: new RegExp(name, "u") })
  ).toHaveCount(0);
  // Its own page is not found for them: it is among no agents they read.
  await adminPage.goto(own);
  await expect(adminPage.getByText("Agent not found")).toBeVisible();
  await expect(adminPage.getByRole("heading", { name })).toHaveCount(0);
});
