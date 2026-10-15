import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, signInAs, signInStaff, signInTo } from "./people.ts";
import type { Person } from "./people.ts";

// What only Grasp's staff do in a client's onboarding (GRA-320), end to
// end: they put the agreements in place, and the links that waited for
// them go out; they give the go, and the company's people sign in, and
// see the programme's week on the dashboard, from the plan. Its
// own Playwright project, after all the others: taking the go back signs
// out everyone the other tests signed in (playwright.config.ts).

test.describe.configure({ mode: "serial" });

/** Today, as core's plan reads it (UTC). */
const today = (): string => new Date().toISOString().slice(0, 10);

test("staff put the agreements in place, and the links that waited go out", async ({
  page,
  cspViolations,
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

  // The test's own page, whose CSP violations are recorded (e2e/csp.ts).
  await signInTo(page.context(), staff);
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
  expect(cspViolations).toStrictEqual([]);
});

test("staff give the go, and the company's people sign in", async ({
  page,
  cspViolations,
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

  // The test's own page, whose CSP violations are recorded (e2e/csp.ts).
  await signInTo(page.context(), staff);
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
  expect(cspViolations).toStrictEqual([]);
});

test("the dashboard counts the programme's weeks from the plan, and exports its report", async ({
  page,
  cspViolations,
}) => {
  // The plan the first test saved starts today, and Grasp's go is given:
  // any member reads the programme's week and stage (none read it before,
  // e2e/dashboard.e2e.ts, as no plan was saved yet).
  const email = `person.${crypto.randomUUID()}@acme.test`;
  const cookie = await signInAs(email);
  const { core, api } = apiOf({ cookie });
  let member: Person;
  try {
    const { userId, role } = await api.whoami();
    member = { userId, email, role, cookie };
  } finally {
    core[Symbol.dispose]();
  }
  await signInTo(page.context(), member);
  await page.goto("/dashboard");

  await expect(page.getByText("Week 1 of 8 · Under way")).toBeVisible();
  await expect(
    page.getByText(/^Report on week 1 ready in [1-7] days?$/u)
  ).toBeVisible();
  await page.getByRole("button", { name: "Export report" }).click();

  const dialog = page.getByRole("dialog", {
    name: "The report as it stands today",
  });
  const report = dialog.getByRole("article", { name: "Report" });
  await expect(report).toContainText("What ran");
  await expect(report).toContainText(/Made with Grasp on/u);
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download Markdown" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(
    `grasp-report-week-1-${today()}.md`
  );
  await expect(dialog).toBeHidden();
  expect(cspViolations).toStrictEqual([]);
});

test("the company's admin goes through their onboarding: the staff list, the leads and the day the interviews start", async ({
  page,
  cspViolations,
}) => {
  // Last of the serial run: what it keeps replaces the roster and the plan
  // the tests before it read.
  const admin = await signInStaff();
  await signInTo(page.context(), admin);
  // The story on "How this works" is told at once.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/setup?step=welcome");

  await expect(
    page.getByRole("heading", { level: 1, name: /, I’m Stephen$/u })
  ).toBeFocused();
  await page.getByRole("button", { name: "English" }).click();
  await page.getByRole("button", { name: "Let’s start" }).click();

  // The story told at once: the plan, summed up.
  await expect(
    page.getByText(/^Your people, documents and tools first\./u)
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Who works where, from a staff list read in the browser.
  await expect(
    page.getByRole("heading", { name: "Who’s who at your company?" })
  ).toBeVisible();
  const run = crypto.randomUUID().slice(0, 8);
  await page.locator('input[type="file"]').setInputFiles({
    name: "staff.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "Name,Email,Team,Job title,Team lead",
        `Lea Bakker,lea.${run}@acme.test,Sales,Head of sales,yes`,
        `Sam Visser,sam.${run}@acme.test,Sales,Account manager,`,
        `Ona Smit,ona.${run}@acme.test,Ops,Planner,`,
      ].join("\n")
    ),
  });
  await expect(
    page.getByText(
      "Thank you. From your staff list I can see 3 people in 2 teams."
    )
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Where the documents live and Pulse: core keeps nothing of them yet, so both are skipped.
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Do you have anything that explains how you work?",
    })
  ).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(
    page.getByRole("heading", { name: "Which tools do people actually use?" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();

  // The leads as the list said them; Ops gets Ona as its lead.
  await expect(
    page.getByRole("heading", {
      name: "Almost done: is this your organization?",
    })
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Lead of Ops" }).click();
  await page.getByRole("option", { name: "Ona Smit" }).click();
  await page.getByRole("button", { name: "This is right" }).click();
  await expect(
    page.getByText("Thank you. I’ll start with these 2 leads.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // The message to send, and the day the first links go out.
  await expect(
    page.getByRole("heading", {
      name: "Before I reach out, let your team know",
    })
  ).toBeVisible();
  await page.getByRole("button", { name: "The day after" }).click();
  const start = await page.getByLabel("Another day").inputValue();
  await page.getByRole("button", { name: "I sent it" }).click();

  await expect(
    page.getByRole("heading", {
      name: "That’s everything from you. Now I’ll talk to your team.",
    })
  ).toBeVisible();
  await expect(page.getByText(/^Starts /u)).toBeVisible();

  // Core keeps what was set: the leads, and the plan from that day.
  const { core, api } = apiOf(admin);
  try {
    const { roster, plan } = await api.onboarding.view();
    const leadOf = (name: string) =>
      roster?.people.find(
        (person) =>
          person.id === roster.teams.find((team) => team.name === name)?.lead
      )?.name;
    expect([leadOf("Sales"), leadOf("Ops")]).toStrictEqual([
      "Lea Bakker",
      "Ona Smit",
    ]);
    expect(plan?.start).toBe(start);
  } finally {
    core[Symbol.dispose]();
  }
  expect(cspViolations).toStrictEqual([]);
});
