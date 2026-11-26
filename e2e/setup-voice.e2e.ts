import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";
import { answerSpeech } from "./speech.ts";

// Stephen says each step of the admin's onboarding as it arrives
// (apps/web/src/voice): its title, and its line when the line is words
// alone, in the page's language. With his voice off, kept in this browser,
// nothing is asked of the voice. The page's speech requests are answered
// with silence the length of the line (e2e/speech.ts).

// Sound plays without a press first, as once the admin has clicked their way in.
test.use({
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

const sourcesHeading = "Where does the work get written down?";
const documentsHeading = "Do you have anything that explains how you work?";

test("the admin goes through steps and back, with his voice on and off", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("setupVoice");
  const page = await pageOf(admin);
  const asked = await answerSpeech(page);

  // Voice on: the welcome is said, in the page's language.
  await page.goto("/setup?step=welcome");
  await expect
    .poll(() =>
      asked.find((line) =>
        line.text.endsWith(
          "I’ll set up Grasp with you, one step at a time. Which language would you like?"
        )
      )
    )
    .toMatchObject({ language: "en" });

  // Each step is said as it arrives: its title, then its line.
  await page.goto("/setup?step=sources");
  await expect(
    page.getByRole("heading", { name: sourcesHeading })
  ).toBeVisible();
  await expect
    .poll(() =>
      asked.some(
        (line) =>
          line.text ===
          `${sourcesHeading} The files, pages and folders your team works from. Connect the tools they’re in, and I’ll only read what you share with me.`
      )
    )
    .toBe(true);

  // On to the documents, and back.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: documentsHeading })
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: sourcesHeading })
  ).toBeVisible();

  // Voice off: kept in this browser, and nothing more is asked of the voice.
  await page.getByRole("button", { name: "Turn my voice off" }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Turn my voice on" })
  ).toBeVisible();
  const before = asked.length;
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: documentsHeading })
  ).toBeVisible();
  // The way back at the foot of the step goes back a step.
  await page
    .getByRole("navigation", { name: "Steps" })
    .getByRole("button", { name: "Back" })
    .click();
  await expect(
    page.getByRole("heading", { name: sourcesHeading })
  ).toBeVisible();
  expect(asked.length).toBe(before);
});

/** Before the admin chose anything; the onboarding's store is the deployment's one. */
const noChoices = {
  sources: [],
  sourcesWanted: [],
  pulse: null,
  hr: null,
};

/** What `ask` gets of `person`'s API, on a connection of its own. */
const withApi = async <T>(
  person: Person,
  ask: (api: ReturnType<typeof apiOf>["api"]) => Promise<T>
): Promise<T> => {
  const { core, api } = apiOf(person);
  try {
    return await ask(api);
  } finally {
    core[Symbol.dispose]();
  }
};

// What the admin chooses on these steps is kept in the deployment's one
// store, which the steps above read too: so this runs in the same file,
// one after the other, and leaves nothing chosen.
test("the admin connects SharePoint, notes Confluence and Personio", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("setupConnect");
  const leaveNothingChosen = async () => {
    await withApi(
      admin,
      async (api) => await api.onboarding.saveChoices(noChoices)
    );
  };
  try {
    await leaveNothingChosen();
    const page = await pageOf(admin);
    await answerSpeech(page);
    await page.goto("/setup?step=sources");
    const places = page.getByRole("list", {
      name: "Where your documents live",
    });

    // SharePoint comes with the company's Microsoft sign-in, and Microsoft
    // 365 is connected for everyone (e2e/connections-seed.ts): connected.
    await places.getByRole("button", { name: "SharePoint" }).click();
    await expect(
      places
        .getByRole("listitem")
        .filter({ hasText: /SharePoint\s*, connected/u })
    ).toBeVisible();
    // Confluence goes through Composio, which this stack doesn't reach: noted.
    await places.getByRole("button", { name: "Confluence" }).click();
    await expect(
      places.getByRole("button", { name: /^Confluence\s*, noted$/u })
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: documentsHeading })
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    // Pulse is not on the admin's path: the HR platform comes next. Personio, noted.
    await expect(
      page.getByRole("heading", { name: "Which HR platform do you use?" })
    ).toBeVisible();
    // Picked is said: the step goes straight on.
    await page.getByRole("button", { name: "Personio" }).click();
    await expect(
      page.getByRole("heading", { name: "We’ll set up your teams together" })
    ).toBeVisible();

    await expect(
      withApi(admin, async (api) => await api.onboarding.choices())
    ).resolves.toStrictEqual({
      sources: ["sharepoint", "confluence"],
      sourcesWanted: [],
      pulse: null,
      hr: { kind: "platform", name: "Personio" },
    });
  } finally {
    await leaveNothingChosen();
  }
});
