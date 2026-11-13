import { expect } from "@playwright/test";
import type { FrameLocator, Locator, Page } from "@playwright/test";

import { commitApp } from "../apps/core/test/app-definitions.ts";
import { test } from "./csp.ts";
import { writeDraft } from "./draft-writes.ts";
import { modelScripts } from "./model-scripts.ts";
import { apiOf, peopleIn } from "./people.ts";
import { tallyFiles } from "./tally-app.ts";

// A chat builds an App: once its agent writes a draft, the App shows as a
// card under the conversation, which opens the App's workspace with this
// chat and its draft, and there the draft's preview. The preview is the
// draft's page, an App of spec 8's layout: its queries, live
// queries and mutations run on the draft's sealed release, on the App's
// preview's one test store, so it reads none of the App's data and
// changes none (the threat model on GRA-662). The local stack reaches no
// model, so the draft is written straight into core's database, as the
// agent's `env.build.write` leaves it (draft-writes.ts). The
// agent's side of it, and what the preview reports back to it, are core's
// tests (apps/core/test/preview-repairs.test.ts).

/**
 * How long sharing waits after an agent's turn: the turn checks the
 * drafts it wrote as sharing does, building them, and sharing is off
 * until that check is done.
 */
const afterTurnCheck = { timeout: 30_000 };

/**
 * Asks `text` in `chat` once its last turn has ended: a turn goes on past
 * its answer while its drafts are checked (core's agent-builds.ts,
 * `turnCheck`), and the chat takes no question meanwhile.
 */
const askOnceIdle = async (chat: Locator, text: string): Promise<void> => {
  await expect(
    chat.getByRole("button", { name: "Send", exact: true })
  ).toBeVisible({ timeout: 30_000 });
  const ask = chat.getByRole("textbox", { name: "Ask for a change" });
  await ask.fill(text);
  await ask.press("Enter");
};

/**
 * The App's own tally page, released and live, once it shows its
 * count. Its first open builds it, which on a loaded machine takes longer
 * than the default 5 seconds.
 */
const openTally = async (page: Page, app: string): Promise<FrameLocator> => {
  await page.goto(`/apps/${app}/full`);
  const appPage = page.frameLocator('iframe[title="App"]');
  await expect(appPage.getByRole("status")).toContainText("in the App", {
    timeout: 20_000,
  });
  return appPage;
};

