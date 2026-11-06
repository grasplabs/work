import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { appReady, modelScripts } from "./model-scripts.ts";
import { peopleIn } from "./people.ts";

// An App, end to end, as a builder makes one: New App, what to build, the
// App's own chat building it (the stack's scripted model reads the
// deployment's docs, writes the App's files and says it's ready, e2e/
// model-scripts.ts), the draft's page in the workspace's preview, then
// Publish changes, as the chat never proposed it, and its review made
// current and published. Shared with someone as a user, they open the
// live App and add a contact on its page, which the App's data shows
// its builder.

/** A turn of the agent's, its model's calls and the tools they call. */
const agentTurn = { timeout: 30_000 };

/** A page's first build, or a read from core on a loaded stack. */
const built = { timeout: 20_000 };

// Never tried again, as the serial journeys aren't (playwright.config.ts):
// a flaky journey shows as itself, with the trace of the run that failed,
// and a failing one costs its part one attempt of its long wait, not three.
// Each action waits as long as a build or a read: one that never can
// fails as itself, not as the whole test's timeout.
test.use({ trace: "retain-on-failure", actionTimeout: built.timeout });
test.describe.configure({ retries: 0 });

test("a builder has an App built in its chat, publishes it, and someone it is shared with adds a contact its data then shows", async ({
  pageOf,
}) => {
  // Its longest waits, one after another: two of the agent's turns and
  // the preview's first load (30 s each) and ten builds or reads (20 s
  // each): 290 s, before its clicks.
  test.setTimeout(300_000);
  const { builder, user } = peopleIn("appBuilt");
  const { opener } = modelScripts.buildsApp;
  const page = await pageOf(builder);

  // New App: what to build, which makes the App with its own chat and
  // opens its workspace, the chat building it there.
  await page.goto("/apps/new");
  await expect(
    page.getByRole("heading", { name: "What do you want to build?" })
  ).toBeVisible();
  const ask = page.getByRole("textbox", { name: "Describe the App" });
  await ask.fill(opener);
  await ask.press("Enter");
  await expect(page).toHaveURL(/\/apps\/[^/]+\/edit/u, built);
  const app = new URL(page.url()).pathname.split("/").at(-2) ?? "";

  // The chat reads how an App is written, writes it, and says so.
  const chat = page.getByRole("region", { name: "Chat" });
  await expect(chat.getByText("Read /guides/project in the docs")).toBeVisible(
    agentTurn
  );
  await expect(chat.getByText(appReady)).toBeVisible(agentTurn);

  // The preview is the draft's page, on a store of its own.
  const preview = page.getByRole("region", { name: /^Preview of /u });
  const frame = preview.frameLocator("iframe");
  // Its first load waits for core to build the draft, behind any update
  // ahead of it: as long as an agent's turn.
  await expect(frame.getByLabel("Contact's name")).toBeVisible(agentTurn);
  await frame.getByLabel("Contact's name").fill("Ada Lovelace");
  await frame.getByRole("button", { name: "Add contact" }).click();
  await expect(
    frame.getByRole("list", { name: "Contacts" }).getByRole("listitem")
  ).toHaveText(["Ada Lovelace"], built);

  // The chat never proposed it: Publish changes does, as the builder,
  // and opens its review, where it is made current and published.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Publish changes/u }).click();
  const review = page.getByRole("dialog", { name: "Publish version 1" });
  await review
    .getByRole("button", { name: "Make version 1 current and publish" })
    .click(built);
  await expect(review).toBeHidden(built);
  await expect(page.getByRole("button", { name: "Published" })).toBeVisible(
    built
  );

  // Shared with someone, as a user. Everyone the stack signs in is
  // called Person, and a builder sees names, not emails: they are told
  // apart by the ID each option goes by.
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page
    .getByRole("option", { name: "Person" })
    .and(page.locator(`[data-value="person:${user.userId}"]`))
    .click();
  // Shared once its Sharing lists them, as a user.
  await page
    .getByRole("navigation", { name: "Workspace views" })
    .getByRole("link", { name: "Settings" })
    .click();
  await page.getByRole("link", { name: "Sharing" }).click();
  await expect(page.getByLabel("Role of Person")).toBeVisible(built);

  // They use the live App: none of the preview's contacts, then theirs.
  const used = await pageOf(user);
  await used.goto(`/apps/${app}`);
  await expect(
    used.getByRole("heading", { level: 1, name: opener })
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

  // The App's data shows its builder the contact they added, among the
  // records of its table.
  await page
    .getByRole("navigation", { name: "Workspace views" })
    .getByRole("link", { name: "Data" })
    .click();
  await page.getByRole("tab", { name: "Records" }).click();
  await expect(page.getByRole("cell", { name: "Grace Hopper" })).toBeVisible(
    built
  );
  await expect(page.getByRole("cell", { name: "Ada Lovelace" })).toHaveCount(0);
});
