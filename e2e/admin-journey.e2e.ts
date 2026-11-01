import { noChoices } from "@grasp-os/shared/onboarding-choices";
import { expect } from "@playwright/test";

import { localAdmin } from "../apps/core/test/sign-in-config.ts";
import { adminCommand, adminSnapshot } from "./admin-steering.ts";
import { test } from "./csp.ts";
import { queuedMail } from "./onboarding-outbox.ts";
import { apiOf, signInAs, signInStaff } from "./people.ts";
import { origin } from "./stack.ts";

// The admin's onboarding, end to end (GRA-339): they sign in, give their
// staff list, confirm the organization as Stephen will interview it, plan
// the day the links go out, and send them on their way. The links due
// then go out by mail, and only those: the leads' at once, nobody's in a
// team that doesn't take part, and no colleague's before their lead has
// talked. A local stack sends no mail anyone receives, so what went out is
// read from the store's outbox (e2e/onboarding-outbox.ts). Its own
// Playwright project, after the onboarding's and the interviews'
// (playwright.config.ts): sending a link tells the team, and nothing
// undoes that.

// Today as the page and core read it alike: core plans in UTC.
test.use({ timezoneId: "UTC" });

/** Today, as core's plan reads it (UTC). */
const today = (): string => new Date().toISOString().slice(0, 10);

const dayMs = 24 * 60 * 60 * 1000;

/** The day `days` from today, as core's plan reads it (UTC). */
const daysFromToday = (days: number): string =>
  new Date(Date.now() + days * dayMs).toISOString().slice(0, 10);

/**
 * What only Grasp's staff do, before the admin starts: the agreements are
 * in place, so links go once they are due. A plan saved by an earlier test
 * is moved to a day still to come, so its alarm sends nothing to the staff
 * list the admin saves before their own plan is made. What earlier tests
 * chose on the admin's steps is cleared, so each step asks again.
 */
const readyForTheAdmin = async (): Promise<void> => {
  const staff = await signInStaff();
  const { core, api } = apiOf(staff);
  try {
    const { roster } = await api.onboarding.view();
    if (roster !== null) {
      await api.onboarding.savePlan({ start: daysFromToday(2) });
    }
    await adminCommand({
      type: "onboarding.agreements",
      payload: {
        agreements: {
          processing: true,
          assessment: true,
          council: "none",
        },
      },
    });
  } finally {
    core[Symbol.dispose]();
  }
  const admin = apiOf({ cookie: await signInAs(localAdmin) });
  try {
    await admin.api.onboarding.saveChoices(noChoices);
  } finally {
    admin.core[Symbol.dispose]();
  }
};

/**
 * The mail queued to addresses ending in `suffix`: its kind, to whom, and
 * whether the link is left to be filled in as it is sent.
 */
const mailTo = async (suffix: string) => {
  const queued = await queuedMail();
  return queued
    .filter(({ to }) => to.endsWith(suffix))
    .map(({ kind, to, text }) => ({
      kind,
      to,
      slot: text.includes("{{link}}"),
    }))
    .toSorted((one, other) => one.to.localeCompare(other.to));
};