test("a chat building an App offers its workspace, whose preview changes none of the App's data", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const tag = crypto.randomUUID().slice(0, 8);
  const name = `Tally ${tag}`;
  try {
    const app = await api.apps.create({ name });
    const { version } = await commitApp(
      api.apps.files,
      app.id,
      tallyFiles("in the App"),
      "A tally"
    );
    // Live, for the people it is shared with (until then, its
    // builders' alone).
    await api.versions.rollback({ kind: "app", id: app.id }, version);
    const chat = await api.chats.create(`Build ${tag}`);
    const page = await pageOf(builder);

    // The App has data of its own: one added through its own page.
    const own = await openTally(page, app.id);
    await own.getByRole("button", { name: "Add one" }).click();
    await expect(own.getByRole("status")).toHaveText("1 in the App");

    // Nothing built yet: the conversation alone.
    // While `failDrafts` holds, reading what the chat worked on goes to an API
    // this stack has switched off (improvement signals), which core
    // refuses: as a read that fails.
    let failDrafts = false;
    await page.routeWebSocket("**/rpc", (socket) => {
      const toCore = socket.connectToServer();
      socket.onMessage((message) => {
        const text = String(message);
        toCore.send(
          failDrafts
            ? text.replaceAll('["chats","worked"]', '["signals","list"]')
            : text
        );
      });
    });
    await page.goto(`/?chat=${chat.id}`);
    const thread = page.getByRole("region", {
      name: `Build ${tag}`,
      exact: true,
    });
    // What the chat builds, on the bar above its box: the App, by name.
    const building = thread.getByRole("link", { name, exact: true });
    await expect(thread).toBeVisible();
    await expect(building).toHaveCount(0);

    // Its agent writes a draft: the App shows on the bar above the box.
    await writeDraft(builder.userId, chat.id, app.id, version, {
      "server/tally.ts":
        tallyFiles("in the preview").files["server/tally.ts"] ?? "",
    });
    // A read of it that fails says so in the chat, and is tried again
    // from there.
    failDrafts = true;
    // Opened afresh from its link: the address left it once it opened.
    await page.goto(`/?chat=${chat.id}`);
    await expect(
      thread.getByText("The Apps this chat builds didn't load.")
    ).toBeVisible();
    await expect(building).toHaveCount(0);
    failDrafts = false;
    await thread.getByRole("button", { name: "Try again" }).click();
    await expect(
      thread.getByText("The Apps this chat builds didn't load.")
    ).toHaveCount(0);

    // The App's workspace is the bar's link away.
    await building.click();
    // It makes this chat the App's, beside the draft it builds, and the
    // address lets it go.
    await expect(page).toHaveURL(new RegExp(`/apps/${app.id}$`, "u"));
    const chatName = page.getByRole("button", {
      name: `Chat name: Build ${tag}`,
    });
    await expect(chatName).toBeVisible();
    // There, the draft this chat builds is the preview, not the live App.
    // Shared with nobody yet: Share with your team is on.
    await expect(
      page.getByRole("button", { name: "Share with your team" })
    ).toBeEnabled();
    const preview = page.getByRole("region", { name: `${name}, your version` });
    // Its own store: none of the App's tally, then only what it added,
    // its live query following each mutation.
    const frame = preview.frameLocator("iframe");
    await expect(frame.getByRole("status")).toHaveText("0 in the preview", {
      timeout: 20_000,
    });
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("1 in the preview");
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("2 in the preview");
    // It stays this chat's as the person moves between the views.
    const views = page.getByRole("navigation", { name: "Workspace views" });
    await views.getByRole("link", { name: "Code" }).click();
    await views.getByRole("link", { name: "App" }).click();
    await expect(chatName).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Share with your team" })
    ).toBeEnabled();
    await expect(
      page.getByRole("heading", { level: 1, name, exact: true })
    ).toBeVisible();

    // The App's own data is as it was: none of the preview's two.
    const after = await openTally(page, app.id);
    await expect(after.getByRole("status")).toHaveText("1 in the App");
  } finally {
    core[Symbol.dispose]();
  }
});

