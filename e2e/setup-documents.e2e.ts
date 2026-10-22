import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { readDocumentsAs } from "./document-readings.ts";
import { peopleIn } from "./people.ts";
import { answerSpeech } from "./speech.ts";

// The documents step of the admin's onboarding: three documents dropped
// are each read at once, a row each says what it is about, Stephen sums
// up the first out loud and asks his one question, answered with a press,
// and the tools named across them open the next step. Core's reading is
// the model's, which the local stack doesn't reach, so it is given here
// (e2e/document-readings.ts), as is his voice (e2e/speech.ts).

// Sound plays without a press first, as once the admin has clicked their way in.
test.use({
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

const onboarding = {
  about: "How a new client is taken on, from the first call to the kickoff.",
  tools: ["HubSpot", "DocuSign"],
  teams: [],
  unclear: [],
  ask: {
    question: "Is this still how new clients are taken on?",
    options: ["Yes, still", "No, it changed"],
  },
};

const readings = {
  "client-onboarding.pdf": onboarding,
  "expenses.pdf": {
    about: "How expenses are claimed and approved.",
    tools: ["Exact Online"],
    teams: [],
    unclear: [],
    ask: null,
  },
  "planning.pdf": {
    about: "How the week's jobs are planned.",
    tools: ["HubSpot", "Microsoft Teams"],
    teams: [],
    unclear: [],
    ask: null,
  },
};

const pdf = (name: string) => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n"),
});

test("the admin drops three documents, answers Stephen's question, and sees their tools on the next step", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("setupDocuments");
  const page = await pageOf(admin);
  const asked = await answerSpeech(page);
  await readDocumentsAs(page, readings);
  await page.goto("/setup?step=documents");
  await expect(
    page.getByRole("heading", {
      name: "Do you have anything that explains how you work?",
    })
  ).toBeVisible();

  await page
    .locator('input[type="file"]')
    .setInputFiles(Object.keys(readings).map(pdf));
  await expect(
    page.getByText(
      "Thank you. I’m reading them now, and you can add more at any time."
    )
  ).toBeVisible();

  // A row each says what its document is about.
  for (const { about } of Object.values(readings)) {
    // oxlint-disable-next-line no-await-in-loop -- one row at a time
    await expect(page.getByText(about)).toBeVisible();
  }

  // His one question, said with what its document is about, answered with a press.
  await expect(
    page.getByText(`${onboarding.ask.question} client-onboarding.pdf`)
  ).toBeVisible();
  await expect
    .poll(() =>
      asked.some(
        (line) => line.text === `${onboarding.about} ${onboarding.ask.question}`
      )
    )
    .toBe(true);
  await page.getByRole("button", { name: "Yes, still" }).click();
  await expect(page.getByRole("button", { name: "Yes, still" })).toBeHidden();
  await expect
    .poll(() => asked.some((line) => line.text === "Got it."))
    .toBe(true);

  // The tools named across them, each once, open the next step.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Which tools do people actually use?" })
  ).toBeVisible();
  await expect(page.getByText(/^In your documents I saw /u)).toHaveText(
    /^In your documents I saw (?=.*HubSpot)(?=.*DocuSign)(?=.*Exact Online)(?=.*Microsoft Teams)/u
  );
});
