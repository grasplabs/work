import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, signInAs, signInStaff, signInTo } from "./people.ts";

// What only Grasp's staff do in a client's onboarding (GRA-320), end to
// end: they put the agreements in place, and the links that waited for
// them go out; they give the go, and the company's people sign in. Its
// own Playwright project, after all the others: taking the go back signs
// out everyone the other tests signed in (playwright.config.ts).

test.describe.configure({ mode: "serial" });

/** Today, as core's plan reads it (UTC). */
const today = (): string => new Date().toISOString().slice(0, 10);

test("staff put the agreements in place, and the links that waited go out", async ({
  browser,
}) => {
  const staff = await signInStaff();
  // People of their own each attempt: saving them takes the links of
  // the people before them, so the team is not told yet.
  const run = crypto.randomUUID().slice(0, 8);
  const lead = `lea-${run}`;
  const { core, api } = apiOf(staff);
  try {
    await api.onboarding.saveRoster({
      teams: [
        { id: `sales-${run}`, name: "Sales", lead },
        { id: `ops-${run}`, name: "Ops", lead: null },
      ],
      people: [
        { id: lead, name: "Lea", team: `sales-${run}` },
        { id: `sam-${run}`, name: "Sam", team: `sales-${run}` },
        { id: `ona-${run}`, name: "Ona", team: `ops-${run}` },
      ],
    });
    await api.onboarding.savePlan({ start: today() });
    await api.onboardingStaff.setAgreements({
      processing: false,
      assessment: false,
      council: "waiting",
    });
  } finally {
    core[Symbol.dispose]();
  }

  const context = await browser.newContext();
  await signInTo(context, staff);
  const page = await context.newPage();
  await page.goto("/onboarding");
  await page
    .getByRole("complementary", { name: "Onboarding sections" })
    .getByRole("link", { name: "Agreements" })
    .click();
  await expect(
    page.getByText("All three in place, or no link goes out: 3 links wait.")
  ).toBeVisible();

  await page
    .getByRole("switch", { name: "Data processing agreement signed" })
    .click();
  await expect(
    page.getByLabel("Day the data processing agreement was signed")
  ).toHaveValue(/^\d{4}-\d{2}-\d{2}$/u);
  await page
    .getByRole("switch", { name: "Risk assessment signed off" })
    .click();
  await page
    .getByRole("combobox", { name: "Works council" })
    .selectOption({ label: "No works council" });
  await page.getByRole("button", { name: "Save the agreements" }).click();

  // At once: the lead's and Ona's; Sam's waits for Lea.
  await expect(
    page.getByText("All in place: 2 links are out, the rest go by the plan.")
  ).toBeVisible();
  // The team is told: what was agreed stays as it was.
  await expect(
    page.getByRole("switch", { name: "Risk assessment signed off" })
  ).toBeDisabled();

  await page.goto("/onboarding");
  await expect(page.getByText("Links out: 2 of 3")).toBeVisible();
  await context.close();
});

test("staff give the go, and the company's people sign in", async ({
  browser,
}) => {
  const staff = await signInStaff();
  const { core, api } = apiOf(staff);
  try {
    // Grasp gave its go once already: the local stack can't come to know
    // enough of the company for a first one (no model reads its kickoff),
    // so the go given here is the one after it was taken back.
    await api.onboardingGate.close();
    await api.onboardingGate.open();
  } finally {
    core[Symbol.dispose]();
  }

  const context = await browser.newContext();
  await signInTo(context, staff);
  const page = await context.newPage();
  await page.goto("/onboarding/open");
  await page.getByRole("button", { name: "Take the go back" }).click();
  await expect(page.getByText("Grasp's go was taken back")).toBeVisible();

  const waiting = `person.${crypto.randomUUID()}@acme.test`;
  await expect(signInAs(waiting)).rejects.toThrow(/not_open_yet/u);

  await page.getByRole("button", { name: "Give the go again" }).click();
  await expect(page.getByText(/^Open since Grasp's go on/u)).toBeVisible();

  // The same person who was turned away comes in now, as a member.
  const member = await signInAs(waiting);
  const signedIn = apiOf({ cookie: member });
  try {
    const { email, role, staff: isStaff } = await signedIn.api.whoami();
    expect({ email, role, isStaff }).toStrictEqual({
      email: waiting,
      role: "user",
      isStaff: false,
    });
  } finally {
    signedIn.core[Symbol.dispose]();
  }
  await context.close();
});