test("the admin signs in, gives the staff list, confirms and plans, and the links that are due go out", async ({
  page,
  cspViolations,
}) => {
  await readyForTheAdmin();
  // The story on "How this works" is told at once.
  await page.emulateMedia({ reducedMotion: "reduce" });
  // The voice is ElevenLabs behind the model gateway, which the local
  // stack doesn't reach: Stephen says nothing, and every line still shows.
  await page.route("**/api/speech", async (route) => {
    await route.fulfill({
      status: 503,
      json: { code: "speech.failed", message: "Not here" },
    });
  });

  // Signed out, the onboarding sends them to sign in, and the company's
  // sign-in (the stack's stand-in for Entra) brings them back to it.
  await page.goto("/setup?step=welcome");
  await expect(
    page.getByText("Use your organization’s account to go on.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
  await expect(page.getByLabel("Email")).toHaveValue(localAdmin);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Back from signing in, the onboarding opens where core says they are:
  // a plan an earlier test saved puts that at the end. They start over.
  await page.waitForURL(
    (url) => url.origin === origin && url.pathname === "/setup"
  );
  await page.goto("/setup?step=welcome");
  await expect(
    page.getByRole("heading", { level: 1, name: /, I’m Stephen$/u })
  ).toBeVisible();
  await page.getByRole("button", { name: "English" }).click();
  await page.getByRole("button", { name: "Let’s start" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // The staff list: four people in three teams, Lea leading Sales.
  await expect(
    page.getByRole("heading", { name: "Who’s who at your company?" })
  ).toBeVisible();
  const run = crypto.randomUUID().slice(0, 8);
  const email = (name: string) => `${name}.${run}@acme.test`;
  await page.locator('input[type="file"]').setInputFiles({
    name: "staff.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "Name,Email,Team,Job title,Team lead",
        `Lea Bakker,${email("lea")},Sales,Head of sales,yes`,
        `Sam Visser,${email("sam")},Sales,Account manager,`,
        `Ona Smit,${email("ona")},Ops,Planner,`,
        `Kai de Wit,${email("kai")},Legal,Counsel,`,
      ].join("\n")
    ),
  });
  await expect(
    page.getByText(
      "Thank you. From your staff list I can see 4 people in 3 teams."
    )
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Documents, tools and the HR platform wait for later.
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
  await page
    .getByRole("button", { name: "We don’t use an HR platform" })
    .click();

  // Confirm: Ona leads Ops, and Legal doesn't take part.
  await expect(
    page.getByRole("heading", {
      name: "Almost done: is this your organization?",
    })
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Lead of Ops" }).click();
  await page.getByRole("option", { name: "Ona Smit" }).click();
  await page.getByRole("switch", { name: "Legal takes part" }).click();
  await page.getByRole("button", { name: "This is right" }).click();
  await expect(
    page.getByText("Thank you. I’ll start with these 2 leads.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Plan: the first links go out today, at a moment already past, to
  // every team that takes part. Then launch.
  await expect(
    page.getByRole("heading", {
      name: "Before I reach out, let your team know",
    })
  ).toBeVisible();
  await page.getByLabel("Another day").fill(today());
  await page.getByLabel("at", { exact: true }).fill("00:00");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "What happens next" })
      .getByText(/^Leads get their link on \d+ \w+ at 0:00\./u)
  ).toBeVisible();
  await page.getByRole("button", { name: "I sent it" }).click();
  await expect(
    page.getByRole("heading", {
      name: "That’s everything from you. Now I’ll talk to your team.",
    })
  ).toBeVisible();

  // What went out: a link to each lead, once, with the link itself left
  // to be filled in as it is sent. Nothing to Sam, who waits for Lea, nor
  // to Kai, whose team doesn't take part.
  const ours = async () => await mailTo(`.${run}@acme.test`);
  await expect.poll(ours, { timeout: 30_000 }).toStrictEqual([
    { kind: "link", to: email("lea"), slot: true },
    { kind: "link", to: email("ona"), slot: true },
  ]);

  // The admin's own view of it: two links out, the rest by the plan.
  const staff = await signInStaff();
  const { core, api } = apiOf(staff);
  try {
    const { roster } = await api.onboarding.view();
    const { links } = await adminSnapshot();
    const out = new Set(
      links.filter(({ sentAt }) => sentAt !== null).map(({ person }) => person)
    );
    expect(
      roster?.people
        .map(({ name, id }) => ({ name, out: out.has(id) }))
        .toSorted((one, other) => one.name.localeCompare(other.name))
    ).toStrictEqual([
      { name: "Kai de Wit", out: false },
      { name: "Lea Bakker", out: true },
      { name: "Ona Smit", out: true },
      { name: "Sam Visser", out: false },
    ]);
  } finally {
    core[Symbol.dispose]();
  }
  // Launched once: the outbox holds each link once, after a while too.
  expect(await ours()).toHaveLength(2);
  expect(cspViolations).toStrictEqual([]);
});
