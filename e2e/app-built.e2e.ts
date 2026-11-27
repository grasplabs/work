import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { appPlanned, appReady, modelScripts } from "./model-scripts.ts";
import { peopleIn } from "./people.ts";
import { toastSaying } from "./said.ts";

// An App, end to end, as a builder makes one: Make something, what they
// want to get done, Grasp's plan, Build it, and the chat building it (the
// stack's scripted model proposes a page the team opens, then reads the
// deployment's docs, writes the App's files and says it's ready, e2e/
// model-scripts.ts), the builder landing in the App to try it, then
// sharing it with someone and publishing it, its first version, which says
// it is live. Shared with someone, they open the App and add a contact on
// its page, which the App's data shows its builder.

/** A turn of the agent's, its model's calls and the tools they call. */
const agentTurn = { timeout: 30_000 };

/** A page's first build, or a read from core on a loaded stack. */
const built = { timeout: 20_000 };

/** How much of the end of their ID tells a person apart from a namesake (people-apart.ts). */
const namesakeIdEnd = 6;

// Never tried again, as the serial journeys aren't (playwright.config.ts):
// a flaky journey shows as itself, with the trace of the run that failed,
// and a failing one costs its part one attempt of its long wait, not three.
// Each action waits as long as a build or a read: one that never can
// fails as itself, not as the whole test's timeout.
test.use({ trace: "retain-on-failure", actionTimeout: built.timeout });
test.describe.configure({ retries: 0 });

