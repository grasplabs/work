import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { readDocumentsAs } from "./document-readings.ts";
import { peopleIn } from "./people.ts";
import { answerSpeech } from "./speech.ts";

// The documents step of the admin's onboarding: three documents dropped
// are each read at once and kept as a chip each, with nothing asked
// about them, and the way on leads to the HR platform. Core's reading is the model's,
// which the local stack doesn't reach, so it is given here
// (e2e/document-readings.ts), as is his voice (e2e/speech.ts).

// Sound plays without a press first, as once the admin has clicked their way in.
test.use({
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

const readings = {
  "client-onboarding.pdf": {
    about: "How a new client is taken on, from the first call to the kickoff.",
    tools: ["HubSpot", "DocuSign"],
    teams: [],
    unclear: [],
  },
  "expenses.pdf": {
    about: "How expenses are claimed and approved.",
    tools: ["Exact Online"],
    teams: [],
    unclear: [],
  },
  "planning.pdf": {
    about: "How the week's jobs are planned.",
    tools: ["HubSpot", "Microsoft Teams"],
    teams: [],
    unclear: [],
  },
};

const pdf = (name: string) => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n"),
});

test("the admin drops three documents and goes on to the HR platform", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("setupDocuments");
  const page = await pageOf(admin);
  await answerSpeech(page);
  await readDocumentsAs(page, readings);
  await page.goto("/setup?step=documents");
  await expect(
    page.getByRole("heading", {
      name: "Share documents that explain how you work",
    })
  ).toBeVisible();

  await page
    .locator('input[type="file"]')
    .setInputFiles(Object.keys(readings).map(pdf));

  // Each, once read, is kept as a chip of what was shared.
  const shared = page.getByRole("list", { name: "Documents you shared" });
  for (const name of Object.keys(readings)) {
    // oxlint-disable-next-line no-await-in-loop -- one chip at a time
    await expect(
      shared.getByRole("button", { name: `Remove ${name}` })
    ).toBeVisible();
  }

  // The way on: the HR platform.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Which HR platform do you use?" })
  ).toBeVisible();
});

test("the admin removes a document that was read", async ({ pageOf }) => {
  const { admin } = peopleIn("setupDocuments");
  const page = await pageOf(admin);
  await answerSpeech(page);
  const name = "expenses.pdf";
  await readDocumentsAs(page, { [name]: readings[name] });
  await page.goto("/setup?step=documents");
  await page.locator('input[type="file"]').setInputFiles([pdf(name)]);
  const remove = page
    .getByRole("list", { name: "Documents you shared" })
    .getByRole("button", { name: `Remove ${name}` });
  await expect(remove).toBeVisible();

  await remove.click();
  await expect(remove).toHaveCount(0);
});
