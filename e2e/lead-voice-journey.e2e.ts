import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { hearAnswerSchema } from "@grasp-os/shared/interview-hear";
import {
  transcriptionCommitSchema,
  transcriptionStartSchema,
} from "@grasp-os/shared/voice";
import { expect } from "@playwright/test";
import type { Page, Route, WebSocketRoute } from "@playwright/test";
import { z } from "zod";

import { adminSnapshot } from "./admin-steering.ts";
import { test } from "./csp.ts";
import { interviewLinkOf } from "./interview-link.ts";
import {
  answered,
  personIn,
  readBack,
  speechSchema,
  today,
  wavOf,
} from "./interview-turns.ts";
import { apiOf, signInStaff } from "./people.ts";
import type { Person } from "./people.ts";

// A team lead's interview by voice, end to end (GRA-339): their link, the
// screens before it, the interview spoken into a microphone, the
// read-back, agreeing to it by saying so. The microphone is Chromium's
// fake one, playing a recorded answer; the outside systems are stood in
// for as the other journeys do (e2e/interview-turns.ts): Stephen's turns,
// his voice, and what the transcription upstream writes down of what was
// said. That last one is answered on the live line's socket
// (`/api/transcription`) as core relays the upstream (GRA-932's protocol),
// and on the recording's way (`/api/interview/hear`) as core answers it.
// Everything else is the page's own: the ear hearing the recording,
// turn-taking, the read-back. The conversation is followed through the
// events the loop tells on `window` (`grasp:interview-loop`).
//
// Then the team's links open once its map is drawn from what the lead
// agreed to. The map is drawn by the careful model in core's alarm, which
// no browser route reaches and the local stack can't call. So here the
// team waits for it (Sam's link stays shut); that the drawing opens it is
// asserted in workerd, with the model provider stood in for (apps/core/test/
// team-map.test.ts, "is drawn once the lead agrees").

/** A recorded answer, as the transcription upstream writes it down. */
const recordedAnswer = "I plan the rota for the team, every Friday.";
/** What the lead says once Stephen asks whether the read-back is right. */
const yes = "Yes, that's correct.";

/**
 * The recorded answer the fake microphone plays, over and over: two
 * seconds of a voice, its pitch and loudness moving as speech does, then
 * three seconds of quiet, so a stretch is heard and then ends. Written
 * before the browser starts.
 */
