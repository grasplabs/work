import { flowSteps } from "@grasp-os/shared/onboarding-flow";
import type {
  FlowStep,
  OnboardingFlow,
} from "@grasp-os/shared/onboarding-flow";
import { expect } from "@playwright/test";

import { adminCommand, adminSnapshot } from "./admin-steering.ts";
import { test } from "./csp.ts";
import { apiOf, signInAs, signInConfiguredAdmin, signInTo } from "./people.ts";
import { installReadingClock, lineOf } from "./speech.ts";
import { workbookOf } from "./staff-workbook.ts";

// A company's own onboarding flow, and Grasp's go as its admin waits
// for it, end to end: a flow of the AI step alone, none at all, and a
// shorter one; a staff list of 170 people from Excel on who's who; and
// the admin settling what needs them before the go lets them in. Each
// closes the deployment, changes its flow or replaces its roster, which
// signs out, turns away or changes what everyone else on the stack sees
// (the organization bar of e2e/setup-voice.e2e.ts counts the roster's
// leads), so they run in a project of their own, one test at a time
// (playwright.config.ts). They need nothing of the onboarding's other
// tests (e2e/onboarding.e2e.ts), so in CI they run on a stack of their own
// beside them; locally, before them, while nobody on the team is told yet.

test.describe.configure({ mode: "serial" });

/** A flow with only the steps in `on`, and nothing of Grasp's before them. */
const flowWithOnly = (on: readonly FlowStep[]): OnboardingFlow => ({
  on: true,
  steps: flowSteps.map((id) => ({ id, on: on.includes(id) })),
  grasp: {
    kickoff: false,
    agreements: { processing: false, assessment: false, council: false },
  },
});

test("an admin whose company's flow is the AI step alone makes that one choice and is in, and so is the company", async ({
  page,
}) => {
  const admin = await signInConfiguredAdmin();
  await adminCommand({ type: "onboarding.gate.close", payload: {} });
  await adminCommand({
    type: "onboarding.flow",
    payload: { flow: flowWithOnly(["ai"]) },
  });
  try {
    // Nobody is interviewed, but its admin hasn't finished: still closed.
    const waiting = `person.${crypto.randomUUID()}@acme.test`;
    await expect(signInAs(waiting)).rejects.toThrow(/not_open_yet/u);

    await signInTo(page.context(), admin);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/setup");
    await expect(
      page.getByRole("heading", { name: "Which AI should I think with?" })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Step \d+$/u })).toHaveCount(
      1
    );
    await page.getByRole("button", { name: "Continue" }).click();

    // The last screen of its flow: the admin is in the platform, and it opened.
    await page.waitForURL((url) => url.pathname === "/");
    await expect
      .poll(async () => {
        const { gate } = await adminSnapshot();
        return gate.open;
      })
      .toBe(true);
    await expect(signInAs(waiting)).resolves.toBeTruthy();
  } finally {
    // All of it again, and open, for the tests after this one.
    await adminCommand({ type: "onboarding.flow", payload: { flow: null } });
    await adminCommand({ type: "onboarding.gate.open", payload: {} });
  }
});

test("a company that goes through no onboarding is open at once, and its admin is never sent to one", async ({
  page,
}) => {
  const admin = await signInConfiguredAdmin();
  await adminCommand({ type: "onboarding.gate.close", payload: {} });
  await adminCommand({
    type: "onboarding.flow",
    payload: { flow: { ...flowWithOnly([]), on: false } },
  });
  try {
    const opened = await adminSnapshot();
    expect(opened.gate.open).toBe(true);
    const member = `person.${crypto.randomUUID()}@acme.test`;
    await expect(signInAs(member)).resolves.toBeTruthy();

    // Signed in, the admin stays home; asked for by its address, the onboarding sends them there.
    await signInTo(page.context(), admin);
    await page.goto("/");
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await page.goto("/setup");
    await page.waitForURL((url) => url.pathname === "/");
    await expect(
      page.getByRole("heading", { name: "Which AI should I think with?" })
    ).toHaveCount(0);
  } finally {
    await adminCommand({ type: "onboarding.flow", payload: { flow: null } });
    await adminCommand({ type: "onboarding.gate.open", payload: {} });
  }
});

test("an admin whose company has a shorter flow gets only its screens, in its order", async ({
  page,
}) => {
  const admin = await signInConfiguredAdmin();
  // No story, nowhere the documents live, no documents and no tools: the
  // leads and the interviews stay.
  await adminCommand({
    type: "onboarding.flow",
    payload: {
      flow: {
        on: true,
        steps: [
          { id: "welcome", on: true },
          { id: "ai", on: true },
          { id: "about", on: false },
          { id: "company", on: true },
          { id: "sources", on: false },
          { id: "documents", on: false },
          { id: "pulse", on: false },
          { id: "leads", on: true },
          { id: "interviews", on: true },
        ],
        grasp: {
          kickoff: true,
          agreements: { processing: true, assessment: true, council: true },
        },
      },
    },
  });
  try {
    await signInTo(page.context(), admin);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/speech", async (route) => {
      await route.fulfill({
        status: 503,
        json: { code: "speech.failed", message: "Not here" },
      });
    });
    await installReadingClock(page);
    await page.goto("/setup?step=welcome");
    await page.getByRole("button", { name: "English" }).click();
    await page.getByRole("button", { name: "Let’s start" }).click();
    await expect(
      page.getByRole("heading", { name: "Which AI should I think with?" })
    ).toBeVisible();
    // Five dots: the welcome, the AI, who's who, the team leads and telling the team.
    await expect(page.getByRole("button", { name: /^Step \d+$/u })).toHaveCount(
      5
    );
    await page.getByRole("button", { name: "Continue" }).click();

    // Straight to who's who: this company's flow has no "How this works".
    await expect(
      page.getByRole("heading", { name: "Who’s who at your company?" })
    ).toBeVisible();
    // A screen its flow doesn't have isn't reached by its address either.
    await page.goto("/setup?step=documents");
    await expect(
      page.getByRole("heading", {
        name: "Do you have anything that explains how you work?",
      })
    ).toHaveCount(0);
  } finally {
    // All of it again, for the tests after this one.
    await adminCommand({ type: "onboarding.flow", payload: { flow: null } });
  }
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
  const admin = await signInConfiguredAdmin();
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

