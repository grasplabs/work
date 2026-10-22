import type {
  StaffAiUseRow,
  StaffInterviewer,
  StaffInterviewers,
} from "@grasp-os/shared/onboarding-staff";
import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { signInStaff, signInTo } from "./people.ts";
import { seededCalls } from "./seeded-calls.ts";

// Grasp's staff see how Stephen and Claire are doing in the onboarding,
// and the AI it used (GRA-324), end to end: from the area's sidebar to
// the ratings, where people stop, and the use by purpose. The local stack
// can't hold interviews (their links go out by email) or AI use (it
// reaches no model), so core's answers to those two calls are seeded on
// the page's connection, as core's own tests count them
// (apps/core/test/staff-interviewers.test.ts).

const stops = (steps: number, story: number): StaffInterviewer["stops"] => ({
  open: 0,
  you: 0,
  anchor: 0,
  story,
  steps,
  exceptions: 0,
  numbers: 0,
  result: 0,
  readback: 0,
});

const lengths = (counts: number[]): StaffInterviewer["lengths"] =>
  [10, 15, 20, 30, null].map((upTo, index) => ({
    upTo,
    count: counts[index] ?? 0,
  }));

const interviewers: StaffInterviewers = {
  interviewers: [
    {
      interviewer: "stephen",
      started: 6,
      finished: 4,
      stopped: 2,
      stops: stops(2, 0),
      rating: { count: 4, average: 4.25, by: [0, 0, 1, 1, 2] },
      minutes: { lead: 24, own: 13 },
      lengths: lengths([1, 2, 1, 0, 0]),
      leftIn: 0.8,
      byVoice: 0.75,
      texts: [
        {
          mark: "a".repeat(64),
          kind: "own",
          locale: "nl",
          started: 5,
          finished: 3,
          rating: { count: 3, average: 4, by: [0, 0, 1, 1, 1] },
        },
        {
          mark: null,
          kind: "lead",
          locale: null,
          started: 1,
          finished: 1,
          rating: { count: 1, average: 5, by: [0, 0, 0, 0, 1] },
        },
      ],
    },
    {
      interviewer: "claire",
      started: 2,
      finished: 1,
      stopped: 1,
      stops: stops(0, 1),
      rating: { count: 1, average: 3, by: [0, 0, 1, 0, 0] },
      minutes: { lead: null, own: 11 },
      lengths: lengths([0, 1, 0, 0, 0]),
      leftIn: 1,
      byVoice: 0,
      texts: [],
    },
  ],
  answers: [{ day: "2026-10-20", answers: 42, middle: 1200, slow: 2600 }],
};

const used = (
  purpose: StaffAiUseRow["purpose"],
  model: string,
  calls: number,
  seconds = 0
): StaffAiUseRow => ({
  day: "2026-10-20",
  purpose,
  model,
  calls,
  tokensIn: calls * 8000,
  tokensCached: calls * 6000,
  tokensOut: calls * 150,
  seconds,
});

const aiUse: StaffAiUseRow[] = [
  used("reading", "anthropic/claude-opus-4-8", 3),
  used("interviews", "anthropic/claude-sonnet-4-5", 120),
  used("interviews", "voice", 60, 1800),
];

test("staff see how Stephen and Claire are doing, and the onboarding's AI use", async ({
  page,
  cspViolations,
}) => {
  const staff = await signInStaff();
  await seededCalls(page, {
    '["onboardingStaff","interviewers"]': interviewers,
    '["onboardingStaff","aiUse"]': aiUse,
  });
  await signInTo(page.context(), staff);
  await page.goto("/onboarding");
  const sections = page.getByRole("complementary", {
    name: "Onboarding sections",
  });

  await sections.getByRole("link", { name: "Interviewers" }).click();
  await expect(page.getByRole("list", { name: "Who people chose" })).toHaveText(
    /Stephen\D*6.*4\.3 of 5.*Claire\D*2.*3\.0 of 5/u
  );
  // Stephen first: what people thought of him, and where they stop.
  await expect(page.getByText("4 of 4 said how it was")).toBeVisible();
  await expect(page.getByText("4.3 of 5").first()).toBeVisible();
  await expect(
    page.getByText("2 interviews stopped halfway and were not picked up again.")
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Where people stop" }).getByRole("listitem")
  ).toContainText([/You and AI\D*0$/u, /Step by step\D*2$/u]);
  await expect(
    page.getByRole("table", { name: "The text each interview ran on" })
  ).toContainText("aaaaaaaaaaaa");
  await expect(
    page.getByRole("table", { name: "Waiting for the answer" })
  ).toContainText("1.2 sec");

  // Claire apart.
  await page.getByRole("button", { name: "Claire" }).click();
  await expect(page.getByText("1 of 1 said how it was")).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Where people stop" }).getByRole("listitem")
  ).toContainText([/Your story\D*1$/u]);

  await sections.getByRole("link", { name: "AI use" }).click();
  const byPurpose = page.getByRole("table", { name: "By purpose" });
  await expect(byPurpose.getByRole("row")).toContainText([
    /Reading.*3/u,
    /anthropic\/claude-opus-4-8/u,
    /Interviews.*180/u,
    /anthropic\/claude-sonnet-4-5.*120/u,
    /Voice.*60.*30\.0/u,
    /Drawing/u,
  ]);
  expect(cspViolations).toStrictEqual([]);
});