const answerFile = path.join(os.tmpdir(), "grasp-e2e-lead-answer.wav");
const rate = 16_000;
writeFileSync(
  answerFile,
  wavOf(
    rate,
    Array.from({ length: rate * 5 }, (_, at) => {
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

/** What the transcription stand-ins saw, and the lines Stephen said. */
interface Heard {
  /** Frames core would refuse. */
  refused: string[];
  /** Live lines started with the lead's link. */
  starts: number;
  /** Each line asked to be said. */
  said: string[];
}

/** What the lead says next: their answer, then, once asked whether it is right, yes. */
const nextSaid = (heard: Heard): string =>
  heard.said.some((line) => line.endsWith("Is that correct?"))
    ? yes
    : recordedAnswer;

/** A text frame's JSON, or nothing. */
const jsonOf = (message: string): unknown => {
  try {
    return JSON.parse(message);
  } catch {
    return undefined;
  }
};

/**
 * The live line, as core relays the upstream: `ready` once the page
 * started it with the lead's link, and what they said a moment after the
 * page commits a stretch.
 */
const liveLine =
  (heard: Heard) =>
  (socket: WebSocketRoute): void => {
    socket.onMessage((message) => {
      if (typeof message !== "string") {
        // Only audio core takes: 16-bit samples, at most 32 KiB a frame.
        if (message.length % 2 !== 0 || message.length > 32 * 1024) {
          heard.refused.push(`frame of ${message.length}`);
        }
        return;
      }
      const frame = jsonOf(message);
      const start = transcriptionStartSchema.safeParse(frame);
      if (start.success) {
        heard.starts += start.data.link === undefined ? 0 : 1;
        socket.send(
          JSON.stringify({
            type: "ready",
            session: crypto.randomUUID(),
            maxSeconds: 900,
          })
        );
        return;
      }
      if (!transcriptionCommitSchema.safeParse(frame).success) {
        heard.refused.push(message);
        return;
      }
      socket.send(
        JSON.stringify({ type: "final", text: nextSaid(heard), words: [] })
      );
    });
  };

/** Stephen's voice: half a second of silence for every line, each noted. */
const voiceSaysNothing = async (page: Page, heard: Heard): Promise<void> => {
  await page.route("**/api/speech", async (route: Route) => {
    const line = speechSchema.parse(route.request().postDataJSON());
    heard.said.push(line.text);
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

/** Each event the loop tells, kept from the page's first moment. */
const watchLoop = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const told: unknown[] = [];
    // `loopEventName` in apps/web/src/interview/loop.ts.
    window.addEventListener("grasp:interview-loop", (event) => {
      if (event instanceof CustomEvent) {
        told.push(event.detail);
      }
    });
    Object.assign(window, { loopEvents: told });
  });
};

/** What the loop told, as far as this test reads it. */
const toldSchema = z.array(
  z.union([
    z.object({
      happened: z.object({ type: z.string(), text: z.string().optional() }),
    }),
    z.object({
      did: z.object({ type: z.string(), text: z.string().optional() }),
    }),
    z.object({ measured: z.unknown(), waited: z.number().nullable() }),
  ])
);

/** Lea leading Sales, with Sam in it, their lead's link out. */
const salesLedBy = async (staff: Person, run: string) => {
  const ids = { team: `sales-${run}`, lea: `lea-${run}`, sam: `sam-${run}` };
  const { core, api } = apiOf(staff);
  try {
    await api.onboarding.confirmRoster({
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
const outOf = async (people: string[]): Promise<string[]> => {
  const { links } = await adminSnapshot();
  {
    return people.filter((person) =>
      links.some((link) => link.person === person && link.sentAt !== null)
    );
  }
};

test("a lead has their interview by voice, agrees to the read-back by saying so, and their team waits for its map", async ({
  page,
  cspViolations,
}) => {
  test.setTimeout(240_000);
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const ids = await salesLedBy(staff, run);
  const asked = await answered(page);
  const heard: Heard = { refused: [], starts: 0, said: [] };
  await voiceSaysNothing(page, heard);
  await page.routeWebSocket("**/api/transcription", liveLine(heard));
  await page.route("**/api/interview/hear", async (route: Route) => {
    await route.fulfill({
      json: hearAnswerSchema.parse({ heard: nextSaid(heard) }),
    });
  });
  await watchLoop(page);

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

  // He asks; the lead answers out loud, and what they said is written
  // down; once they are done he answers with the read-back, and their yes
  // agrees to it. Nobody types or presses anything.
  await expect(page.getByText(readBack)).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("heading", { name: "Thank you, Lea." })
  ).toBeVisible({ timeout: 90_000 });

  const told = toldSchema.parse(
    await page.evaluate((): unknown => Reflect.get(window, "loopEvents"))
  );
  const finals = new Set(
    told.flatMap((event) =>
      "happened" in event && event.happened.type === "final"
        ? [event.happened.text]
        : []
    )
  );
  const asks = told.flatMap((event) =>
    "did" in event && event.did.type === "ask" ? [event.did.text] : []
  );
  // The team's map can't be drawn on the stack (above): Lea's interview
  // is kept as agreed, and Sam waits for the map.
  await expect.poll(async () => await personIn(ids.lea)).toBe("completed");
  expect({
    heard: {
      live: heard.starts > 0,
      refused: heard.refused,
      answer: finals.has(recordedAnswer),
      yes: finals.has(yes),
    },
    answered: asks.some((text = "") => text.includes(recordedAnswer)),
    turns: asked.turns.map(({ event }) => event),
    refused: asked.refused,
    out: await outOf([ids.lea, ids.sam]),
    csp: cspViolations,
  }).toStrictEqual({
    heard: { live: true, refused: [], answer: true, yes: true },
    answered: true,
    turns: ["start", "answer"],
    refused: [],
    out: [ids.lea],
    csp: [],
  });
});