test("a builder makes an App from what they want done, shares it with their team, and someone it is shared with adds a contact its data then shows", async ({
  pageOf,
}) => {
  // Its longest waits, one after another: two of the agent's turns and
  // the preview's first load (30 s each) and ten builds or reads (20 s
  // each): 290 s, before its clicks.
  test.setTimeout(300_000);
  const { builder, user } = peopleIn("appBuilt");
  const { opener } = modelScripts.buildsApp;
  const page = await pageOf(builder);

  // Build new app: Chat's page, what they want done, and Grasp's plan
  // for it in the chat. Nothing is made until Build it; then Grasp builds
  // it in the chat, ticking off what it does, and offers to open the App,
  // where the same chat docks beside it.
  await page.goto("/apps");
  await page.getByRole("link", { name: "Build new app" }).click();
  await expect(page).toHaveURL(/\/\?make=app$/u);
  await expect(
    page.getByRole("heading", { name: "What do you want to get done?" })
  ).toBeVisible();
  const ask = page.getByRole("textbox", { name: "Your question" });
  await ask.fill(opener);
  await ask.press("Enter");
  const plan = page.getByRole("region", {
    name: "Here's what Grasp will make",
  });
  await expect(plan.getByText(appPlanned)).toBeVisible(agentTurn);
  // Build it lands on the App at once, its bar naming it, while the chat
  // beside it builds it. The calm "Setting up" between is not waited for
  // here: the stack's model builds the App in about a second, so it can be
  // gone between two of the assertion's looks. Its page test proves it
  // (app-workspace.test.tsx).
  await plan.getByRole("button", { name: "Build it" }).click();
  await expect(page).toHaveURL(/\/apps\/[^/?]+$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: appPlanned })
  ).toBeAttached(built);
  const app = new URL(page.url()).pathname.split("/").at(-1) ?? "";

  // The chat read how an App is written, wrote it, and said so.
  const chat = page.getByRole("region", { name: "Chat" });
  await expect(chat.getByText(appReady)).toBeVisible(agentTurn);
  // Where it stands, in the bar: beside the docked chat it gives way to
  // the name and Share, so it is there, unseen. The bar says it once
  // Grasp's turn is over, its check of the drafts it wrote included
  // ("Checking the App…"), not as the chat's words show: on a loaded
  // stack that check takes seconds more, so it is waited for as long as
  // an agent's turn.
  await expect(page.getByText("Only you see this")).toBeAttached(agentTurn);

  // The preview is the draft's page, on a store of its own.
  const preview = page.getByRole("region", { name: /, your version$/u });
  const frame = preview.frameLocator("iframe");
  // Its first load waits for core to build the draft, behind any update
  // ahead of it: as long as an agent's turn.
  await expect(frame.getByLabel("Contact's name")).toBeVisible(agentTurn);
  await frame.getByLabel("Contact's name").fill("Ada Lovelace");
  await frame.getByRole("button", { name: "Add contact" }).click();
  await expect(
    frame.getByRole("list", { name: "Contacts" }).getByRole("listitem")
  ).toHaveText(["Ada Lovelace"], built);

  // The chat never shares or publishes it: the builder does, each on its own:
  // Share gives it to whom they pick, Publish checks the draft and makes it
  // the first version. Everyone the stack signs in is called Person, and a builder
  // sees names, not emails: they are told apart by the ID each goes by.
  const userIdEnd = `ID …${user.userId.slice(-namesakeIdEnd)}`;
  // Beside the docked chat the bar is narrow: Share folds into Publish's
  // dialog, as who can open it.
  await page.getByRole("button", { name: "Publish", exact: true }).click(built);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Manage" })
    .click();
  const sharing = page.getByRole("dialog", { name: `Share ${appPlanned}` });
  await sharing.getByLabel("Add people, teams or projects").click();
  await page
    .getByRole("option", { name: "Person" })
    .filter({ hasText: userIdEnd })
    .click(built);
  // The list stays open for more picks; Escape closes it over the chip.
  await page.keyboard.press("Escape");
  await sharing.getByRole("button", { name: "Add", exact: true }).click();
  // The share held: Share lists them, its one Person.
  await expect(
    sharing
      .getByRole("list", { name: "Shared with" })
      .getByRole("listitem")
      .filter({ hasText: "Person" })
  ).toHaveCount(1, built);
  await sharing.getByRole("button", { name: "Done", exact: true }).click();
  await expect(sharing).toHaveCount(0);
  // The bar folds as the chat takes its width again, Publish an icon of
  // the same name: pressed once the bar has settled.
  const publishing = page.getByRole("dialog", {
    name: `Publish ${appPlanned}`,
  });
  const openPublishing = async (): Promise<void> => {
    await expect(async () => {
      if ((await publishing.count()) === 0) {
        await page
          .getByRole("button", { name: "Publish", exact: true })
          .filter({ visible: true })
          .click({ timeout: 2000 });
      }
      await expect(publishing).toBeVisible({ timeout: 2000 });
    }).toPass(built);
  };
  // Publish checks the draft and makes it the first version.
  await openPublishing();
  await publishing
    .getByRole("button", { name: "Publish", exact: true })
    .click(built);
  await expect(toastSaying(page, `${appPlanned} is live`)).toBeVisible(built);

  // They use the live App: none of the preview's contacts, then theirs.
  const used = await pageOf(user);
  await used.goto(`/apps/${app}`);
  await expect(
    used.getByRole("heading", { level: 1, name: appPlanned })
  ).toBeVisible(built);
  const appPage = used.frameLocator('iframe[title="App"]');
  const contacts = appPage
    .getByRole("list", { name: "Contacts" })
    .getByRole("listitem");
  await expect(appPage.getByLabel("Contact's name")).toBeVisible(built);
  await expect(contacts).toHaveCount(0);
  await appPage.getByLabel("Contact's name").fill("Grace Hopper");
  await appPage.getByRole("button", { name: "Add contact" }).click();
  await expect(contacts).toHaveText(["Grace Hopper"], built);

  // Shared, with nothing changed since, the workspace is what the team
  // sees: its Data shows its builder the contact they added, a row of its
  // table's grid, and none of the preview's.
  await page
    .getByRole("navigation", { name: /s workspace$/u })
    .getByRole("link", { name: "Data" })
    .click();
  await expect(
    page.getByRole("rowheader", { name: "Grace Hopper" })
  ).toBeVisible(built);
  await expect(
    page.getByRole("rowheader", { name: "Ada Lovelace" })
  ).toHaveCount(0);
});
