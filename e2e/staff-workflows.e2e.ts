import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { STARTING_ORG_RULES } from "@grasp-os/shared/admin/onboarding-admin";
import type { Told } from "@grasp-os/shared/admin/org-record";
import type { StaffWorks } from "@grasp-os/shared/onboarding-staff";
import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { signInStaff, signInTo } from "./people.ts";
import { seededCalls } from "./seeded-calls.ts";

// Grasp's staff see each piece of work as drawn from the interviews
// (GRA-377), end to end: from the area's sidebar to a drawn piece of
// work, with each person's numbers apart and its open questions. The
// local stack can't hold interviews (their links go out by email) or draw
// work (it reaches no model), so core's answers to those two calls are
// seeded on the page's connection, as core's own tests draw them
// (apps/core/test/onboarding-staff-works.test.ts).

const isoAt = (day: string, time = "09:00:00.000Z"): string => `${day}T${time}`;

/** Sales, led by Lisa, with Tom and Ann: Lisa and Tom talked about taking orders, Ann not yet. */
const snapshot: AdminSnapshot = {
  now: isoAt("2026-10-14", "10:05:00.000Z"),
  company: {
    name: "Bakkerij Noord",
    timeZone: "Europe/Amsterdam",
    signInDomains: ["bakkerij.test"],
    signIn: ["microsoft"],
    admins: [],
  },
  contacts: null,
  roster: {
    teams: [{ id: "sales", name: "Sales", lead: "lisa", does: "", off: false }],
    people: [
      { id: "lisa", name: "Lisa de Vries", team: "sales" },
      { id: "tom", name: "Tom Jansen", team: "sales" },
      { id: "ann", name: "Ann Bos", team: "sales" },
    ].map((person) => ({ ...person, email: "", title: "", away: false })),
  },
  plan: { start: "2026-10-05", days: 14 },
  agreements: { processing: true, assessment: true, council: "none" },
  agreed: true,
  paused: false,
  told: true,
  mapped: ["sales"],
  links: [
    { person: "lisa", state: "completed" as const },
    { person: "tom", state: "completed" as const },
    { person: "ann", state: "invited" as const },
  ].map((link) => ({
    ...link,
    sentAt: isoAt("2026-10-05"),
    openedAt: link.state === "invited" ? null : isoAt("2026-10-06"),
    remindedAt: null,
    deletedAt: null,
    failedMail: null,
  })),
  interviews: (["lisa", "tom"] as const).map((person) => ({
    person,
    kind: person === "lisa" ? ("lead" as const) : ("own" as const),
    startedAt: isoAt("2026-10-07"),
    completedAt: isoAt("2026-10-07", "09:30:00.000Z"),
    updatedAt: isoAt("2026-10-07", "09:30:00.000Z"),
    agreed: true,
    phase: "readback" as const,
    stoppedAt: null,
    minutes: 30,
    facts: 8,
    out: 0,
    confirmed: 8,
    rating: 5,
    typed: true,
    interviewer: "stephen" as const,
  })),
  works: { works: [], rules: STARTING_ORG_RULES, counted: [] },
  setup: {
    setup: { languages: [], limits: [], terms: [] },
    changed: false,
    suggested: { languages: [], limits: [], terms: [] },
  },
  kickoff: null,
  gate: {
    open: false,
    closedSince: null,
    threshold: 80,
    known: 40,
    ready: false,
    over: false,
    openedAt: null,
  },
  contract: null,
  members: [],
  integrations: null,
  asked: [],
  usage: [],
};

const told = (numbers: Partial<Told>): Told => ({
  start: true,
  steps: [0, 1],
  end: true,
  way: null,
  waits: [],
  differently: [],
  decides: false,
  own: false,
  ai: false,
  volume: null,
  takes: null,
  wrong: null,
  right: false,
  ask: false,
  next: false,
  example: null,
  term: false,
  out: [],
  ...numbers,
});

/** Taking orders, drawn from what Lisa and Tom agreed to, each with numbers of their own. */
const works: StaffWorks = {
  works: [
    {
      id: "orders",
      team: "sales",
      name: "Taking orders",
      item: ["order", "orders"],
      doers: ["lisa", "tom", "ann"],
      share: 0.6,
      from: "lead",
      stale: false,
      drawn: {
        at: isoAt("2026-10-07", "10:00:00.000Z"),
        from: ["lisa", "tom"],
        starts: "A shop calls with an order.",
        steps: [
          {
            text: "Write the order down in the order sheet.",
            who: "Sales",
            tool: "Excel",
            minutes: [2, 5, 10],
            documented: false,
          },
          {
            text: "Send the order to the bakery.",
            who: "Sales",
            tool: "Email",
            minutes: null,
            documented: false,
          },
        ],
        waits: [],
        differently: [
          {
            when: "the shop is new",
            does: "Ask Finance for a customer number.",
            outOfTen: 1,
            after: 0,
          },
        ],
        decides: "",
        own: "",
        ai: "",
        right: "",
        ask: "",
        next: "",
        term: null,
        differs: null,
        per: "week",
        unit: "minutes",
        told: {
          lisa: told({ volume: [20, 40], volumeOf: "me", takes: [2, 5, 10] }),
          tom: told({ volume: [60, 80], volumeOf: "team", wrong: 2 }),
        },
        open: ["Who takes an order when Sales is out?"],
      },
    },
  ],
  rules: STARTING_ORG_RULES,
  counted: [],
};

test("staff see a drawn piece of work, each person's numbers apart, and its open questions", async ({
  page,
  cspViolations,
}) => {
  const staff = await signInStaff();
  await seededCalls(page, {
    '["onboardingStaff","interviews"]': snapshot,
    '["onboardingStaff","works"]': works,
  });
  await signInTo(page.context(), staff);
  await page.goto("/onboarding");
  await page
    .getByRole("complementary", { name: "Onboarding sections" })
    .getByRole("link", { name: "Workflows" })
    .click();

  await expect(
    page.getByRole("region", { name: "How far the workflows are" })
  ).toContainText("0 of 1 workflows known");
  await page.getByRole("link", { name: "Open Taking orders" }).click();

  // The canvas as it runs today, with the case off the usual way.
  const today = page.getByRole("region", { name: "As it runs today" });
  await expect(
    today.getByRole("list", { name: "The steps" }).getByRole("button")
  ).toHaveText([
    /Write the order down in the order sheet\..*Excel/u,
    /Send the order to the bakery\./u,
  ]);
  await expect(today).toContainText("When the shop is new");
  // What is still missing ends with what the next interviews should ask.
  await expect(
    today.getByRole("list", { name: "Still missing" }).getByRole("listitem")
  ).toContainText([
    /1 person who does it has not talked/u,
    /Who takes an order when Sales is out\?/u,
  ]);

  // Each person's numbers apart, never averaged.
  await expect(
    page.getByRole("table", { name: "Each person's numbers" }).getByRole("row")
  ).toHaveText([
    /Who.*How many.*How long.*Wrong/u,
    /Lisa de Vries.*20 to 40 a week, their own.*5 minutes, 2 to 10.*Not said/u,
    /Tom Jansen.*60 to 80 a week, for the whole team.*Not said.*2 in 10/u,
  ]);
  await expect(
    page.getByText("20 to 60 in a quiet week, 40 to 80 in a busy one.")
  ).toBeVisible();

  // A step opens who told it.
  await today
    .getByRole("button", { name: /Send the order to the bakery/u })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Who told this step" })
  ).toContainText("2 of the 3 needed told it.");
  expect(cspViolations).toStrictEqual([]);
});
