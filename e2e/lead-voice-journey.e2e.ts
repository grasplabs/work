import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

import { test } from "./csp.ts";
import { interviewLinkOf } from "./interview-link.ts";
import {
  answered,
  readBack,
  speechSchema,
  today,
  wavOf,
} from "./interview-turns.ts";
import { apiOf, signInStaff } from "./people.ts";
import type { Person } from "./people.ts";

// A team lead's interview by voice, end to end (GRA-339): their link, the
// screens before it, the interview spoken into a microphone, the
// read-back, agreeing to it; then their team's links open. The microphone
// is Chromium's fake one, playing a recorded answer; the outside systems
// are stood in for as the other journeys do (e2e/interview-turns.ts):
// Stephen's turns, his voice, and what the voice provider writes down of
// what was said.
//
// Not yet: Stephen's ears (GRA-381) and his turn-taking (GRA-383) aren't
// built, so nobody is heard yet and the test is marked to be fixed. Once
// they land: point `earRoute` at the path GRA-381 gives the live line,
// answer it the way that path answers, and take the `fixme` off. Its
// last step needs one more stand-in: the team's map is drawn by the
// careful model in core's own alarm, which no browser route reaches, and
// the local stack reaches no model; until a gateway is stood in for on
// the stack, the drawing fails and the team waits for its retries.

/** A recorded answer, as the voice provider writes it down. */
const recordedAnswer = "I plan the rota for the team, every Friday.";

/**
 * The recorded answer the fake microphone plays, over and over: two
 * seconds of a voice, its pitch and loudness moving as speech does, then
 * a breath's silence, so a stretch is heard and then ends. Written before
 * the browser starts.
 */
const answerFile = path.join(os.tmpdir(), "grasp-e2e-lead-answer.wav");
const rate = 16_000;
writeFileSync(
  answerFile,
  wavOf(
    rate,
    Array.from({ length: rate * 3 }, (_, at) => {
      const seconds = at / rate;
      if (seconds >= 2) {
        return 0;
      }
      const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * seconds);
      const pitch = 140 + 30 * Math.sin(2 * Math.PI * 0.7 * seconds);
      return 0.35 * syllable * Math.sin(2 * Math.PI * pitch * seconds);
    })
  )
);

// Sound plays without a press first, and the microphone is allowed without asking.
test.use({
  launchOptions: {
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${answerFile}`,
    ],
  },
});

/**
 * Where the page sends what the microphone hears, to have it written
 * down: a guess until GRA-381 lands the live line's path (a relay through
 * core, or a single-use pass to the provider, GRA-362).
 */
const earRoute = "**/api/interview/ear**";

/** Answers every line asked to be said with half a second of silence. */
const voiceSaysNothing = async (page: Page): Promise<void> => {
  await page.route("**/api/speech", async (route: Route) => {
    const line = speechSchema.parse(route.request().postDataJSON());
    await route.fulfill({
      json: {
        audio: wavOf(
          8000,
          Array.from({ length: 4000 }, () => 0)
        ).toString("base64"),
        mime: "audio/wav",
        words: line.text
          .split(/\s+/u)
          .map((text) => ({ text, startMs: 0, endMs: 500 })),
      },
    });
  });
};

/** Lea leading Sales, with Sam in it, their lead's link out. */
const salesLedBy = async (staff: Person, run: string) => {
  const ids = { team: `sales-${run}`, lea: `lea-${run}`, sam: `sam-${run}` };
  const { core, api } = apiOf(staff);
  try {
    await api.onboarding.saveRoster({
      teams: [{ id: ids.team, name: "Sales", lead: ids.lea }],
      people: [
        { id: ids.lea, name: "Lea", team: ids.team },
        { id: ids.sam, name: "Sam", team: ids.team },
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
  return ids;
};

/** Whose links are out, of `people`. */
const outOf = async (staff: Person, people: string[]): Promise<string[]> => {
  const { core, api } = apiOf(staff);
  try {
    const { links } = await api.onboardingStaff.interviews();
    return people.filter((person) =>
      links.some((link) => link.person === person && link.sentAt !== null)
    );
  } finally {
    core[Symbol.dispose]();
  }
};

test.fixme("a lead has their interview by voice, agrees to the read-back, and their team's links open", async ({
  page,
  cspViolations,
}) => {
  // GRA-381 (Stephen's ears) and GRA-383 (turn-taking) aren't built: the
  // page doesn't listen yet, so the recorded answer is never heard.
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const ids = await salesLedBy(staff, run);
  const asked = await answered(page);
  await voiceSaysNothing(page);
  // The voice provider writes down the recorded answer.
  const heard: string[] = [];
  await page.route(earRoute, async (route: Route) => {
    heard.push(route.request().url());
    await route.fulfill({ json: { text: recordedAnswer, final: true } });
  });

  // The screens before it, and the sound check, by voice.
  await page.goto(await interviewLinkOf(ids.lea));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Stephen", exact: true }).click();
  await page
    .getByRole("button", { name: "Check sound and microphone" })
    .click();
  await page.getByRole("button", { name: "Yes, I can hear you" }).click();
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.click();

  // He asks; the lead answers out loud; what they said is written down
  // as they say it, and once they are done he answers.
  await expect(page.getByText("Stephen is talking")).toBeVisible();
  await expect(page.getByText(recordedAnswer)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(readBack)).toBeVisible({ timeout: 30_000 });

  // The read-back, agreed to.
  await page.getByRole("button", { name: "Yes, that’s correct" }).click();
  await expect(
    page.getByRole("heading", { name: "Thank you, Lea." })
  ).toBeVisible();

  // The team's map is drawn from what Lea agreed to, and Sam's link opens.
  await expect
    .poll(async () => await outOf(staff, [ids.lea, ids.sam]), {
      timeout: 60_000,
    })
    .toStrictEqual([ids.lea, ids.sam]);
  expect({
    heard: heard.length > 0,
    turns: asked.turns.map(({ event }) => event),
    refused: asked.refused,
  }).toStrictEqual({
    heard: true,
    turns: ["start", "answer", "readback"],
    refused: [],
  });
  expect(cspViolations).toStrictEqual([]);
});
