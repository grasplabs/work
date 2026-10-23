import { readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import { expect } from "@playwright/test";
import type { Request } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn, signInAs, signInStaff, signInTo } from "./people.ts";
import type { Person } from "./people.ts";
import { origin, stateDir } from "./stack.ts";
import { workbookOf } from "./staff-workbook.ts";

// What only Grasp's staff do in a client's onboarding (GRA-320), end to
// end: they put the agreements in place, and the links that waited for
// them go out; they give the go, and the company's people sign in, and
// see the programme's week on the dashboard, from the plan. Its
// own Playwright project, after all the others: taking the go back signs
// out everyone the other tests signed in (playwright.config.ts). The
// admin's own steps come last, as each replaces the deployment's roster:
// their journey through the wizard, a large staff list from Excel, and
// last, with interviews seeded, what they see while Stephen talks to the
// team.

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

/** What someone said in their interview, with what Stephen marked in it. */
const said = "Every morning I open the invoices in Exact first.";

/** Lea's interview, finished and agreed to, as her page keeps it. */
const leasInterview = (): InterviewProgress => ({
  person: "completed",
  told: true,
  mode: "type",
  lines: [
    { from: "stephen", text: "What do you do first in the morning?" },
    {
      from: "person",
      text: said,
      typed: true,
      marks: [{ quote: "open the invoices in Exact", tag: "system" }],
    },
  ],
  facts: [
    {
      id: "f1",
      tag: "system",
      text: "You open the invoices in Exact first.",
      record: "Open the invoices in Exact first.",
      agreed: true,
    },
  ],
  phase: "readback",
  wants: "end",
  startedAt: Date.now() - 20 * 60 * 1000,
  confirmed: 1,
  adding: false,
  addedAt: 0,
  rating: 5,
  interviewer: "claire",
});

