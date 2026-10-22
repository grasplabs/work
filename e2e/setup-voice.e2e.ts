import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";
import { answerSpeech } from "./speech.ts";

// Stephen says each step of the admin's onboarding (apps/web/src/voice):
// with the sound on, each step's line is asked of the voice, the next
// step's ahead of time, and a step's way on comes once it is said; with
// the sound off, nothing is asked and the way on comes once there was time
// to read it. The page's speech requests are answered with silence the
// length of the line (e2e/speech.ts).

// Sound plays without a press first, as once the admin has clicked their way in.
test.use({
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

const sourcesLine =
  "Where does the work get written down? Procedures, handbooks, how-tos. Connect where they live, and I’ll only read what you share with me.";

test("the admin goes through empty steps and back, with the sound on and off", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("setupVoice");
  const page = await pageOf(admin);
  const asked = await answerSpeech(page);

  // Sound on: the welcome is said warmly, in the page's language.
  await page.goto("/setup?step=welcome");
  await expect(
    page.getByRole("heading", { level: 1, name: /, I’m Stephen$/u })
  ).toBeFocused();
  await expect
    .poll(() =>
      asked.find((line) =>
        line.text.endsWith(
          "Stephen. Before we start, which language do you prefer?"
        )
      )
    )
    .toMatchObject({ language: "en", tone: "warm" });

  // On who's who, the next step's line is fetched ahead.
  await page.goto("/setup?step=company");
  await expect(
    page.getByRole("heading", { name: "Who’s who at your company?" })
  ).toBeVisible();
  await expect
    .poll(() => asked.some((line) => line.text === sourcesLine))
    .toBe(true);

  // Said, the way on comes: past where the documents live, and back.
  await page.goto("/setup?step=sources");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Do you have anything that explains how you work?",
    })
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Where does the work get written down?" })
  ).toBeVisible();

  // Pause holds him, and play goes on.
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();

  // Sound off: kept in this browser, nothing more is asked of the voice,
  // and the way on comes once there was time to read the step.
  await page.getByRole("button", { name: "Turn sound off" }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Turn sound on" })
  ).toHaveAttribute("aria-pressed", "false");
  const before = asked.length;
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
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("heading", {
      name: "Do you have anything that explains how you work?",
    })
  ).toBeVisible();
  expect(asked.length).toBe(before);
});
