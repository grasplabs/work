import { interviewTurnRequestSchema } from "@grasp-os/shared/interview-turn";
import type {
  InterviewTurnRequest,
  StephenTurn,
  TurnEvent,
} from "@grasp-os/shared/interview-turn";
import { expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";

import { test } from "./csp.ts";
import { interviewLinkOf } from "./interview-link.ts";
import { apiOf, signInStaff } from "./people.ts";
import type { Person } from "./people.ts";

// Someone's own interview, end to end (GRA-345, GRA-346): they open their
// link, choose their language and who they talk with, read what this is,
// answer by typing, stop for now and carry on, put a line of the read-back
// right, agree to it, and the interview is agreed in the store. Another
// goes through the screens before it in Dutch and chooses Claire, whose
// text and voice every turn then uses.
// The local stack reaches no model, so Stephen's turns are the browser's:
// what the page asks of `/api/interview/turn` is checked against what core
// takes, and answered as core would, a line of JSON at a time. Everything
// else, opening the link and keeping what was said, is core's own. The
// stack has no voice either: what the page asks of `/api/speech` is
// noted and refused, so each line lights up without sound. Its
// own Playwright project, after the onboarding's (playwright.config.ts):
// sending a link tells the team, and nothing undoes that.

/** What the page asks to have said: the line, and in whose voice (`@grasp-os/shared/voice`). */
const speechSchema = z.object({ text: z.string(), speaker: z.string() });

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

/** Someone in a team of their own, with their interview link out; their link's path. */
const invited = async (
  staff: Person,
  person: string,
  name: string
): Promise<string> => {
  const { core, api } = apiOf(staff);
  try {
    await api.onboarding.saveRoster({
      teams: [{ id: `team-${person}`, name: "Finance", lead: null }],
      people: [{ id: person, name, team: `team-${person}` }],
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
  return await interviewLinkOf(person);
};

/** What the page asked of core's turns and voice, as the stack answers them. */
interface Asked {
  /** Turns core would refuse. */
  refused: unknown[];
  /** Each turn's event, and who was asked to hold it. */
  turns: { event: string; interviewer: string }[];
  /** Each line asked to be said, and in whose voice. */
  said: { text: string; speaker: unknown }[];
}

/** Answers every turn as core would, and refuses every line to be said, as a stack without a voice does. */
const answered = async (page: Page): Promise<Asked> => {
  const asked: Asked = { refused: [], turns: [], said: [] };
  await page.route("**/api/interview/turn", async (route: Route) => {
    const turn = interviewTurnRequestSchema.safeParse(
      route.request().postDataJSON()
    );
    if (!turn.success) {
      asked.refused.push(turn.error.issues);
      await route.fulfill({ status: 400, body: "{}" });
      return;
    }
    asked.turns.push({
      event: turn.data.event,
      interviewer: turn.data.interviewer,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: streamed(answerTo(turn.data)),
    });
  });
  await page.route("**/api/speech", async (route: Route) => {
    const line = speechSchema.safeParse(route.request().postDataJSON());
    asked.said.push(
      line.success
        ? { text: line.data.text, speaker: line.data.speaker }
        : { text: "", speaker: null }
    );
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "speech.unavailable",
        message: "The voice isn't set up for this deployment yet.",
      }),
    });
  });
  return asked;
};

test("someone has their interview by typing, carries on after stopping, and agrees to the read-back", async ({
  page,
}) => {
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const person = `noor-${run}`;
  const link = await invited(staff, person, "Noor");
  // Every turn the page asks for must be one core takes.
  const asked = await answered(page);

  await page.goto(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Stephen", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Hi Noor, I’m Stephen. I’m an AI, and I work for Grasp.",
    })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Type instead, without sound" })
    .click();
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
  expect({
    refused: asked.refused,
    events: asked.turns.map(({ event }) => event),
  }).toStrictEqual({
    refused: [],
    events: ["start", "resume", "answer", "readback"],
  });
});

test("someone goes through the screens before the interview in Dutch, chooses Claire, and talks with her", async ({
  page,
}) => {
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const person = `lotte-${run}`;
  const link = await invited(staff, person, "Lotte");
  const asked = await answered(page);

  // The device's language is marked; another is one press away, and the question is asked in it.
  await page.goto(link);
  await expect(
    page.getByRole("button", { name: "English", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Nederlands", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "In welke taal wil je dit interview doen?",
    })
  ).toBeVisible();
  await page.getByRole("button", { name: "Doorgaan" }).click();

  // Stephen and Claire each say who they are, in their own voice; neither is chosen beforehand.
  await expect(
    page.getByText("Kies door wie je geïnterviewd wilt worden.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Claire", exact: true }).click();

  // What this is, with her; then the sound check, said in her voice.
  await expect(
    page.getByRole("heading", {
      name: "Hoi Lotte, ik ben Claire. Ik ben een AI en ik werk voor Grasp.",
    })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Geluid en microfoon testen" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Hoi Lotte, ik ben Claire, een AI. Kun je me horen?",
    })
  ).toBeVisible();
  await expect
    .poll(
      () =>
        asked.said.find(({ text }) => text.endsWith("Kun je me horen?"))
          ?.speaker
    )
    .toBe("claire");
  await page
    .getByRole("button", { name: "Liever typen, zonder geluid" })
    .click();

  // The first turn is hers, and core keeps who was chosen.
  await expect(page.getByText(first)).toBeVisible();
  await expect(
    page.getByText(/^Claire (?<doing>stelt een vraag|luistert|denkt na)\.$/u)
  ).toBeAttached();
  const reader = apiOf(staff);
  try {
    await expect
      .poll(async () => {
        const { progress } =
          await reader.api.onboardingStaff.transcript(person);
        return progress?.interviewer;
      })
      .toBe("claire");
  } finally {
    reader.core[Symbol.dispose]();
  }
  expect({
    refused: asked.refused,
    turns: asked.turns,
    claire: asked.said.find(({ text }) => text === "En ik ben Claire.")
      ?.speaker,
  }).toStrictEqual({
    refused: [],
    turns: [{ event: "start", interviewer: "claire" }],
    claire: "claire",
  });
});