/** One call of the interview page to core. */
const interviewCall = async (body: object): Promise<unknown> => {
  const response = await fetch(new URL(interviewApiPath, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return await response.json();
};

/** Keeps `progress` on a person's link, from a device that opens it as their page does. */
const interviewOn = async (
  path: string,
  progress: InterviewProgress
): Promise<void> => {
  const secret = path.split("#")[1] ?? "";
  const session = await interviewCall({ action: "session", secret });
  const key =
    typeof session === "object" &&
    session !== null &&
    "key" in session &&
    typeof session.key === "string"
      ? session.key
      : "";
  await interviewCall({ action: "save", secret, key, version: 0, progress });
};

test("staff open someone's transcript, and the audit log has the read; the company's admin reaches none of it", async ({
  page,
  cspViolations,
}) => {
  const staff = await signInStaff();
  const { admin } = peopleIn("staffInterviews");
  const since = new Date().toISOString();
  // Lea, the lead whose link the test before sent out, talks with Claire.
  const { core, api } = apiOf(staff);
  let lea = "";
  try {
    const { roster, links } = await api.onboardingStaff.interviews();
    lea =
      roster?.people.find(
        (person) =>
          person.name === "Lea" &&
          links.some(
            (link) => link.person === person.id && link.sentAt !== null
          )
      )?.id ?? "";
    await interviewOn(await api.onboardingStaff.link(lea), leasInterview());
  } finally {
    core[Symbol.dispose]();
  }

  await signInTo(page.context(), staff);
  await page.goto("/onboarding");
  await page
    .getByRole("complementary", { name: "Onboarding sections" })
    .getByRole("link", { name: "Interviews" })
    .click();
  await expect(
    page.getByRole("list", { name: "How far everyone has come" })
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Interviews" })
    .getByRole("link", { name: "Transcripts" })
    .click();
  await page.getByRole("link", { name: "Read the transcript of Lea" }).click();

  const conversation = page.getByRole("region", { name: "The conversation" });
  await expect(conversation).toContainText(said);
  // What Claire wrote down is marked where Lea said it, and kept as the record has it.
  await expect(conversation.locator("mark")).toHaveText(
    "open the invoices in Exact"
  );
  await expect(
    page.getByRole("region", { name: "What Claire wrote down" })
  ).toContainText("Open the invoices in Exact first.");

  // The read is in the audit log, by the staff member, once the log has
  // taken it from core's outbox.
  const reader = apiOf(staff);
  try {
    await expect
      .poll(async () => {
        const { records } = await reader.api.audit.search({
          action: "onboarding.transcript.read",
          from: since,
        });
        return records.map(({ event }) => [
          event?.actor.type,
          event?.target?.type,
        ]);
      })
      .toStrictEqual([["staff", "interview"]]);
  } finally {
    reader.core[Symbol.dispose]();
  }

  // The company's admin: the area takes them home, and core refuses them.
  await page.context().clearCookies();
  await signInTo(page.context(), admin);
  await page.goto(`/onboarding/interviews/${lea}`);
  await expect(page).not.toHaveURL(/\/onboarding/u);
  await expect(page.getByText(said)).toHaveCount(0);
  const company = apiOf(admin);
  try {
    const refused = await Promise.all(
      [
        company.api.onboardingStaff.interviews(),
        company.api.onboardingStaff.transcript(lea),
        company.api.onboardingStaff.link(lea),
      ].map(async (call) => {
        try {
          await call;
          return "answered";
        } catch (error) {
          return error instanceof Error && "code" in error
            ? String(error.code)
            : "failed";
        }
      })
    );
    expect(refused).toStrictEqual([
      "onboarding.staff_only",
      "onboarding.staff_only",
      "onboarding.staff_only",
    ]);
  } finally {
    company.core[Symbol.dispose]();
  }
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
    page.getByText(/^Your next report is ready (?:tomorrow|in [2-7] days)$/u)
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

/** What a line asked of the voice says, and in what tone. */
const lineOf = (request: Request): { text: string; tone: unknown } => {
  const body: unknown = request.postDataJSON();
  return typeof body === "object" &&
    body !== null &&
    "text" in body &&
    typeof body.text === "string"
    ? { text: body.text, tone: "tone" in body ? body.tone : undefined }
    : { text: "", tone: undefined };
};

test("the company's admin goes through their onboarding: the staff list, the organization as Stephen will interview it, the plan and letting Grasp's mail through", async ({
  page,
  cspViolations,
}) => {
  // Late in the serial run: what it keeps replaces the roster and the plan
  // the tests before it read.
  const admin = await signInStaff();
  await signInTo(page.context(), admin);
  // The story on "How this works" is told at once.
  await page.emulateMedia({ reducedMotion: "reduce" });
  // The voice isn't reached from the local stack: what the page asks of it is kept, and it says nothing.
  const asked: { text: string; tone: unknown }[] = [];
  await page.route("**/api/speech", async (route) => {
    asked.push(lineOf(route.request()));
    await route.fulfill({
      status: 503,
      json: { code: "speech.failed", message: "Not here" },
    });
  });
  const toneOf = (text: string) =>
    asked.find((line) => line.text === text)?.tone;
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
        `Kai de Wit,kai.${run}@acme.test,Legal,Counsel,`,
      ].join("\n")
    ),
  });
  await expect(
    page.getByText(
      "Thank you. From your staff list I can see 4 people in 3 teams."
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

  // The leads as the list said them; Ops gets Ona as its lead, and Legal does not take part.
  await expect(
    page.getByRole("heading", {
      name: "Almost done: is this your organization?",
    })
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Lead of Ops" }).click();
  await page.getByRole("option", { name: "Ona Smit" }).click();
  await page.getByRole("switch", { name: "Legal takes part" }).click();
  await expect(
    page.getByRole("combobox", { name: "Lead of Legal" })
  ).toBeDisabled();
  await page.getByRole("button", { name: "This is right" }).click();
  const thanks = "Thank you. I’ll start with these 2 leads.";
  await expect(page.getByText(thanks)).toBeVisible();
  // Said on its own, warmly.
  await expect.poll(() => toneOf(thanks)).toBe("warm");
  await page.getByRole("button", { name: "Continue" }).click();

  // The message to send, the day the first links go out, and Ops later.
  await expect(
    page.getByRole("heading", {
      name: "Before I reach out, let your team know",
    })
  ).toBeVisible();
  await page.getByRole("button", { name: "The day after" }).click();
  const start = await page.getByLabel("Another day").inputValue();
  // Only the teams that take part are there to hold back.
  await expect(page.getByRole("checkbox", { name: /^Legal/u })).toHaveCount(0);
  await page.getByRole("checkbox", { name: /^Ops/u }).click();
  await page.getByRole("button", { name: "On a later day" }).click();
  const later = await page
    .getByLabel("The day the other teams get their links")
    .inputValue();
  const next = page
    .getByRole("alert")
    .filter({ hasText: "What happens next" })
    .getByText(/^The lead of 1 team gets their link /u);
  await expect(next).toBeVisible();
  // Stephen says what happens next, as the plan has it now.
  const nextLine = await next.textContent();
  await expect.poll(() => toneOf(nextLine ?? "")).toBe("sincere, steady");
  await page.getByRole("button", { name: "I sent it" }).click();

  await expect(
    page.getByRole("heading", {
      name: "That’s everything from you. Now I’ll talk to your team.",
    })
  ).toBeVisible();
  await expect(page.getByText(/^Starts /u)).toBeVisible();

  // Before the links go out: let Grasp's mail through the mail filter,
  // its sending domain named, with the steps for either suite.
  await expect(page.getByText("Let Grasp’s mail through")).toBeVisible();
  await expect(page.getByText("mail.localhost", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Google Workspace" }).click();
  await expect(
    page.getByText(
      "Under Spam, bypass spam filters for an approved senders list, and add mail.localhost to it."
    )
  ).toBeVisible();
  await page.getByRole("button", { name: "It’s done" }).click();
  await expect(page.getByText("Settled: It’s done")).toBeVisible();
  // Done, it no longer asks, and nothing needs the admin.
  await page.reload();
  await expect(page.getByText(/^Starts /u)).toBeVisible();
  await expect(page.getByText("Let Grasp’s mail through")).toBeHidden();
  await page.goto("/setup?step=review");
  await expect(
    page.getByRole("heading", { name: "Nothing needs you" })
  ).toBeVisible();

  // Core keeps what was set: the leads, Legal off, the plan from that day
  // with Ops on its own later day, and links for the three who take part.
  const { core, api } = apiOf(admin);
  try {
    const { roster, plan } = await api.onboarding.view();
    const teamOf = (name: string) =>
      roster?.teams.find((team) => team.name === name);
    const leadOf = (name: string) =>
      roster?.people.find((person) => person.id === teamOf(name)?.lead)?.name;
    const ops = teamOf("Ops")?.id ?? "";
    const opsAt = plan?.later?.[ops];
    const { waiting } = await api.onboardingStaff.agreements();
    expect({
      leads: [leadOf("Sales"), leadOf("Ops")],
      off: roster?.teams.filter((team) => team.off).map(({ name }) => name),
      start: plan?.start,
      held: Object.keys(plan?.later ?? {}),
      // Its own moment, on the later day, after the first links.
      opsLater:
        later > start &&
        typeof opsAt === "string" &&
        plan?.at !== undefined &&
        opsAt > plan.at,
      waiting,
    }).toStrictEqual({
      leads: ["Lea Bakker", "Ona Smit"],
      off: ["Legal"],
      start,
      held: [ops],
      opsLater: true,
      waiting: 3,
    });
  } finally {
    core[Symbol.dispose]();
  }
  expect(cspViolations).toStrictEqual([]);
});

/** The teams of a staff list of a company that size. */
const nineTeams = [
  "Sales",
  "Customer service",
  "Planning",
  "Field service",
  "Warehouse",
  "Finance",
  "HR",
  "IT",
  "Marketing",
];

test("a staff list of 170 people in 9 teams, from Excel, is kept; the same list again changes nothing", async ({
  page,
  cspViolations,
}) => {
  // After the journey above: its list of four is there as the step arrives.
  const admin = await signInStaff();
  await signInTo(page.context(), admin);
  // The voice isn't reached from the local stack: what the page asks of it is kept, and it says nothing.
  const asked: { text: string; tone: unknown }[] = [];
  await page.route("**/api/speech", async (route) => {
    asked.push(lineOf(route.request()));
    await route.fulfill({
      status: 503,
      json: { code: "speech.failed", message: "Not here" },
    });
  });
  const run = crypto.randomUUID().slice(0, 8);
  const rows = Array.from({ length: 170 }, (_, at) => {
    const team = nineTeams[at % nineTeams.length] ?? "Sales";
    return [
      `Person ${at + 1}`,
      `person${at + 1}.${run}@acme.test`,
      team,
      at < nineTeams.length ? `Head of ${team}` : "Employee",
      at < nineTeams.length ? "yes" : "",
    ];
  });
  const list = {
    name: "staff.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbookOf([
      ["Name", "Email", "Team", "Job title", "Team lead"],
      ...rows,
    ]),
  };
  const counted =
    "Thank you. From your staff list I can see 170 people in 9 teams.";
  const saidAlone = () =>
    asked.filter((line) => line.text === counted).map(({ tone }) => tone);

  await page.goto("/setup?step=company");
  await expect(
    page.getByRole("heading", { name: "Who’s who at your company?" })
  ).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(list);
  await expect(page.getByText(counted)).toBeVisible();
  // Read on this visit, Stephen says so on its own, plainly.
  await expect.poll(saidAlone).toStrictEqual(["clear, measured pace"]);

  const { core, api } = apiOf(admin);
  try {
    const { roster: kept } = await api.onboarding.view();
    expect({
      people: kept?.people.length,
      teams: kept?.teams.map(({ name }) => name).toSorted(),
      led: kept?.teams.every(({ lead }) => lead !== null),
    }).toStrictEqual({
      people: 170,
      teams: nineTeams.toSorted(),
      led: true,
    });

    // The same list again, on another visit: said again once read, and nothing changes.
    await page.reload();
    await expect(page.getByText(counted)).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(list);
    await expect.poll(() => saidAlone().length).toBe(2);
    const again = await api.onboarding.view();
    expect(again.roster).toStrictEqual(kept);
  } finally {
    core[Symbol.dispose]();
  }
  expect(cspViolations).toStrictEqual([]);
});

/** The day `days` from today (UTC), as `YYYY-MM-DD`. */
const dayFrom = (days: number): string =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Writes the onboarding's state straight into its object's local SQLite,
 * as the seed does (scripts/seed/local.ts): what no API can backdate, the
 * interviews of days before today, which the admin's numbers move by.
 */
const onboardingSql = (write: (db: DatabaseSync) => void): void => {
  const dir = path.join(stateDir, "v3/do/grasp-os-core-Onboarding");
  const file = readdirSync(dir).find((name) => name.endsWith(".sqlite"));
  if (file === undefined) {
    throw new Error(`No Onboarding object under ${dir}`);
  }
  const db = new DatabaseSync(path.join(dir, file));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    write(db);
  } finally {
    db.close();
  }
};

test("while Stephen talks to the team, the admin sees the numbers, no team under five, the quiet team, and the links to send", async ({
  page,
  cspViolations,
}) => {
  // Last in the serial run: it replaces the roster, and moves the plan back.
  const admin = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const sales = `sales-${run}`;
  const service = `service-${run}`;
  const ops = `ops-${run}`;
  const member = (id: string, name: string, team: string) => ({
    id: `${id}-${run}`,
    name,
    team,
  });
  const { core, api } = apiOf(admin);
  try {
    await api.onboarding.saveRoster({
      teams: [
        { id: sales, name: "Sales", lead: `lea-${run}` },
        { id: service, name: "Service", lead: `lisa-${run}` },
        { id: ops, name: "Ops", lead: `ona-${run}` },
      ],
      people: [
        member("lea", "Lea Bakker", sales),
        ...["Sam", "Sid", "Sue", "Sy", "Saar", "Sem"].map((name) =>
          member(name.toLowerCase(), name, sales)
        ),
        member("lisa", "Lisa de Vries", service),
        ...["Vic", "Vera", "Vos", "Vin", "Val"].map((name) =>
          member(name.toLowerCase(), name, service)
        ),
        // A team of four: it shows only whether its lead talked.
        member("ona", "Ona Smit", ops),
        ...["Oli", "Oz", "Otto"].map((name) =>
          member(name.toLowerCase(), name, ops)
        ),
      ],
    });
    await api.onboarding.savePlan({ start: today() });
    await api.onboardingStaff.setAgreements({
      processing: true,
      assessment: true,
      council: "none",
    });
  } finally {
    core[Symbol.dispose]();
  }
  // Seeded interviews: the plan began six days ago, and by yesterday Sales
  // had heard from five of its six, Service from none of its five, and
  // Ops from its three; Lea and Ona talked, Lisa didn't.
  const yesterday = dayFrom(-1);
  onboardingSql((db) => {
    db.prepare("UPDATE onboarding SET plan = ? WHERE id = 1").run(
      JSON.stringify({ start: dayFrom(-6), days: 14 })
    );
    const count = db.prepare(
      "INSERT OR REPLACE INTO team_counts (team, day, asked, talked) VALUES (?, ?, ?, ?)"
    );
    count.run(sales, yesterday, 6, 5);
    count.run(service, yesterday, 5, 0);
    count.run(ops, yesterday, 3, 3);
    const talked = db.prepare(
      "INSERT OR REPLACE INTO interview_states (person, kind, lead_of, started_at, completed_at, updated_at) VALUES (?, 'lead', ?, ?, ?, ?)"
    );
    const at = `${yesterday}T10:00:00.000Z`;
    // Each as the lead of the team they led when their link went out.
    for (const [lead, team] of [
      [`lea-${run}`, sales],
      [`ona-${run}`, ops],
    ]) {
      talked.run(lead, team, at, at, at);
    }
  });

  await signInTo(page.context(), admin);
  await page.emulateMedia({ reducedMotion: "reduce" });
  // The voice isn't reached from the local stack: it says nothing.
  await page.route("**/api/speech", async (route) => {
    await route.fulfill({
      status: 503,
      json: { code: "speech.failed", message: "Not here" },
    });
  });
  await page.goto("/setup?step=listening");
  await expect(page.getByText("Day 7 of 14")).toBeVisible();
  const figure = (label: string) =>
    page.locator("div.rounded-xl").filter({ hasText: label });
  await expect(figure("team leads talked")).toContainText("2 of 3");
  await expect(figure("colleagues talked")).toContainText("5");
  await expect(
    page.getByText(
      "Service has been quiet so far. A short message from Lisa, their lead, usually helps. I’ll remind everyone once myself."
    )
  ).toBeVisible();

  // Team by team: numbers for Sales, too few for Service, none for Ops.
  await page.getByRole("button", { name: "By team" }).click();
  const panel = page.getByRole("dialog");
  await expect(panel).toContainText(/Sales\D*5 of 6/u);
  await expect(panel).toContainText("ServiceLead not yetFewer than 3 of 5");
  await expect(panel).toContainText("OpsLead talkedUnder 5");
  await page.keyboard.press("Escape");

  // Everyone's link is out by now: Lea's and the others' after three working days.
  await page.reload();
  const links = page.getByRole("button", { name: /^\d+ new links to send$/u });
  await expect(links).toBeVisible();
  await links.click();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: /^The \d+ new links, as a list$/u })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("grasp-links.csv");
  // Taken: none are new any more.
  await expect(
    page.getByRole("button", { name: "Links to send" })
  ).toBeVisible();

  // The same, under Settings, Onboarding.
  await page.goto("/settings/onboarding");
  await expect(page.getByText("Day 7 of 14")).toBeVisible();
  await expect(
    page.getByText(/^Service has been quiet so far\./u)
  ).toBeVisible();
  expect(cspViolations).toStrictEqual([]);
});