/** A call the page makes to core, as Cap'n Web writes it: its pushes are numbered from 1. */
const makesCall = /^\["(?:push|stream)",/u;

/** The way the admin settled the difference, in a call to settle it. */
const settleChoice = /"tickets","(?<holds>both|first|other)"/u;

/** A message on the page's connection, as its fields. */
const fieldsOf = (message: string | Buffer): unknown[] => {
  const parsed: unknown = JSON.parse(String(message));
  if (!Array.isArray(parsed)) {
    return [];
  }
  const fields: unknown[] = parsed;
  return fields;
};

/** A piece of work told two ways that nobody could explain, as core would draw it. */
const ticketsDifference = {
  work: "tickets",
  name: "nieuwe tickets afhandelen",
  team: "Ops",
  way: "Look up the customer in the client sheet.",
  other: "Look up the customer in Salesforce.",
};

test("the admin settles what needs them, and once Grasp gives its go, goes in through the way in", async ({
  page,
  cspViolations,
}) => {
  const admin = await signInConfiguredAdmin();
  // Waiting for Grasp's go.
  await adminCommand({ type: "onboarding.gate.close", payload: {} });

  // The local stack reaches no model, so it draws no work: core's answer
  // to what needs the admin is given a difference as the drawing leaves
  // one, and the admin's settling of it answered as core keeps it
  // (apps/core/test/onboarding-review.test.ts settles a drawn one).
  let holds: string | null = null;
  const settled: string[] = [];
  const review = () => ({
    differences: [[{ ...ticketsDifference, holds }]],
    mapped: 3,
  });
  await page.routeWebSocket("**/rpc", (socket) => {
    const server = socket.connectToServer();
    let calls = 0;
    const reviews = new Set<number>();
    const settles = new Set<number>();
    socket.onMessage((message) => {
      const text = String(message);
      if (makesCall.test(text)) {
        calls += 1;
        if (text.includes('"onboarding","review"')) {
          reviews.add(calls);
        }
        const choice = text.includes('"onboarding","settle"')
          ? settleChoice.exec(text)?.groups?.holds
          : undefined;
        if (choice !== undefined) {
          settles.add(calls);
          settled.push(choice);
          holds = choice;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const [kind, id] = fieldsOf(message);
      const answers = kind === "resolve" || kind === "reject";
      if (
        answers &&
        typeof id === "number" &&
        (reviews.has(id) || settles.has(id))
      ) {
        socket.send(JSON.stringify(["resolve", id, review()]));
        return;
      }
      socket.send(message);
    });
  });
  await signInTo(page.context(), admin);
  await page.goto("/setup?step=review");

  // The difference, and letting Grasp's mail through, which this new
  // browser hasn't settled.
  await expect(
    page.getByRole("heading", { name: "2 things for you" })
  ).toBeVisible();
  const needs = page.getByRole("region", { name: "What needs you" });
  await expect(
    needs.getByText("People do “nieuwe tickets afhandelen” in two ways")
  ).toBeVisible();
  // The two ways side by side, never who told which.
  await expect(
    needs.getByText("Look up the customer in Salesforce.")
  ).toBeVisible();
  await needs.getByRole("button", { name: "Keep both" }).click();
  await expect(needs.getByText("Settled: Keep both")).toBeVisible();
  expect(settled).toStrictEqual(["both"]);
  await needs.getByRole("button", { name: "It’s done" }).click();
  await expect(
    page.getByRole("heading", { name: "Nothing needs you" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Stephen's thanks, and until Grasp's go, that it opens once checked.
  await expect(
    page.getByRole("heading", { name: /^Thank you, /u })
  ).toBeVisible();
  await expect(
    page.getByText(/3 pieces of work are mapped and ready for you\.$/u)
  ).toBeVisible();
  await expect(
    page.getByText(
      "We open your platform once we’ve checked everything with you. You’ll hear from us."
    )
  ).toBeVisible();

  await adminCommand({ type: "onboarding.gate.open", payload: {} });
  // The page asks again on its own, and the way in begins: the brain's
  // dots build the dashboard, then let it be.
  await expect(page.getByText("Your platform is open.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page).toHaveURL(/\/dashboard$/u, { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Workflows" })).toBeVisible();
  await expect(page.getByText("Opening Grasp")).toHaveCount(0, {
    timeout: 15_000,
  });
  expect(cspViolations).toStrictEqual([]);
});
