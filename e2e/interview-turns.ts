/**
 * Someone's interview as the e2e stack holds it (e2e/interview.e2e.ts and
 * the journeys): the local stack reaches no model, so Stephen's turns are
 * the browser's. What the page asks of `/api/interview/turn` is checked
 * against what core takes, and answered as core would, a line of JSON at a
 * time; what it asks of `/api/speech` is noted and refused, as a stack
 * without a voice does. Everything else, opening the link and keeping
 * what was said, is core's own.
 */
import { interviewTurnRequestSchema } from "@grasp-os/shared/interview-turn";
import type {
  InterviewTurnRequest,
  StephenTurn,
  TurnEvent,
} from "@grasp-os/shared/interview-turn";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";

import { interviewLinkOf } from "./interview-link.ts";
import { apiOf } from "./people.ts";
import type { Person } from "./people.ts";

/** A WAV of 16-bit mono samples at `rate`, each from -1 to 1. */
export const wavOf = (rate: number, samples: number[]): Buffer => {
  const data = samples.length * 2;
  const wav = Buffer.alloc(44 + data);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + data, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(data, 40);
  for (const [at, sample] of samples.entries()) {
    wav.writeInt16LE(Math.round(sample * 32_767), 44 + at * 2);
  }
  return wav;
};

/** What the page asks to have said: the line, and in whose voice (`@grasp-os/shared/voice`). */
export const speechSchema = z.object({ text: z.string(), speaker: z.string() });

/** Today, as core's plan reads it (UTC). */
export const today = (): string => new Date().toISOString().slice(0, 10);

export const turnOf = (more: Partial<StephenTurn>): StephenTurn => ({
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

/** The first sentence of a line, sent ahead while the rest is written, as core does (`earlyOpening`): never a question. */
const openingOf = (say: string): string | undefined =>
  /^(?<first>.*?[.!…])\s+\S/u.exec(say)?.groups?.first;

/** A turn as core streams it: the first sentence of his line, his line, where it goes, then the whole turn. */
export const streamed = (turn: StephenTurn): string => {
  const opening = openingOf(turn.say);
  const events: TurnEvent[] = [
    ...(opening === undefined
      ? []
      : [{ opening: { say: opening, tone: turn.tone } }]),
    { line: { say: turn.say, tone: turn.tone } },
    { next: { phase: turn.phase, wants: turn.wants } },
    { turn },
  ];
  return events.map((event) => JSON.stringify(event)).join("\n");
};

export const first = "Hi, I'm Stephen, an AI. What do you do most?";
export const back = "Welcome back. What do you do first with an invoice?";
export const readBack = "Thank you. Let me read back what I wrote down.";
export const changed = "I put that right. Is that correct?";

/** What Stephen answers each thing that happens, as the models would. */
export const answerTo = (asked: InterviewTurnRequest): StephenTurn => {
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
export const personIn = async (
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
export const invited = async (
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
export interface Asked {
  /** Turns core would refuse. */
  refused: unknown[];
  /** Each turn's event, and who was asked to hold it. */
  turns: { event: string; interviewer: string }[];
  /** Each line asked to be said, and in whose voice. */
  said: { text: string; speaker: unknown }[];
}

/** Answers every turn as core would, and refuses every line to be said, as a stack without a voice does. */
export const answered = async (page: Page): Promise<Asked> => {
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