test("an App's own chat writes its page and server code, and its workspace previews it, taking each write in place, its page's even while the server code doesn't build", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const name = `Tally ${crypto.randomUUID().slice(0, 8)}`;
  try {
    const app = await api.apps.create({ name });
    const page = await pageOf(builder);
    await page.goto(`/apps/${app.id}`);
    await expect(
      page.getByRole("heading", { name: "What should this App do?" })
    ).toBeVisible();

    // A version published elsewhere, from another tab: the App shows, as
    // the team sees it while nothing is changed over it.
    const { version } = await commitApp(
      api.apps.files,
      app.id,
      tallyFiles("in the App"),
      "A tally"
    );
    await api.versions.rollback({ kind: "app", id: app.id }, version);
    const published = page
      .getByRole("region", { name: `${name}, as your team sees it` })
      .frameLocator("iframe");
    await expect(published.getByRole("status")).toHaveText("0 in the App", {
      timeout: 30_000,
    });

    const { opener } = modelScripts.buildsTally;
    const chat = page.getByRole("region", { name: "Chat" });
    const ask = chat.getByRole("textbox", { name: "Ask for a change" });
    await askOnceIdle(chat, opener);
    await expect(chat.getByText("The tally is in the preview.")).toBeVisible({
      timeout: 30_000,
    });

    // The page the agent wrote runs in the preview, on a store of its own.
    const preview = page.getByRole("region", { name: `${name}, your version` });
    // Only its builder sees it: Share with your team is on, once the
    // turn's check of the draft is done.
    await expect(
      page.getByRole("button", { name: "Share with your team" })
    ).toBeEnabled(afterTurnCheck);
    const frame = preview.frameLocator("iframe");
    await expect(frame.getByRole("status")).toHaveText("0 in the preview", {
      timeout: 30_000,
    });
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("1 in the preview");

    // The agent writes the page again: the frame it has open takes the
    // write in place, its document never loaded again, and its store
    // keeps what was added.
    const pageFrame = page
      .frames()
      .find((each) => each.url().includes("/page-frame"));
    expect(pageFrame).toBeDefined();
    await pageFrame?.evaluate(() => {
      Reflect.set(globalThis, "stillThisDocument", true);
    });
    await expect(
      chat.getByRole("button", { name: "Send", exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await ask.fill("Rename the button.");
    const asked = Date.now();
    await ask.press("Enter");
    await expect(chat.getByText("Renaming the button.")).toBeVisible({
      timeout: 30_000,
    });
    const written = Date.now();
    await expect(
      frame.getByRole("button", { name: "Add another" })
    ).toBeVisible({ timeout: 10_000 });
    const shown = Date.now();
    console.info(
      `preview took the write ${shown - written} ms after the chat showed it (${shown - asked} ms after asking)`
    );
    const sameDocument: unknown = await pageFrame?.evaluate((): unknown =>
      Reflect.get(globalThis, "stillThisDocument")
    );
    expect({
      count: await frame.getByRole("status").textContent(),
      sameDocument,
    }).toStrictEqual({ count: "1 in the preview", sameDocument: true });

    // The agent writes its server code alone: the frame takes it in
    // place, its live count read again on the new code, on the same test
    // store: the App's preview keeps one store across server code changes,
    // for every builder, until one of them resets it, so the one added
    // before still counts.
    await askOnceIdle(chat, "Count anew.");
    await expect(chat.getByText("It counts anew.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(frame.getByRole("status")).toHaveText("1 counted anew", {
      timeout: 10_000,
    });
    await frame.getByRole("button", { name: "Add another" }).click();
    await expect(frame.getByRole("status")).toHaveText("2 counted anew");

    // Server code that doesn't build, with a write of the page: the page
    // still takes the write, built against the references the draft last
    // generated, and its calls show the server code's error, while the
    // problem is being fixed.
    await askOnceIdle(chat, "Take more.");
    await expect(chat.getByText("It takes more.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(frame.getByRole("alert")).toContainText(
      "server code doesn't build",
      { timeout: 10_000 }
    );
    await expect(preview.getByText("Fixing a problem…")).toBeVisible();

    // Once it builds, the frame takes it: started afresh, as the error the
    // page showed can't be taken back in place, its data kept.
    await askOnceIdle(chat, "Fix the count.");
    await expect(chat.getByText("The count is fixed.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(frame.getByRole("status")).toHaveText("2 fixed", {
      timeout: 10_000,
    });
    await expect(frame.getByRole("button", { name: "Add more" })).toBeVisible();
    await expect(preview.getByText("Fixing a problem…")).toHaveCount(0);

    // The Code view shows the draft the preview does, before anything is
    // published: the App's project as the agent wrote it, its last write
    // too.
    await page
      .getByRole("navigation", { name: "Workspace views" })
      .getByRole("link", { name: "Code" })
      .click();
    // Its tree: folders first, each open, then the files, each by name.
    const files = page.getByRole("navigation", { name: "Files" });
    await expect(files.getByRole("button")).toHaveText([
      "server",
      "schema.ts",
      "tally.ts",
      "src",
      "routes",
      "index.tsx",
      "grasp.config.ts",
    ]);
    await files.getByRole("button", { name: "index.tsx" }).click();
    const code = page.getByRole("region", {
      name: "Code of src/routes/index.tsx",
    });
    await expect(code).toContainText("Add more");
    await expect(
      page.getByRole("navigation", { name: "Open file" })
    ).toHaveText(/src.*routes.*index\.tsx/u);
  } finally {
    core[Symbol.dispose]();
  }
});

test("an App's workspace previews the App before its chat changes anything, then each change its chat makes", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const name = `Tally ${crypto.randomUUID().slice(0, 8)}`;
  try {
    const app = await api.apps.create({ name });
    const { version } = await commitApp(
      api.apps.files,
      app.id,
      tallyFiles("in the App"),
      "A tally"
    );
    await api.versions.rollback({ kind: "app", id: app.id }, version);
    const page = await pageOf(builder);
    await page.goto(`/apps/${app.id}`);

    // No change asked for yet: the App's live version, as the team sees it.
    const live = page
      .getByRole("region", { name: `${name}, as your team sees it` })
      .frameLocator("iframe");
    await expect(live.getByRole("status")).toHaveText("0 in the App", {
      timeout: 30_000,
    });
    // Shared with nobody yet: Share with your team is on, for the App's
    // live version as it is.
    await expect(
      page.getByRole("button", { name: "Share with your team" })
    ).toBeEnabled();

    // A version published elsewhere comes into the open preview.
    const second = await commitApp(
      api.apps.files,
      app.id,
      tallyFiles("in version 2"),
      "Elsewhere"
    );
    await api.versions.rollback({ kind: "app", id: app.id }, second.version);
    await expect(live.getByRole("status")).toHaveText("0 in version 2", {
      timeout: 30_000,
    });

    // Asked for one: the builder's own version shows it, on a store of the
    // preview's own.
    const { opener } = modelScripts.buildsTally;
    const chat = page.getByRole("region", { name: "Chat" });
    await askOnceIdle(chat, opener);
    await expect(chat.getByText("The tally is in the preview.")).toBeVisible({
      timeout: 30_000,
    });
    // Only its builder sees it: Share with your team is on, once the
    // turn's check of the draft is done.
    await expect(
      page.getByRole("button", { name: "Share with your team" })
    ).toBeEnabled(afterTurnCheck);
    const frame = page
      .getByRole("region", { name: `${name}, your version` })
      .frameLocator("iframe");
    await expect(frame.getByRole("status")).toHaveText("0 in the preview", {
      timeout: 30_000,
    });
  } finally {
    core[Symbol.dispose]();
  }
});

test("a preview opened on a draft that doesn't build shows the App's latest version, saying it is being fixed, until a write builds", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const name = `Tally ${crypto.randomUUID().slice(0, 8)}`;
  try {
    const app = await api.apps.create({ name });
    const { version } = await commitApp(
      api.apps.files,
      app.id,
      tallyFiles("in the App"),
      "A tally"
    );
    await api.versions.rollback({ kind: "app", id: app.id }, version);
    const page = await pageOf(builder);
    await page.goto(`/apps/${app.id}`);
    await expect(
      page
        .getByRole("region", { name: `${name}, as your team sees it` })
        .frameLocator("iframe")
        .getByRole("status")
    ).toHaveText("0 in the App", { timeout: 30_000 });
    const preview = page.getByRole("region", { name: `${name}, your version` });
    const frame = preview.frameLocator("iframe");

    const { opener } = modelScripts.fixesBrokenTally;
    const chat = page.getByRole("region", { name: "Chat" });
    await askOnceIdle(chat, opener);
    await expect(
      chat.getByText("The tally's page doesn't build yet.")
    ).toBeVisible({ timeout: 30_000 });

    // Opened afresh on it: the App's latest version's page, its calls on
    // the draft as it is, and a word that the problem is being fixed.
    await page.reload();
    await expect(frame.getByRole("status")).toHaveText("0 in the preview", {
      timeout: 30_000,
    });
    await expect(preview.getByText("Fixing a problem…")).toBeVisible();

    await askOnceIdle(chat, "Fix the page.");
    await expect(chat.getByText("The tally works now.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(preview.getByText("Fixing a problem…")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(frame.getByRole("status")).toHaveText("0 in the preview");
  } finally {
    core[Symbol.dispose]();
  }
});

test("a preview whose first page doesn't build shows it once the agent's next write fixes it", async ({
  pageOf,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const name = `Tally ${crypto.randomUUID().slice(0, 8)}`;
  try {
    const app = await api.apps.create({ name });
    const page = await pageOf(builder);
    await page.goto(`/apps/${app.id}`);
    await expect(
      page.getByRole("heading", { name: "What should this App do?" })
    ).toBeVisible();

    const { opener } = modelScripts.fixesBrokenTally;
    const chat = page.getByRole("region", { name: "Chat" });
    await askOnceIdle(chat, opener);
    await expect(
      chat.getByText("The tally's page doesn't build yet.")
    ).toBeVisible({ timeout: 30_000 });

    // Its first build fails: the preview says so in its place, with Fix
    // with Grasp, and takes no updates.
    const preview = page.getByRole("region", { name: `${name}, your version` });
    await expect(preview.getByText("The preview didn't start")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      preview.getByText("The draft's code doesn't build.")
    ).toBeVisible();
    await expect(
      preview.getByRole("button", { name: "Fix with Grasp" })
    ).toBeVisible();

    // The next write fixes it: the preview starts afresh and shows it.
    await askOnceIdle(chat, "Fix the page.");
    await expect(chat.getByText("The tally works now.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(preview.frameLocator("iframe").getByRole("status")).toHaveText(
      "0 in the preview",
      { timeout: 30_000 }
    );
  } finally {
    core[Symbol.dispose]();
  }
});
