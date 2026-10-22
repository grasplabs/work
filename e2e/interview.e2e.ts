import { interviewTurnRequestSchema } from "@grasp-os/shared/interview-turn";
import type {
  InterviewTurnRequest,
  StephenTurn,
  TurnEvent,
} from "@grasp-os/shared/interview-turn";
import { expect } from "@playwright/test";
import type { Route } from "@playwright/test";

import { test } from "./csp.ts";
import { interviewLinkOf } from "./interview-link.ts";
import { apiOf, signInStaff } from "./people.ts";
import type { Person } from "./people.ts";

// Someone's own interview, end to end (GRA-345): they open their link,
// answer Stephen by typing, stop for now and carry on, put a line of the
// read-back right, agree to it, and the interview is agreed in the store.
// The local stack reaches no model, so Stephen's turns are the browser's:
// what the page asks of `/api/interview/turn` is checked against what core
// takes, and answered as core would, a line of JSON at a time. Everything
// else, opening the link and keeping what was said, is core's own. Its
// own Playwright project, after the onboarding's (playwright.config.ts):
// sending a link tells the team, and nothing undoes that.

/** Today, as core's plan reads it (UTC). */
const today = (): string => new Date().toISOString().slice(0, 10);

const turnOf = (more: Partial<StephenTurn>): StephenTurn => ({
  say: "",
  tone: null,
  phase: "you",
  facts: [],
  changes: [],
  wants: "answer",
  more: false,
  approved: false,
  ...more,
});

/** A turn as core streams it: his line, where it goes, then the whole turn. */
const streamed = (turn: StephenTurn): string =>
  [
    { line: { say: turn.say, tone: turn.tone } },
    { next: { phase: turn.phase, wants: turn.wants } },
    { turn },
  ]
    .map((event: TurnEvent) => JSON.stringify(event))
    .join("\n");

const first = "Hi, I'm Stephen, an AI. What do you do most?";
const back = "Welcome back. What do you do first with an invoice?";
const readBack = "Thank you. Let me read back what I wrote down.";
const changed = "I put that right. Is that correct?";

/** What Stephen answers each thing that happens, as the models would. */
const answerTo = (asked: InterviewTurnRequest): StephenTurn => {
  const said = asked.lines.at(-1)?.text ?? "";
  switch (asked.event) {
    case "start": {
      return turnOf({ say: first });
    }
    case "resume": {
      return turnOf({ say: back, phase: "steps" });
    }
    case "readback": {
      return turnOf({
        say: changed,
        phase: "readback",
        wants: "readback",
        changes: [
          {
            id: "f2",
            text: "You send it to Kim in finance.",
            record: "Send it to Kim in finance.",
          },
        ],
      });
    }
    case "add":
    case "answer":
    case "file":
    case "nudge": {
      return turnOf({
        say: readBack,
        phase: "result",
        wants: "readback",
        facts: [
          {
            tag: "system",
            text: "You check the invoice in Exact.",
            record: "Check the invoice in Exact.",
            quote: said.includes("in Exact") ? "in Exact" : "",
          },
          {
            tag: "handoff",
            text: "You send it to Sam.",
            record: "Send it to Sam.",
            quote: "",
          },
        ],
      });
    }
    default: {
      return asked.event satisfies never;
    }
  }
};

/** Where `person` stands, as core keeps their interview. */
const personIn = async (
  staff: Person,
  person: string
): Promise<string | undefined> => {
  const { core, api } = apiOf(staff);
  try {
    const { progress } = await api.onboardingStaff.transcript(person);
    return progress?.person;
  } finally {
    core[Symbol.dispose]();
  }
};

test("someone has their interview by typing, carries on after stopping, and agrees to the read-back", async ({
  page,
}) => {
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const person = `noor-${run}`;
  const { core, api } = apiOf(staff);
  try {
    await api.onboarding.saveRoster({
      teams: [{ id: `finance-${run}`, name: "Finance", lead: null }],
      people: [{ id: person, name: "Noor", team: `finance-${run}` }],
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
  const link = await interviewLinkOf(person);

  // Every turn the page asks for must be one core takes.
  const refused: unknown[] = [];
  const events: string[] = [];
  await page.route("**/api/interview/turn", async (route: Route) => {
    const asked = interviewTurnRequestSchema.safeParse(
      route.request().postDataJSON()
    );
    if (!asked.success) {
      refused.push(asked.error.issues);
      await route.fulfill({ status: 400, body: "{}" });
      return;
    }
    events.push(asked.data.event);
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: streamed(answerTo(asked.data)),
    });
  });

  await page.goto(link);
  await expect(
    page.getByRole("heading", {
      name: "Hi Noor, I’m Stephen. I’m an AI, and I work for Grasp.",
    })
  ).toBeVisible();
  await page.getByRole("button", { name: "Start by typing" }).click();
  await expect(page.getByText(first)).toBeVisible();

  // They stop, and the link carries on where it was, after a reload too.
  await page.getByRole("button", { name: "Stop for now" }).click();
  await expect(page.getByText("Your place is kept.")).toBeVisible();
  await expect
    .poll(async () => await personIn(staff, person))
    .toBe("incomplete");
  await page.reload();
  await expect(page.getByText(back)).toBeVisible();

  const answer = page.getByLabel("Your answer");
  await answer.fill("I check it in Exact, then I send it to Sam.");
  await answer.press("Enter");

  // The read-back, a part at a time: a line put right where it is.
  await expect(page.getByText(readBack)).toBeVisible();
  const lines = page.getByRole("list").filter({ hasText: "Exact" });
  await expect(lines.getByRole("listitem")).toHaveText([
    "You check the invoice in Exact.",
    "You send it to Sam.",
  ]);
  await page
    .getByRole("button", { name: "Change: You send it to Sam." })
    .click();
  const field = page.getByLabel("Change: You send it to Sam.");
  await field.fill("You send it to Kim.");
  await field.press("Enter");
  await expect(page.getByText(changed)).toBeVisible();
  await expect(lines.getByRole("listitem")).toHaveText([
    "You check the invoice in Exact.",
    "You send it to Kim in finance.",
  ]);
  await page.getByRole("button", { name: "Yes, that’s correct" }).click();
  await expect(
    page.getByRole("heading", { name: "Thank you, Noor." })
  ).toBeVisible();

  // Core keeps it agreed: what is left in, as it was put right.
  const reader = apiOf(staff);
  try {
    await expect
      .poll(async () => {
        const { progress } =
          await reader.api.onboardingStaff.transcript(person);
        return {
          person: progress?.person,
          facts: progress?.facts.map(({ text, agreed }) => ({ text, agreed })),
        };
      })
      .toStrictEqual({
        person: "completed",
        facts: [
          { text: "You check the invoice in Exact.", agreed: true },
          { text: "You send it to Kim in finance.", agreed: true },
        ],
      });
  } finally {
    reader.core[Symbol.dispose]();
  }
  expect({ refused, events }).toStrictEqual({
    refused: [],
    events: ["start", "resume", "answer", "readback"],
  });
});
